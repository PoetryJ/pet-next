'use strict';
/**
 * Linux 专用：**X11 指针位置查询**（纯 Node，无原生模块、不依赖任何外部命令）。
 *
 * 为什么需要它（issue：桌面模式在 Linux 上点不动）：
 *   桌面宠物窗口默认整窗点击穿透（透明像素不该挡住下层应用），能不能点全靠主进程判断
 *   「光标现在在不在宠物身上」。Windows/macOS 上 `screen.getCursorScreenPoint()` 每次都是实时值；
 *   **Linux/X11 上它返回的是 Chromium 缓存的最后一个鼠标事件位置**——而我们的窗口又恰好
 *   在穿透状态下收不到任何鼠标事件，于是这个值从建窗那一刻起就冻结了：兜底轮询永远拿着
 *   一个陈旧坐标去算，宠物永远翻不成可交互，桌面模式在 Linux 上等于完全点不动。
 *
 *   实测（2026-10，Ubuntu 22.04 / Xorg / Electron 43）：把光标用 XTest 移到宠物身上，
 *   `screen.getCursorScreenPoint()` 仍返回建窗时的旧坐标；X 服务器的 QueryPointer 则是实时的。
 *
 * 做法：直接跟 X server 说 X11 协议的最小必要部分——连接握手（含 MIT-MAGIC-COOKIE-1，
 *   从 Xauthority 读）与 `QueryPointer`（opcode 38）。每 60ms 查一次，结果缓存给兜底轮询用。
 *   失败（Wayland 会话没有 X11 套接字、Xauthority 不可读、协议解析异常）时 `get()` 返回 null，
 *   调用方回退到 Electron 的原生 API——行为与改造前完全一致，不会更糟。
 *
 * 坐标系：QueryPointer 返回的是**物理像素**；Electron 的 `win.getBounds()` 是 DIP。
 *   缩放不为 1 时由调用方除以 `screen.getPrimaryDisplay().scaleFactor`（见 main.js 的 currentPointer）。
 *
 * 为什么不用现成工具：xdotool 不是各发行版必备（本机就没有），python3-xlib 同样不是；
 *   而这点协议用 100 行纯 JS 就能讲清楚，不给用户增加任何安装步骤。
 *
 * 跑法（自检）：node -e "require('./x11-pointer.js').probe().then(console.log)"
 */
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** X11 协议里屏幕根的 QueryPointer 请求长度（opcode + pad + length + window） */
const QUERY_POINTER = 38;
/** QueryPointer 应答固定 32 字节 */
const REPLY_BYTES = 32;

/** 从 Xauthority 里取本 display 的 MIT-MAGIC-COOKIE-1；没有则返回 null（匿名连接） */
function readCookie(display) {
  const file = process.env.XAUTHORITY || path.join(os.homedir(), '.Xauthority');
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  const m = /^(?:[^:]*):(\d+)(?:\.\d+)?$/.exec(display || '');
  const wantNum = m ? m[1] : null;
  let off = 0;
  let fallback = null;
  while (off + 2 <= buf.length) {
    try {
      const family = buf.readUInt16BE(off);
      off += 2;
      const readField = () => {
        const len = buf.readUInt16BE(off);
        off += 2;
        const value = buf.subarray(off, off + len);
        off += len;
        return value;
      };
      const addr = readField();
      const num = readField().toString('latin1');
      const name = readField().toString('latin1');
      const data = readField();
      if (name !== 'MIT-MAGIC-COOKIE-1') continue;
      const entry = { family, addr, num, name, data };
      if (wantNum !== null && num === wantNum) return entry;
      if (fallback === null) fallback = entry;
    } catch {
      break;
    }
  }
  return fallback;
}

/** 连接 X11 套接字：优先文件系统路径，其次 Linux 抽象命名空间（/tmp 被重映射时仍可用） */
function connect(display) {
  const num = (/^(?:[^:]*):(\d+)/.exec(display) || [])[1] || '0';
  const paths = [`/tmp/.X11-unix/X${num}`, `\u0000/tmp/.X11-unix/X${num}`];
  return new Promise((resolve, reject) => {
    let index = 0;
    const attempt = () => {
      if (index >= paths.length) {
        reject(new Error('cannot connect to display ' + display));
        return;
      }
      const socket = net.connect(paths[index++]);
      const fail = (error) => {
        socket.destroy();
        if (index < paths.length) attempt();
        else reject(error);
      };
      socket.once('connect', () => {
        socket.off('error', fail);
        resolve(socket);
      });
      socket.once('error', fail);
    };
    attempt();
  });
}

/** 在 setup 应答体里定位第一块屏幕的根窗口。偏移 0/16 两种都试：实测个别服务器多 16 字节前缀 */
function parseRoot(body) {
  const pad = (n) => (4 - (n % 4)) % 4;
  for (const start of [0, 16]) {
    if (body.length < start + 16) continue;
    const vendorLen = body.readUInt16LE(start);
    if (vendorLen < 1 || vendorLen > 255) continue;
    const vendor = body.subarray(start + 16, start + 16 + vendorLen).toString('latin1');
    if (!/^[\x20-\x7e]+$/.test(vendor)) continue;
    const numScreens = body[start + 4];
    const numFormats = body[start + 5];
    if (numScreens < 1 || numFormats > 32) continue;
    const screenOff = start + 16 + vendorLen + pad(vendorLen) + numFormats * 8;
    if (screenOff + 4 > body.length) continue;
    const root = body.readUInt32LE(screenOff);
    if (root !== 0) return root;
  }
  throw new Error('cannot locate root window in X11 setup reply');
}

