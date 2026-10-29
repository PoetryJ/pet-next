/**
 * 点播生命周期：请求身份、世代与阶段，外加适配器要执行的动作。
 *
 * 不访问 DOM、React、网络或时钟。加载、play、清理、上报由浏览器与桌面适配器执行；
 * 超时由可注入的计时器发 `failed`。必须始终成立：每个请求最多一个终态；
 * 世代或阶段不符的事件不改状态、不产生动作。
 * @module dsh-pet/src/shared/playback-lifecycle
 */
import type { ReportableStatus } from './playback.ts';

/** 阶段：`ready` 表示可以调用 play，还没兑现。 */
export type PlaybackPhase = 'idle' | 'loading' | 'ready' | 'playing' | 'ended' | 'failed' | 'cancelled' | 'disposed';

/** 素材身份：实际地址与 once。同名不同地址、once 变化都是另一次请求。 */
export interface PlaybackAsset {
  url: string;
  once: boolean;
}

/** 一次换源请求。`playbackId` 为空是自播，不上报。 */
export interface PlaybackRequest {
  playbackId: string | null;
  asset: PlaybackAsset;
}

/** 进入 failed 的原因。播放拒绝由 `playResolved` 写入，不走 `failed` 事件。 */
export type PlaybackFailureReason = 'asset-load' | 'decode-error' | 'timeout';

/** 进入 cancelled 的原因。 */
export type PlaybackCancelReason = 'superseded' | 'frozen';

/** 驱动归约的事件。异步回调必须带上自己的 generation。 */
export type PlaybackEvent =
  | { type: 'begin'; request: PlaybackRequest }
  | { type: 'loaded'; generation: number }
  | { type: 'playResolved'; generation: number; ok: boolean }
  | { type: 'failed'; generation: number; reason: PlaybackFailureReason }
  | { type: 'ended'; generation: number }
  | { type: 'cancel'; reason: PlaybackCancelReason }
  | { type: 'dispose' };

/** 适配器要执行的动作。内核自己不执行。 */
export type PlaybackEffect =
  | { type: 'load'; generation: number; request: PlaybackRequest }
  | { type: 'play'; generation: number }
  | { type: 'abort'; generation: number }
  | { type: 'pause' }
  | { type: 'cleanup' }
  | { type: 'report'; playbackId: string; status: ReportableStatus; reason?: string };

/** 当前请求与阶段。替换时只保留最新一条。 */
export interface PlaybackState {
  generation: number;
  phase: PlaybackPhase;
  request: PlaybackRequest | null;
}

/** 归约结果。无事发生时 `state` 是入参原引用。 */
export interface PlaybackReduction {
  state: PlaybackState;
  effects: readonly PlaybackEffect[];
}

/** React 换源身份：回声判定要用 seq，不能只看动画名。 */
export interface PlaybackCueIdentity {
  anim: string;
  once: boolean;
  seq: number;
  cuePlayback: string | null;
}

/** 空闲起点。每次调用返回新对象。 */
export function initialPlaybackState(): PlaybackState {
  return { generation: 0, phase: 'idle', request: null };
}

/**
 * 消费编号后的 React 回声。
 *
 * 只在编号从有值变成 null、且动画名 / once / seq 都没变时为真。
 * 真实点击、自播和 seq 变化都要继续执行。
 */
export function isPlaybackCueEcho(prev: PlaybackCueIdentity, next: PlaybackCueIdentity): boolean {
  return (
    prev.cuePlayback !== null &&
    next.cuePlayback === null &&
    prev.anim === next.anim &&
    prev.once === next.once &&
    prev.seq === next.seq
  );
}

/**
 * 把一条事件折进状态。
 *
 * @param state - 当前世代与阶段。
 * @param event - 适配器观察到的事实；迟到回调带的是当时的 generation。
 * @returns 下一状态，以及适配器必须执行的动作。不匹配的事件两者都不变。
 */
