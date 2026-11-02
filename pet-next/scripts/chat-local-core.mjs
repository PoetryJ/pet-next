/**
 * M3-1 正式入口（local 模式）编排核心：只起真实 Electron，连已存在的 Qwen 服务。
 *
 * 与 chat:preview 的区别（也是本模块的验收点）：
 * - 绝不启动 fake 服务，也不启动任何模型进程；
 * - 启动前不自动探测（避免每次真起都多打真实请求），只有 --probe 才 GET /models；
 * - 配置非法 / 预检失败一律非零退出并给出可读错误，不静默降级成演示回复。
 *
 * 复用 scripts/chat-demo-core.mjs 的 resolveElectronPath / createLineReader / parseRecord / parsePort，
 * 只在这里重写编排（无 fake），便于单测注入假 spawn / 假 env / 假 fetch。
 * @module pet-next/scripts/chat-local-core
 */
import path from 'node:path';

import { DEFAULT_PET_ROOT, createLineReader, parsePort, parseRecord, resolveElectronPath } from './chat-demo-core.mjs';

/*
 * 契约常量（contracts/chat.ts）在 .mjs 里无法导入（本入口不加 --experimental-strip-types），
 * 因此在这里镜像一份命名；chat-local-core.test.ts 会断言与 contracts/chat.ts 完全一致，防止漂移。
 */
export const LOCAL_ENV = 'PET_NEXT_CHAT_LOCAL';
export const PREVIEW_ENV = 'PET_NEXT_CHAT_PREVIEW';
export const BASE_URL_ENV = 'PET_NEXT_QWEN_BASE_URL';
export const MODEL_ENV = 'PET_NEXT_QWEN_MODEL';
export const DEFAULT_BASE_URL = 'http://127.0.0.1:18872/v1';
export const DEFAULT_MODEL = 'qwen3.8-27b';
export const PROBE_TIMEOUT_MS = 5000;

/** 面板已渲染的信号：electron/main.ts 的 ready-to-show 记录。 */
const PANEL_LOADED_EVENT = 'ready';
/** 页面加载失败信号，出现即判失败。 */
const PAGE_FAIL_EVENT = 'fail-load';

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function isLoopbackHost(hostname) {
  const host = String(hostname).toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

/** 缺失（undefined）走默认值；显式给空串按非法处理，不偷偷兜底。 */
function readOptional(env, name) {
  const raw = env[name];
  if (raw === undefined) return { given: false, text: '' };
  return { given: true, text: String(raw).trim() };
}

/** 与 electron/chat-config.ts resolveQwenConfig 同规则（parity 由单测锁定）。 */
export function resolveLocalConfig(env) {
  const base = readOptional(env, BASE_URL_ENV);
  let baseUrl = DEFAULT_BASE_URL;
  if (base.given) {
    if (base.text === '') return { ok: false, error: `${BASE_URL_ENV} 为空` };
    let url;
    try {
      url = new URL(base.text);
    } catch {
      return { ok: false, error: `${BASE_URL_ENV} 不是合法 URL：${base.text}` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: `${BASE_URL_ENV} 只支持 http/https，收到 ${url.protocol}` };
    }
    if (url.username !== '' || url.password !== '') {
      return { ok: false, error: `${BASE_URL_ENV} 不允许包含凭据` };
    }
    if (!isLoopbackHost(url.hostname)) {
      return {
        ok: false,
        error: `${BASE_URL_ENV} 必须是本机 loopback（127.0.0.1 / localhost / [::1]），收到 ${url.hostname}`,
      };
    }
    if (url.search !== '' || url.hash !== '') {
      return { ok: false, error: `${BASE_URL_ENV} 不能带查询串或片段：${base.text}` };
    }
    baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  }

  const model = readOptional(env, MODEL_ENV);
  if (!model.given) return { ok: true, config: { baseUrl, model: DEFAULT_MODEL } };
  if (model.text === '') return { ok: false, error: `${MODEL_ENV} 为空` };
  return { ok: true, config: { baseUrl, model: model.text } };
}

/** GET `${baseUrl}/models`：200 且含配置模型才算可用（与 electron/chat-config.ts 同口径）。 */
export async function probeLocalService(config, fetchImpl, timeoutMs = PROBE_TIMEOUT_MS) {
  const url = `${config.baseUrl}/models`;
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, error: `无法连接 ${config.baseUrl}：${messageOf(error)}` };
  }
  const status = response && typeof response.status === 'number' ? response.status : undefined;
  if (status !== 200) {
    return { ok: false, error: `${url} 返回 ${status === undefined ? '未知状态' : String(status)}` };
  }
  let body;
  try {
    body = typeof response.json === 'function' ? await response.json() : undefined;
  } catch (error) {
    return { ok: false, error: `${url} 响应不是合法 JSON：${messageOf(error)}` };
  }
  const data = body && typeof body === 'object' && Array.isArray(body.data) ? body.data : [];
  const models = data
    .map((item) => (item && typeof item === 'object' && typeof item.id === 'string' ? item.id : null))
    .filter((id) => id !== null && id.length > 0);
  if (!models.includes(config.model)) {
    const available = models.length > 0 ? models.join(', ') : '空';
    return { ok: false, error: `服务未提供模型 ${config.model}（可用：${available}）`, models };
  }
  return { ok: true, models };
}

