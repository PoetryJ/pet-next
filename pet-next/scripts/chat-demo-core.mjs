/**
 * M3-0 聊天预览编排核心：本地假服务 + 真实 Electron 聊天面板。
 *
 * 链路：fake-server-main.ts(127.0.0.1) -> http provider(主进程) -> 面板"演示回复"。
 * 未接真实模型：健康口径只报 offline_ready，且必须两条同时成立才为 true：
 *   ① fake `/healthz` 返回 `{status:'offline_ready'}`；
 *   ② Electron 面板页已渲染（主进程 ready 记录，即 ready-to-show，等价于 did-finish-load 的可观测信号）。
 *
 * 入口 scripts/chat-demo.mjs 只负责注入真实 IO；编排全在这里，便于单测注入假子进程 / 假 fetch。
 * @module pet-next/scripts/chat-demo-core
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 未显式传 petRoot 时按本文件位置推断（scripts/..）。 */
export const DEFAULT_PET_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 面板已渲染的可观测信号：electron/main.ts 的 ready-to-show 记录（不改 electron/** 能拿到的最强信号）。 */
const PANEL_LOADED_EVENT = 'ready';
/** 页面加载失败信号，出现即判失败，不能报 offline_ready。 */
const PAGE_FAIL_EVENT = 'fail-load';

/**
 * 解析 Electron 可执行文件。
 * electron 是 CJS 包，`require('electron')` 直接返回可执行文件路径；写成属性访问（`.electron`）会拿到 undefined。
 * @param {string} petRoot
 * @returns {string}
 */
export function resolveElectronPath(petRoot) {
  const require = createRequire(path.join(petRoot, 'package.json'));
  const resolved = require('electron');
  if (typeof resolved !== 'string' || resolved.length === 0) {
    throw new Error(`electron 可执行文件解析失败：require('electron') 返回 ${String(resolved)}`);
  }
  return resolved;
}

/** 合法端口：1..65535 的整数；其余（空、字符串、越界）返回 null。 */
export function parsePort(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (text.length === 0) return null;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/**
 * 按完整行切分 chunk：stdout 可能半行到达，也可能一次多行，未闭合的尾巴留在 buffer 里。
 * @param {(line: string) => void} onLine
 */
export function createLineReader(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += String(chunk);
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line.trim().length > 0) onLine(line);
        index = buffer.indexOf('\n');
      }
    },
    get pending() {
      return buffer;
    },
  };
}

/**
 * 从一行输出里取出 JSON 记录（允许前缀噪声）；不是 JSON 返回 null。
 * @param {string} line
 * @returns {Record<string, unknown> | null}
 */
