/**
 * 反馈提示视图：最小 DOM 替身（与 chat-panel.test.ts 同风格，不引入 jsdom）。
 * 只读 DOM 契约：[data-testid="chat-feedback"]、data-kind、hidden、textContent。
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { createFeedbackView } from './feedback-view.ts';

class StubElement {
  tagName: string;
  className = '';
  textContent = '';
  hidden = false;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: StubElement[] = [];
  parentElement: StubElement | null = null;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  appendChild(child: StubElement): StubElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    const parent = this.parentElement;
    if (parent === null) return;
    parent.children = parent.children.filter((item) => item !== this);
    this.parentElement = null;
  }
}

function installDocument(): void {
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new StubElement(tag),
  };
}

function elementOf(view: ReturnType<typeof createFeedbackView>): StubElement {
  return view.element as unknown as StubElement;
}

describe('feedback view', () => {
  beforeEach(() => {
    installDocument();
  });

  test('初始隐藏、无 kind', () => {
    const view = createFeedbackView();
    const el = elementOf(view);
    assert.equal(el.dataset.testid, 'chat-feedback');
    assert.equal(el.hidden, true);
    assert.equal(el.dataset.kind, undefined);
  });

  test('waiting/success/error/cancelled 四类文案与 data-kind', () => {
    const view = createFeedbackView();
    const el = elementOf(view);
    const cases = [
      ['waiting', '等待回复…'],
      ['success', '收到回复'],
      ['error', '发送失败'],
      ['cancelled', '已取消'],
    ] as const;
    for (const [kind, text] of cases) {
      view.apply({ type: 'hint-show', kind });
      assert.equal(el.hidden, false);
      assert.equal(el.dataset.kind, kind);
      assert.equal(el.textContent, text);
    }
  });

  test('hint-hide 隐藏并清空', () => {
    const view = createFeedbackView();
    const el = elementOf(view);
    view.apply({ type: 'hint-show', kind: 'waiting' });
    view.apply({ type: 'hint-hide', reason: 'reset' });
    assert.equal(el.hidden, true);
    assert.equal(el.dataset.kind, '');
    assert.equal(el.textContent, '');
  });

  test('react 效果不影响视图（回应由控制器转发）', () => {
    const view = createFeedbackView();
    const el = elementOf(view);
    view.apply({ type: 'hint-show', kind: 'success' });
    view.apply({ type: 'react', token: 1 });
    assert.equal(el.dataset.kind, 'success');
    assert.equal(el.textContent, '收到回复');
  });

  test('dispose 后 apply 不生效且节点被移除', () => {
    const view = createFeedbackView();
    const host = new StubElement('div');
    host.appendChild(elementOf(view));
    view.apply({ type: 'hint-show', kind: 'waiting' });
    view.dispose();
    assert.equal(elementOf(view).parentElement, null);
    view.apply({ type: 'hint-show', kind: 'error' });
    assert.equal(elementOf(view).dataset.kind, 'waiting');
    assert.equal(elementOf(view).hidden, false);
  });
});
