/**
 * 阶段机必须逐步对上规范性例子，并守住协议里的边界。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  mulberry32,
  NORMATIVE_EXAMPLES,
  SUSTAINED_LOAD,
  type ArbiterDecision,
  type ArbiterEvent,
  type ArbiterInput,
  type ArbiterSource,
  type ArbiterStep,
} from '../../../contracts/index.ts';
import { createStateMachine, type MachineState } from './index.ts';

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

function replay(inputs: readonly ArbiterInput[]): { state: MachineState; steps: ArbiterStep<MachineState>[] } {
  const arbiter = createStateMachine();
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

function assertPhase(state: MachineState): void {
  if (state.active === null) {
    assert.equal(state.phase, 'idle');
    return;
  }
  assert.equal(state.phase, state.active.source);
  assert.equal(state.queue.some((event) => event.id === state.active?.id), false);
}

function sourceForRoll(roll: number): ArbiterSource {
  if (roll < SUSTAINED_LOAD.dragBelow) return 'drag';
  if (roll < SUSTAINED_LOAD.clickBelow) return 'click';
  return 'auto';
}

function sustainedInputs(): ArbiterInput[] {
  const random = mulberry32(SUSTAINED_LOAD.seed);
  const inputs: ArbiterInput[] = [];
  for (let index = 0; index < SUSTAINED_LOAD.count; index += 1) {
    const timeMs = index * SUSTAINED_LOAD.timeStepMs;
    const source = sourceForRoll(random());
    inputs.push(
      deliver(`sustained-${index}`, source, index, timeMs, timeMs + SUSTAINED_LOAD.ttlMs, timeMs),
    );
  }
  return inputs;
}

describe('createStateMachine', () => {
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
        assert.equal(actual.queueLength, actual.state.queue.length, `${example.name}#${index}`);
        assertPhase(actual.state);
      }
    }
  });

  test('step 不修改入参，返回的队列、seen 和事件都是新副本', () => {
    const arbiter = createStateMachine();
    const initial = arbiter.initialState();
    const seen = initial.seen;
    const queue = initial.queue;
    const started = arbiter.step(initial, deliver('c', 'click', 0, 0, 100));
    assert.equal(initial.seen, seen);
    assert.equal(initial.queue, queue);
    assert.equal(initial.active, null);
    assert.equal(initial.phase, 'idle');
    assert.equal(initial.seen.size, 0);
    assert.notEqual(started.state.seen, initial.seen);
    assert.notEqual(started.state.queue, initial.queue);
    assert.equal(started.state.phase, 'click');

    const event: ArbiterEvent = { id: 'a', source: 'auto', seq: 1, timeMs: 1, expiresAtMs: 50 };
    const queued = arbiter.step(started.state, { type: 'deliver', event, nowMs: 1 });
    event.expiresAtMs = 1;
    event.id = 'mutated';
    assert.equal(queued.state.queue[0]?.id, 'a');
    assert.equal(queued.state.queue[0]?.expiresAtMs, 50);
    assert.notEqual(queued.state.queue[0], event);
    assert.notEqual(queued.state.queue, started.state.queue);
    assert.notEqual(queued.state.seen, started.state.seen);
    assert.notEqual(queued.state.active, started.state.active);
    assert.equal(started.state.active?.id, 'c');
    assert.equal(started.state.phase, 'click');
  });

  test('两次 createStateMachine 的 seen 不互通', () => {
    const left = createStateMachine();
    const right = createStateMachine();
    left.step(left.initialState(), deliver('c', 'click', 0, 0, 100));
    const started = right.step(right.initialState(), deliver('c', 'click', 0, 0, 100));
    assert.equal(started.decisions[0]?.reason, 'started');
  });

  test('同一输入回放两次，决策和 queueLength 相同', () => {
    const example = NORMATIVE_EXAMPLES[0];
    assert.ok(example);
    const once = replay(example.inputs);
    const twice = replay(example.inputs);
    const view = (steps: readonly ArbiterStep<MachineState>[]) =>
      steps.map((step) => ({ decisions: step.decisions, queueLength: step.queueLength }));
    assert.deepEqual(view(once.steps), view(twice.steps));
    assert.notEqual(once.state.seen, twice.state.seen);
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
    assert.equal(steps[1]?.state.phase, 'click');
  });

  test('拖动直接抢占自动提醒，同级自动提醒只入队', () => {
    const preempted = replay([deliver('a', 'auto', 0, 0, 100), deliver('d', 'drag', 1, 5, 100)]);
    assert.deepEqual(decisionIds(preempted.steps[1]?.decisions), ['preempted:a', 'started:d']);
    assert.equal(preempted.steps[1]?.queueLength, 0);
    assert.equal(preempted.steps[1]?.state.phase, 'drag');

    const queued = replay([deliver('a1', 'auto', 0, 0, 100), deliver('a2', 'auto', 1, 5, 100)]);
    assert.equal(queued.steps[1]?.decisions[0]?.reason, 'queued-same-rank');
    assert.equal(queued.steps[1]?.state.phase, 'auto');
    assert.equal(queued.steps[1]?.queueLength, 1);
  });

  test('timeMs 达到 expiresAtMs 时即使 now 更早也丢弃，同一 id 再投递是重复', () => {
    const { steps } = replay([deliver('x', 'click', 0, 20, 20, 10), deliver('x', 'click', 1, 20, 80, 11)]);
    assert.deepEqual(steps[0]?.decisions, [{ outcome: 'discard', reason: 'expired', eventId: 'x', actionId: null }]);
    assert.equal(steps[0]?.state.active, null);
    assert.equal(steps[0]?.state.phase, 'idle');
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
    assert.equal(steps[2]?.state.phase, 'drag');
    assert.equal(steps[2]?.queueLength, 1);
    assert.equal(steps[3]?.decisions[0]?.actionId, 'missing');
    assert.equal(steps[3]?.state.active?.id, 'd');
    assert.equal(steps[3]?.queueLength, 1);
  });

  test('没有当前动作时的完成回调是 stale-completion', () => {
    const { steps } = replay([complete('ghost', 0)]);
    assert.deepEqual(steps[0]?.decisions, [{ outcome: 'discard', reason: 'stale-completion', eventId: null, actionId: 'ghost' }]);
    assert.equal(steps[0]?.queueLength, 0);
    assert.equal(steps[0]?.state.phase, 'idle');
  });

  test('空闲但队列里已有事件时，新投递先开始，对不上的完成不放行等待者', () => {
    const arbiter = createStateMachine();
    const seeded: MachineState = {
      phase: 'idle',
      active: null,
      queue: [{ id: 'queued', source: 'click', seq: 0, timeMs: 0, expiresAtMs: 100 }],
      seen: new Set(['queued']),
    };
    const delivered = arbiter.step(seeded, deliver('fresh', 'auto', 1, 1, 100));
    assert.equal(delivered.decisions[0]?.reason, 'started');
    assert.equal(delivered.decisions[0]?.eventId, 'fresh');
    assert.equal(delivered.queueLength, 1);
    assert.equal(delivered.state.queue[0]?.id, 'queued');
    assert.equal(delivered.state.phase, 'auto');

    const stale = arbiter.step(seeded, complete('missing', 1));
    assert.deepEqual(stale.decisions, [{ outcome: 'discard', reason: 'stale-completion', eventId: null, actionId: 'missing' }]);
    assert.equal(stale.queueLength, 1);
    assert.equal(stale.state.phase, 'idle');
    assert.equal(stale.state.active, null);
  });

  test('阶段标签与活动动作不一致时，以活动动作的来源查表', () => {
    const arbiter = createStateMachine();
    const labeledDrag: MachineState = {
      phase: 'drag',
      active: { id: 'c', source: 'click', seq: 0, timeMs: 0, expiresAtMs: 100 },
      queue: [],
      seen: new Set(['c']),
    };
    const duringClick = arbiter.step(labeledDrag, deliver('a', 'auto', 1, 1, 100));
    assert.equal(duringClick.decisions[0]?.reason, 'queued-lower-rank');
    assert.equal(duringClick.state.phase, 'click');

    const labeledIdle: MachineState = {
      phase: 'drag',
      active: null,
      queue: [],
      seen: new Set(),
    };
    const started = arbiter.step(labeledIdle, deliver('a', 'auto', 0, 0, 100));
    assert.equal(started.decisions[0]?.reason, 'started');
    assert.equal(started.state.phase, 'auto');
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
    assert.equal(steps[4]?.state.phase, 'idle');
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
    assert.equal(steps[3]?.state.phase, 'click');
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
    assert.equal(steps[4]?.state.phase, 'auto');
  });

  test('抢占后的旧动作不回到队列', () => {
    const { steps } = replay([deliver('a', 'auto', 0, 0, 100), deliver('c', 'click', 1, 5, 100), complete('c', 6)]);
    assert.equal(steps[1]?.queueLength, 0);
    assert.deepEqual(steps[2]?.decisions, [{ outcome: 'execute', reason: 'completed', eventId: 'c', actionId: 'c' }]);
    assert.equal(steps[2]?.state.active, null);
    assert.equal(steps[2]?.state.phase, 'idle');
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
    assert.equal(steps[2]?.state.phase, 'drag');
  });

  test('部分等待到期时只丢掉到期项，拖动期间的新自动提醒仍入队', () => {
    const { steps } = replay([
      deliver('d', 'drag', 0, 0, 1000),
      deliver('a', 'auto', 1, 1, 10),
      deliver('c', 'click', 2, 2, 100),
      deliver('b', 'auto', 3, 10, 100, 10),
    ]);
    assert.deepEqual(decisionIds(steps[3]?.decisions), ['expired:a', 'drag-blocks-auto:b']);
    assert.equal(steps[3]?.queueLength, 2);
    assert.deepEqual(
      steps[3]?.state.queue.map((event) => event.id),
      ['c', 'b'],
    );
    assert.equal(steps[3]?.state.phase, 'drag');
  });

  test('第二条拖动不抢占第一条', () => {
    const { steps } = replay([deliver('d1', 'drag', 0, 0, 100), deliver('d2', 'drag', 1, 5, 100)]);
    assert.equal(steps[1]?.decisions[0]?.reason, 'queued-same-rank');
    assert.equal(steps[1]?.state.active?.id, 'd1');
    assert.equal(steps[1]?.state.phase, 'drag');
    assert.equal(steps[1]?.queueLength, 1);
  });

  test('点击进行中的自动提醒记为 queued-lower-rank', () => {
    const { steps } = replay([deliver('c', 'click', 0, 0, 100), deliver('a', 'auto', 1, 5, 100)]);
    assert.equal(steps[1]?.decisions[0]?.reason, 'queued-lower-rank');
    assert.equal(steps[1]?.decisions[0]?.actionId, null);
    assert.equal(steps[1]?.state.active?.id, 'c');
    assert.equal(steps[1]?.state.phase, 'click');
  });

  test('持续负载：不开始已过期事件，一步最多开始一个，队列长度等于等待数', () => {
    const inputs = sustainedInputs();
    const delivered = new Map<string, ArbiterEvent>();
    const { steps } = replay(inputs);
    assert.equal(steps.length, SUSTAINED_LOAD.count);
    assert.equal(steps[0]?.decisions[0]?.reason, 'started');
    assert.equal(steps[0]?.decisions[0]?.eventId, 'sustained-0');
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      const step = steps[index];
      if (input === undefined || step === undefined || input.type !== 'deliver') {
        assert.fail(`sustained#${index} 缺少投递`);
      }
      delivered.set(input.event.id, input.event);
      const started = step.decisions.filter((decision) => decision.reason === 'started');
      assert.equal(started.length <= 1, true, `sustained#${index}`);
      for (const decision of started) {
        const event = decision.eventId === null ? undefined : delivered.get(decision.eventId);
        assert.ok(event, `sustained#${index}`);
        assert.equal(input.nowMs >= event.expiresAtMs || event.timeMs >= event.expiresAtMs, false, event.id);
      }
      assert.equal(step.queueLength, step.state.queue.length, `sustained#${index}`);
      assertPhase(step.state);
      for (const decision of step.decisions) {
        if (decision.reason !== 'preempted' || decision.eventId === null) continue;
        assert.equal(
          step.state.queue.some((event) => event.id === decision.eventId),
          false,
          decision.eventId,
        );
      }
    }
  });
});
