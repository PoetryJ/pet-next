/**
 * 反馈归约：固定事件序列 + 注入时钟，不用真实 sleep。
 * 覆盖契约硬约束：同 token 重发、reset 后迟到、连续提交、重复终态、
 * 拖动中完成、dispose 后事件、expire 匹配与不匹配、入参不可变。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FEEDBACK_HIDE_MS, initialFeedbackState, reduceFeedback } from './reduce.ts';
import type { FeedbackEffect, FeedbackEvent, FeedbackState } from './types.ts';

const T0 = 1_000;

/** 依次归约事件，返回终态与全部效果（按发生顺序）。 */
function run(
  events: FeedbackEvent[],
  options: { hideAfterMs?: number; now?: (index: number) => number } = {},
): { state: FeedbackState; effects: FeedbackEffect[] } {
  let state = initialFeedbackState();
  const effects: FeedbackEffect[] = [];
  events.forEach((event, index) => {
    const nowMs = options.now ? options.now(index) : T0 + index * 10;
    const step = reduceFeedback(state, event, { nowMs, hideAfterMs: options.hideAfterMs });
    state = step.state;
    effects.push(...step.effects);
  });
  return { state, effects };
}

function kinds(effects: FeedbackEffect[]): string[] {
  return effects.map((effect) => (effect.type === 'hint-show' ? `show:${effect.kind}` : effect.type));
}

