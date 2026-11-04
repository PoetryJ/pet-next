/**
 * M3-6：聊天反馈薄接线——包装既有 ChatPanelClient 的 send/cancel/reset，
 * 用内部 token 驱动 core/feedback 归约；不新增模型 POST，不改主进程契约。
 * 成功且非拖动时通过 onReact 请求一次回应（由页面接到唯一 behavior 入口）。
 * @module pet-next/app/feedback
 */
import { FEEDBACK_HIDE_MS, initialFeedbackState, reduceFeedback } from '../core/feedback/index.ts';
import type { FeedbackEffect, FeedbackEvent, FeedbackState } from '../core/feedback/index.ts';
import type { ChatSendRequest, ChatSendResult } from '../contracts/chat.ts';
import type { FeedbackView } from './feedback-view.ts';
import type { ChatPanelClient } from './chat-panel.ts';

export interface FeedbackController {
  /** 交给 mountChatPanel 的 client（三个方法均为包装后的薄壳）。 */
  readonly client: ChatPanelClient;
  /** 拖动起止（由页面手势回调驱动）：拖中完成只提示，不排回应。 */
  drag(active: boolean): void;
  dispose(): void;
}

export interface FeedbackControllerOptions {
  inner: ChatPanelClient;
  view: FeedbackView;
  /** 请求一次回应；仅成功且非拖动、且每 token 至多一次。 */
  onReact(token: number): void;
  nowMs?(): number;
  /** 注入定时器：返回取消函数。测试不用真实 sleep。 */
  schedule?(delayMs: number, tick: () => void): () => void;
  hideAfterMs?: number;
}

function defaultSchedule(delayMs: number, tick: () => void): () => void {
  const handle = setTimeout(tick, delayMs);
  return () => {
    clearTimeout(handle);
  };
}

export function createFeedbackController(options: FeedbackControllerOptions): FeedbackController {
  const nowMs = options.nowMs ?? (() => Date.now());
  const schedule = options.schedule ?? defaultSchedule;
  const hideAfterMs = options.hideAfterMs ?? FEEDBACK_HIDE_MS;

  let state: FeedbackState = initialFeedbackState();
  let cancelTimer: (() => void) | null = null;
  let disposed = false;

  function applyEffect(effect: FeedbackEffect): void {
    options.view.apply(effect);
    if (effect.type === 'react') options.onReact(effect.token);
  }

  /** 单个在途定时器：每次归约后先取消旧的，再按当前 deadline 重挂。 */
  function reschedule(): void {
    cancelTimer?.();
    cancelTimer = null;
    if (state.deadlineAtMs === null) return;
    const token = state.token;
    const delay = Math.max(0, state.deadlineAtMs - nowMs());
    cancelTimer = schedule(delay, () => {
      cancelTimer = null;
      dispatch({ type: 'expire', token });
    });
  }

  function dispatch(event: FeedbackEvent): void {
    if (disposed) return;
    const step = reduceFeedback(state, event, { nowMs: nowMs(), hideAfterMs });
    state = step.state;
    for (const effect of step.effects) applyEffect(effect);
    reschedule();
  }

  const client: ChatPanelClient = {
    send(request: ChatSendRequest): Promise<ChatSendResult> {
      // 关闭路径不创建本对象；此处仅在被显式启用时运行。
      dispatch({ type: 'submit' });
      const submitToken = state.token;
      return options.inner.send(request).then((result) => {
        if (result.status === 'ok') dispatch({ type: 'ok', token: submitToken });
        else if (result.status === 'error') dispatch({ type: 'error', token: submitToken });
        else dispatch({ type: 'cancel', token: submitToken });
        return result;
      });
    },
    cancel(id: string): void {
      options.inner.cancel(id);
      dispatch({ type: 'cancel', token: state.token });
    },
    reset(): void {
      options.inner.reset();
      dispatch({ type: 'reset' });
    },
  };

  return {
    client,
    drag(active: boolean): void {
      dispatch({ type: active ? 'drag-start' : 'drag-end' });
    },
    dispose(): void {
      if (disposed) return;
      dispatch({ type: 'dispose' });
      disposed = true;
      cancelTimer?.();
      cancelTimer = null;
      options.view.dispose();
    },
  };
}
