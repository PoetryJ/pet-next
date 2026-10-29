/**
 * 基线必须逐步对上规范性例子，并守住协议里的边界。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  NORMATIVE_EXAMPLES,
  type ArbiterDecision,
  type ArbiterEvent,
  type ArbiterInput,
  type ArbiterStep,
} from '../../../contracts/index.ts';
import { createBaseline, type BaselineState } from './index.ts';

function deliver(
  id: string,
  source: ArbiterEvent['source'],
  seq: number,
  timeMs: number,
  expiresAtMs: number,
  nowMs = timeMs,
): ArbiterInput {
  return { type: 'deliver', event: { id, source, seq, timeMs, expiresAtMs }, nowMs };
}

function complete(actionId: string, nowMs: number): ArbiterInput {
  return { type: 'complete', actionId, nowMs };
}

function replay(inputs: readonly ArbiterInput[]): { state: BaselineState; steps: ArbiterStep<BaselineState>[] } {
  const arbiter = createBaseline();
  let state = arbiter.initialState();
  const steps = [];
  for (const input of inputs) {
    const result = arbiter.step(state, input);
    state = result.state;
    steps.push(result);
  }
  return { state, steps };
}

function decisionIds(decisions: readonly ArbiterDecision[] | undefined): string[] {
  return (decisions ?? []).map((decision) => `${decision.reason}:${decision.eventId ?? 'null'}`);
}

describe('createBaseline', () => {
  test('规范性例子：逐步决策和 queueLength 与契约一致', () => {
    for (const example of NORMATIVE_EXAMPLES) {
      const { steps } = replay(example.inputs);
      assert.equal(steps.length, example.expected.length, example.name);
      for (let index = 0; index < example.expected.length; index += 1) {
        const actual = steps[index];
        const want = example.expected[index];
        assert.ok(actual && want, `${example.name}#${index}`);
        assert.equal(actual.queueLength, want.queueLength, `${example.name}#${index}`);
        assert.deepEqual(actual.decisions, want.decisions, `${example.name}#${index}`);
      }
    }
  });

  test('step 不修改入参，返回的队列、seen 和事件都是新副本', () => {
    const arbiter = createBaseline();
    const initial = arbiter.initialState();
    const seen = initial.seen;
    const queue = initial.queue;
    const started = arbiter.step(initial, deliver('c', 'click', 0, 0, 100));
    assert.equal(initial.seen, seen);
    assert.equal(initial.queue, queue);
    assert.equal(initial.active, null);
    assert.equal(initial.seen.size, 0);
    assert.notEqual(started.state.seen, initial.seen);
    assert.notEqual(started.state.queue, initial.queue);

    const event: ArbiterEvent = { id: 'a', source: 'auto', seq: 1, timeMs: 1, expiresAtMs: 50 };
    const queued = arbiter.step(started.state, { type: 'deliver', event, nowMs: 1 });
    event.expiresAtMs = 1;
    event.id = 'mutated';
    assert.equal(queued.state.queue[0]?.id, 'a');
    assert.equal(queued.state.queue[0]?.expiresAtMs, 50);
    assert.notEqual(queued.state.queue, started.state.queue);
    assert.notEqual(queued.state.seen, started.state.seen);
    assert.equal(started.state.active?.id, 'c');
  });

  test('两次 createBaseline 的 seen 不互通', () => {
    const left = createBaseline();
    const right = createBaseline();
    left.step(left.initialState(), deliver('c', 'click', 0, 0, 100));
    const started = right.step(right.initialState(), deliver('c', 'click', 0, 0, 100));
    assert.equal(started.decisions[0]?.reason, 'started');
  });

  test('已开始的动作到点也不过期，只会被更高优先级抢占', () => {
    const { steps } = replay([deliver('a', 'auto', 0, 0, 5), deliver('c', 'click', 1, 30, 100, 30)]);
    assert.deepEqual(
      steps[1]?.decisions.map((decision) => decision.reason),
      ['preempted', 'started'],
    );
    assert.equal(steps[1]?.decisions[0]?.eventId, 'a');
    assert.equal(steps[1]?.decisions[0]?.actionId, 'a');
    assert.equal(steps[1]?.queueLength, 0);
    assert.equal(steps[1]?.state.active?.id, 'c');
  });

  test('timeMs 达到 expiresAtMs 时即使 now 更早也丢弃，同一 id 再投递是重复', () => {
    const { steps } = replay([deliver('x', 'click', 0, 20, 20, 10), deliver('x', 'click', 1, 20, 80, 11)]);
    assert.deepEqual(steps[0]?.decisions, [{ outcome: 'discard', reason: 'expired', eventId: 'x', actionId: null }]);
    assert.equal(steps[0]?.state.active, null);
    assert.equal(steps[0]?.queueLength, 0);
    assert.equal(steps[1]?.decisions[0]?.reason, 'duplicate');
    assert.equal(steps[1]?.decisions[0]?.actionId, null);
    assert.equal(steps[1]?.state.active, null);
  });

  test('对不上的完成回调留着当前动作，也不摘掉尚未开始的事件', () => {
    const { steps } = replay([
      deliver('d', 'drag', 0, 0, 100),
      deliver('c', 'click', 1, 5, 100),
      complete('c', 6),
      complete('missing', 7),
    ]);
    assert.deepEqual(steps[2]?.decisions, [{ outcome: 'discard', reason: 'stale-completion', eventId: null, actionId: 'c' }]);
    assert.equal(steps[2]?.state.active?.id, 'd');
    assert.equal(steps[2]?.queueLength, 1);
    assert.equal(steps[3]?.decisions[0]?.actionId, 'missing');
    assert.equal(steps[3]?.state.active?.id, 'd');
    assert.equal(steps[3]?.queueLength, 1);
  });

  test('没有当前动作时的完成回调是 stale-completion', () => {
    const { steps } = replay([complete('ghost', 0)]);
    assert.deepEqual(steps[0]?.decisions, [{ outcome: 'discard', reason: 'stale-completion', eventId: null, actionId: 'ghost' }]);
    assert.equal(steps[0]?.queueLength, 0);
  });

  test('过期输出按 seq、timeMs、id，不按入队顺序', () => {
    const { steps } = replay([
      deliver('d', 'drag', 0, 0, 1000),
      deliver('b', 'auto', 5, 2, 10),
      deliver('a', 'auto', 1, 3, 10),
      deliver('c', 'click', 5, 1, 10),
      complete('d', 10),
    ]);
    assert.deepEqual(decisionIds(steps[4]?.decisions), ['expired:a', 'expired:c', 'expired:b', 'completed:d']);
    assert.equal(steps[4]?.queueLength, 0);
    assert.equal(steps[4]?.state.active, null);
  });

  test('seq 与 timeMs 相同时，过期和随后开始都按 id 的字典序', () => {
    const { steps } = replay([
      deliver('d', 'drag', 0, 0, 100),
      deliver('m', 'click', 3, 4, 80),
      deliver('k', 'click', 3, 4, 80),
      complete('d', 9),
    ]);
    assert.equal(steps[3]?.decisions[1]?.reason, 'started');
    assert.equal(steps[3]?.decisions[1]?.eventId, 'k');
    assert.equal(steps[3]?.queueLength, 1);
    assert.equal(steps[3]?.state.queue[0]?.id, 'm');
  });

  test('空出当前动作后，更高优先级先于更小的 seq，且一步只开始一个', () => {
    const { steps } = replay([
      deliver('d', 'drag', 0, 0, 100),
      deliver('a', 'auto', 0, 5, 100),
      deliver('c', 'click', 9, 6, 100),
      complete('d', 7),
      complete('c', 8),
    ]);
    const startedOnComplete = steps[3]?.decisions.filter((decision) => decision.reason === 'started') ?? [];
    assert.equal(startedOnComplete.length, 1);
    assert.equal(startedOnComplete[0]?.eventId, 'c');
    assert.equal(steps[3]?.queueLength, 1);
    assert.equal(steps[4]?.decisions[1]?.eventId, 'a');
    assert.equal(steps[4]?.queueLength, 0);
  });

  test('抢占后的旧动作不回到队列', () => {
    const { steps } = replay([
      deliver('a', 'auto', 0, 0, 100),
      deliver('c', 'click', 1, 5, 100),
      complete('c', 6),
    ]);
    assert.equal(steps[1]?.queueLength, 0);
    assert.deepEqual(steps[2]?.decisions, [{ outcome: 'execute', reason: 'completed', eventId: 'c', actionId: 'c' }]);
    assert.equal(steps[2]?.state.active, null);
  });

  test('重复投递不改已开始事件的 seq；同一步仍先丢掉过期等待', () => {
    const { steps } = replay([
      deliver('d', 'drag', 0, 0, 1000),
      deliver('a', 'auto', 1, 5, 10),
      deliver('d', 'drag', 99, 20, 1000, 10),
    ]);
    assert.deepEqual(decisionIds(steps[2]?.decisions), ['expired:a', 'duplicate:d']);
    assert.equal(steps[2]?.decisions[1]?.actionId, null);
    assert.equal(steps[2]?.state.active?.seq, 0);
    assert.equal(steps[2]?.queueLength, 0);
  });

  test('第二条拖动不抢占第一条', () => {
    const { steps } = replay([deliver('d1', 'drag', 0, 0, 100), deliver('d2', 'drag', 1, 5, 100)]);
    assert.equal(steps[1]?.decisions[0]?.reason, 'queued-same-rank');
    assert.equal(steps[1]?.state.active?.id, 'd1');
    assert.equal(steps[1]?.queueLength, 1);
  });

  test('点击进行中的自动提醒记为 queued-lower-rank', () => {
    const { steps } = replay([deliver('c', 'click', 0, 0, 100), deliver('a', 'auto', 1, 5, 100)]);
    assert.equal(steps[1]?.decisions[0]?.reason, 'queued-lower-rank');
    assert.equal(steps[1]?.decisions[0]?.actionId, null);
    assert.equal(steps[1]?.state.active?.id, 'c');
  });
});
