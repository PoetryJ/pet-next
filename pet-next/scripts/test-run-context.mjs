/**
 * M3-8 测试资源隔离：每次真实 Electron / bench 运行独占一套目录、日志、配置、端口和显示器。
 *
 * 最小 API（负责人冻结口径）：
 *   createRunContext({ label, kind, appRoot? }) ->
 *     { dir, logDir, configPath, modelLogPath, sshLogPath, freePort(), env(extra), snapshot(), cleanup() }
 *   startOwnXvfb({ label }) -> { display, socket, stop() }
 *
 * 语义：
 * 1) 唯一：目录带时间戳 + pid + 随机后缀；端口只从内核临时端口取一次并登记；显示器由本进程
 *    用标记文件认领，绝不碰 :94（集成负责人）与 :95-:97（并行 agent），也不 kill 别人的 Xvfb/Electron。
 * 2) 构建先完成再启动：本模块不构建。调用顺序是
 *      ctx = createRunContext(...)            // 只建目录，不起进程、不监听端口
 *      await buildOnce()                      // 例如等 dist/electron/main.js 出现
 *      xvfb = await startOwnXvfb(...)         // 构建完成后再起显示器
 *      spawn(entry, args, { env: ctx.env({ DISPLAY: xvfb.display }) })
 *    这样构建失败时不会留下 Xvfb/Electron/端口；ctx.env() 每次都新建对象，构建后用再取一次即可。
 * 3) 收尾先断言再清理：cleanup() 先探测本轮端口是否仍被监听、日志/配置文件是否残留，
 *    把结论写进 <logDir>/residual.json 并作为返回值；ok=false 时保留本轮目录当证据，不删。
 *    清理只删本轮目录，不杀任何进程（外部进程一律不碰），所以调用方要自己停自己起的子进程。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RUN_ROOT = path.join(os.tmpdir(), 'pet-next-runs');
/** 显示器认领范围：跳过共享的 :94 与并行 agent 的 :95-:97。 */
const DISPLAY_MIN = 120;
const DISPLAY_MAX = 699;
const XVFB_READY_MS = 8000;
const XVFB_STOP_GRACE_MS = 2000;
const PORT_PROBE_MS = 250;

function assertLabel(value, field) {
  if (typeof value !== 'string' || value.length === 0 || !LABEL.test(value)) {
    throw new Error(`${field} 必须是 kebab-case 非空字符串，收到：${String(value)}`);
  }
}

