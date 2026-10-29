/**
 * 冻结契约的可观察结果。主体是契约替身，不是单槽内核或实验仲裁的内部步骤。
 * 真实 B/C 未接入时不要删这些断言；接线清单在 `wiring.ts`。
 * @module pet-next/tests/contracts/cases
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AssetCandidateManifest } from '../../contracts/asset-candidate.ts';
import { REQUIRED_BACKGROUNDS } from '../../contracts/assets.ts';
import { BEHAVIOR_LIMITS, type BehaviorEffect, type BehaviorInput } from '../../contracts/behavior.ts';
import { REQUIRED_CONTRACT_CASES, type RequiredContractCase } from '../../contracts/coverage.ts';
import type { SlotClip, SlotPlayRequest, TwoSlotAdapter, TwoSlotNotice } from '../../contracts/media-slot.ts';
import { createContractBehavior } from './behavior-double.ts';
import { FakeClock, flush } from './controlled.ts';
import { createContractMedia, type MediaHarness, type PrepareResult } from './media-double.ts';
import { NEEDS_REAL } from './wiring.ts';

const TIMEOUT_MS = 1000;
const SHIPPED_IDLE = 'assets/idle.webm';
const SHIPPED = new Set(['assets/idle.webm', 'assets/reaction.webm', 'assets/placeholder.png']);

const covered: RequiredContractCase[] = [];

describe('REQUIRED_CONTRACT_CASES', () => {
  contractTest('late-loaded', async () => {
    const manifest = candidateManifest();
    assertCandidate(manifest);
    const media = openMedia();
    assert.equal(media.adapter.mode, 'two-slot');
    media.adapter.begin(play('A', SHIPPED_IDLE, 'idle', false));
    media.adapter.begin(play('B', manifest.outputPath, 'reaction', true));
    media.adapter.begin(play('C', manifest.outputPath, 'reaction', true));
    const tokenA = media.tokenFor('A');
    const tokenB = media.tokenFor('B');
    const tokenC = media.tokenFor('C');
    same(new Set([tokenA.slot, tokenB.slot, tokenC.slot]), new Set([0, 1]));
    if (tokenA.slot === tokenC.slot) assert.ok(tokenC.generation > tokenA.generation);

    await settle(media, 'A', { ok: true });
    await settle(media, 'B', { ok: true });
    same(media.notices, []);
    await settle(media, 'C', { ok: true });
    same(noticeKeys(media.notices), ['C:prepared', 'C:shown', 'C:playing']);
    media.emitFirstFrame(tokenA, 'A');
    media.emitFirstFrame(tokenB, 'B');
    assert.equal(media.notices.some((notice) => notice.type === 'first-frame'), false);
    media.emitFirstFrame(tokenC, 'C');
    assert.equal(media.notices.at(-1)?.requestId, 'C');
    assert.equal(media.notices.at(-1)?.type, 'first-frame');

    const held = openMedia();
    held.adapter.begin(play('A', SHIPPED_IDLE, 'idle', false));
    await settle(held, 'A', { ok: true });
    held.clearNotices();
    held.adapter.begin(play('B', manifest.outputPath, 'reaction', true));
    held.adapter.begin(play('C', manifest.outputPath, 'reaction', true));
    assert.equal(held.tokenFor('B').slot, held.tokenFor('C').slot);
    assert.notEqual(held.tokenFor('B').generation, held.tokenFor('C').generation);
    assert.notEqual(held.tokenFor('A').slot, held.tokenFor('C').slot);
    await settle(held, 'B', { ok: true });
    same(held.notices, []);
    await settle(held, 'C', { ok: true });
    same(noticeKeys(held.notices), ['C:prepared', 'C:shown', 'C:playing']);

    const { scheduler, calls } = openBehavior();
    const first = scheduler.step(scheduler.initialState(), click('A', 0));
    const second = scheduler.step(first.state, click('B', 1));
    const third = scheduler.step(second.state, click('C', 2));
    same(third.effects, [
      { type: 'cancel', requestId: 'B', reason: 'superseded' },
      { type: 'start', requestId: 'C', clip: 'reaction' },
    ] as const satisfies readonly BehaviorEffect[]);
    const stale = scheduler.step(third.state, settled('A', true, 3));
    same(stale.effects, []);
    const done = scheduler.step(third.state, settled('C', true, 4));
    same(done.effects, [{ type: 'idle' }] as const satisfies readonly BehaviorEffect[]);
    assert.equal(calls.now, 0);
  });

  contractTest('late-ended', async () => {
    const media = openMedia();
    media.adapter.begin(play('A', SHIPPED_IDLE, 'idle', false));
    await settle(media, 'A', { ok: true });
    media.adapter.begin(play('B', candidateManifest().outputPath, 'reaction', true));
    media.adapter.begin(play('C', candidateManifest().outputPath, 'reaction', true));
    await settle(media, 'C', { ok: true });
    const before = media.notices.length;
    media.emitEnded(media.tokenFor('A'), 'A');
    media.emitEnded(media.tokenFor('B'), 'B');
    assert.equal(media.notices.length, before);
    media.emitEnded(media.tokenFor('C'), 'C');
    assert.equal(media.notices.at(-1)?.type, 'ended');
    assert.equal(media.notices.at(-1)?.requestId, 'C');
    media.emitEnded(media.tokenFor('C'), 'C');
    assert.equal(media.notices.filter((notice) => notice.type === 'ended').length, 1);

    const { scheduler, calls } = openBehavior();
    const active = scheduler.step(scheduler.step(scheduler.initialState(), click('C', 0)).state, click('C-later', 1));
    const stale = scheduler.step(active.state, settled('A', true, 2));
    same(stale.effects, []);
    const done = scheduler.step(active.state, settled('C-later', true, 3));
    same(done.effects, [{ type: 'idle' }] as const satisfies readonly BehaviorEffect[]);
    assert.equal(calls.now, 0);
    assert.equal(calls.random, 0);
  });

  contractTest('duplicate-request', async () => {
    const url = candidateManifest().outputPath;
    const media = openMedia();
    media.adapter.begin(play('same', url, 'reaction', true));
    media.adapter.begin(play('same', 'assets/candidates/other.webm', 'reaction', true));
    await settle(media, 'same', { ok: true });
    same(noticeKeys(media.notices), ['same:prepared', 'same:shown', 'same:playing']);
    media.clearNotices();
    media.adapter.begin(play('next', url, 'reaction', true));
    await settle(media, 'next', { ok: true });
    same(noticeKeys(media.notices), ['next:prepared', 'next:shown', 'next:playing']);

    const { scheduler, calls } = openBehavior();
    const first = scheduler.step(scheduler.initialState(), click('a', 0));
    const second = scheduler.step(first.state, click('a', 1));
    same(second.effects, []);
    assert.equal(second.pending, 0);
    const queued = scheduler.step(first.state, auto('a', 2, 100));
    same(queued.effects, []);
    const held = scheduler.step(scheduler.initialState(), click('hold', 0));
    const pending = scheduler.step(held.state, auto('wait', 1, 100));
    const pendingAgain = scheduler.step(pending.state, auto('wait', 2, 100));
    same(pending.effects, []);
    assert.equal(pending.pending, 1);
    same(pendingAgain.effects, []);
    assert.equal(pendingAgain.pending, 1);

    const autoRun = scheduler.step(scheduler.initialState(), auto('x', 0, 100));
    const dragged = scheduler.step(autoRun.state, drag('start', 1));
    const replay = scheduler.step(dragged.state, auto('x', 2, 100));
    same(autoRun.effects, [{ type: 'start', requestId: 'x', clip: 'auto' }] as const satisfies readonly BehaviorEffect[]);
    same(replay.effects, []);
    assert.equal(calls.now, 0);
    assert.equal(calls.random, 0);
  });

  contractTest('consecutive-clicks', async () => {
    const { scheduler, calls } = openBehavior();
    const c1 = scheduler.step(scheduler.initialState(), click('c1', 0));
    const c2 = scheduler.step(c1.state, click('c2', 1));
    const c3 = scheduler.step(c2.state, click('c3', 2));
    same(c1.effects, [{ type: 'start', requestId: 'c1', clip: 'reaction' }] as const satisfies readonly BehaviorEffect[]);
    same(c2.effects, [
      { type: 'cancel', requestId: 'c1', reason: 'superseded' },
      { type: 'start', requestId: 'c2', clip: 'reaction' },
    ] as const satisfies readonly BehaviorEffect[]);
    same(c3.effects, [
      { type: 'cancel', requestId: 'c2', reason: 'superseded' },
      { type: 'start', requestId: 'c3', clip: 'reaction' },
    ] as const satisfies readonly BehaviorEffect[]);
    assert.equal(c1.pending, 0);
    assert.equal(c2.pending, 0);
    assert.equal(c3.pending, 0);
    const done = scheduler.step(c3.state, settled('c3', true, 3));
    same(done.effects, [{ type: 'idle' }] as const satisfies readonly BehaviorEffect[]);
    const late = scheduler.step(c3.state, settled('c1', true, 4));
    same(late.effects, []);

    const moving = scheduler.step(scheduler.initialState(), auto('move', 0, 500));
    const interrupt = scheduler.step(moving.state, click('tap', 1));
    same(interrupt.effects, [
      { type: 'cancel', requestId: 'move', reason: 'superseded' },
      { type: 'start', requestId: 'tap', clip: 'reaction' },
    ] as const satisfies readonly BehaviorEffect[]);
    assert.equal(interrupt.pending, 0);

    const media = openMedia();
    media.adapter.begin(play('c1', candidateManifest().outputPath, 'reaction', true));
    media.adapter.begin(play('c2', candidateManifest().outputPath, 'reaction', true));
    media.adapter.begin(play('c3', candidateManifest().outputPath, 'reaction', true));
    await settle(media, 'c1', { ok: true });
    await settle(media, 'c2', { ok: true });
    same(media.notices, []);
    await settle(media, 'c3', { ok: true });
    same(noticeKeys(media.notices), ['c3:prepared', 'c3:shown', 'c3:playing']);
    assert.equal(calls.now, 0);
    assert.equal(calls.random, 0);
  });

  contractTest('load-failure', async () => {
    const media = openMedia();
    const url = candidateManifest().outputPath;
    media.adapter.begin(play('A', SHIPPED_IDLE, 'idle', false));
    await settle(media, 'A', { ok: true });
    media.clearNotices();
    media.adapter.begin(play('B', url, 'reaction', true));
    await settle(media, 'B', { ok: false, reason: 'asset-load' });
    same(media.notices, [
      {
        type: 'failed',
        token: media.tokenFor('B'),
        requestId: 'B',
        reason: 'asset-load',
        keptRequestId: 'A',
      },
    ]);
    media.emitFirstFrame(media.tokenFor('A'), 'A');
    assert.equal(media.notices.at(-1)?.type, 'first-frame');
    assert.equal(media.notices.at(-1)?.requestId, 'A');

    media.clearNotices();
    media.adapter.begin(play('D', url, 'reaction', true));
    await settle(media, 'D', { ok: false, reason: 'decode-error' });
    same(media.notices, [
      {
        type: 'failed',
        token: media.tokenFor('D'),
        requestId: 'D',
        reason: 'decode-error',
        keptRequestId: 'A',
      },
    ]);

    media.clearNotices();
    media.adapter.begin(play('T', url, 'reaction', true));
    media.clock.advance(TIMEOUT_MS - 1);
    same(media.notices, []);
    media.clock.advance(1);
    same(media.notices, [
      {
        type: 'failed',
        token: media.tokenFor('T'),
        requestId: 'T',
        reason: 'timeout',
        keptRequestId: 'A',
      },
    ]);
    await settle(media, 'T', { ok: true });
    assert.equal(media.notices.length, 1);
    assert.equal(media.notices.some((notice) => notice.type === 'playing'), false);

    const fresh = openMedia();
    fresh.adapter.begin(play('Z', url, 'reaction', true));
    await settle(fresh, 'Z', { ok: false, reason: 'asset-load' });
    const failure = fresh.notices[0];
    assert.ok(failure);
    assert.equal(failure.type, 'failed');
    if (failure.type === 'failed') assert.equal(failure.keptRequestId, null);

    const { scheduler, calls } = openBehavior();
    const started = scheduler.step(scheduler.initialState(), click('B', 0));
    const failed = scheduler.step(started.state, settled('B', false, 1));
    same(failed.effects, [{ type: 'idle' }] as const satisfies readonly BehaviorEffect[]);
    assert.equal(failed.pending, 0);
    assert.equal(failed.history, 1);
    assert.equal(calls.now, 0);
  });

  contractTest('callback-after-dispose', async () => {
    const media = openMedia();
    const url = candidateManifest().outputPath;
    media.adapter.begin(play('A', url, 'reaction', true));
    const token = media.tokenFor('A');
    media.adapter.dispose();
    await settle(media, 'A', { ok: true });
    media.emitEnded(token, 'A');
    media.emitFirstFrame(token, 'A');
    assert.doesNotThrow(() => {
      media.adapter.begin(play('B', url, 'reaction', true));
    });
    media.clock.advance(TIMEOUT_MS * 5);
    same(media.notices, []);
    assert.throws(() => media.tokenFor('B'), /no token/);

    const playing = openMedia();
    playing.adapter.begin(play('P', url, 'reaction', true));
    await settle(playing, 'P', { ok: true });
    const shown = playing.tokenFor('P');
    playing.clearNotices();
    playing.adapter.dispose();
    playing.emitEnded(shown, 'P');
    playing.emitFirstFrame(shown, 'P');
    playing.clock.advance(TIMEOUT_MS);
    same(playing.notices, []);
  });

  contractTest('preheat-races-click', async () => {
    const url = candidateManifest().outputPath;
    const media = openMedia('two-slot-preheat');
    assert.equal(media.adapter.mode, 'two-slot-preheat');
    media.adapter.begin(play('idle', SHIPPED_IDLE, 'idle', false));
    await settle(media, 'idle', { ok: true });
    media.clearNotices();
    media.adapter.preheat(play('pre', url, 'reaction', true));
    media.adapter.begin(play('click', url, 'reaction', true));
    const pre = media.tokenFor('pre');
    const clickToken = media.tokenFor('click');
    assert.equal(pre.slot, clickToken.slot);
    assert.notEqual(pre.generation, clickToken.generation);
    assert.notEqual(media.tokenFor('idle').slot, clickToken.slot);
    assert.equal(pre.slot === 0 || pre.slot === 1, true);
    await settle(media, 'pre', { ok: true });
    same(media.notices, []);
    await settle(media, 'click', { ok: true });
    same(noticeKeys(media.notices), ['click:prepared', 'click:shown', 'click:playing']);
    media.emitEnded(pre, 'pre');
    assert.equal(media.notices.some((notice) => notice.requestId === 'pre' && (notice.type === 'playing' || notice.type === 'ended')), false);

    const ignored = openMedia('two-slot-preheat');
    ignored.adapter.preheat(play('nope', url, 'idle', false));
    same(ignored.notices, []);
    assert.throws(() => ignored.tokenFor('nope'), /no token/);

    const ready = openMedia('two-slot-preheat');
    ready.adapter.begin(play('idle', SHIPPED_IDLE, 'idle', false));
    await settle(ready, 'idle', { ok: true });
    ready.clearNotices();
    ready.adapter.preheat(play('pre2', url, 'reaction', true));
    await settle(ready, 'pre2', { ok: true });
    same(noticeKeys(ready.notices), ['pre2:prepared']);
    assert.equal(ready.notices.some((notice) => notice.type === 'playing' || notice.type === 'ended'), false);
    ready.adapter.begin(play('click2', url, 'reaction', true));
    await settle(ready, 'click2', { ok: true });
    ready.emitEnded(ready.tokenFor('pre2'), 'pre2');
    assert.equal(ready.notices.some((notice) => notice.requestId === 'pre2' && notice.type !== 'prepared'), false);
    assert.equal(ready.notices.some((notice) => notice.requestId === 'click2' && notice.type === 'playing'), true);
    for (const notice of ready.notices) {
      if (notice.requestId !== 'pre2') continue;
      assert.equal(notice.type === 'prepared' || notice.type === 'failed', true);
    }
  });

  contractTest('drag-blocks-auto', () => {
    const blocked = openBehavior();
    const dragging = blocked.scheduler.step(blocked.scheduler.initialState(), drag('start', 0));
    same(dragging.effects, []);
    const rejected = blocked.scheduler.step(dragging.state, auto('a1', 1, 10_000));
    same(rejected.effects, [{ type: 'cancel', requestId: 'a1', reason: 'drag' }] as const satisfies readonly BehaviorEffect[]);
    assert.equal(rejected.pending, 0);
    const released = blocked.scheduler.step(rejected.state, drag('end', 2));
    same(released.effects, []);
    const next = blocked.scheduler.step(released.state, auto('a2', 3, 10_000));
    same(next.effects, [{ type: 'start', requestId: 'a2', clip: 'auto' }] as const satisfies readonly BehaviorEffect[]);
    assert.equal(blocked.calls.random, 0);

    const moving = openBehavior();
    const running = moving.scheduler.step(moving.scheduler.initialState(), auto('run', 0, 500));
    const stopped = moving.scheduler.step(running.state, drag('start', 10));
    same(running.effects, [{ type: 'start', requestId: 'run', clip: 'auto' }] as const satisfies readonly BehaviorEffect[]);
    same(stopped.effects, [
      { type: 'cancel', requestId: 'run', reason: 'drag' },
      { type: 'idle' },
    ] as const satisfies readonly BehaviorEffect[]);
    assert.equal(stopped.effects.some((effect) => effect.type === 'start'), false);

    const held = openBehavior();
    const clickStep = held.scheduler.step(held.scheduler.initialState(), click('c', 0));
    const queued = held.scheduler.step(clickStep.state, auto('wait', 1, 10_000));
    const dragStart = held.scheduler.step(queued.state, drag('start', 2));
    const during = held.scheduler.step(dragStart.state, auto('nope', 3, 10_000));
    const dragEnd = held.scheduler.step(during.state, drag('end', 4));
    const finished = held.scheduler.step(dragEnd.state, settled('c', true, 5));
    same(queued.effects, []);
    assert.equal(queued.pending, 1);
    same(dragStart.effects, []);
    assert.equal(dragStart.pending, 1);
    same(during.effects, [{ type: 'cancel', requestId: 'nope', reason: 'drag' }] as const satisfies readonly BehaviorEffect[]);
    assert.equal(during.pending, 1);
    same(dragEnd.effects, []);
    assert.equal(dragEnd.pending, 1);
    same(finished.effects, [
      { type: 'idle' },
      { type: 'start', requestId: 'wait', clip: 'auto' },
    ] as const satisfies readonly BehaviorEffect[]);
    assert.equal(finished.pending, 0);
    assert.equal(held.calls.random, 0);
    assert.equal(blocked.calls.now, 0);
    assert.equal(moving.calls.now, 0);
    assert.equal(held.calls.now, 0);
  });

  contractTest('expired-action', () => {
    const boundary = openBehavior();
    const equal = boundary.scheduler.step(boundary.scheduler.initialState(), auto('late', 10, 10));
    same(equal.effects, [{ type: 'cancel', requestId: 'late', reason: 'expired' }] as const satisfies readonly BehaviorEffect[]);
    assert.equal(equal.pending, 0);
    const earlier = boundary.scheduler.step(boundary.scheduler.initialState(), auto('ok', 9, 10));
    same(earlier.effects, [{ type: 'start', requestId: 'ok', clip: 'auto' }] as const satisfies readonly BehaviorEffect[]);
    const clickAtExpiry = boundary.scheduler.step(boundary.scheduler.initialState(), click('tap', 10, 10));
    same(clickAtExpiry.effects, [{ type: 'start', requestId: 'tap', clip: 'reaction' }] as const satisfies readonly BehaviorEffect[]);

    const pending = openBehavior();
    const held = pending.scheduler.step(pending.scheduler.initialState(), click('hold', 0));
    const queued = pending.scheduler.step(held.state, auto('pending', 0, 100));
    const expired = pending.scheduler.step(queued.state, settled('hold', true, 100));
    assert.equal(queued.pending, 1);
    same(expired.effects, [
      { type: 'cancel', requestId: 'pending', reason: 'expired' },
      { type: 'idle' },
    ] as const satisfies readonly BehaviorEffect[]);
    assert.equal(expired.pending, 0);

    const live = openBehavior();
    const liveHeld = live.scheduler.step(live.scheduler.initialState(), click('hold', 0));
    const liveQueued = live.scheduler.step(liveHeld.state, auto('pending', 0, 100));
    const started = live.scheduler.step(liveQueued.state, settled('hold', true, 99));
    same(started.effects, [
      { type: 'idle' },
      { type: 'start', requestId: 'pending', clip: 'auto' },
    ] as const satisfies readonly BehaviorEffect[]);
    assert.equal(live.calls.random, 0);

    const duringDrag = openBehavior();
    const dragStart = duringDrag.scheduler.step(duringDrag.scheduler.initialState(), drag('start', 0));
    const whileDragging = duringDrag.scheduler.step(dragStart.state, auto('old', 50, 50));
    same(whileDragging.effects, [{ type: 'cancel', requestId: 'old', reason: 'expired' }] as const satisfies readonly BehaviorEffect[]);

    const afterDrag = openBehavior();
    const clickStep = afterDrag.scheduler.step(afterDrag.scheduler.initialState(), click('hold', 0));
    const waiting = afterDrag.scheduler.step(clickStep.state, auto('soon', 0, 50));
    const dragging = afterDrag.scheduler.step(waiting.state, drag('start', 10));
    const idleDuringDrag = afterDrag.scheduler.step(dragging.state, settled('hold', true, 20));
    const dragEnd = afterDrag.scheduler.step(idleDuringDrag.state, drag('end', 50));
    same(idleDuringDrag.effects, [{ type: 'idle' }] as const satisfies readonly BehaviorEffect[]);
    assert.equal(idleDuringDrag.pending, 1);
    same(dragEnd.effects, [{ type: 'cancel', requestId: 'soon', reason: 'expired' }] as const satisfies readonly BehaviorEffect[]);
    assert.equal(dragEnd.pending, 0);
    assert.equal(dragEnd.effects.some((effect) => effect.type === 'start'), false);
    assert.equal(boundary.calls.now, 0);
    assert.equal(pending.calls.now, 0);
    assert.equal(live.calls.now, 0);
    assert.equal(duringDrag.calls.now, 0);
    assert.equal(afterDrag.calls.now, 0);
    assert.equal(boundary.calls.random, 0);
  });

  contractTest('bounded-history', async () => {
    assert.equal(BEHAVIOR_LIMITS.pending, 8);
    assert.equal(BEHAVIOR_LIMITS.history, 32);

    const isolated = openBehavior();
    const s0 = isolated.scheduler.initialState();
    const s1 = isolated.scheduler.initialState();
    const from0 = isolated.scheduler.step(s0, click('a', 0));
    const from0Again = isolated.scheduler.step(s0, click('a', 0));
    assert.notEqual(from0.state, s0);
    assert.notEqual(from0.state, from0Again.state);
    same(from0.effects, from0Again.effects);
    const untouched = isolated.scheduler.step(s0, click('b', 1));
    same(untouched.effects, [{ type: 'start', requestId: 'b', clip: 'reaction' }] as const satisfies readonly BehaviorEffect[]);
    const carried = isolated.scheduler.step(from0.state, click('b', 1));
    same(carried.effects, [
      { type: 'cancel', requestId: 'a', reason: 'superseded' },
      { type: 'start', requestId: 'b', clip: 'reaction' },
    ] as const satisfies readonly BehaviorEffect[]);
    const fresh = isolated.scheduler.step(s1, click('a', 0));
    same(fresh.effects, [{ type: 'start', requestId: 'a', clip: 'reaction' }] as const satisfies readonly BehaviorEffect[]);

    const capacity = openBehavior([0, 0, 0, 0, 0, 0, 0]);
    let state = capacity.scheduler.step(capacity.scheduler.initialState(), click('hold', 0)).state;
    for (let i = 0; i < 10; i += 1) {
      const queued = capacity.scheduler.step(state, auto(`a${i}`, 0, 10_000));
      same(queued.effects, []);
      assert.equal(queued.pending, Math.min(i + 1, BEHAVIOR_LIMITS.pending));
      state = queued.state;
    }
    const expected = ['a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'];
    let active = 'hold';
    for (let i = 0; i < expected.length; i += 1) {
      const expectedId = expected[i];
      assert.ok(expectedId);
      const settledStep = capacity.scheduler.step(state, settled(active, true, 1));
      same(settledStep.effects, [
        { type: 'idle' },
        { type: 'start', requestId: expectedId, clip: 'auto' },
      ] as const satisfies readonly BehaviorEffect[]);
      active = expectedId;
      state = settledStep.state;
    }
    assert.equal(capacity.calls.random, 7);
    const tail = capacity.scheduler.step(state, settled('a9', true, 1));
    same(tail.effects, [{ type: 'idle' }] as const satisfies readonly BehaviorEffect[]);
    assert.equal(tail.pending, 0);
    assert.equal(capacity.calls.random, 7);

    const picker = openBehavior([0.99]);
    const pickerHeld = picker.scheduler.step(picker.scheduler.initialState(), click('hold', 0));
    let pickerState = pickerHeld.state;
    for (const id of ['p0', 'p1', 'p2']) {
      const queued = picker.scheduler.step(pickerState, auto(id, 1, 10_000));
      pickerState = queued.state;
    }
    const picked = picker.scheduler.step(pickerState, settled('hold', true, 2));
    same(picked.effects, [
      { type: 'idle' },
      { type: 'start', requestId: 'p2', clip: 'auto' },
    ] as const satisfies readonly BehaviorEffect[]);
    assert.equal(picked.pending, 2);
    assert.equal(picker.calls.random, 1);

    const history = openBehavior();
    let historyState = history.scheduler.initialState();
    for (let i = 0; i < 40; i += 1) {
      const started = history.scheduler.step(historyState, click(`c${i}`, i));
      assert.equal(started.effects.some((effect) => effect.type === 'start' && effect.requestId === `c${i}`), true);
      const settledStep = history.scheduler.step(started.state, settled(`c${i}`, true, i));
      same(settledStep.effects, [{ type: 'idle' }] as const satisfies readonly BehaviorEffect[]);
      assert.equal(settledStep.pending, 0);
      assert.equal(settledStep.history, Math.min(i + 1, BEHAVIOR_LIMITS.history));
      historyState = settledStep.state;
    }
    assert.equal(history.scheduler.step(historyState, click('extra', 100)).effects.some((effect) => effect.type === 'start' && effect.requestId === 'extra'), true);

    const media = openMedia();
    const url = candidateManifest().outputPath;
    assert.equal(SHIPPED.has(url), false);
    for (let i = 0; i < 20; i += 1) media.adapter.begin(play(`m${i}`, url, 'reaction', true));
    const tokens = Array.from({ length: 20 }, (_, index) => media.tokenFor(`m${index}`));
    assert.equal(new Set(tokens.map((token) => token.slot)).size, 2);
    for (const token of tokens) assert.equal(token.slot === 0 || token.slot === 1, true);
    const firstToken = tokens[0];
    assert.ok(firstToken);
    assert.equal(tokens.some((token) => token.slot === firstToken.slot && token.generation > firstToken.generation), true);
    for (let i = 0; i < 19; i += 1) await settle(media, `m${i}`, { ok: true });
    same(media.notices, []);
    await settle(media, 'm19', { ok: true });
    same(noticeKeys(media.notices), ['m19:prepared', 'm19:shown', 'm19:playing']);
    assert.equal(isolated.calls.now, 0);
    assert.equal(capacity.calls.now, 0);
    assert.equal(picker.calls.now, 0);
    assert.equal(history.calls.now, 0);
  });
});

test('每个必需用例都登记了一次，并且标出了仍需真实 B 或 C 的名字', () => {
  same([...covered].sort(), [...REQUIRED_CONTRACT_CASES].sort());
  const marked = [...new Set<RequiredContractCase>([...NEEDS_REAL.B, ...NEEDS_REAL.C])].sort();
  same(marked, [...REQUIRED_CONTRACT_CASES].sort());
  const needsB: readonly RequiredContractCase[] = NEEDS_REAL.B;
  const needsC: readonly RequiredContractCase[] = NEEDS_REAL.C;
  assert.equal(needsB.includes('preheat-races-click'), true);
  assert.equal(needsC.includes('preheat-races-click'), false);
  assert.equal(needsB.includes('callback-after-dispose'), true);
  assert.equal(needsC.includes('callback-after-dispose'), false);
  assert.equal(needsC.includes('drag-blocks-auto'), true);
  assert.equal(needsB.includes('drag-blocks-auto'), false);
  assert.equal(needsC.includes('expired-action'), true);
  assert.equal(needsB.includes('expired-action'), false);
});

/** 比较值，但不把实参收窄成期望字面量。`assert.deepEqual` 的断言签名会让后续检查变成 `never`。 */
function same(actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected);
}

