/**
 * M3-2 chat:remote 编排核心：建本次 SSH 隧道 -> 校验模型服务 -> 复用 chat-local 真实模式 -> 统一收尾。
 * 原理：Windows 的 127.0.0.1 是 Windows 自己，必须把服务器 127.0.0.1:18872 经 SSH 转发到本机；
 * 只管理本次 ssh 与本次 Electron，隧道失败/中断明确报错，不静默转 fake、不做无限重试。
 * 全部 IO 可注入，便于单测（不建真实隧道、不起 Electron）。
 * @module pet-next/scripts/chat-remote-core
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { startTunnel as realStartTunnel, resolveTunnelConfig } from '../adapters/connection/tunnel.ts';
import { probeLocalService, runLocal } from './chat-local-core.mjs';

export const REMOTE_ENV = {
  local: 'PET_NEXT_CHAT_LOCAL',
  baseUrl: 'PET_NEXT_QWEN_BASE_URL',
  model: 'PET_NEXT_QWEN_MODEL',
  transport: 'PET_NEXT_CHAT_TRANSPORT',
};

export const DEFAULT_REMOTE_MODEL = 'qwen3.8-27b';

/** 事件名（NDJSON 输出，供验收脚本解析）。 */
export const REMOTE_EVENTS = {
  config: 'chat-remote-config',
  tunnel: 'chat-remote-tunnel',
  probe: 'chat-remote-probe',
  electronConfig: 'chat-remote-electron-config',
  ready: 'chat-remote-ready',
  done: 'chat-remote-done',
  failed: 'chat-remote-failed',
  tunnelLost: 'chat-remote-tunnel-lost',
  cancelled: 'chat-remote-cancelled',
};

/** 与 package.json engines 对齐：--experimental-strip-types 需要 Node 22.12+。 */
export const MIN_NODE = { major: 22, minor: 12 };

/** 预检：Node 版本、构建产物；缺什么给可读中文错误。ssh 是否存在由隧道层分类（ssh-missing）。 */
export function precheckRemote({ petRoot, electronExists = null, nodeVersion = process.versions.node } = {}) {
  const problems = [];
  const [majorText, minorText] = String(nodeVersion).split('.');
  const major = Number(majorText);
  const minor = Number(minorText ?? 0);
  const tooLow =
    !Number.isInteger(major) ||
    !Number.isInteger(minor) ||
    major < MIN_NODE.major ||
    (major === MIN_NODE.major && minor < MIN_NODE.minor);
  if (tooLow) {
    problems.push(`Node 版本过低（${nodeVersion}），需要 ${MIN_NODE.major}.${MIN_NODE.minor}+（--experimental-strip-types）`);
  }
  const hasElectron =
    typeof electronExists === 'function'
      ? electronExists()
      : petRoot
        ? existsSync(path.join(petRoot, 'dist/electron/main.js'))
        : false;
  if (!hasElectron) problems.push('缺少构建产物 dist/electron/main.js：请先执行 pnpm build');
  return { ok: problems.length === 0, problems };
}

/**
 * 运行 chat:remote。返回退出码（不直接 process.exit，便于单测）。
 * @param {object} options
 * @returns {Promise<number>}
 */
