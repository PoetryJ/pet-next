/**
 * 反馈控制器：包装 ChatPanelClient 的生命周期，注入调度器与时钟，无真实 sleep。
 * 断言 POST 不增加（inner.send 调用次数不变）、回应至多一次、迟到/拖动/dispose 行为。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ChatSendRequest, ChatSendResult } from '../contracts/chat.ts';
import type { FeedbackEffect } from '../core/feedback/index.ts';
import { createFeedbackController } from './feedback.ts';
import type { FeedbackView } from './feedback-view.ts';
import type { ChatPanelClient } from './chat-panel.ts';

interface Deferred {
  request: ChatSendRequest;
  resolve(result: ChatSendResult): void;
  reject(error: Error): void;
}

function createInner(): { client: ChatPanelClient; calls: { send: number; cancel: string[]; reset: number }; deferreds: Deferred[] } {
  const calls = { send: 0, cancel: [] as string[], reset: 0 };
  const deferreds: Deferred[] = [];
  return {
    calls,
    deferreds,
    client: {
      send(request) {
        calls.send += 1;
        return new Promise<ChatSendResult>((resolve, reject) => {
          deferreds.push({ request, resolve, reject });
        });
      },
      cancel(id) {
        calls.cancel.push(id);
      },
      reset() {
        calls.reset += 1;
      },
    },
  };
}

class FakeView implements FeedbackView {
  element = {} as HTMLElement;
  applied: FeedbackEffect[] = [];
  disposed = 0;
  apply(effect: FeedbackEffect): void {
    this.applied.push(effect);
  }
  dispose(): void {
    this.disposed += 1;
  }
  kinds(): string[] {
    return this.applied.map((effect) => (effect.type === 'hint-show' ? `show:${effect.kind}` : effect.type));
  }
}

class FakeScheduler {
  entries: Array<{ delayMs: number; tick: () => void }> = [];
  schedule = (delayMs: number, tick: () => void): (() => void) => {
    const entry = { delayMs, tick };
    this.entries.push(entry);
    return () => {
      this.entries = this.entries.filter((item) => item !== entry);
    };
  };
  fireAll(): void {
    const list = this.entries;
    this.entries = [];
    for (const entry of list) entry.tick();
  }
  get count(): number {
    return this.entries.length;
  }
}

interface Harness {
  view: FakeView;
  scheduler: FakeScheduler;
  inner: ReturnType<typeof createInner>;
  reacts: number[];
  clock: { now: number };
  controller: ReturnType<typeof createFeedbackController>;
}

function harness(): Harness {
  const inner = createInner();
  const view = new FakeView();
  const scheduler = new FakeScheduler();
  const reacts: number[] = [];
  const clock = { now: 1_000 };
  const controller = createFeedbackController({
    inner: inner.client,
    view,
    onReact: (token) => reacts.push(token),
    nowMs: () => clock.now,
    schedule: scheduler.schedule,
    hideAfterMs: 500,
  });
  return { view, scheduler, inner, reacts, clock, controller };
}

function request(text: string): ChatSendRequest {
  return { id: 'chat-p1', text };
}

const okResult = (text: string): ChatSendResult => ({ id: 'chat-p1', status: 'ok', text });
const errorResult = (): ChatSendResult => ({ id: 'chat-p1', status: 'error', code: 'timeout' });
const cancelledResult = (): ChatSendResult => ({ id: 'chat-p1', status: 'cancelled' });

describe('feedback controller', () => {
  test('send 前出现 waiting，POST 次数不增加', async () => {
    const h = harness();
    const pending = h.controller.client.send(request('你好'));
    assert.deepEqual(h.view.kinds(), ['show:waiting']);
    assert.equal(h.inner.calls.send, 1);
    h.inner.deferreds[0]?.resolve(okResult('回复'));
    await pending;
    assert.equal(h.inner.calls.send, 1);
  });

  test('成功：success 提示 + onReact 恰一次', async () => {
    const h = harness();
    const pending = h.controller.client.send(request('你好'));
    h.inner.deferreds[0]?.resolve(okResult('回复'));
    await pending;
    assert.deepEqual(h.view.kinds(), ['show:waiting', 'show:success', 'react']);
    assert.deepEqual(h.reacts, [1]);
  });

  test('错误：error 提示且不回应', async () => {
    const h = harness();
    const pending = h.controller.client.send(request('你好'));
    h.inner.deferreds[0]?.resolve(errorResult());
    await pending;
    assert.deepEqual(h.view.kinds(), ['show:waiting', 'show:error']);
    assert.deepEqual(h.reacts, []);
  });

  test('cancelled 结果：cancelled 提示且不回应', async () => {
    const h = harness();
    const pending = h.controller.client.send(request('你好'));
    h.inner.deferreds[0]?.resolve(cancelledResult());
    await pending;
    assert.deepEqual(h.view.kinds(), ['show:waiting', 'show:cancelled']);
    assert.deepEqual(h.reacts, []);
  });

  test('cancel 透传并立即提示取消（在途时）', () => {
    const h = harness();
    void h.controller.client.send(request('你好'));
    h.controller.client.cancel('chat-p1');
    assert.deepEqual(h.inner.calls.cancel, ['chat-p1']);
    assert.deepEqual(h.view.kinds(), ['show:waiting', 'show:cancelled']);
    assert.deepEqual(h.reacts, []);
  });

  test('reset 透传、清提示，并让旧结果迟到零动作', async () => {
    const h = harness();
    const pending = h.controller.client.send(request('你好'));
    h.controller.client.reset();
    assert.equal(h.inner.calls.reset, 1);
    assert.deepEqual(h.view.kinds(), ['show:waiting', 'hint-hide']);
    h.inner.deferreds[0]?.resolve(okResult('迟到'));
    await pending;
    assert.deepEqual(h.view.kinds(), ['show:waiting', 'hint-hide']);
    assert.deepEqual(h.reacts, []);
  });

  test('拖动中成功：只提示，不回应', async () => {
    const h = harness();
    h.controller.drag(true);
    const pending = h.controller.client.send(request('你好'));
    h.inner.deferreds[0]?.resolve(okResult('回复'));
    await pending;
    h.controller.drag(false);
    assert.deepEqual(h.view.kinds(), ['show:waiting', 'show:success']);
    assert.deepEqual(h.reacts, []);
  });

  test('任意时刻至多一个定时器；到期隐藏', async () => {
    const h = harness();
    const pending = h.controller.client.send(request('你好'));
    assert.equal(h.scheduler.count, 1);
    assert.equal(h.scheduler.entries[0]?.delayMs, 500);
    // 连续提交：重排前取消旧定时器，仍只有一个。
    h.controller.client.send(request('第二句'));
    assert.equal(h.scheduler.count, 1);
    // 到期即隐藏，且不再留定时器；之后没有在途终态需要处理。
    h.clock.now += 500;
    h.scheduler.fireAll();
    assert.equal(h.view.kinds().includes('hint-hide'), true);
    assert.equal(h.scheduler.count, 0);
    h.inner.deferreds[0]?.resolve(cancelledResult());
    await pending;
    // 旧 token（1）的终态对当前 token（2）零效果。
    assert.equal(h.view.kinds().includes('show:cancelled'), false);
  });

  test('终态提示重新挂一个定时器（成功后到期隐藏）', async () => {
    const h = harness();
    const pending = h.controller.client.send(request('你好'));
    h.inner.deferreds[0]?.resolve(okResult('回复'));
    await pending;
    assert.equal(h.scheduler.count, 1);
    h.clock.now += 500;
    h.scheduler.fireAll();
    assert.deepEqual(h.view.kinds(), ['show:waiting', 'show:success', 'react', 'hint-hide']);
    assert.equal(h.scheduler.count, 0);
  });

  test('慢回复：等待提示到期后成功仍提示且回应恰一次（2s 延迟）', async () => {
    const h = harness();
    const pending = h.controller.client.send(request('你好'));
    h.clock.now += 500;
    h.scheduler.fireAll();
    assert.deepEqual(h.view.kinds(), ['show:waiting', 'hint-hide']);
    assert.equal(h.scheduler.count, 0, '等待到期后不保留定时器');
    h.clock.now += 1500;
    h.inner.deferreds[0]?.resolve(okResult('慢回复'));
    await pending;
    assert.deepEqual(h.view.kinds(), ['show:waiting', 'hint-hide', 'show:success', 'react']);
    assert.deepEqual(h.reacts, [1]);
    assert.equal(h.inner.calls.send, 1);
    assert.equal(h.scheduler.count, 1, '成功提示重新挂终态定时器');
  });

  test('慢回复：等待到期后迟到 error/cancel 只提示不回应', async () => {
    const lateError = harness();
    const p1 = lateError.controller.client.send(request('你好'));
    lateError.clock.now += 500;
    lateError.scheduler.fireAll();
    lateError.clock.now += 1500;
    lateError.inner.deferreds[0]?.resolve(errorResult());
    await p1;
    assert.deepEqual(lateError.view.kinds(), ['show:waiting', 'hint-hide', 'show:error']);
    assert.deepEqual(lateError.reacts, []);

    const lateCancel = harness();
    const p2 = lateCancel.controller.client.send(request('你好'));
    lateCancel.clock.now += 500;
    lateCancel.scheduler.fireAll();
    lateCancel.clock.now += 1500;
    lateCancel.inner.deferreds[0]?.resolve(cancelledResult());
    await p2;
    assert.deepEqual(lateCancel.view.kinds(), ['show:waiting', 'hint-hide', 'show:cancelled']);
    assert.deepEqual(lateCancel.reacts, []);
  });

  test('慢回复：等待到期后 reset，迟到 ok 零动作', async () => {
    const h = harness();
    const pending = h.controller.client.send(request('你好'));
    h.clock.now += 500;
    h.scheduler.fireAll();
    h.controller.client.reset();
    h.clock.now += 1500;
    h.inner.deferreds[0]?.resolve(okResult('迟到'));
    await pending;
    assert.deepEqual(h.view.kinds(), ['show:waiting', 'hint-hide', 'hint-hide']);
    assert.deepEqual(h.reacts, []);
  });

  test('慢回复：等待到期后取消与迟到成功并存，先到终态为准且不回应', async () => {
    const h = harness();
    const pending = h.controller.client.send(request('你好'));
    h.clock.now += 500;
    h.scheduler.fireAll();
    h.controller.client.cancel('chat-p1');
    h.clock.now += 1500;
    h.inner.deferreds[0]?.resolve(okResult('迟到成功'));
    await pending;
    assert.deepEqual(h.view.kinds(), ['show:waiting', 'hint-hide', 'show:cancelled']);
    assert.deepEqual(h.reacts, []);
  });

  test('慢回复：拖动中等待到期后完成，只提示不补播回应', async () => {
    const h = harness();
    h.controller.drag(true);
    const pending = h.controller.client.send(request('你好'));
    h.clock.now += 500;
    h.scheduler.fireAll();
    h.clock.now += 1500;
    h.inner.deferreds[0]?.resolve(okResult('慢回复'));
    await pending;
    h.controller.drag(false);
    assert.deepEqual(h.view.kinds(), ['show:waiting', 'hint-hide', 'show:success']);
    assert.deepEqual(h.reacts, []);
  });

  test('dispose 释放视图与定时器，之后不再产生提示', async () => {
    const h = harness();
    const pending = h.controller.client.send(request('你好'));
    h.controller.dispose();
    assert.equal(h.view.disposed, 1);
    assert.equal(h.scheduler.count, 0);
    h.inner.deferreds[0]?.resolve(okResult('回复'));
    await pending;
    assert.deepEqual(h.view.kinds(), ['show:waiting', 'hint-hide']);
    assert.deepEqual(h.reacts, []);
    // 透传仍然工作（不吞请求），但不再产生任何效果。
    void h.controller.client.send(request('之后'));
    assert.equal(h.inner.calls.send, 2);
    assert.deepEqual(h.view.kinds(), ['show:waiting', 'hint-hide']);
  });
});