export function reducePlayback(state: PlaybackState, event: PlaybackEvent): PlaybackReduction {
  switch (event.type) {
    case 'begin':
      return begin(state, event.request);
    case 'loaded':
      return loaded(state, event.generation);
    case 'playResolved':
      return playResolved(state, event.generation, event.ok);
    case 'failed':
      return fail(state, event.generation, event.reason);
    case 'ended':
      return ended(state, event.generation);
    case 'cancel':
      return cancel(state, event.reason);
    case 'dispose':
      return dispose(state);
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

function begin(state: PlaybackState, request: PlaybackRequest): PlaybackReduction {
  if (state.phase === 'disposed') return keep(state);
  const next = copyRequest(request);
  if (state.request !== null && sameRequest(state.request, next) && isDuplicate(state.phase, next.playbackId)) {
    return keep(state);
  }
  const effects: PlaybackEffect[] = [];
  if (isInFlight(state.phase)) {
    const previousId = state.request?.playbackId ?? null;
    if (previousId !== null && previousId !== next.playbackId) {
      effects.push({ type: 'report', playbackId: previousId, status: 'cancelled', reason: 'superseded' });
    }
    effects.push({ type: 'abort', generation: state.generation });
  }
  const generation = state.generation + 1;
  effects.push({ type: 'load', generation, request: next });
  return { state: { generation, phase: 'loading', request: next }, effects };
}

function loaded(state: PlaybackState, generation: number): PlaybackReduction {
  if (generation !== state.generation || state.phase !== 'loading') return keep(state);
  return { state: { ...state, phase: 'ready' }, effects: [{ type: 'play', generation }] };
}

function playResolved(state: PlaybackState, generation: number, ok: boolean): PlaybackReduction {
  if (generation !== state.generation || state.phase !== 'ready') return keep(state);
  const playbackId = state.request?.playbackId ?? null;
  if (ok) {
    const effects: PlaybackEffect[] = [];
    if (playbackId !== null) effects.push({ type: 'report', playbackId, status: 'playing' });
    return { state: { ...state, phase: 'playing' }, effects };
  }
  return terminal(state, 'failed', playbackId, 'play-rejected', generation);
}

function fail(state: PlaybackState, generation: number, reason: PlaybackFailureReason): PlaybackReduction {
  if (generation !== state.generation) return keep(state);
  if (reason === 'timeout') {
    if (state.phase !== 'loading') return keep(state);
  } else if (!isInFlight(state.phase)) {
    return keep(state);
  }
  return terminal(state, 'failed', state.request?.playbackId ?? null, reason, generation);
}

function ended(state: PlaybackState, generation: number): PlaybackReduction {
  if (generation !== state.generation || state.phase !== 'playing') return keep(state);
  const playbackId = state.request?.playbackId ?? null;
  const effects: PlaybackEffect[] = [];
  if (playbackId !== null) effects.push({ type: 'report', playbackId, status: 'ended' });
  return { state: { ...state, phase: 'ended' }, effects };
}

function cancel(state: PlaybackState, reason: PlaybackCancelReason): PlaybackReduction {
  if (!isInFlight(state.phase)) return keep(state);
  const effects: PlaybackEffect[] = [{ type: 'abort', generation: state.generation }];
  if (reason === 'frozen') effects.push({ type: 'pause' });
  const playbackId = state.request?.playbackId ?? null;
  if (playbackId !== null) effects.push({ type: 'report', playbackId, status: 'cancelled', reason });
  return { state: { ...state, phase: 'cancelled' }, effects };
}

function dispose(state: PlaybackState): PlaybackReduction {
  if (state.phase === 'disposed') return keep(state);
  return {
    state: { ...state, phase: 'disposed' },
    effects: [{ type: 'abort', generation: state.generation }, { type: 'cleanup' }],
  };
}

function terminal(
  state: PlaybackState,
  phase: 'failed',
  playbackId: string | null,
  reason: string,
  generation: number,
): PlaybackReduction {
  const effects: PlaybackEffect[] = [{ type: 'abort', generation }];
  if (playbackId !== null) effects.push({ type: 'report', playbackId, status: 'failed', reason });
  return { state: { ...state, phase }, effects };
}

function keep(state: PlaybackState): PlaybackReduction {
  return { state, effects: [] };
}

function copyRequest(request: PlaybackRequest): PlaybackRequest {
  return { playbackId: request.playbackId, asset: { url: request.asset.url, once: request.asset.once } };
}

function sameRequest(current: PlaybackRequest, next: PlaybackRequest): boolean {
  return (
    current.playbackId === next.playbackId &&
    current.asset.url === next.asset.url &&
    current.asset.once === next.asset.once
  );
}

function isInFlight(phase: PlaybackPhase): boolean {
  return phase === 'loading' || phase === 'ready' || phase === 'playing';
}

/**
 * 同一当前请求的重复提交。
 * 有编号的请求在进行中和已落定后都不再重入；自播只在 play 兑现前去重，播完或正在播允许重播。
 */
function isDuplicate(phase: PlaybackPhase, playbackId: string | null): boolean {
  if (playbackId !== null) return isInFlight(phase) || phase === 'ended' || phase === 'failed' || phase === 'cancelled';
  return phase === 'loading' || phase === 'ready';
}