export async function runRemote(options = {}) {
  const {
    spawn,
    startTunnelFn = realStartTunnel,
    fetchImpl = globalThis.fetch,
    env = process.env,
    signals = process,
    log = (line) => console.log(line),
    logError = (line) => console.error(line),
    petRoot = process.cwd(),
    platform = process.platform,
    sshBin = 'ssh',
    sshArgsPrefix = [],
    fileConfig = {},
    model = env[REMOTE_ENV.model] ?? DEFAULT_REMOTE_MODEL,
    probeService = probeLocalService,
    localRunner = runLocal,
    monitorIntervalMs = 500,
    electronExists = null,
    nodeVersion = process.versions.node,
  } = options;
  if (typeof spawn !== 'function') throw new TypeError('runRemote 需要可注入的 spawn');

  const record = (payload) => log(JSON.stringify(payload));
  let tunnel = null;
  let tunnelLost = false;
  let electronChild = null;
  let exitCode = 0;
  /** 'starting' 覆盖预检/建隧道/探测；'running' 后由 runLocal 自己处理信号；'done' 已收尾。 */
  let phase = 'starting';
  let cancelCode = 0;
  const abortController = new AbortController();
  const onSignal = (code) => {
    if (phase !== 'starting') return; // 运行期信号交给 runLocal（它自己会收窗口并返回 130/143）。
    if (cancelCode !== 0) return;
    cancelCode = code;
    abortController.abort();
  };
  const onSigint = () => onSignal(130);
  const onSigterm = () => onSignal(143);
  // 信号从第一个异步操作之前就注册：隧道/探测阶段的 Ctrl-C 也必须收尾，不得继续起 Electron。
  signals.on?.('SIGINT', onSigint);
  signals.on?.('SIGTERM', onSigterm);

  try {
    // 1) 预检
    const pre = precheckRemote({ petRoot, electronExists, nodeVersion });
    if (!pre.ok) {
      for (const problem of pre.problems) logError(`chat-remote 失败：${problem}`);
      record({ event: REMOTE_EVENTS.failed, reason: 'precheck-failed', problems: pre.problems, exit: 1 });
      exitCode = 1;
      return exitCode;
    }

    // 2) 配置
    const configResult = resolveTunnelConfig(env, fileConfig);
    if (!configResult.ok) {
      const { code, message } = configResult.error;
      logError(`chat-remote 失败：配置无效（${message}）`);
      record({ event: REMOTE_EVENTS.failed, reason: code, error: message, exit: 1 });
      exitCode = 1;
      return exitCode;
    }
    const tunnelConfig = configResult.config;
    record({
      event: REMOTE_EVENTS.config,
      host: tunnelConfig.host,
      port: tunnelConfig.port,
      user: tunnelConfig.user,
      localPort: tunnelConfig.localPort,
      remoteHost: tunnelConfig.remoteHost,
      remotePort: tunnelConfig.remotePort,
      model,
    });

    if (cancelCode !== 0) {
      record({ event: REMOTE_EVENTS.cancelled, code: cancelCode, stage: 'pre-tunnel' });
      logError('chat-remote 已取消：未建立隧道');
      exitCode = cancelCode;
      return exitCode;
    }

    // 3) 建隧道（只管理本次进程）。隧道层约定 spawn 接收"一个参数数组"；这里把 Node spawn 包成该形状。
    const tunnelChildSpawn = (tunnelArgs) => {
      if (tunnelArgs.length === 0) throw new Error('隧道启动参数为空');
      return spawn(tunnelArgs[0], tunnelArgs.slice(1));
    };
    const started = await startTunnelFn(tunnelConfig, {
      spawn: tunnelChildSpawn,
      sshBin,
      argsPrefix: sshArgsPrefix,
      fetchImpl,
      signal: abortController.signal,
    });
    if (!started.ok) {
      const { code, message } = started.error;
      if (code === 'cancelled') {
        record({ event: REMOTE_EVENTS.cancelled, code: cancelCode || 130, stage: 'tunnel' });
        logError('chat-remote 已取消：启动阶段中断，本次隧道已关闭');
        exitCode = cancelCode || 130;
        return exitCode;
      }
      logError(`chat-remote 失败：${message}`);
      record({ event: REMOTE_EVENTS.failed, reason: code, error: message, exit: 1 });
      exitCode = 1;
      return exitCode;
    }
    // 先接管本次隧道句柄再判取消：取消发生在隧道路由之后时，也必须由 finally 关闭它。
    tunnel = started.handle;
    if (cancelCode !== 0) {
      record({ event: REMOTE_EVENTS.cancelled, code: cancelCode, stage: 'tunnel' });
      logError('chat-remote 已取消：启动阶段中断，本次隧道已关闭');
      exitCode = cancelCode;
      return exitCode;
    }
    const baseUrl = `${tunnel.localBaseUrl}/v1`;
    record({ event: REMOTE_EVENTS.tunnel, ok: true, baseUrl });

    // 4) 校验转发端模型服务（不推理，只 GET /models）
    const probed = await probeService({ baseUrl, model }, fetchImpl);
    if (cancelCode !== 0) {
      record({ event: REMOTE_EVENTS.cancelled, code: cancelCode, stage: 'probe' });
      logError('chat-remote 已取消：模型探测阶段中断，不启动聊天窗口');
      exitCode = cancelCode;
      return exitCode;
    }
    if (!probed || probed.ok !== true) {
      const error = (probed && probed.error) || '未知错误';
      logError(`chat-remote 失败：转发端模型服务不可用（${error}）`);
      record({ event: REMOTE_EVENTS.failed, reason: 'probe-failed', baseUrl, error, exit: 1 });
      exitCode = 1;
      return exitCode;
    }
    record({ event: REMOTE_EVENTS.probe, ok: true, baseUrl, models: probed.models ?? [] });
    // 链路就绪（隧道 + 转发端模型均可用）；面板可用性由 Electron 侧 ready/local-ready 记录。
    record({ event: REMOTE_EVENTS.ready, mode: 'local', baseUrl, model, transport: 'tunnel' });

    // 5) 复用 chat-local 真实模式起 Electron（不启动 fake、不启动模型）
    record({
      event: REMOTE_EVENTS.electronConfig,
      baseUrl,
      model,
      transport: 'tunnel',
      userData: env.PET_NEXT_USER_DATA ?? null,
    });
    const monitor = setInterval(() => {
      if (tunnel !== null && tunnel.isAlive() === false && tunnelLost === false) {
        tunnelLost = true;
        record({ event: REMOTE_EVENTS.tunnelLost, exit: 1 });
        logError('chat-remote 失败：SSH 隧道已断开，关闭聊天窗口；请检查网络后重试');
        try {
          electronChild?.kill('SIGTERM');
        } catch {
          /* 已退出 */
        }
      }
    }, monitorIntervalMs);
    monitor.unref?.();

    phase = 'running';
    try {
      exitCode = await localRunner({
        spawn,
        env: {
          ...env,
          [REMOTE_ENV.baseUrl]: baseUrl,
          [REMOTE_ENV.model]: model,
          [REMOTE_ENV.transport]: 'tunnel',
          [REMOTE_ENV.local]: '1',
        },
        signals,
        log,
        logError,
        petRoot,
        platform,
        onChild: (child) => {
          electronChild = child;
        },
      });
    } finally {
      clearInterval(monitor);
    }
    if (tunnelLost) exitCode = 1;
    if (cancelCode !== 0 && exitCode === 0) exitCode = cancelCode;
    return exitCode;
  } finally {
    phase = 'done';
    signals.off?.('SIGINT', onSigint);
    signals.off?.('SIGTERM', onSigterm);
    if (tunnel !== null) {
      await tunnel.stop();
      // done 的 exit 必须与真实退出码一致（此前 probe-failed 返回 1 但 done 写 0）。
      record({ event: REMOTE_EVENTS.done, exit: exitCode });
    }
  }
}
