/**
 * 预览行为会话：冷却从回待机起算、拖动优先、连点覆盖、失败回待机、
 * 长会话追踪有界、退出后不复活。全部用注入的伪时钟与一次性定时器。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAILY_CADENCE, DEMO_CADENCE } from '../contracts/behavior.ts';
import type { PetMedia, PetMediaRequest, PetMediaStatus } from './pet-media.ts';
import { createBehaviorPet, type BehaviorPet } from './behavior-pet.ts';

/** 一次性定时器桩：挂表不自动触发，测试手动推进。 */
class FakeScheduler {
  armed: Array<{ delayMs: number; tick: () => void; cancelled: boolean }> = [];

  schedule(delayMs: number, tick: () => void): () => void {
    const entry = { delayMs, tick, cancelled: false };
    this.armed.push(entry);
    return () => {
      entry.cancelled = true;
      const at = this.armed.indexOf(entry);
      if (at >= 0) this.armed.splice(at, 1);
    };
  }

  get liveCount(): number {
    return this.armed.filter((entry) => !entry.cancelled).length;
  }

  /** 触发最早的在途定时器。 */
  fireOldest(): void {
    const entry = this.armed.find((item) => !item.cancelled);
    if (entry) {
      const at = this.armed.indexOf(entry);
      this.armed.splice(at, 1);
      entry.tick();
    }
  }
}

interface Harness {
  pet: BehaviorPet;
  clock: FakeScheduler;
  plays: PetMediaRequest[];
  visuals: string[];
  moves: Array<{ dx: number; dy: number }>;
  lastTrace: readonly string[];
  randomCalls: number;
  quitCalls: number;
  setNow(value: number): void;
}

function createHarness(cadence: { autoCooldownMinMs: number; autoCooldownMaxMs: number }): Harness {
  let now = 0;
  const clock = new FakeScheduler();
  const plays: PetMediaRequest[] = [];
  const visuals: string[] = [];
  let lastTrace: readonly string[] = [];
  const moves: Array<{ dx: number; dy: number }> = [];
  const dragging: boolean[] = [];
  let randomCalls = 0;
  let quitCalls = 0;
  const media: PetMedia = {
    begin(request) {
      plays.push(request);
    },
    showPlaceholder() {
      return undefined;
    },
    dispose() {
      return undefined;
    },
  };
  const pet = createBehaviorPet({
    media,
    idleUrl: 'idle.webm',
    reactionUrl: 'react.webm',
    cadence,
    dragThresholdPx: 5,
    nowMs: () => now,
    random() {
      randomCalls += 1;
      return 0;
    },
    schedule(delayMs, tick) {
      return clock.schedule(delayMs, tick);
    },
    moveBy(dx, dy) {
      moves.push({ dx, dy });
    },
    quit() {
      quitCalls += 1;
    },
    setVisual(visual) {
      visuals.push(visual);
    },
    setTrace(trace) {
      lastTrace = [...trace];
    },
    setDragging(value) {
      dragging.push(value);
    },
  });
  return {
    pet,
    clock,
    plays,
    visuals,
    moves,
    get lastTrace() {
      return lastTrace;
    },
    get randomCalls() {
      return randomCalls;
    },
    get quitCalls() {
      return quitCalls;
    },
    setNow(value) {
      now = value;
    },
  };
}

function clickOnce(pet: BehaviorPet): void {
  pet.pointer({ type: 'pointerdown', pointerId: 1, x: 0, y: 0 });
  pet.pointer({ type: 'pointerup', pointerId: 1, x: 1, y: 1 });
}

test('演示节奏：boot 后按 cadence 挂一次性定时器，自动动作结束才重算冷却', () => {
  const h = createHarness(DEMO_CADENCE);
  h.pet.boot();
  assert.equal(h.plays[0]?.clip, 'idle');
  assert.equal(h.clock.liveCount, 1);
  assert.equal(h.clock.armed[0]?.delayMs, 1600);
  // min === max 时不消耗随机数。
  assert.equal(h.randomCalls, 0);
  h.clock.fireOldest();
  const auto = h.plays[1];
  assert.equal(auto?.clip, 'auto');
  assert.equal(auto?.url, 'react.webm');
  assert.equal(h.clock.liveCount, 0, '自动动作在播时先不挂下一次');
  h.setNow(2_000);
  h.pet.onMedia({ requestId: auto?.requestId ?? '', status: 'ended', keptRequestId: null } satisfies PetMediaStatus);
  assert.equal(h.clock.liveCount, 1, '回到待机后重挂');
  assert.equal(h.clock.armed.at(-1)?.delayMs, 1600);
});

test('日常节奏：冷却区间取样消耗随机数且落在 [45s, 900s]', () => {
  const h = createHarness(DAILY_CADENCE);
  h.pet.boot();
  assert.equal(h.randomCalls, 1);
  const delay = h.clock.armed[0]?.delayMs ?? -1;
  assert.ok(delay >= 45_000 && delay <= 900_000, `delay ${delay} 不在区间`);
  // random()=0 → 取下限。
  assert.equal(delay, 45_000);
});