function contractTest(name: RequiredContractCase, fn: () => Promise<void> | void): void {
  if (covered.includes(name)) throw new Error(`duplicate case ${name}`);
  covered.push(name);
  test(name, fn);
}

function openMedia(mode: TwoSlotAdapter['mode'] = 'two-slot'): MediaHarness {
  return createContractMedia({
    mode,
    clock: new FakeClock(),
    timeoutMs: TIMEOUT_MS,
    onNotice() {},
  });
}

function openBehavior(randomValues: readonly number[] = []) {
  const calls = { random: 0, now: 0 };
  const scheduler = createContractBehavior({
    nowMs() {
      calls.now += 1;
      throw new Error('step 只能使用输入里的 nowMs');
    },
    random() {
      const value = randomValues[calls.random];
      calls.random += 1;
      if (value === undefined) throw new Error(`unexpected random() #${calls.random}`);
      return value;
    },
  });
  return { scheduler, calls };
}

function play(requestId: string, url: string, clip: SlotClip, once: boolean): SlotPlayRequest {
  return { requestId, url, clip, once };
}

function click(requestId: string, nowMs: number, expiresAtMs = nowMs + 10_000): BehaviorInput {
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

async function settle(media: MediaHarness, requestId: string, result: PrepareResult): Promise<void> {
  media.settlePrepare(requestId, result);
  await flush();
}

function noticeKeys(notices: readonly TwoSlotNotice[]): string[] {
  return notices.map((notice) => `${notice.requestId}:${notice.type}`);
}

function candidateManifest(): AssetCandidateManifest {
  return {
    role: 'reaction',
    kind: 'displacement-fallback',
    sourcePath: SHIPPED_IDLE,
    sourceSha256: 'source-not-a-real-hash',
    outputPath: 'assets/candidates/reaction-shift.webm',
    outputSha256: 'output-not-a-real-hash',
    plates: [
      { background: 'light', imagePath: 'assets/candidates/light.png' },
      { background: 'dark', imagePath: 'assets/candidates/dark.png' },
      { background: 'checker', imagePath: 'assets/candidates/checker.png' },
    ],
    command: ['ffmpeg', '-i', SHIPPED_IDLE],
    limitation: '这不是修复原视频，只是在现有透明待机上做位移。',
  };
}

function assertCandidate(manifest: AssetCandidateManifest): void {
  assert.equal(SHIPPED.has(manifest.outputPath), false);
  same(
    manifest.plates.map((plate) => plate.background),
    [...REQUIRED_BACKGROUNDS],
  );
  assert.equal(manifest.kind, 'displacement-fallback');
  assert.equal(typeof manifest.limitation === 'string' && manifest.limitation.length > 0, true);
}