/**
 * 跑一次 local 模式：解析配置 ->（可选）预检 -> 起 Electron -> 等 ready -> 收尾。
 * 只管理本次启动的 Electron；返回退出码而不是直接 process.exit，便于单测。
 *
 * @param {object} options
 * @param {Function} options.spawn 与 node:child_process.spawn 同形（可注入）
 * @param {Record<string, string | undefined>} [options.env] 调用方环境（含 QWEN_* 与 PET_NEXT_*）
 * @param {{ on: Function, off?: Function }} [options.signals] 信号源（默认 process）
 * @param {(line: string) => void} [options.log] 标准输出（默认 console.log）
 * @param {(line: string) => void} [options.logError] 错误输出（默认 console.error）
 * @param {string} [options.petRoot]
 * @param {NodeJS.Platform} [options.platform]
 * @param {() => string} [options.electronPath] Electron 路径解析（默认走 resolveElectronPath）
 * @param {number} [options.stopGraceMs] SIGTERM 后等多久补 SIGKILL
 * @param {boolean} [options.probe] true 时启动前 GET /models 并打印结果
 * @param {(config: { baseUrl: string, model: string }, fetchImpl: Function) => Promise<object>} [options.probeService]
 * @param {Function} [options.fetchImpl] 预检用的 fetch（probe 为 true 时必填）
 * @returns {Promise<number>} 退出码：正常关窗 0；失败 1；Ctrl-C 130；SIGTERM 143
 */