test('点击打断自动动作，拖动只移动窗口，失败回应指向缺失地址', () => {
  const h = createHarness(DEMO_CADENCE);
  h.pet.boot();
  h.clock.fireOldest();
  const autoId = h.plays[1]?.requestId;
  assert.ok(autoId);
  clickOnce(h.pet);
  const click = h.plays.at(-1);
  assert.equal(click?.clip, 'reaction');
  assert.equal(click?.url, 'react.webm');
  assert.notEqual(click?.requestId, autoId);
  h.pet.onMedia({ requestId: autoId, status: 'ended', keptRequestId: null } satisfies PetMediaStatus);
  h.pet.pointer({ type: 'pointerdown', pointerId: 1, x: 0, y: 0 });
  h.pet.pointer({ type: 'pointermove', pointerId: 1, x: 12, y: 4 });
  h.pet.pointer({ type: 'pointerup', pointerId: 1, x: 12, y: 4 });
  assert.deepEqual(h.moves, [{ dx: 12, dy: 4 }]);
  assert.equal(h.plays.filter((play) => play.clip === 'reaction').length, 1, '拖动不产生点击');
  h.setNow(5_000);
  h.pet.failNext();
  const failed = h.plays.at(-1);
  assert.equal(failed?.clip, 'reaction');
  assert.equal(failed?.url, 'file:///tmp/pet-next-preview-missing-reaction.webm');
  const failedId = failed?.requestId;
  assert.ok(failedId);
  const beforeIdle = h.plays.length;
  h.pet.onMedia({ requestId: failedId, status: 'failed', keptRequestId: null } satisfies PetMediaStatus);
  assert.equal(h.plays[beforeIdle]?.clip, 'idle');
  assert.equal(h.plays[beforeIdle]?.url, 'idle.webm');
  assert.equal(h.clock.liveCount, 1, '失败回待机后重挂下一次自动动作');
});

test('拖动进行中定时器到期：不提议自动动作，改期重来', () => {
  const h = createHarness(DEMO_CADENCE);
  h.pet.boot();
  h.pet.pointer({ type: 'pointerdown', pointerId: 1, x: 0, y: 0 });
  h.pet.pointer({ type: 'pointermove', pointerId: 1, x: 9, y: 0 });
  const before = h.plays.length;
  h.clock.fireOldest();
  assert.equal(h.plays.length, before, '拖动中不开始自动动作');
  assert.equal(h.clock.liveCount, 1, '改期重挂');
  h.pet.pointer({ type: 'pointerup', pointerId: 1, x: 9, y: 0 });
  h.clock.fireOldest();
  assert.equal(h.plays.at(-1)?.clip, 'auto', '拖动结束后到期能开始自动动作');
});

test('连点覆盖：旧回应未结束前新点击取代旧点击', () => {
  const h = createHarness(DEMO_CADENCE);
  h.pet.boot();
  clickOnce(h.pet);
  const first = h.plays.at(-1);
  clickOnce(h.pet);
  const second = h.plays.at(-1);
  assert.ok(first && second);
  assert.notEqual(first.requestId, second.requestId);
  assert.equal(h.visuals.filter((visual) => visual === 'reaction').length, 2);
  // 旧请求事后才回报结束：不得干扰新活动请求（不重播待机、不新增播放）。
  const armedBefore = h.clock.liveCount;
  const playsBefore = h.plays.length;
  h.pet.onMedia({ requestId: first.requestId, status: 'ended', keptRequestId: null } satisfies PetMediaStatus);
  assert.equal(h.plays.length, playsBefore, '旧回调不触发新播放');
  assert.equal(h.visuals.at(-1), 'reaction', '新点击的回应仍在画面上');
  assert.ok(h.clock.liveCount >= armedBefore, '重挂不减少在途定时器');
  // 真正的活动请求结束后才回待机并重挂。
  h.pet.onMedia({ requestId: second.requestId, status: 'ended', keptRequestId: null } satisfies PetMediaStatus);
  assert.equal(h.visuals.at(-1), 'idle');
});

test('长会话有界：万次点击后 trace ≤ 32，最老请求身份按未知处理', () => {
  const h = createHarness(DEMO_CADENCE);
  h.pet.boot();
  clickOnce(h.pet);
  const firstReactionId = h.plays.at(-1)?.requestId ?? '';
  assert.ok(firstReactionId);
  for (let i = 0; i < 10_000; i += 1) {
    clickOnce(h.pet);
  }
  assert.ok(h.plays.length >= 10_000, '每次点击都发起播放请求');
  assert.ok(h.plays.length < 10_100, '请求总量与点击同阶，不重复放大');
  assert.ok(h.lastTrace.length <= 32, `trace 长度 ${h.lastTrace.length} 超上限`);
  // 未结算请求身份超过上限后，最老的被淘汰：再收到它的终态按未知请求处理（占位符路径）。
  h.pet.onMedia({ requestId: firstReactionId, status: 'failed', keptRequestId: null } satisfies PetMediaStatus);
  assert.equal(h.visuals.at(-1), 'placeholder', '被淘汰的旧身份按未知处理');
});

test('quit 后定时器与媒体回调都不能复活会话', () => {
  const h = createHarness(DEMO_CADENCE);
  h.pet.boot();
  h.clock.fireOldest();
  const autoId = h.plays[1]?.requestId ?? '';
  h.pet.quit();
  assert.equal(h.quitCalls, 1);
  assert.equal(h.clock.liveCount, 0);
  const playsBefore = h.plays.length;
  h.pet.onMedia({ requestId: autoId, status: 'ended', keptRequestId: null } satisfies PetMediaStatus);
  h.clock.fireOldest();
  assert.equal(h.plays.length, playsBefore, '退出后不再发起播放');
  h.pet.quit();
  assert.equal(h.quitCalls, 1, '重复 quit 幂等');
});