function compactStamp(date) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function fileSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** 端口是否仍有人在监听（只连接本机回环，不发送数据）。 */
function portListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(PORT_PROBE_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * 建一次运行的隔离上下文。只建目录和登记路径；不起进程、不监听端口、不动全局状态。
 * @param {{ label: string, kind: string, appRoot?: string }} options
 */
export function createRunContext(options) {
  const { label, kind, appRoot = process.cwd() } = options ?? {};
  assertLabel(label, 'label');
  assertLabel(kind, 'kind');

  const createdAt = new Date();
  const leaf = `${compactStamp(createdAt)}-${label}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const dir = path.join(RUN_ROOT, kind, leaf);
  const logDir = path.join(dir, 'logs');
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dir, 'userData'), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dir, 'config'), { recursive: true, mode: 0o700 });

  const context = {
    dir,
    logDir,
    /** PET_NEXT_REMOTE_CONFIG 指向这里；文件不存在时入口按"无本地配置"处理。 */
    configPath: path.join(dir, 'config', 'qwen-remote.json'),
    /** FAKE_MODEL_LOG 指向这里（NDJSON，每次请求一行）。 */
    modelLogPath: path.join(logDir, 'model.ndjson'),
    /** FAKE_SSH_LOG 指向这里（NDJSON，隧道替身参数/监听/退出）。 */
    sshLogPath: path.join(logDir, 'ssh.ndjson'),
  };

  const ports = [];
  const meta = {
    label,
    kind,
    appRoot,
    dir,
    createdAt: createdAt.toISOString(),
    pid: process.pid,
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
  };
  writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

  /** 取一个当前可绑定的回环端口并登记；每次运行多端口互不共用。 */
  async function freePort() {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          server.close(() => reject(new Error('freePort: 未拿到端口')));
          return;
        }
        const { port: assigned } = address;
        server.close(() => resolve(assigned));
      });
    });
    ports.push(port);
    return port;
  }

  /** 子进程环境：本次运行的目录/日志/配置 + 可选额外变量；不继承 NODE_OPTIONS。 */
  function env(extra = {}) {
    const merged = { ...process.env };
    delete merged.NODE_OPTIONS;
    const runEnv = {
      ...merged,
      PET_NEXT_RUN_DIR: dir,
      PET_NEXT_USER_DATA: path.join(dir, 'userData'),
      PET_NEXT_REMOTE_CONFIG: context.configPath,
      FAKE_MODEL_LOG: context.modelLogPath,
      FAKE_SSH_LOG: context.sshLogPath,
    };
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete runEnv[key];
      else runEnv[key] = String(value);
    }
    return runEnv;
  }

  /** 本轮资源快照（纯读，无副作用）：调用方可用它做"清理前"的记录。 */
  function snapshot() {
    return {
      label,
      kind,
      dir,
      logDir,
      createdAt: meta.createdAt,
      ports: [...ports],
      paths: {
        configPath: context.configPath,
        modelLogPath: context.modelLogPath,
        sshLogPath: context.sshLogPath,
      },
      files: {
        metaExists: existsSync(path.join(dir, 'meta.json')),
        configBytes: fileSize(context.configPath),
        modelLogBytes: fileSize(context.modelLogPath),
        sshLogBytes: fileSize(context.sshLogPath),
        logFiles: existsSync(logDir) ? readdirSync(logDir).sort() : [],
      },
      meta: readJsonIfExists(path.join(dir, 'meta.json')),
    };
  }

  /**
   * 先记录残留断言，再只清本轮目录。
   * @param {{ keepDir?: boolean }} [cleanupOptions]
   */
  async function cleanup(cleanupOptions = {}) {
    const stillListening = [];
    for (const port of ports) {
      if (await portListening(port)) stillListening.push(port);
    }
    const residual = {
      label,
      kind,
      dir,
      createdAt: meta.createdAt,
      cleanedAt: new Date().toISOString(),
      ok: stillListening.length === 0,
      ports: { allocated: [...ports], stillListening },
      files: snapshot().files,
      notes: [],
      dirKept: false,
    };
    if (stillListening.length > 0) {
      residual.notes.push(`端口仍被监听，调用方未释放：${stillListening.join(',')}`);
    }
    // 先落盘，再决定删不删：有残留就保留目录，避免把证据一起清掉。
    try {
      writeFileSync(path.join(logDir, 'residual.json'), `${JSON.stringify(residual, null, 2)}\n`);
    } catch {
      residual.notes.push('residual.json 写入失败（日志目录已不存在）');
    }
    const keep = cleanupOptions.keepDir === true || !residual.ok;
    if (!keep) {
      rmSync(dir, { recursive: true, force: true });
    }
    residual.dirKept = keep;
    return residual;
  }

  return {
    ...context,
    freePort,
    env,
    snapshot,
    cleanup,
  };
}

/** 显示器认领标记：同一显示器编号在同一时刻只有一个进程能建出来。 */
function claimDisplay(number) {
  const marker = path.join(os.tmpdir(), `pet-next-xvfb-${number}.lock`);
  try {
    writeFileSync(marker, `${process.pid}\n`, { flag: 'wx' });
    return marker;
  } catch {
    return null;
  }
}

function releaseDisplay(marker) {
  try {
    rmSync(marker, { force: true });
  } catch {
    // 清理失败不掩盖原始错误。
  }
}

function displaySocket(number) {
  return `/tmp/.X11-unix/X${number}`;
}

/**
 * 起一个只属于本轮的 Xvfb：跳过 :94/:95-:97，也不碰任何已有显示器。
 * 构建必须已完成再调用（见文件头顺序说明）。
 * @param {{ label: string }} options
 * @returns {Promise<{ display: string, socket: string, pid: number, stop: () => Promise<{ stopped: boolean, signal: string | null }> }>}
 */
export async function startOwnXvfb(options) {
  const { label } = options ?? {};
  assertLabel(label, 'label');

  const start = DISPLAY_MIN + (process.pid % 40);
  let chosen = null;
  for (let attempt = 0; attempt < DISPLAY_MAX - DISPLAY_MIN; attempt += 1) {
    const number = DISPLAY_MIN + ((start - DISPLAY_MIN + attempt) % (DISPLAY_MAX - DISPLAY_MIN + 1));
    if (existsSync(displaySocket(number)) || existsSync(`/tmp/.X${number}-lock`)) continue;
    const marker = claimDisplay(number);
    if (marker === null) continue;
    chosen = { number, marker };
    break;
  }
  if (chosen === null) throw new Error(`没有可用的 Xvfb 显示器（${DISPLAY_MIN}..${DISPLAY_MAX}）`);

  const socket = displaySocket(chosen.number);
  let stderr = '';
  const child = spawn('Xvfb', [`:${chosen.number}`, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < 4000) stderr += chunk;
  });

  const failed = () => {
    releaseDisplay(chosen.marker);
    return new Error(`Xvfb :${chosen.number} 起不来：${stderr.trim() || '无输出'}`);
  };

  try {
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + XVFB_READY_MS;
      const poll = () => {
        if (existsSync(socket)) {
          resolve();
          return;
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          reject(failed());
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`Xvfb :${chosen.number} ${XVFB_READY_MS}ms 内没有创建 socket ${socket}`));
          return;
        }
        setTimeout(poll, 50);
      };
      child.once('error', (error) => reject(new Error(`Xvfb 无法启动：${error.message}`)));
      poll();
    });
  } catch (error) {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已经退出。
    }
    releaseDisplay(chosen.marker);
    throw error;
  }

  let stopped = false;
  /** 只停本次 spawn 的 Xvfb（按 pid），不按名字批量 kill。 */
  async function stop() {
    if (stopped) return { stopped: false, signal: null };
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          resolve();
        }, XVFB_STOP_GRACE_MS);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    releaseDisplay(chosen.marker);
    return { stopped: true, signal: child.signalCode };
  }

  return { display: `:${chosen.number}`, socket, pid: child.pid, stop };
}