export async function runLocal(options) {
  const {
    spawn,
    env = {},
    signals = process,
    log = (line) => console.log(line),
    logError = (line) => console.error(line),
    petRoot = DEFAULT_PET_ROOT,
    platform = process.platform,
    electronPath = () => resolveElectronPath(petRoot),
    stopGraceMs = 3000,
    probe = false,
    probeService = probeLocalService,
    fetchImpl,
  } = options ?? {};
  if (typeof spawn !== 'function') throw new TypeError('runLocal 需要可注入的 spawn');

  const record = (payload) => log(JSON.stringify(payload));
  const forward = (prefix, chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim().length > 0) log(`[${prefix}] ${line.trim()}`);
    }
  };

  /** @type {any} */
  let child = null;
  let finished = false;
  let shutdownPromise = null;
  let readyReported = false;
  let resolveExit = () => {};
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  const isRunning = (target) => target !== null && target.exitCode === null && target.signalCode === null;

  /** 先 SIGTERM，等不到再 SIGKILL；只对本次启动仍在跑的子进程动手。 */
  function stopChild(target) {
    if (!isRunning(target)) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;
      const done = () => {
        if (timer !== null) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        try {
          target.kill('SIGKILL');
        } catch {
          // 已经退出。
        }
      }, stopGraceMs);
      timer.unref?.();
      target.once('exit', done);
      try {
        target.kill('SIGTERM');
      } catch {
        done();
      }
    });
  }

  async function finish(code) {
    finished = true;
    signals.off?.('SIGINT', onSigint);
    signals.off?.('SIGTERM', onSigterm);
    await stopChild(child);
    record({ event: 'chat-local-done', mode: 'local', exit: code });
    resolveExit(code);
  }

  function shutdown(code) {
    if (shutdownPromise === null) shutdownPromise = finish(code);
    return shutdownPromise;
  }

  function fail(reason, code = 1, extra = {}) {
    if (finished) return;
    const details = extra && typeof extra === 'object' ? extra : {};
    const suffix = typeof details.message === 'string' ? `（${details.message}）` : '';
    logError(`chat-local 失败：${reason}${suffix}`);
    record({ event: 'chat-local-failed', reason, exit: code, ...details });
    void shutdown(code);
  }

  function onSigint() {
    void shutdown(130);
  }

  function onSigterm() {
    void shutdown(143);
  }

  function markReady(config) {
    if (readyReported || finished) return;
    readyReported = true;
    record({ event: 'chat-local-ready', mode: 'local', baseUrl: config.baseUrl, model: config.model });
  }

  // 1) 配置解析：非法直接非零退出，不起 Electron。
  const configResult = resolveLocalConfig(env);
  if (!configResult.ok) {
    logError(`chat-local 失败：配置无效（${configResult.error}）`);
    record({ event: 'chat-local-failed', reason: 'config-invalid', exit: 1, error: configResult.error });
    return 1;
  }
  const config = configResult.config;
  record({ event: 'chat-local-config', mode: 'local', baseUrl: config.baseUrl, model: config.model });

  // 2) 可选预检：默认不探测，避免每次真起都多打一次真实请求。
  if (probe) {
    if (typeof fetchImpl !== 'function') throw new TypeError('--probe 需要注入 fetchImpl');
    let probed;
    try {
      probed = await probeService(config, fetchImpl);
    } catch (error) {
      probed = { ok: false, error: messageOf(error) };
    }
    if (!probed || probed.ok !== true) {
      const error = probed && typeof probed.error === 'string' ? probed.error : '未知错误';
      logError(`chat-local 预检失败：${error}`);
      record({
        event: 'chat-local-probe',
        ok: false,
        baseUrl: config.baseUrl,
        model: config.model,
        error,
        models: (probed && probed.models) ?? null,
      });
      record({ event: 'chat-local-failed', reason: 'probe-failed', exit: 1, error });
      return 1;
    }
    record({
      event: 'chat-local-probe',
      ok: true,
      baseUrl: config.baseUrl,
      model: config.model,
      models: Array.isArray(probed.models) ? probed.models : [],
    });
  }

  // 3) 起 Electron（只有这一个子进程，无 fake、无模型进程）。
  const electronArgs = [];
  if (platform === 'linux') electronArgs.push('--no-sandbox', '--disable-dev-shm-usage');
  const debugPort = parsePort(env.PET_NEXT_CHAT_DEBUG_PORT);
  if (debugPort === null && String(env.PET_NEXT_CHAT_DEBUG_PORT ?? '').trim() !== '') {
    record({ event: 'chat-local-warn', reason: 'invalid-debug-port', value: String(env.PET_NEXT_CHAT_DEBUG_PORT) });
  }
  if (debugPort !== null) electronArgs.push(`--remote-debugging-port=${debugPort}`);
  electronArgs.push(path.join(petRoot, 'dist/electron/main.js'));

  let binary;
  try {
    binary = electronPath();
  } catch (error) {
    fail('electron-path-error', 1, { message: messageOf(error) });
    return await exitPromise;
  }
  if (typeof binary !== 'string' || binary.length === 0) {
    fail('electron-path-invalid', 1, { electronPath: String(binary) });
    return await exitPromise;
  }

  if (String(env[PREVIEW_ENV] ?? '').trim() !== '') {
    record({ event: 'chat-local-warn', reason: 'preview-env-ignored', env: PREVIEW_ENV });
  }
  record({
    event: 'chat-local-electron-config',
    debugPort,
    electronArgs,
    userData: env.PET_NEXT_USER_DATA ?? null,
  });

  signals.on('SIGINT', onSigint);
  signals.on('SIGTERM', onSigterm);

  try {
    child = spawn(binary, electronArgs, {
      cwd: petRoot,
      // local 开关与最终生效的配置显式下发（页面依然拿不到地址与凭据）；PET_NEXT_USER_DATA /
      // PET_NEXT_CHAT_DEBUG_PORT 等其余变量原样透传。
      env: {
        ...env,
        [LOCAL_ENV]: '1',
        [BASE_URL_ENV]: config.baseUrl,
        [MODEL_ENV]: config.model,
        PET_NEXT_TEST: env.PET_NEXT_TEST ?? '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    child = null;
    fail('electron-spawn-error', 1, { message: messageOf(error) });
    return await exitPromise;
  }

  const lines = createLineReader((line) => {
    const parsed = parseRecord(line);
    if (parsed !== null && parsed.event === PANEL_LOADED_EVENT) markReady(config);
    if (parsed !== null && parsed.event === PAGE_FAIL_EVENT) {
      fail('page-load-failed', 1, { code: parsed.code ?? null, description: parsed.description ?? null });
    }
    log(`[electron] ${line.trim()}`);
  });
  child.stdout?.on('data', (chunk) => lines.push(chunk));
  child.stderr?.on('data', (chunk) => forward('electron-stderr', chunk));
  child.on('error', (error) => {
    fail('electron-spawn-error', 1, { message: messageOf(error) });
  });
  child.on('exit', (code, signal) => {
    record({ event: 'electron-exit', code: code ?? null, signal: signal ?? null });
    if (finished) return;
    if (code === 0 && !signal) void shutdown(0);
    else fail('electron-exit', 1, { code: code ?? null, signal: signal ?? null });
  });

  const exitCode = await exitPromise;
  signals.off?.('SIGINT', onSigint);
  signals.off?.('SIGTERM', onSigterm);
  return exitCode;
}
