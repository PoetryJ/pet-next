/**
 * M3-7 B：launcher 控制器（状态机 + 资源归属；core 层自包含，IO/隧道/探测全部注入）。
 *
 * 硬约束（TASKS M3-7 B）：
 * - 探测只走既有 /v1/models GET（零 POST），绝不触发模型推理；
 * - 探测/启动共用一个操作槽：进行中再次调用直接 busy，不排队、不并发两套资源；
 * - 探测成功/失败/取消都必须收掉本次隧道；
 * - start 成功保留本次隧道到 stop()；stop 幂等，未运行时也 resolve。
 * @module pet-next/core/launcher/controller
 */
import type {
  LauncherConfig,
  LauncherConfigValidator,
  LauncherController,
  LauncherError,
  LauncherProbeResult,
  LauncherStartOptions,
  LauncherStartResult,
  LauncherTunnelResolver,
  LauncherTunnelSpec,
} from './types.ts';
import { type LauncherConfigIo, loadLauncherConfig, saveLauncherConfig } from './config.ts';

/** 隧道句柄最小形状（真实实现见 contracts/connection.ts 的 TunnelHandle，结构兼容）。 */
export interface LauncherTunnelHandle {
  readonly localBaseUrl: string;
  stop(): Promise<void>;
  isAlive(): boolean;
}

/** 隧道启动注入：真实实现为 adapters/connection/tunnel.ts 的 startTunnel。 */
export type LauncherStartTunnel = (
  spec: LauncherTunnelSpec,
  deps: { signal: AbortSignal; fetchImpl?: typeof fetch },
) => Promise<
  | { ok: true; handle: LauncherTunnelHandle }
  | { ok: false; error: { code: LauncherError['code']; message: string } }
>;

/** 探测注入：与 scripts/chat-local-core.mjs 的 probeLocalService 同形状（GET /models）。 */
export type LauncherProbeService = (
  config: { baseUrl: string; model: string },
  fetchImpl: typeof fetch,
) => Promise<{ ok: boolean; error?: string; models?: string[] }>;

export interface LauncherControllerDeps {
  configFile: string;
  configIo: LauncherConfigIo;
  validate: LauncherConfigValidator;
  resolveTunnel: LauncherTunnelResolver;
  startTunnel: LauncherStartTunnel;
  probeService: LauncherProbeService;
  /** 必填（避免 core 层引用运行时全局；真实实现由 adapters 传 globalThis.fetch）。 */
  fetchImpl: typeof fetch;
  defaultModel?: string;
}

type Opened =
  | { ok: true; baseUrl: string; model: string; handle: LauncherTunnelHandle; models: string[] }
  | { ok: false; error: LauncherError };

function busyError(): LauncherError {
  return { code: 'busy', message: '已有一次测试连接或启动正在进行，请等待完成后再试' };
}

export function createLauncherController(deps: LauncherControllerDeps): LauncherController {
  let phase: 'idle' | 'probing' | 'starting' | 'running' = 'idle';
  let tunnel: LauncherTunnelHandle | null = null;
  let abort: AbortController | null = null;
  let currentOp: Promise<unknown> | null = null;

  const defaultModel = (): string => deps.defaultModel ?? 'qwen3.8-27b';

  /**
   * 打开隧道并做一次零 POST 探测。
   * 失败路径（含探测失败、取消）都在这里收掉本次隧道；成功路径把句柄交给调用方决定保留或立即关闭。
   */
  async function openTunnel(config: LauncherConfig, model: string, signal: AbortSignal): Promise<Opened> {
    const normalized = deps.validate(config);
    if (!normalized.ok) return normalized;
    const resolved = deps.resolveTunnel(normalized.config);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const started = await deps.startTunnel(resolved.spec, {
      signal,
      fetchImpl: deps.fetchImpl,
    });
    if (!started.ok) return { ok: false, error: { code: started.error.code, message: started.error.message } };

    const { handle } = started;
    const baseUrl = `${handle.localBaseUrl}/v1`;
    const probed = await deps.probeService({ baseUrl, model }, deps.fetchImpl);
    if (!probed.ok) {
      await handle.stop();
      return {
        ok: false,
        error: { code: 'service-unavailable', message: probed.error ?? `服务未提供模型 ${model}` },
      };
    }
    return { ok: true, baseUrl, model, handle, models: probed.models ?? [] };
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    currentOp = promise.then(
      () => undefined,
      () => undefined,
    );
    return promise;
  }

  return {
    loadConfig() {
      return loadLauncherConfig(deps.configIo, deps.configFile, deps.validate);
    },

    saveConfig(config) {
      return saveLauncherConfig(deps.configIo, deps.configFile, config, deps.validate);
    },

    async probe(config, model): Promise<LauncherProbeResult> {
      if (phase !== 'idle') return { ok: false, error: busyError() };
      phase = 'probing';
      const controller = new AbortController();
      abort = controller;
      const chosen = model ?? defaultModel();
      const op = (async (): Promise<LauncherProbeResult> => {
        try {
          const opened = await openTunnel(config, chosen, controller.signal);
          if (!opened.ok) return opened;
          // 探测语义：成功也收隧道（只证明"能连通"）。
          await opened.handle.stop();
          return { ok: true, model: chosen, models: opened.models };
        } finally {
          abort = null;
          if (phase === 'probing') phase = 'idle';
        }
      })();
      return track(op);
    },

    async start(config, options): Promise<LauncherStartResult> {
      if (phase !== 'idle') return { ok: false, error: busyError() };
      phase = 'starting';
      const controller = new AbortController();
      abort = controller;
      const model = options.model ?? defaultModel();
      const op = (async (): Promise<LauncherStartResult> => {
        try {
          const opened = await openTunnel(config, model, controller.signal);
          if (!opened.ok) return opened;
          tunnel = opened.handle;
          phase = 'running';
          const resolvedOptions: Required<LauncherStartOptions> = {
            experience: options.experience,
            chatContext: options.chatContext,
            model,
          };
          return { ok: true, baseUrl: opened.baseUrl, model, options: resolvedOptions };
        } finally {
          abort = null;
          if (phase === 'starting') phase = 'idle';
        }
      })();
      return track(op);
    },

    async stop(): Promise<void> {
      abort?.abort();
      const closing = tunnel;
      tunnel = null;
      if (closing) await closing.stop();
      const op = currentOp;
      if (op) await op;
      if (phase === 'running') phase = 'idle';
    },

    state(): { phase: 'idle' | 'probing' | 'starting' | 'running' } {
      return { phase };
    },
  };
}
