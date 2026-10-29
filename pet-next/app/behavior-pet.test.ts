/**
 * 预览行为会话：拖动不产生点击，失败的下一次回应使用缺失地址。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PetMedia, PetMediaRequest, PetMediaStatus } from './pet-media.ts';
import { createBehaviorPet } from './behavior-pet.ts';

test('点击打断自动动作，拖动只移动窗口，失败回应指向缺失地址', () => {
  let now = 0;
  const plays: PetMediaRequest[] = [];
  const visuals: string[] = [];
  const traces: string[] = [];
  const moves: Array<{ dx: number; dy: number }> = [];
  const dragging: boolean[] = [];
  let ticks = 0;
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
    dragThresholdPx: 5,
    nowMs: () => now,
    random: () => 0,
    schedule(_delay, tick) {
      ticks += 1;
      tick();
      return () => undefined;
    },
    moveBy(dx, dy) {
      moves.push({ dx, dy });
    },
    quit() {
      return undefined;
    },
    setVisual(visual) {
      visuals.push(visual);
    },
    setTrace(trace) {
      traces.push(trace.join(','));
    },
    setDragging(value) {
      dragging.push(value);
    },
  });
  pet.boot();
  assert.equal(ticks, 1);
  assert.equal(plays[0]?.clip, 'idle');
  assert.equal(plays[1]?.clip, 'auto');
  assert.equal(plays[1]?.url, 'react.webm');
  const autoId = plays[1]?.requestId;
  assert.ok(autoId);
  pet.pointer({ type: 'pointerdown', pointerId: 1, x: 0, y: 0 });
  pet.pointer({ type: 'pointerup', pointerId: 1, x: 1, y: 1 });
  const click = plays.at(-1);
  assert.equal(click?.clip, 'reaction');
  assert.equal(click?.url, 'react.webm');
  assert.notEqual(click?.requestId, autoId);
  pet.onMedia({ requestId: autoId, status: 'ended', keptRequestId: null } satisfies PetMediaStatus);
  pet.pointer({ type: 'pointerdown', pointerId: 1, x: 0, y: 0 });
  pet.pointer({ type: 'pointermove', pointerId: 1, x: 12, y: 4 });
  pet.pointer({ type: 'pointerup', pointerId: 1, x: 12, y: 4 });
  assert.deepEqual(moves, [{ dx: 12, dy: 4 }]);
  assert.deepEqual(dragging, [true, false]);
  assert.equal(plays.filter((play) => play.clip === 'reaction').length, 1);
  now = 5_000;
  pet.failNext();
  const failed = plays.at(-1);
  assert.equal(failed?.clip, 'reaction');
  assert.equal(failed?.url, 'file:///tmp/pet-next-preview-missing-reaction.webm');
  const failedId = failed?.requestId;
  assert.ok(failedId);
  const beforeIdle = plays.length;
  pet.onMedia({ requestId: failedId, status: 'failed', keptRequestId: null });
  assert.equal(plays[beforeIdle]?.clip, 'idle');
  assert.equal(plays[beforeIdle]?.url, 'idle.webm');
  assert.equal(visuals.at(-1), 'idle');
  assert.equal(traces.at(-1)?.includes('placeholder'), false);
});