describe('feedback reduce', () => {
  test('submit 产生 waiting 提示与 deadline；token 递增', () => {
    const { state, effects } = run([{ type: 'submit' }]);
    assert.deepEqual(kinds(effects), ['show:waiting']);
    assert.equal(state.token, 1);
    assert.equal(state.phase, 'waiting');
    assert.equal(state.deadlineAtMs, T0 + FEEDBACK_HIDE_MS);
  });

  test('ok 当前 token：success 提示 + 恰好一次 react', () => {
    const { state, effects } = run([{ type: 'submit' }, { type: 'ok', token: 1 }]);
    assert.deepEqual(kinds(effects), ['show:waiting', 'show:success', 'react']);
    assert.equal(state.reacted, true);
    assert.equal(state.phase, 'hint');
  });

  test('同 token 重复终态零新动作（react 只有一次）', () => {
    const { effects } = run([
      { type: 'submit' },
      { type: 'ok', token: 1 },
      { type: 'ok', token: 1 },
      { type: 'error', token: 1 },
      { type: 'cancel', token: 1 },
    ]);
    assert.deepEqual(kinds(effects), ['show:waiting', 'show:success', 'react']);
  });

  test('error 当前 token：错误提示、无 react、不假成功', () => {
    const { state, effects } = run([{ type: 'submit' }, { type: 'error', token: 1 }]);
    assert.deepEqual(kinds(effects), ['show:waiting', 'show:error']);
    assert.equal(kinds(effects).includes('react'), false);
    assert.equal(state.reacted, false);
  });

  test('cancel 当前 token：cancelled 提示，不发 react', () => {
    const { effects } = run([{ type: 'submit' }, { type: 'cancel', token: 1 }]);
    assert.deepEqual(kinds(effects), ['show:waiting', 'show:cancelled']);
  });

  test('连续提交：旧 token 的终态零效果', () => {
    const { state, effects } = run([
      { type: 'submit' },
      { type: 'submit' },
      { type: 'ok', token: 1 },
    ]);
    assert.equal(state.token, 2);
    assert.deepEqual(kinds(effects), ['show:waiting', 'show:waiting']);
  });

  test('reset 后迟到 ok/error 零效果且提示被清', () => {
    const { state, effects } = run([
      { type: 'submit' },
      { type: 'reset' },
      { type: 'ok', token: 1 },
      { type: 'error', token: 2 },
    ]);
    assert.deepEqual(kinds(effects), ['show:waiting', 'hint-hide']);
    assert.equal(state.phase, 'idle');
    assert.equal(state.epoch, 1);
    assert.equal(effects.some((effect) => effect.type === 'react'), false);
  });

  test('拖动中完成：只提示成功，不排回应也不排队补发', () => {
    const { effects } = run([
      { type: 'submit' },
      { type: 'drag-start' },
      { type: 'ok', token: 1 },
      { type: 'drag-end' },
    ]);
    assert.deepEqual(kinds(effects), ['show:waiting', 'show:success']);
  });

  test('拖动结束后新成功仍可回应', () => {
    const { effects } = run([
      { type: 'submit' },
      { type: 'drag-start' },
      { type: 'ok', token: 1 },
      { type: 'drag-end' },
      { type: 'submit' },
      { type: 'ok', token: 2 },
    ]);
    assert.deepEqual(kinds(effects), ['show:waiting', 'show:success', 'show:waiting', 'show:success', 'react']);
  });

  test('dispose 后任何事件零效果（一次后永久静默）', () => {
    const { state, effects } = run([
      { type: 'submit' },
      { type: 'dispose' },
      { type: 'ok', token: 1 },
      { type: 'drag-start' },
      { type: 'expire', token: 1 },
      { type: 'submit' },
    ]);
    assert.deepEqual(kinds(effects), ['show:waiting', 'hint-hide']);
    assert.equal(state.disposed, true);
    assert.equal(effects.filter((effect) => effect.type === 'hint-show').length, 1);
  });

  test('expire 只在 token 匹配且到期时隐藏', () => {
    const early = run([{ type: 'submit' }, { type: 'expire', token: 1 }], {
      now: (index) => (index === 0 ? T0 : T0 + 10),
    });
    assert.deepEqual(kinds(early.effects), ['show:waiting']);

    const stale = run([{ type: 'submit' }, { type: 'expire', token: 99 }], {
      now: (index) => (index === 0 ? T0 : T0 + FEEDBACK_HIDE_MS + 1),
    });
    assert.deepEqual(kinds(stale.effects), ['show:waiting']);

    const due = run([{ type: 'submit' }, { type: 'expire', token: 1 }], {
      now: (index) => (index === 0 ? T0 : T0 + FEEDBACK_HIDE_MS + 1),
    });
    // 等待提示到期只隐藏提示：请求仍在途，phase 保持 waiting 以便迟到终态仍可归约。
    assert.deepEqual(kinds(due.effects), ['show:waiting', 'hint-hide']);
    assert.equal(due.state.phase, 'waiting');
    assert.equal(due.state.token, 1);
    assert.equal(due.state.deadlineAtMs, null);
  });

  test('慢回复：等待提示到期后 2s 成功仍有 success 提示与恰一次回应', () => {
    const { state, effects } = run(
      [{ type: 'submit' }, { type: 'expire', token: 1 }, { type: 'ok', token: 1 }],
      { now: (index) => (index === 0 ? T0 : index === 1 ? T0 + FEEDBACK_HIDE_MS : T0 + 2_000) },
    );
    assert.deepEqual(kinds(effects), ['show:waiting', 'hint-hide', 'show:success', 'react']);
    assert.equal(state.phase, 'hint');
    assert.equal(state.reacted, true);
    assert.equal(state.deadlineAtMs, T0 + 2_000 + FEEDBACK_HIDE_MS);
  });

  test('慢回复：等待提示到期后迟到 error/cancel 只提示不回应', () => {
    const lateError = run(
      [{ type: 'submit' }, { type: 'expire', token: 1 }, { type: 'error', token: 1 }],
      { now: (index) => (index === 0 ? T0 : index === 1 ? T0 + FEEDBACK_HIDE_MS : T0 + 2_000) },
    );
    assert.deepEqual(kinds(lateError.effects), ['show:waiting', 'hint-hide', 'show:error']);
    assert.equal(lateError.state.reacted, false);

    const lateCancel = run(
      [{ type: 'submit' }, { type: 'expire', token: 1 }, { type: 'cancel', token: 1 }],
      { now: (index) => (index === 0 ? T0 : index === 1 ? T0 + FEEDBACK_HIDE_MS : T0 + 2_000) },
    );
    assert.deepEqual(kinds(lateCancel.effects), ['show:waiting', 'hint-hide', 'show:cancelled']);
    assert.equal(lateCancel.state.reacted, false);
  });

  test('慢回复：等待到期后 reset，迟到 ok 零动作', () => {
    const { state, effects } = run(
      [{ type: 'submit' }, { type: 'expire', token: 1 }, { type: 'reset' }, { type: 'ok', token: 1 }],
      { now: (index) => (index === 0 ? T0 : index === 1 ? T0 + FEEDBACK_HIDE_MS : T0 + 2_000) },
    );
    assert.deepEqual(kinds(effects), ['show:waiting', 'hint-hide', 'hint-hide']);
    assert.equal(state.phase, 'idle');
    assert.equal(effects.some((effect) => effect.type === 'react'), false);
  });

  test('慢回复：等待到期后重复终态仍只回应一次', () => {
    const { effects } = run(
      [
        { type: 'submit' },
        { type: 'expire', token: 1 },
        { type: 'ok', token: 1 },
        { type: 'ok', token: 1 },
        { type: 'error', token: 1 },
      ],
      { now: (index) => (index === 0 ? T0 : index === 1 ? T0 + FEEDBACK_HIDE_MS : T0 + 2_000) },
    );
    assert.deepEqual(kinds(effects), ['show:waiting', 'hint-hide', 'show:success', 'react']);
  });

  test('慢回复：拖动中等待到期后完成，只提示成功不补播回应', () => {
    const { effects } = run(
      [
        { type: 'submit' },
        { type: 'drag-start' },
        { type: 'expire', token: 1 },
        { type: 'ok', token: 1 },
        { type: 'drag-end' },
      ],
      { now: (index) => (index === 0 ? T0 : index === 2 ? T0 + FEEDBACK_HIDE_MS : T0 + 2_000) },
    );
    assert.deepEqual(kinds(effects), ['show:waiting', 'hint-hide', 'show:success']);
    assert.equal(effects.some((effect) => effect.type === 'react'), false);
  });

  test('终态提示到期才回 idle（success 隐藏后 token 失效）', () => {
    const { state, effects } = run(
      [{ type: 'submit' }, { type: 'ok', token: 1 }, { type: 'expire', token: 1 }, { type: 'ok', token: 1 }],
      { now: (index) => (index === 0 ? T0 : index === 1 ? T0 + 100 : T0 + 100 + FEEDBACK_HIDE_MS) },
    );
    assert.deepEqual(kinds(effects), ['show:waiting', 'show:success', 'react', 'hint-hide']);
    assert.equal(state.phase, 'idle');
    assert.equal(state.deadlineAtMs, null);
  });

  test('任意时刻至多一个 deadline（状态只有一个字段，后续提示覆盖旧期限）', () => {
    const { state } = run([{ type: 'submit' }, { type: 'error', token: 1 }], {
      now: (index) => (index === 0 ? T0 : T0 + 500),
    });
    assert.equal(state.deadlineAtMs, T0 + 500 + FEEDBACK_HIDE_MS);
  });

  test('入参不可变：冻结状态与选项不报错', () => {
    const frozen = Object.freeze(initialFeedbackState());
    const step = reduceFeedback(frozen, { type: 'submit' }, Object.freeze({ nowMs: T0 }));
    assert.equal(step.state.token, 1);
    assert.equal(frozen.token, 0);
    assert.equal(frozen.phase, 'idle');
  });

  test('未知事件类型零效果不抛错', () => {
    const state = initialFeedbackState();
    const step = reduceFeedback(state, { type: 'future' } as unknown as FeedbackEvent, { nowMs: T0 });
    assert.deepEqual(step.effects, []);
    assert.equal(step.state, state);
  });
});
