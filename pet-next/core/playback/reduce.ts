/**
 * 点播生命周期归约。不访问 DOM、Electron、文件系统、网络或时钟。
 * @module pet-next/core/playback/reduce
 */
import type { PlaybackCueIdentity, PlaybackEvent, PlaybackReduction, PlaybackState } from './types.ts';

/** 空闲起点。每次调用返回新对象。 */
export function initialPlaybackState(): PlaybackState {
  throw new Error('not implemented');
}

/**
 * 把一条事件折进状态。
 *
 * @param state - 当前世代与阶段。
 * @param event - 适配器观察到的事实；迟到回调带的是当时的 generation。
 * @returns 下一状态，以及适配器必须执行的动作。不匹配的事件两者都不变。
 */
export function reducePlayback(_state: PlaybackState, _event: PlaybackEvent): PlaybackReduction {
  throw new Error('not implemented');
}

/**
 * 编号从有值变成 null，且动画名、once、seq 都没变时为真。
 * 真实换源和 seq 变化都要继续执行。
 */
export function isPlaybackCueEcho(_prev: PlaybackCueIdentity, _next: PlaybackCueIdentity): boolean {
  throw new Error('not implemented');
}