/** X11 连接握手；成功返回 { socket, root } */
function handshake(display) {
  return connect(display).then(
    (socket) =>
      new Promise((resolve, reject) => {
        const cookie = readCookie(display);
        const name = cookie ? Buffer.from(cookie.name, 'latin1') : Buffer.alloc(0);
        const data = cookie ? cookie.data : Buffer.alloc(0);
        const pad = (n) => (4 - (n % 4)) % 4;
        const head = Buffer.alloc(12);
        head.write('l', 0, 'latin1');
        head.writeUInt16LE(11, 2);
        head.writeUInt16LE(0, 4);
        head.writeUInt16LE(name.length, 6);
        head.writeUInt16LE(data.length, 8);
        const setup = Buffer.concat([
          head,
          name,
          Buffer.alloc(pad(name.length)),
          data,
          Buffer.alloc(pad(data.length)),
        ]);

        let buffer = Buffer.alloc(0);
        const onData = (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length < 8) return;
          if (buffer[0] !== 1) {
            cleanup();
            reject(new Error('X11 setup failed, status=' + buffer[0]));
            return;
          }
          const total = 8 + buffer.readUInt16LE(6) * 4;
          if (buffer.length < total) return;
          cleanup();
          try {
            resolve({ socket, root: parseRoot(buffer.subarray(8)) });
          } catch (error) {
            socket.destroy();
            reject(error);
          }
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          socket.off('data', onData);
          socket.off('error', onError);
        };
        socket.on('data', onData);
        socket.on('error', onError);
        socket.write(setup);
      }),
  );
}

/**
 * 创建一个轮询式的指针提供者。
 *
 * @param {{ intervalMs?: number, display?: string }} [options]
 * @returns {{ get: () => {x:number,y:number}|null, start: () => void, stop: () => void, probe: () => Promise<{x:number,y:number}> }}
 *   `get()` 返回最近一次成功查询的坐标（物理像素），尚未成功过则为 null。
 */
function createLinuxPointer(options = {}) {
  const intervalMs = options.intervalMs ?? 60;
  const display = options.display || process.env.DISPLAY || ':0';
  let socket = null;
  let root = 0;
  let pending = null; // 当前 QueryPointer 应答的 resolver
  let buffer = Buffer.alloc(0);
  let last = null;
  let timer = null;
  let inFlight = false;
  let stopped = false;

  function reset() {
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
    socket = null;
    root = 0;
    buffer = Buffer.alloc(0);
    if (pending) {
      pending.reject(new Error('connection reset'));
      pending = null;
    }
  }

  function ensure() {
    if (socket) return Promise.resolve();
    return handshake(display).then(({ socket: s, root: r }) => {
      socket = s;
      root = r;
      buffer = Buffer.alloc(0);
      s.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (pending && buffer.length >= REPLY_BYTES) {
          const reply = buffer.subarray(0, REPLY_BYTES);
          buffer = buffer.subarray(REPLY_BYTES);
          const resolve = pending.resolve;
          pending = null;
          // 应答首字节必须是 1（Reply），否则说明协议已经错位
          if (reply[0] !== 1) {
            resolve(null);
            continue;
          }
          resolve({ x: reply.readInt16LE(16), y: reply.readInt16LE(18) });
        }
      });
      s.on('error', reset);
      s.on('close', reset);
    });
  }

  function query() {
    return ensure().then(
      () =>
        new Promise((resolve, reject) => {
          pending = { resolve, reject };
          const req = Buffer.alloc(8);
          req[0] = QUERY_POINTER;
          req.writeUInt16LE(2, 2);
          req.writeUInt32LE(root, 4);
          socket.write(req);
        }),
    );
  }

  function tick() {
    if (inFlight || stopped) return;
    inFlight = true;
    query()
      .then((point) => {
        if (point) last = point;
      })
      .catch(() => {
        reset();
      })
      .finally(() => {
        inFlight = false;
      });
  }

  return {
    get: () => last,
    start() {
      if (timer !== null || stopped) return;
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      reset();
    },
    /** 单次查询（自检/测试用） */
    probe: () =>
      handshake(display).then(({ socket: s, root: r }) => {
        return new Promise((resolve, reject) => {
          let buffer = Buffer.alloc(0);
          const onData = (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length < REPLY_BYTES) return;
            s.off('data', onData);
            s.destroy();
            resolve({ x: buffer.readInt16LE(16), y: buffer.readInt16LE(18) });
          };
          s.on('data', onData);
          s.on('error', (error) => {
            s.destroy();
            reject(error);
          });
          const req = Buffer.alloc(8);
          req[0] = QUERY_POINTER;
          req.writeUInt16LE(2, 2);
          req.writeUInt32LE(r, 4);
          s.write(req);
        });
      }),
  };
}

module.exports = { createLinuxPointer, parseRoot };

if (require.main === module) {
  createLinuxPointer()
    .probe()
    .then((point) => console.log(JSON.stringify(point)), () => process.exit(1));
}
