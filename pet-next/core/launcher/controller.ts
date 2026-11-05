/**
 * M3-7 B：launcher 控制器（状态机 + 资源归属；core 层自包含，IO/隧道/探测全部注入）。
 *
 * 硬约束（TASKS M3-7 B / R1 A）：
 * - 探测只走既有 /v1/models GET（零 POST），绝不触发模型推理；
 * - 探测/启动共用一个操作槽：进行中再次调用直接 busy，不排队、不并发两套资源；
 * - 每次 probe/start 建一个操作对象，独占 AbortController、句柄、结算与幂等 close；
 * - 取得隧道立即登记；同一取消信号贯穿 /models 探测；
 * - 每个 await 之后复核取消/操作身份/句柄存活；取消后绝不返回 ok，也不把句柄交给 start；
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

/**
 * 探测注入：与 scripts/chat-local-core.mjs 的 probeLocalService 同形状（GET /models）。
 * signal 为本次操作的取消信号，真实实现应把它合并进 fetch（保留自身超时）。
 */
export type LauncherProbeService = (
  config: { baseUrl: string; model: string },
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
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

/**
 * 单次 probe/start 的操作对象：本次操作独占的资源与取消语义。
 * - handle：取得的隧道句柄，取得即登记（含取消后晚交付的句柄）；
 * - closePromise：对该句柄的幂等关闭，多次 close 返回同一 Promise；
 * - cancelled：stop() 打的取消位（不依赖底层传输是否配合 abort）；
 * - completion：本次操作结算（永远 resolve，便于 stop 等待而不抛）。
 */
interface LauncherOperation {
  readonly controller: AbortController;
  handle: LauncherTunnelHandle | null;
  closePromise: Promise<void> | null;
  cancelled: boolean;
  completion: Promise<void>;
}

const CANCELLED_MESSAGE = '已取消本次连接操作，隧道未交付';

function busyError(): LauncherError {
  return { code: 'busy', message: '已有一次测试连接或启动正在进行，请等待完成后再试' };
}

function cancelledError(): LauncherError {
  return { code: 'cancelled', message: CANCELLED_MESSAGE };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 关闭句柄：立即发起，异常不外泄（关闭失败不阻塞后续收尾）。 */
function closeHandle(handle: LauncherTunnelHandle): Promise<void> {
  try {
    return Promise.resolve(handle.stop()).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

export function createLauncherController(deps: LauncherControllerDeps): LauncherController {
  let phase: 'idle' | 'probing' | 'starting' | 'running' = 'idle';
  let tunnel: LauncherTunnelHandle | null = null;
  let parkedClose: Promise<void> | null = null;
  let activeOp: LauncherOperation | null = null;

  const defaultModel = (): string => deps.defaultModel ?? 'qwen3.8-27b';

  /** 建操作对象并占住操作槽（同步完成，stop 立刻能看到本次操作）。 */
  function beginOperation(): LauncherOperation {
    const op: LauncherOperation = {
      controller: new AbortController(),
      handle: null,
      closePromise: null,
      cancelled: false,
      completion: Promise.resolve(),
    };
    activeOp = op;
    return op;
  }

  /**
   * 取得隧道立即登记：登记发生在拿到句柄后的第一条语句上。
   * 若此刻本操作已被取消（stop 先到、句柄后交付），立刻关闭，绝不交给调用方。
   */
  function adopt(op: LauncherOperation, handle: LauncherTunnelHandle): void {
    op.handle = handle;
    op.closePromise = null;
    if (op.cancelled || op.controller.signal.aborted) {
      op.closePromise = closeHandle(handle);
    }
  }

  /** 幂等关闭本操作的句柄：同一句柄多次调用返回同一 Promise、只 stop 一次。 */
  function closeOperationHandle(op: LauncherOperation): Promise<void> {
    const handle = op.handle;
    if (!handle) return Promise.resolve();
    if (!op.closePromise) op.closePromise = closeHandle(handle);
    return op.closePromise;
  }

  /** 每个 await 之后的复核：本操作已取消 / 已被顶替 → cancelled。 */
  function cancellationOf(op: LauncherOperation): LauncherError | null {
    if (op.cancelled || op.controller.signal.aborted || activeOp !== op) return cancelledError();
    return null;
  }

  /**
   * 打开隧道并做一次零 POST 探测。
   * 失败路径（含探测失败、取消、异常）都在这里收掉本次隧道；成功路径把句柄交给调用方决定保留或立即关闭。
   */
  async function openTunnel(config: LauncherConfig, model: string, op: LauncherOperation): Promise<Opened> {
    const normalized = deps.validate(config);
    if (!normalized.ok) return normalized;
    const resolved = deps.resolveTunnel(normalized.config);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const signal = op.controller.signal;
    let started: Awaited<ReturnType<LauncherStartTunnel>>;
    try {
      started = await deps.startTunnel(resolved.spec, { signal, fetchImpl: deps.fetchImpl });
    } catch (error) {
      const cancelled = cancellationOf(op);
      await closeOperationHandle(op);
      return {
        ok: false,
        error: cancelled ?? { code: 'disconnected', message: `隧道启动失败：${messageOf(error)}` },
      };
    }

    if (started.ok) adopt(op, started.handle);

    const cancelledAfterStart = cancellationOf(op);
    if (cancelledAfterStart) {
      await closeOperationHandle(op);
      return { ok: false, error: cancelledAfterStart };
    }
    if (!started.ok) {
      return { ok: false, error: { code: started.error.code, message: started.error.message } };
    }

    const { handle } = started;
    const baseUrl = `${handle.localBaseUrl}/v1`;

    let probed: { ok: boolean; error?: string; models?: string[] };
    try {
      probed = await deps.probeService({ baseUrl, model }, deps.fetchImpl, signal);
    } catch (error) {
      const cancelled = cancellationOf(op);
      await closeOperationHandle(op);
      return {
        ok: false,
        error: cancelled ?? { code: 'service-unavailable', message: `探测 ${baseUrl}/models 失败：${messageOf(error)}` },
      };
    }

    const cancelledAfterProbe = cancellationOf(op);
    if (cancelledAfterProbe) {
      await closeOperationHandle(op);
      return { ok: false, error: cancelledAfterProbe };
    }
    if (!handle.isAlive()) {
      await closeOperationHandle(op);
      return { ok: false, error: { code: 'not-ready', message: '隧道在探测期间已断开，请重试' } };
    }
    if (!probed.ok) {
      await closeOperationHandle(op);
      return {
        ok: false,
        error: { code: 'service-unavailable', message: probed.error ?? `服务未提供模型 ${model}` },
      };
    }
    return { ok: true, baseUrl, model, handle, models: probed.models ?? [] };
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
      const op = beginOperation();
      const chosen = model ?? defaultModel();
      const body = (async (): Promise<LauncherProbeResult> => {
        try {
          const opened = await openTunnel(config, chosen, op);
          if (!opened.ok) return opened;
          // 探测语义：连通即成功，成功也收隧道（只证明"能连通"）。
          await closeOperationHandle(op);
          const cancelled = cancellationOf(op);
          if (cancelled) return { ok: false, error: cancelled };
          return { ok: true, model: chosen, models: opened.models };
        } finally {
          if (activeOp === op) activeOp = null;
          if (phase === 'probing') phase = 'idle';
        }
      })();
      op.completion = body.then(
        () => undefined,
        () => undefined,
      );
      return body;
    },

    async start(config, options): Promise<LauncherStartResult> {
      if (phase !== 'idle') return { ok: false, error: busyError() };
      phase = 'starting';
      const op = beginOperation();
      const model = options.model ?? defaultModel();
      const body = (async (): Promise<LauncherStartResult> => {
        try {
          const opened = await openTunnel(config, model, op);
          if (!opened.ok) return opened;
          // 探测通过到交付之间也可能被 stop：取消后绝不返回 ok、绝不交出句柄。
          const cancelled = cancellationOf(op);
          if (cancelled) {
            await closeOperationHandle(op);
            return { ok: false, error: cancelled };
          }
          tunnel = opened.handle;
          parkedClose = null;
          phase = 'running';
          const resolvedOptions: Required<LauncherStartOptions> = {
            experience: options.experience,
            chatContext: options.chatContext,
            model,
          };
          return { ok: true, baseUrl: opened.baseUrl, model, options: resolvedOptions };
        } finally {
          if (activeOp === op) activeOp = null;
          if (phase === 'starting') phase = 'idle';
        }
      })();
      op.completion = body.then(
        () => undefined,
        () => undefined,
      );
      return body;
    },

    async stop(): Promise<void> {
      const op = activeOp;
      if (op) {
        // 先打取消位并 abort（不依赖底层是否响应 abort），再立即关已取得的句柄。
        op.cancelled = true;
        op.controller.abort();
        await closeOperationHandle(op);
        // 等操作结算：之后才是"晚交付句柄"的兜底关闭。
        await op.completion;
        await closeOperationHandle(op);
      }
      const parked = tunnel;
      tunnel = null;
      if (parked) parkedClose = closeHandle(parked);
      if (parkedClose) await parkedClose;
      if (activeOp === null) phase = 'idle';
    },

    state(): { phase: 'idle' | 'probing' | 'starting' | 'running' } {
      return { phase };
    },
  };
}
