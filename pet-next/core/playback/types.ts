/**
 * 点播生命周期的类型。时间、请求编号和外部结果都由调用方传入。
 * @module pet-next/core/playback/types
 */

/** 渲染端可上报的状态。 */
export type ReportableStatus = 'playing' | 'ended' | 'failed' | 'cancelled';

/** 阶段。`ready` 表示可以调用 play，还没兑现。 */
export type PlaybackPhase = 'idle' | 'loading' | 'ready' | 'playing' | 'ended' | 'failed' | 'cancelled' | 'disposed';

/** 素材身份。同名不同地址或 once 变化都是另一次请求。 */
export interface PlaybackAsset {
  url: string;
  /** 为真时播完即止；为假时由适配器循环。 */
  once: boolean;
}

/** 一次换源请求。 */
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

/** 换源身份。回声判定用 seq，不能只看动画名。 */
export interface PlaybackCueIdentity {
  anim: string;
  once: boolean;
  seq: number;
  cuePlayback: string | null;
}