export function parseRecord(line) {
  const start = line.indexOf('{');
  if (start < 0) return null;
  try {
    const value = JSON.parse(line.slice(start));
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 跑一次聊天预览：起 fake -> 等 /healthz -> 起 Electron -> 等面板 ready -> 收尾。
 * 只管理本次 start 的两个子进程；返回退出码而不是直接 process.exit，便于单测。
 *
 * @param {object} options
 * @param {Function} options.spawn 与 node:child_process.spawn 同形（可注入）
 * @param {(url: string) => Promise<{ ok?: boolean, status?: number, json?: () => Promise<unknown> }>} options.fetchHealth
 * @param {Record<string, string | undefined>} [options.env] 调用方环境（原样透传给两个子进程）
 * @param {{ on: Function, off?: Function }} [options.signals] 信号源（默认 process）
 * @param {(line: string) => void} [options.log] 标准输出（默认 console.log）
 * @param {(line: string) => void} [options.logError] 错误输出（默认 console.error）
 * @param {string} [options.petRoot]
 * @param {string} [options.execPath] 跑 fake 的 node（默认 process.execPath）
 * @param {NodeJS.Platform} [options.platform]
 * @param {() => string} [options.electronPath] Electron 路径解析（默认走 resolveElectronPath）
 * @param {number} [options.stopGraceMs] SIGTERM 后等多久补 SIGKILL
 * @returns {Promise<number>} 退出码：正常关窗 0；失败 1；Ctrl-C 130；SIGTERM 143
 */
export async function runDemo(options) {
  const {
    spawn,
    fetchHealth,
    env = {},
    signals = process,
    log = (line) => console.log(line),
    logError = (line) => console.error(line),
    petRoot = DEFAULT_PET_ROOT,
    execPath = process.execPath,
    platform = process.platform,
    electronPath = () => resolveElectronPath(petRoot),
    stopGraceMs = 3000,
  } = options ?? {};
  if (typeof spawn !== 'function') throw new TypeError('runDemo 需要可注入的 spawn');
  if (typeof fetchHealth !== 'function') throw new TypeError('runDemo 需要可注入的 fetchHealth');

  const record = (payload) => log(JSON.stringify(payload));
  const forward = (prefix, chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim().length > 0) log(`[${prefix}] ${line.trim()}`);
    }
  };

  /** @type {any} */
  let fakeChild = null;
  /** @type {any} */
  let electronChild = null;
  let fakeUrl = null;
  let healthOk = false;
  let panelLoaded = false;
  let electronStarted = false;
  let offlineReported = false;
  let finished = false;
  let shutdownPromise = null;
  let resolveExit = () => {};
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  const isRunning = (child) =>
    child !== null && child.exitCode === null && child.signalCode === null;

  /** 先 SIGTERM，等不到再 SIGKILL；只对本次启动仍在跑的子进程动手。 */
  function stopChild(child) {
    if (!isRunning(child)) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;
      const done = () => {
        if (timer !== null) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 已经退出。
        }
      }, stopGraceMs);
      timer.unref?.();
      child.once('exit', done);
      try {
        child.kill('SIGTERM');
      } catch {
        done();
      }
    });
  }

  async function finish(code) {
    finished = true;
    signals.off?.('SIGINT', onSigint);
    signals.off?.('SIGTERM', onSigterm);
    await stopChild(electronChild);
    await stopChild(fakeChild);
    const offlineReady = healthOk && panelLoaded;
    record({
      event: 'chat-demo-done',
      offline_ready: offlineReady,
      exit: code,
      fakeUrl,
      electronStarted,
    });
    resolveExit(code);
  }

  function shutdown(code) {
    if (shutdownPromise === null) shutdownPromise = finish(code);
    return shutdownPromise;
  }

  /** 失败路径：先报错，再收尾，最后以非零码结束（绝不在失败时报 offline_ready:true）。 */
  function fail(reason, code = 1, extra = {}) {
    if (finished) return;
    const details = extra && typeof extra === 'object' ? extra : {};
    const suffix = typeof details.message === 'string' ? `（${details.message}）` : '';
    logError(`chat-demo 失败：${reason}${suffix}`);
    record({ event: 'chat-demo-failed', reason, exit: code, ...details });
    void shutdown(code);
  }

  function markPanelLoaded() {
    if (panelLoaded || finished) return;
    panelLoaded = true;
    if (healthOk && !offlineReported) {
      offlineReported = true;
      record({ event: 'chat-demo-ready', offline_ready: true, url: fakeUrl });
    }
  }

  function handleElectronLine(line) {
    const parsed = parseRecord(line);
    if (parsed !== null && parsed.event === PANEL_LOADED_EVENT) markPanelLoaded();
    log(`[electron] ${line.trim()}`);
    if (parsed !== null && parsed.event === PAGE_FAIL_EVENT) {
      fail('page-load-failed', 1, { code: parsed.code ?? null, description: parsed.description ?? null });
    }
  }

  function startElectron() {
    if (electronStarted || finished) return;
    electronStarted = true;

    const electronArgs = [];
    if (platform === 'linux') electronArgs.push('--no-sandbox', '--disable-dev-shm-usage');
    const debugPort = parsePort(env.PET_NEXT_CHAT_DEBUG_PORT);
    if (debugPort === null && String(env.PET_NEXT_CHAT_DEBUG_PORT ?? '').trim() !== '') {
      record({ event: 'chat-demo-warn', reason: 'invalid-debug-port', value: String(env.PET_NEXT_CHAT_DEBUG_PORT) });
    }
    if (debugPort !== null) electronArgs.push(`--remote-debugging-port=${debugPort}`);
    electronArgs.push(path.join(petRoot, 'dist/electron/main.js'));

    let binary;
    try {
      binary = electronPath();
    } catch (error) {
      fail('electron-path-error', 1, { message: messageOf(error) });
      return;
    }
    if (typeof binary !== 'string' || binary.length === 0) {
      fail('electron-path-invalid', 1, { electronPath: String(binary) });
      return;
    }
    record({ event: 'chat-demo-electron-config', debugPort, electronArgs, userData: env.PET_NEXT_USER_DATA ?? null });

    try {
      electronChild = spawn(binary, electronArgs, {
        cwd: petRoot,
        // PET_NEXT_USER_DATA / PET_NEXT_CHAT_DEBUG_PORT 等其余变量原样透传。
        env: {
          ...env,
          PET_NEXT_CHAT_PREVIEW: '1',
          PET_NEXT_CHAT_FAKE_URL: fakeUrl,
          PET_NEXT_TEST: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      electronChild = null;
      fail('electron-spawn-error', 1, { message: messageOf(error) });
      return;
    }

    const lines = createLineReader(handleElectronLine);
    electronChild.stdout?.on('data', (chunk) => lines.push(chunk));
    electronChild.stderr?.on('data', (chunk) => forward('electron-stderr', chunk));
    electronChild.on('error', (error) => {
      fail('electron-spawn-error', 1, { message: messageOf(error) });
    });
    electronChild.on('exit', (code, signal) => {
      record({ event: 'electron-exit', code: code ?? null, signal: signal ?? null });
      if (finished) return;
      if (code === 0 && !signal) void shutdown(0);
      else fail('electron-exit', 1, { code: code ?? null, signal: signal ?? null });
    });
  }

  async function waitForHealth() {
    if (finished || fakeUrl === null) return;
    let response;
    try {
      response = await fetchHealth(`${fakeUrl}/healthz`);
    } catch (error) {
      fail('fake-health-failed', 1, { message: messageOf(error) });
      return;
    }
    if (finished) return;
    if (response && response.ok === false) {
      fail('fake-health-failed', 1, { status: response.status ?? null });
      return;
    }
    let body;
    try {
      body = response && typeof response.json === 'function' ? await response.json() : response;
    } catch (error) {
      fail('fake-health-failed', 1, { message: messageOf(error) });
      return;
    }
    if (finished) return;
    const status = body && typeof body === 'object' ? body.status : undefined;
    if (status !== 'offline_ready') {
      fail('fake-health-not-ready', 1, { status: status ?? null });
      return;
    }
    healthOk = true;
    record({ event: 'fake-chat-health', status: 'offline_ready', url: fakeUrl });
    // fake 真就绪后才启动 Electron。
    startElectron();
  }

  async function onFakeReady(ready) {
    if (fakeUrl !== null || finished) return;
    if (typeof ready.url !== 'string' || ready.url.length === 0) {
      fail('fake-ready-invalid', 1, { url: String(ready.url) });
      return;
    }
    fakeUrl = ready.url;
    record({ event: 'fake-chat-server-ready', port: ready.port ?? null, url: fakeUrl });
    await waitForHealth();
  }

  function startFake() {
    fakeChild = spawn(execPath, ['--experimental-strip-types', path.join(petRoot, 'adapters/chat/fake-server-main.ts')], {
      cwd: petRoot,
      env: { ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = createLineReader((line) => {
      const parsed = parseRecord(line);
      if (parsed !== null && parsed.event === 'fake-chat-server-ready') {
        void onFakeReady(parsed).catch((error) => fail('fake-ready-error', 1, { message: messageOf(error) }));
        return;
      }
      log(`[fake] ${line.trim()}`);
    });
    fakeChild.stdout?.on('data', (chunk) => lines.push(chunk));
    fakeChild.stderr?.on('data', (chunk) => forward('fake-stderr', chunk));
    fakeChild.on('error', (error) => {
      fail('fake-spawn-error', 1, { message: messageOf(error) });
    });
    fakeChild.on('exit', (code, signal) => {
      record({ event: 'fake-chat-server-exit', code: code ?? null, signal: signal ?? null });
      if (finished) return;
      fail('fake-exit', 1, { code: code ?? null, signal: signal ?? null });
    });
  }

  const onSigint = () => {
    void shutdown(130);
  };
  const onSigterm = () => {
    void shutdown(143);
  };
  signals.on('SIGINT', onSigint);
  signals.on('SIGTERM', onSigterm);

  try {
    startFake();
  } catch (error) {
    fail('fake-spawn-error', 1, { message: messageOf(error) });
  }

  const code = await exitPromise;
  signals.off?.('SIGINT', onSigint);
  signals.off?.('SIGTERM', onSigterm);
  return code;
}
