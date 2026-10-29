/**
 * 产品行为：假时钟、注入随机数。不放宽断言来换通过。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createDesktopPetBehavior, type BehaviorPorts } from './desktop.ts';
import {
  BEHAVIOR_LIMITS,
  EXPERIMENT_SAME_RANK_QUEUE,
  PRODUCT_BEHAVIOR_RULES,
  indexFromRandom,
} from './policy.ts';
import { proposeNextAuto } from './propose.ts';
import { stepBehavior } from './reduce.ts';
import { createBehaviorScheduler } from './scheduler.ts';
import type { BehaviorDeps, BehaviorEffect, BehaviorInput, BehaviorState } from './types.ts';

function clockDeps(): BehaviorDeps & { set(nowMs: number): void; setRandom(sample: number): void; reads: number; samples: number } {
  let now = 0;
  let sample = 0;
  const deps = {
    reads: 0,
    samples: 0,
    nowMs() {
      deps.reads += 1;
      return now;
    },
    random() {
      deps.samples += 1;
      return sample;
    },
    set(next: number) {
      now = next;
    },
    setRandom(next: number) {
      sample = next;
    },
  };
  return deps;
}

function frozenDeps(random: () => number = forbidRandom): BehaviorDeps {
  return {
    nowMs() {
      throw new Error('step read the clock');
    },
    random,
  };
}

function forbidRandom(): number {
  throw new Error('random() should not be called');
}

function click(requestId: string, nowMs: number, expiresAtMs: number): BehaviorInput {
  return { type: 'click', requestId, nowMs, expiresAtMs };
}

function auto(requestId: string, nowMs: number, expiresAtMs: number): BehaviorInput {
  return { type: 'auto', requestId, nowMs, expiresAtMs };
}

function drag(phase: 'start' | 'end', nowMs: number): BehaviorInput {
  return { type: 'drag', phase, nowMs };
}

function settled(requestId: string, ok: boolean, nowMs: number): BehaviorInput {
  return { type: 'settled', requestId, ok, nowMs };
}

function run(inputs: readonly BehaviorInput[], random: () => number = forbidRandom) {
  const scheduler = createBehaviorScheduler(frozenDeps(random));
  let state = scheduler.initialState();
  const steps = inputs.map((input) => {
    const step = scheduler.step(state, input);
    state = step.state;
    return step;
  });
  return { state, steps };
}

function ports(): BehaviorPorts & {
  plays: { requestId: string; clip: string; url: string; once: boolean }[];
  cancels: { requestId: string; reason: string }[];
  idles: number;
} {
  const recorded = {
    plays: [] as { requestId: string; clip: string; url: string; once: boolean }[],
    cancels: [] as { requestId: string; reason: string }[],
    idles: 0,
    play(request: { requestId: string; clip: string; url: string; once: boolean }) {
      recorded.plays.push({ ...request });
    },
    cancel(requestId: string, reason: 'superseded' | 'expired' | 'drag') {
      recorded.cancels.push({ requestId, reason });
    },
    showIdle() {
      recorded.idles += 1;
    },
  };
  return recorded;
}

describe('proposeNextAuto', () => {
  test('假时钟决定候选是否到期，单条候选不调用 random，也不改写 requestId', () => {
    const deps = clockDeps();
    const candidates = [
      { requestId: 'early', readyAtMs: 0, expiresAtMs: 10 },
      { requestId: 'later', readyAtMs: 20, expiresAtMs: 40 },
    ];
    assert.deepEqual(proposeNextAuto(candidates, deps), {
      type: 'auto',
      requestId: 'early',
      nowMs: 0,
      expiresAtMs: 10,
    });
    assert.equal(deps.samples, 0);
    assert.equal(deps.reads, 1);

    deps.set(10);
    assert.equal(proposeNextAuto(candidates, deps), null);
    assert.equal(deps.samples, 0);

    deps.set(20);
    assert.deepEqual(proposeNextAuto(candidates, deps), {
      type: 'auto',
      requestId: 'later',
      nowMs: 20,
      expiresAtMs: 40,
    });
    assert.equal(deps.samples, 0);
  });

  test('多条到期候选用注入随机数取下标，身份仍来自候选', () => {
    const deps = clockDeps();
    deps.set(5);
    deps.setRandom(0.5);
    const proposal = proposeNextAuto(
      [
        { requestId: 'a', readyAtMs: 0, expiresAtMs: 100 },
        { requestId: 'b', readyAtMs: 0, expiresAtMs: 100 },
      ],
      deps,
    );
    assert.deepEqual(proposal, { type: 'auto', requestId: 'b', nowMs: 5, expiresAtMs: 100 });
    assert.equal(deps.samples, 1);
    assert.equal(proposal?.requestId === 'a' || proposal?.requestId === 'b', true);

    deps.setRandom(0);
    const first = proposeNextAuto(
      [
        { requestId: 'a', readyAtMs: 0, expiresAtMs: 100 },
        { requestId: 'b', readyAtMs: 0, expiresAtMs: 100 },
      ],
      deps,
    );
    assert.equal(first?.requestId, 'a');
    assert.equal(deps.samples, 2);
  });
});

describe('product scheduler', () => {
  test('规则列表与实验同级排队分开，步进不读时钟', () => {
    assert.deepEqual(PRODUCT_BEHAVIOR_RULES, [
      'drag-priority',
      'latest-click-overrides',
      'auto-only-when-idle',
      'no-auto-start-during-drag',
      'expired-auto-discarded',
      'idle-after-settle',
      'idempotent-request',
      'bounded-capacity',
    ]);
    const ruleNames: readonly string[] = PRODUCT_BEHAVIOR_RULES;
    assert.equal(ruleNames.includes(EXPERIMENT_SAME_RANK_QUEUE), false);
    assert.equal(BEHAVIOR_LIMITS.pending, 8);
    assert.equal(BEHAVIOR_LIMITS.history, 32);
    assert.equal(indexFromRandom(1, forbidRandom), 0);
    assert.equal(indexFromRandom(2, () => 0), 0);
    assert.equal(indexFromRandom(2, () => 0.999), 1);
    assert.throws(() => indexFromRandom(2, () => 1), RangeError);
    assert.throws(() => indexFromRandom(2, () => -0.01), RangeError);

    const started = run([click('c1', 10, 40)]);
    assert.deepEqual(started.steps[0]?.effects, [{ type: 'start', requestId: 'c1', clip: 'reaction' }]);
    assert.equal(started.steps[0]?.pending, 0);
    assert.equal(started.steps[0]?.history, 0);
    assert.equal(started.state.active?.requestId, 'c1');
  });

  test('新点击覆盖旧点击，不把同级点击留在队列', () => {
    const { steps, state } = run([click('c1', 0, 100), click('c2', 1, 100), click('c3', 2, 100)]);
    assert.deepEqual(steps[1]?.effects, [
      { type: 'cancel', requestId: 'c1', reason: 'superseded' },
      { type: 'start', requestId: 'c2', clip: 'reaction' },
    ]);
    assert.equal(steps[1]?.pending, 0);
    assert.equal(steps[1]?.state.pendingClick, null);
    assert.deepEqual(steps[1]?.state.pendingAutos, []);
    assert.deepEqual(steps[2]?.effects, [
      { type: 'cancel', requestId: 'c2', reason: 'superseded' },
      { type: 'start', requestId: 'c3', clip: 'reaction' },
    ]);
    assert.equal(state.pendingClick, null);
    assert.equal(state.active?.requestId, 'c3');
    assert.deepEqual(
      state.history.map((entry) => [entry.requestId, entry.outcome]),
      [
        ['c1', 'superseded'],
        ['c2', 'superseded'],
      ],
    );
    assert.equal(JSON.stringify(steps.flatMap((step) => step.effects)).includes(EXPERIMENT_SAME_RANK_QUEUE), false);
  });

  test('点击打断自动动作，拖动本身不产生回应', () => {
    const { steps } = run([auto('a1', 0, 100), click('c1', 5, 100), drag('start', 6), drag('end', 7)]);
    assert.deepEqual(steps[0]?.effects, [{ type: 'start', requestId: 'a1', clip: 'auto' }]);
    assert.deepEqual(steps[1]?.effects, [
      { type: 'cancel', requestId: 'a1', reason: 'superseded' },
      { type: 'start', requestId: 'c1', clip: 'reaction' },
    ]);
    assert.equal(steps[1]?.pending, 0);
    assert.deepEqual(steps[2]?.effects, [
      { type: 'cancel', requestId: 'c1', reason: 'drag' },
      { type: 'idle' },
    ]);
    assert.equal(steps[2]?.effects.some((effect) => effect.type === 'start'), false);
    assert.deepEqual(steps[3]?.effects, []);
    assert.equal(steps[3]?.state.active, null);
  });

  test('拖动期间只保留最新点击，结束后才开始，且不启动自动动作', () => {
    const { steps } = run([
      drag('start', 0),
      auto('a1', 1, 100),
      click('c1', 2, 100),
      click('c2', 3, 100),
      drag('end', 4),
    ]);
    assert.deepEqual(steps[0]?.effects, []);
    assert.deepEqual(steps[1]?.effects, []);
    assert.equal(steps[1]?.pending, 1);
    assert.equal(steps[1]?.state.pendingAutos[0]?.requestId, 'a1');
    assert.deepEqual(steps[2]?.effects, []);
    assert.equal(steps[2]?.state.pendingClick?.requestId, 'c1');
    assert.deepEqual(steps[3]?.effects, [{ type: 'cancel', requestId: 'c1', reason: 'superseded' }]);
    assert.equal(steps[3]?.state.pendingClick?.requestId, 'c2');
    assert.equal(steps[3]?.effects.some((effect) => effect.type === 'start'), false);
    assert.deepEqual(steps[4]?.effects, [{ type: 'start', requestId: 'c2', clip: 'reaction' }]);
    assert.equal(steps[4]?.state.pendingAutos[0]?.requestId, 'a1');
    assert.equal(steps[4]?.pending, 1);
  });

  test('空闲时自动动作才开始；拖动中到达的自动动作在拖动结束后才开始', () => {
    const blocked = run([drag('start', 0), auto('a1', 1, 100), drag('end', 10)]);
    assert.deepEqual(blocked.steps[1]?.effects, []);
    assert.equal(blocked.steps[1]?.state.dragging, true);
    assert.equal(blocked.steps[1]?.state.active, null);
    assert.deepEqual(blocked.steps[2]?.effects, [{ type: 'start', requestId: 'a1', clip: 'auto' }]);

    const idle = run([auto('a2', 0, 20)]);
    assert.deepEqual(idle.steps[0]?.effects, [{ type: 'start', requestId: 'a2', clip: 'auto' }]);
    assert.equal(idle.steps[0]?.pending, 0);
  });

  test('nowMs 等于 expiresAtMs 的自动动作丢弃，活动中的请求不过期', () => {
    const expired = run([auto('a1', 5, 5), auto('bad', Number.NaN, 10)]);
    assert.deepEqual(expired.steps[0]?.effects, [{ type: 'cancel', requestId: 'a1', reason: 'expired' }]);
    assert.equal(expired.steps[0]?.state.active, null);
    assert.equal(expired.steps[0]?.pending, 0);
    assert.deepEqual(expired.steps[1]?.effects, [{ type: 'cancel', requestId: 'bad', reason: 'expired' }]);

    const held = run([click('c1', 0, 20), auto('a2', 100, 200)]);
    assert.equal(held.state.active?.requestId, 'c1');
    assert.equal(held.steps[1]?.effects.some((effect) => effect.type === 'cancel' && effect.requestId === 'c1'), false);
    assert.equal(held.steps[1]?.pending, 1);

    const pendingExpired = run([drag('start', 0), auto('a3', 0, 50), drag('end', 50)]);
    assert.deepEqual(pendingExpired.steps[2]?.effects, [{ type: 'cancel', requestId: 'a3', reason: 'expired' }]);
    assert.equal(pendingExpired.state.active, null);

    const clickExpired = run([drag('start', 0), click('c9', 0, 30), drag('end', 30)]);
    assert.deepEqual(clickExpired.steps[2]?.effects, [{ type: 'cancel', requestId: 'c9', reason: 'expired' }]);
    assert.equal(clickExpired.state.active, null);
  });

  test('完成或失败后只回待机，不在同一步启动待处理的自动动作', () => {
    const done = run([click('c1', 0, 100), auto('a1', 1, 100), settled('c1', true, 20)]);
    assert.deepEqual(done.steps[2]?.effects, [{ type: 'idle' }]);
    assert.equal(done.state.active, null);
    assert.equal(done.state.pendingAutos[0]?.requestId, 'a1');
    assert.equal(done.steps[2]?.history, 1);
    assert.equal(done.state.history[0]?.ok, true);

    const failed = run([click('c2', 0, 100), settled('c2', false, 5), settled('c2', false, 6)]);
    assert.deepEqual(failed.steps[1]?.effects, [{ type: 'idle' }]);
    assert.equal(failed.state.history[0]?.ok, false);
    assert.deepEqual(failed.steps[2]?.effects, []);
    assert.equal(failed.state.active, null);

    const stale = run([click('c3', 0, 100), settled('other', true, 4)]);
    assert.deepEqual(stale.steps[1]?.effects, []);
    assert.equal(stale.state.active?.requestId, 'c3');

    const pumped = run([
      click('c4', 0, 100),
      auto('a4', 1, 100),
      settled('c4', true, 2),
      drag('start', 3),
      drag('end', 4),
    ]);
    assert.deepEqual(pumped.steps[2]?.effects, [{ type: 'idle' }]);
    assert.deepEqual(pumped.steps[4]?.effects, [{ type: 'start', requestId: 'a4', clip: 'auto' }]);
  });

  test('同一 requestId 在窗口内不能第二次开始', () => {
    const { steps, state } = run([click('c1', 0, 50), click('c1', 10, 50), settled('c1', true, 20), click('c1', 30, 80)]);
    assert.deepEqual(steps[1]?.effects, []);
    assert.equal(steps[1]?.state.active?.requestId, 'c1');
    assert.deepEqual(steps[3]?.effects, []);
    assert.equal(state.active, null);
    assert.equal(state.history.some((entry) => entry.requestId === 'c1'), true);
  });

  test('多个可开始的自动动作才调用 random，下标决定开始哪一条', () => {
    const held = run([drag('start', 0), auto('a', 1, 100), auto('b', 2, 100)]).state;
    let calls = 0;
    const low = stepBehavior(held, drag('end', 3), () => {
      calls += 1;
      return 0;
    });
    const high = stepBehavior(held, drag('end', 3), () => 0.99);
    assert.equal(calls, 1);
    assert.deepEqual(low.effects, [{ type: 'start', requestId: 'a', clip: 'auto' }]);
    assert.deepEqual(
      low.state.pendingAutos.map((item) => item.requestId),
      ['b'],
    );
    assert.deepEqual(high.effects, [{ type: 'start', requestId: 'b', clip: 'auto' }]);
    assert.deepEqual(
      high.state.pendingAutos.map((item) => item.requestId),
      ['a'],
    );

    const single = run([drag('start', 0), auto('only', 1, 100)]).state;
    const started = stepBehavior(single, drag('end', 2), forbidRandom);
    assert.deepEqual(started.effects, [{ type: 'start', requestId: 'only', clip: 'auto' }]);
  });

  test('重复拖动开始不重复取消', () => {
    const { steps } = run([click('c1', 0, 100), drag('start', 1), drag('start', 2)]);
    assert.deepEqual(steps[1]?.effects, [
      { type: 'cancel', requestId: 'c1', reason: 'drag' },
      { type: 'idle' },
    ]);
    assert.deepEqual(steps[2]?.effects, []);
    assert.equal(steps[2]?.state.dragging, true);
    assert.equal(steps[2]?.history, 1);
  });

  test('返回的状态不与入参共享数组', () => {
    const scheduler = createBehaviorScheduler(frozenDeps());
    const first = scheduler.initialState();
    const second = scheduler.initialState();
    assert.notEqual(first.pendingAutos, second.pendingAutos);
    assert.notEqual(first.history, second.history);
    const stepped = scheduler.step(first, auto('a1', 0, 10));
    assert.notEqual(stepped.state.pendingAutos, first.pendingAutos);
    assert.notEqual(stepped.state.history, first.history);
    assert.equal(first.active, null);
    assert.equal(first.pendingAutos.length, 0);
    stepped.state.pendingAutos.push({
      requestId: 'mutated',
      kind: 'auto',
      expiresAtMs: 1,
      admittedAtMs: 0,
    });
    const again = scheduler.step(first, auto('a1', 0, 10));
    assert.deepEqual(again.effects, stepped.effects);
    assert.equal(again.state.pendingAutos.length, 0);
    assert.equal(again.state.active?.requestId, 'a1');
  });

  test('待处理超过 8 时丢掉最旧的自动动作，最新点击仍保留', () => {
    const inputs: BehaviorInput[] = [drag('start', 0), click('keep', 1, 500)];
    for (let index = 0; index < 9; index += 1) inputs.push(auto(`a${index}`, index + 2, 500));
    const { steps, state } = run(inputs);
    const last = steps[steps.length - 1];
    assert.ok(last);
    assert.equal(last.pending, BEHAVIOR_LIMITS.pending);
    assert.deepEqual(state.history, [
      { requestId: 'a0', kind: 'auto', outcome: 'dropped', ok: null, atMs: 9 },
      { requestId: 'a1', kind: 'auto', outcome: 'dropped', ok: null, atMs: 10 },
    ]);
    assert.deepEqual(
      state.pendingAutos.map((item) => item.requestId),
      ['a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'],
    );
    assert.equal(state.pendingClick?.requestId, 'keep');
    assert.equal(last.effects.some((effect) => effect.type === 'start'), false);
  });

  test('历史超过 32 后丢掉最旧记录，窗口内的 id 仍幂等，挤出后可以再次接纳', () => {
    const inputs: BehaviorInput[] = [];
    for (let index = 0; index < 40; index += 1) inputs.push(auto(`a${index}`, index, index));
    const filled = run(inputs);
    assert.equal(filled.state.history.length, BEHAVIOR_LIMITS.history);
    assert.equal(filled.state.history[0]?.requestId, 'a8');
    assert.equal(filled.state.history[31]?.requestId, 'a39');
    assert.equal(filled.state.history.every((entry) => entry.outcome === 'expired'), true);

    const retained = createBehaviorScheduler(frozenDeps());
    const duplicate = retained.step(filled.state, auto('a39', 100, 200));
    assert.deepEqual(duplicate.effects, []);
    assert.equal(duplicate.state.active, null);

    const reused = retained.step(filled.state, auto('a0', 100, 200));
    assert.deepEqual(reused.effects, [{ type: 'start', requestId: 'a0', clip: 'auto' }]);
  });

  test('固定脚本覆盖拖动、覆盖点击、过期和回待机', () => {
    const { steps, state } = run([
      click('c0', 0, 100),
      auto('a1', 10, 40),
      settled('c0', true, 20),
      drag('start', 30),
      drag('end', 35),
      click('c5', 40, 90),
      drag('start', 45),
      auto('a7', 46, 80),
      auto('a8', 47, 47),
      click('c9', 48, 200),
      click('c10', 49, 200),
      drag('end', 50),
      settled('c10', false, 60),
      drag('start', 70),
      drag('end', 71),
    ]);
    const effects = steps.map((step) => step.effects);
    const expected: BehaviorEffect[][] = [
      [{ type: 'start', requestId: 'c0', clip: 'reaction' }],
      [],
      [{ type: 'idle' }],
      [],
      [{ type: 'start', requestId: 'a1', clip: 'auto' }],
      [
        { type: 'cancel', requestId: 'a1', reason: 'superseded' },
        { type: 'start', requestId: 'c5', clip: 'reaction' },
      ],
      [
        { type: 'cancel', requestId: 'c5', reason: 'drag' },
        { type: 'idle' },
      ],
      [],
      [{ type: 'cancel', requestId: 'a8', reason: 'expired' }],
      [],
      [{ type: 'cancel', requestId: 'c9', reason: 'superseded' }],
      [{ type: 'start', requestId: 'c10', clip: 'reaction' }],
      [{ type: 'idle' }],
      [],
      [{ type: 'start', requestId: 'a7', clip: 'auto' }],
    ];
    assert.deepEqual(effects, expected);
    assert.equal(state.active?.requestId, 'a7');
    assert.equal(steps[12]?.state.history.find((entry) => entry.requestId === 'c10')?.ok, false);
    assert.equal(steps[2]?.pending, 1);
    assert.equal(steps[11]?.pending, 1);
  });

  test('长序列保持容量，过期请求不开始，拖动期间不开始，同一 id 只开始一次', () => {
    const scheduler = createBehaviorScheduler(frozenDeps(() => 0));
    let state: BehaviorState = scheduler.initialState();
    const started = new Set<string>();
    const expires = new Map<string, number>();
    let dragging = false;
    for (let index = 0; index < 100; index += 1) {
      const nowMs = index * 10;
      const requestId = `r${index}`;
      const expiresAtMs = nowMs + (index % 5 === 0 ? 0 : 80);
      let input: BehaviorInput;
      const kind = index % 6;
      if (kind === 0) input = click(requestId, nowMs, expiresAtMs);
      else if (kind === 1 || kind === 3) input = auto(requestId, nowMs, kind === 3 ? nowMs : expiresAtMs);
      else if (kind === 2) input = drag('start', nowMs);
      else if (kind === 4) input = drag('end', nowMs);
      else {
        const activeId = [...started].at(-1) ?? 'missing';
        input = settled(activeId, index % 2 === 0, nowMs);
      }
      if (input.type === 'click' || input.type === 'auto') expires.set(input.requestId, input.expiresAtMs);
      const beforeDragging = dragging;
      const step = scheduler.step(state, input);
      if (step.pending > BEHAVIOR_LIMITS.pending) assert.equal(step.pending, BEHAVIOR_LIMITS.pending);
      if (step.history > BEHAVIOR_LIMITS.history) assert.equal(step.history, BEHAVIOR_LIMITS.history);
      assert.equal(step.pending, step.state.pendingAutos.length + (step.state.pendingClick === null ? 0 : 1));
      assert.equal(step.history, step.state.history.length);
      assert.equal(JSON.stringify(step.effects).includes(EXPERIMENT_SAME_RANK_QUEUE), false);
      for (const effect of step.effects) {
        if (effect.type !== 'start') continue;
        assert.equal(started.has(effect.requestId), false, effect.requestId);
        started.add(effect.requestId);
        const deadline = expires.get(effect.requestId);
        assert.equal(deadline !== undefined && nowMs < deadline, true, effect.requestId);
      }
      if (beforeDragging && !(input.type === 'drag' && input.phase === 'end')) {
        assert.equal(
          step.effects.some((effect) => effect.type === 'start'),
          false,
        );
      }
      if (input.type === 'drag' && input.phase === 'start') dragging = true;
      if (input.type === 'drag' && input.phase === 'end') dragging = false;
      state = step.state;
    }
    assert.equal(started.size > 0, true);
    assert.equal(state.history.length <= BEHAVIOR_LIMITS.history, true);
    assert.equal(state.pendingAutos.length + (state.pendingClick === null ? 0 : 1) <= BEHAVIOR_LIMITS.pending, true);
  });
});

describe('desktop pet session', () => {
  const assets = { idleUrl: 'idle.webm', reactionUrl: 'reaction.webm', autoUrl: 'auto.webm' };

  test('假时钟下：空闲提议、拖动阻止、最新点击、失败回待机', () => {
    const deps = clockDeps();
    const recorded = ports();
    const pet = createDesktopPetBehavior({ deps, assets, ports: recorded });

    assert.equal(pet.considerAuto([{ requestId: 'a1', readyAtMs: 0, expiresAtMs: 50 }]), true);
    assert.deepEqual(recorded.plays, [{ requestId: 'a1', clip: 'auto', url: 'auto.webm', once: true }]);
    assert.equal(pet.phase, 'active');
    assert.equal(pet.activeRequestId, 'a1');

    const readsAfterStart = deps.reads;
    pet.dragStart();
    assert.deepEqual(recorded.cancels, [{ requestId: 'a1', reason: 'drag' }]);
    assert.equal(recorded.idles, 1);
    assert.equal(pet.dragging, true);
    assert.equal(pet.phase, 'idle');

    const readsWhileDragging = deps.reads;
    assert.equal(readsWhileDragging > readsAfterStart, true);
    assert.equal(pet.considerAuto([{ requestId: 'a2', readyAtMs: 0, expiresAtMs: 80 }]), false);
    assert.equal(deps.reads, readsWhileDragging);
    assert.equal(deps.samples, 0);
    assert.equal(recorded.plays.length, 1);

    pet.dragEnd();
    pet.click('c1', 100);
    assert.deepEqual(recorded.plays[1], { requestId: 'c1', clip: 'reaction', url: 'reaction.webm', once: true });
    pet.click('c2', 100);
    assert.deepEqual(recorded.cancels[1], { requestId: 'c1', reason: 'superseded' });
    assert.deepEqual(recorded.plays[2], { requestId: 'c2', clip: 'reaction', url: 'reaction.webm', once: true });
    assert.equal(pet.pending, 0);
    assert.equal(pet.activeRequestId, 'c2');

    const readsWhileActive = deps.reads;
    assert.equal(pet.considerAuto([{ requestId: 'a3', readyAtMs: 0, expiresAtMs: 500 }]), false);
    assert.equal(deps.reads, readsWhileActive);

    pet.settled('c2', false);
    assert.equal(pet.phase, 'idle');
    assert.equal(pet.activeRequestId, null);
    assert.equal(recorded.idles, 2);
    assert.equal(pet.history >= 1, true);

    deps.set(10);
    assert.equal(pet.considerAuto([{ requestId: 'late', readyAtMs: 100, expiresAtMs: 200 }]), false);
    assert.equal(recorded.plays.length, 3);

    deps.set(100);
    assert.equal(pet.considerAuto([{ requestId: 'a4', readyAtMs: 100, expiresAtMs: 200 }]), true);
    assert.deepEqual(recorded.plays[3], { requestId: 'a4', clip: 'auto', url: 'auto.webm', once: true });
  });

  test('拖动期间的点击等到松手，过期点击在松手时丢弃', () => {
    const deps = clockDeps();
    const recorded = ports();
    const pet = createDesktopPetBehavior({ deps, assets, ports: recorded });
    pet.dragStart();
    pet.click('c1', 1000);
    assert.deepEqual(recorded.plays, []);
    assert.equal(pet.pending, 1);
    pet.dragEnd();
    assert.deepEqual(recorded.plays, [{ requestId: 'c1', clip: 'reaction', url: 'reaction.webm', once: true }]);

    const expired = ports();
    const later = createDesktopPetBehavior({ deps, assets, ports: expired });
    deps.set(0);
    later.dragStart();
    deps.set(5);
    later.click('c2', 10);
    deps.set(15);
    later.dragEnd();
    assert.deepEqual(expired.plays, []);
    assert.deepEqual(expired.cancels, [{ requestId: 'c2', reason: 'expired' }]);
    assert.equal(later.phase, 'idle');
  });

  test('ttl 非法时抛错，端口不能重入', () => {
    const deps = clockDeps();
    const recorded = ports();
    const pet = createDesktopPetBehavior({ deps, assets, ports: recorded });
    assert.throws(() => pet.click('c', Number.NaN), RangeError);
    assert.throws(() => pet.click('c', -1), RangeError);
    assert.equal(recorded.plays.length, 0);

    const reentering = createDesktopPetBehavior({
      deps,
      assets,
      ports: {
        play() {
          reentering.click('again', 10);
        },
        cancel() {},
        showIdle() {},
      },
    });
    assert.throws(() => reentering.click('c1', 10), /re-enter/);
  });
});
