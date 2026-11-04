/**
 * 聊天与宠物反馈联动的纯状态。
 * 不依赖 DOM / Electron / 网络 / 真实时钟；时间与调度由调用方注入。
 * 归属判定只用内部递增 token 与会话 epoch，外部 requestId 不参与。
 * @module pet-next/core/feedback/types
 */

/** `idle` 无提示；`waiting` 提交后等待；`hint` 终态结果提示（成功/错误/取消）。 */
export type FeedbackPhase = 'idle' | 'waiting' | 'hint';

export interface FeedbackState {
  /** 会话代际：reset 递增；旧代际的事件一律无效。 */
  epoch: number;
  /** 当前有效 token，只在 reduce 内部递增；外部事件必须回带它。 */
  token: number;
  phase: FeedbackPhase;
  /** 拖动优先：拖中不排回应长队。 */
  drag: boolean;
  /** 当前提示的隐藏期限（注入时钟）；无提示为 null。任意时刻至多一个定时器。 */
  deadlineAtMs: number | null;
  /** 本 token 的回应资格是否已消耗（每成功 token 至多一次 react）。 */
  reacted: boolean;
  /** dispose 之后任何事件都不再生效。 */
  disposed: boolean;
}

export type FeedbackEvent =
  | { type: 'submit' }
  | { type: 'ok'; token: number }
  | { type: 'error'; token: number }
  | { type: 'cancel'; token: number }
  | { type: 'reset' }
  | { type: 'dispose' }
  | { type: 'drag-start' }
  | { type: 'drag-end' }
  | { type: 'expire'; token: number };

export type FeedbackEffect =
  | { type: 'hint-show'; kind: 'waiting' | 'success' | 'error' | 'cancelled' }
  | { type: 'hint-hide'; reason: 'expire' | 'reset' | 'dispose' }
  | { type: 'react'; token: number };
