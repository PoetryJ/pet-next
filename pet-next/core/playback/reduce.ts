/**
 * 点播生命周期：请求身份、世代与阶段，外加适配器要执行的动作。
 *
 * 不访问 DOM、Electron、文件系统、网络或时钟。加载、play、清理由适配器执行；
 * 超时由可注入的计时器发 `failed`。必须始终成立：每个请求最多一个终态；
 * 世代或阶段不符的事件不改状态、不产生动作。
 * @module pet-next/core/playback/reduce
 */
import type {
  PlaybackCancelReason,
  PlaybackCueIdentity,
  PlaybackEffect,
  PlaybackEvent,
  PlaybackFailureReason,
  PlaybackPhase,
  PlaybackReduction,
  PlaybackRequest,
  PlaybackState,
} from './types.ts';

/** 空闲起点。每次调用返回新对象。 */
export function initialPlaybackState(): PlaybackState {
  return { generation: 0, phase: 'idle', request: null };
}

/**
 * 消费编号后的回声。
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
  return terminal(state, playbackId, 'play-rejected', generation);
}

function fail(state: PlaybackState, generation: number, reason: PlaybackFailureReason): PlaybackReduction {
  if (generation !== state.generation) return keep(state);
  if (reason === 'timeout') {
    if (state.phase !== 'loading') return keep(state);
  } else if (!isInFlight(state.phase)) {
    return keep(state);
  }
  return terminal(state, state.request?.playbackId ?? null, reason, generation);
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
  playbackId: string | null,
  reason: string,
  generation: number,
): PlaybackReduction {
  const effects: PlaybackEffect[] = [{ type: 'abort', generation }];
  if (playbackId !== null) effects.push({ type: 'report', playbackId, status: 'failed', reason });
  return { state: { ...state, phase: 'failed' }, effects };
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
