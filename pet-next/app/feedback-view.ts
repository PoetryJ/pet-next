/**
 * M3-6：聊天反馈提示（小型 DOM，单节点）。
 * 只消费 core/feedback 的效果；不轮询、不读网络、不碰播放器。
 * DOM 契约（e2e 只读）：[data-testid="chat-feedback"]，textContent=提示文案，
 * data-kind ∈ waiting|success|error|cancelled；无提示时 hidden 且无 data-kind。
 * @module pet-next/app/feedback-view
 */
import type { FeedbackEffect } from '../core/feedback/index.ts';

export interface FeedbackView {
  /** 供面板插入的节点（同一节点跨会话复用）。 */
  readonly element: HTMLElement;
  apply(effect: FeedbackEffect): void;
  dispose(): void;
}

const KIND_TEXT = {
  waiting: '等待回复…',
  success: '收到回复',
  error: '发送失败',
  cancelled: '已取消',
} as const;

export function createFeedbackView(): FeedbackView {
  const element = document.createElement('div');
  element.className = 'chat-feedback';
  element.dataset.testid = 'chat-feedback';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.hidden = true;

  let disposed = false;
  return {
    element,
    apply(effect) {
      if (disposed) return;
      if (effect.type === 'hint-show') {
        element.textContent = KIND_TEXT[effect.kind];
        element.dataset.kind = effect.kind;
        element.hidden = false;
        return;
      }
      if (effect.type === 'hint-hide') {
        element.textContent = '';
        element.dataset.kind = '';
        element.hidden = true;
      }
    },
    dispose() {
      disposed = true;
      element.remove();
    },
  };
}
