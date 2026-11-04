/**
 * 反馈状态归约：纯函数，不修改入参。
 * 语义硬约束见 docs/M3-6-INTERFACE.txt 第二节；每次归约至多一个 deadline，
 * 调用方按 deadlineAtMs 挂一个可取消定时器，到期回灌 `expire`。
 * @module pet-next/core/feedback/reduce
 */
import type { FeedbackEffect, FeedbackEvent, FeedbackState } from './types.ts';

/** 结果提示默认展示时长（毫秒）。等待提示同理，直到终态或到期。 */
export const FEEDBACK_HIDE_MS = 1600;

export function initialFeedbackState(): FeedbackState {
  return {
    epoch: 0,
    token: 0,
    phase: 'idle',
    drag: false,
    deadlineAtMs: null,
    reacted: false,
    disposed: false,
  };
}

export interface FeedbackReduceOptions {
  /** 注入时钟（毫秒）。 */
  nowMs: number;
  /** 提示可见时长；缺省 FEEDBACK_HIDE_MS。 */
  hideAfterMs?: number;
}

export interface FeedbackStep {
  state: FeedbackState;
  effects: FeedbackEffect[];
}

function idle(state: FeedbackState, patch: Partial<FeedbackState> = {}): FeedbackState {
  return { ...state, phase: 'idle', deadlineAtMs: null, reacted: false, ...patch };
}

/**
 * 归约一次事件。
 *
 * 归属规则：`ok`/`error`/`cancel`/`expire` 只在 token 等于当前有效 token 时生效；
 * reset 递增 epoch 并让旧 token 失效；dispose 之后永久失效。迟到与重复终态零效果。
 * 拖动中成功只提示不排回应；拖动结束不补发被丢弃的回应。
 */
export function reduceFeedback(
  state: FeedbackState,
  event: FeedbackEvent,
  options: FeedbackReduceOptions,
): FeedbackStep {
  if (state.disposed) return { state, effects: [] };

  const hideAfterMs = options.hideAfterMs ?? FEEDBACK_HIDE_MS;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : 0;
  /** 当前 token 的终态是否被接受（去重与迟到隔离的唯一闸门）。 */
  const accepts = (token: number): boolean =>
    token === state.token && state.phase !== 'idle' && state.phase !== 'hint';

  switch (event.type) {
    case 'submit': {
      // 新提交：旧 token 立即失效（其终态 event 只会零效果）。
      const next = state.token + 1;
      return {
        state: { ...state, token: next, phase: 'waiting', deadlineAtMs: nowMs + hideAfterMs, reacted: false },
        effects: [{ type: 'hint-show', kind: 'waiting' }],
      };
    }
    case 'ok': {
      if (!accepts(event.token) || state.reacted) return { state, effects: [] };
      const effects: FeedbackEffect[] = [{ type: 'hint-show', kind: 'success' }];
      // 拖动优先：拖中完成只给结果提示，丢弃回应动作，也不排队补发。
      if (!state.drag) effects.push({ type: 'react', token: event.token });
      return {
        state: { ...state, phase: 'hint', deadlineAtMs: nowMs + hideAfterMs, reacted: true },
        effects,
      };
    }
    case 'error': {
      if (!accepts(event.token)) return { state, effects: [] };
      return {
        state: { ...state, phase: 'hint', deadlineAtMs: nowMs + hideAfterMs, reacted: false },
        effects: [{ type: 'hint-show', kind: 'error' }],
      };
    }
    case 'cancel': {
      if (!accepts(event.token)) return { state, effects: [] };
      return {
        state: { ...state, phase: 'hint', deadlineAtMs: nowMs + hideAfterMs, reacted: false },
        effects: [{ type: 'hint-show', kind: 'cancelled' }],
      };
    }
    case 'reset': {
      // 新对话：代际+1、旧 token 全体失效、立即清提示。
      return {
        state: idle(state, { epoch: state.epoch + 1, token: state.token + 1 }),
        effects: [{ type: 'hint-hide', reason: 'reset' }],
      };
    }
    case 'dispose': {
      return {
        state: idle(state, { epoch: state.epoch + 1, token: state.token + 1, disposed: true }),
        effects: [{ type: 'hint-hide', reason: 'dispose' }],
      };
    }
    case 'drag-start': {
      if (state.drag) return { state, effects: [] };
      return { state: { ...state, drag: true }, effects: [] };
    }
    case 'drag-end': {
      if (!state.drag) return { state, effects: [] };
      // 不补发拖动期间被丢弃的回应。
      return { state: { ...state, drag: false }, effects: [] };
    }
    case 'expire': {
      if (event.token !== state.token) return { state, effects: [] };
      if (state.deadlineAtMs === null || nowMs < state.deadlineAtMs) return { state, effects: [] };
      if (state.phase === 'waiting') {
        // 等待提示到期只隐藏提示：请求仍在途，保留 waiting 与 token，
        // 迟到的有效终态仍可归约（成功提示 + 一次回应），不因提示超时而丢结果。
        return { state: { ...state, deadlineAtMs: null }, effects: [{ type: 'hint-hide', reason: 'expire' }] };
      }
      // 终态结果提示（success/error/cancelled）到期才回 idle。
      return { state: idle(state), effects: [{ type: 'hint-hide', reason: 'expire' }] };
    }
    default: {
      // 未知事件（未来扩展）零效果，不抛错。
      return { state, effects: [] };
    }
  }
}
