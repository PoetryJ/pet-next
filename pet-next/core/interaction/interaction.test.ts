/**
 * 点击/拖动边界、pointercancel、连续点击、回待机和失败降级。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { initialGestureState, reduceGesture } from './gesture.ts';
import type { GestureEvent, GestureState } from './types.ts';
import { initialPetSessionState, reducePetSession } from './session.ts';
import type { PetSessionState } from './types.ts';

function down(pointerId = 1, x = 0, y = 0): GestureEvent {
  return { type: 'pointerdown', pointerId, x, y };
}
function move(pointerId: number, x: number, y: number): GestureEvent {
  return { type: 'pointermove', pointerId, x, y };
}
function up(pointerId = 1, x = 0, y = 0): GestureEvent {
  return { type: 'pointerup', pointerId, x, y };
}
function cancel(pointerId = 1): GestureEvent {
  return { type: 'pointercancel', pointerId };
}

function applyGesture(events: GestureEvent[], threshold: number): { state: GestureState; types: string[] } {
  let state = initialGestureState();
  const types: string[] = [];
  for (const event of events) {
    const reduction = reduceGesture(state, event, threshold);
    state = reduction.state;
    types.push(...reduction.effects.map((effect) => effect.type));
  }
  return { state, types };
}

describe('reduceGesture', () => {
  test('未达阈值的松开是点击，刚好达到阈值则是拖动', () => {
    const click = applyGesture([down(), move(1, 2, 2), up(1, 2, 2)], 5);
    assert.deepEqual(click.types, ['click']);
    assert.equal(click.state.phase, 'idle');

    const edge = reduceGesture(
      reduceGesture(initialGestureState(), down(), 5).state,
      move(1, 3, 4),
      5,
    );
    assert.equal(edge.state.dragged, true);
    assert.deepEqual(
      edge.effects.map((effect) => effect.type),
      ['drag-start', 'drag-move'],
    );
    const dragMove = edge.effects.find((effect) => effect.type === 'drag-move');
    assert.equal(dragMove?.type, 'drag-move');
    if (dragMove?.type === 'drag-move') {
      assert.equal(dragMove.dx, 3);
      assert.equal(dragMove.dy, 4);
    }
    const released = reduceGesture(edge.state, up(1, 3, 4), 5);
    assert.deepEqual(
      released.effects.map((effect) => effect.type),
      ['drag-end'],
    );
    assert.equal(
      released.effects.some((effect) => effect.type === 'click'),
      false,
    );
  });

  test('超过阈值后的增量从上次采样计算，阈值本身是参数', () => {
    let state = reduceGesture(initialGestureState(), down(), 10).state;
    state = reduceGesture(state, move(1, 9, 0), 10).state;
    assert.equal(state.dragged, false);
    const crossed = reduceGesture(state, move(1, 10, 0), 10);
    assert.equal(crossed.state.dragged, true);
    const first = crossed.effects.find((effect) => effect.type === 'drag-move');
    assert.deepEqual(first, { type: 'drag-move', dx: 10, dy: 0 });
    const next = reduceGesture(crossed.state, move(1, 14, -2), 10);
    assert.deepEqual(next.effects, [{ type: 'drag-move', dx: 4, dy: -2 }]);
    const looser = applyGesture([down(), move(1, 9, 0), up(1, 9, 0)], 10);
    assert.deepEqual(looser.types, ['click']);
  });

  test('拖动松开和 pointercancel 都不点击', () => {
    const dragged = applyGesture([down(), move(1, 8, 0), cancel()], 5);
    assert.deepEqual(dragged.types, ['drag-start', 'drag-move', 'drag-end']);
    const pending = applyGesture([down(), move(1, 2, 0), cancel()], 5);
    assert.deepEqual(pending.types, []);
    assert.equal(pending.state.phase, 'idle');
    const bare = applyGesture([cancel(), up()], 5);
    assert.deepEqual(bare.types, []);
  });

  test('其它指针和按下期间的第二次按下被忽略', () => {
    let state = reduceGesture(initialGestureState(), down(1, 0, 0), 5).state;
    const otherDown = reduceGesture(state, down(2, 20, 20), 5);
    assert.equal(otherDown.state, state);
    const otherMove = reduceGesture(state, move(2, 30, 0), 5);
    assert.equal(otherMove.state, state);
    state = reduceGesture(state, move(1, 12, 0), 5).state;
    const otherUp = reduceGesture(state, up(2, 12, 0), 5);
    assert.equal(otherUp.state.dragged, true);
    assert.deepEqual(otherUp.effects, []);
  });

  test('负阈值被拒绝', () => {
    assert.throws(() => reduceGesture(initialGestureState(), down(), -1), RangeError);
  });
});

function runSession(events: Parameters<typeof reducePetSession>[1][]) {
  let state = initialPetSessionState();
  const effects: string[] = [];
  for (const event of events) {
    const reduction = reducePetSession(state, event);
    state = reduction.state;
    for (const effect of reduction.effects) {
      effects.push(effect.type === 'play' ? `${effect.clip}:${effect.requestId}` : 'placeholder');
    }
  }
  return { state, effects };
}

describe('reducePetSession', () => {
  test('开机进待机，点击升成回应，只有当前回应结束才回待机', () => {
    const booted = runSession([{ type: 'boot' }]);
    assert.deepEqual(booted.effects, ['idle:1']);
    assert.equal(booted.state.visual, 'idle');
    const again = reducePetSession(booted.state, { type: 'boot' });
    assert.equal(again.state, booted.state);
    assert.deepEqual(again.effects, []);

    const clicked = runSession([
      { type: 'boot' },
      { type: 'click' },
      { type: 'clip-ended', requestId: 1, clip: 'idle' },
      { type: 'clip-ended', requestId: 2, clip: 'reaction' },
    ]);
    assert.deepEqual(clicked.effects, ['idle:1', 'reaction:2', 'idle:3']);
    assert.equal(clicked.state.visual, 'idle');
  });

  test('连续点击以最新请求为准，旧 ended 和 failed 都不能回待机', () => {
    let state: PetSessionState = initialPetSessionState();
    const effects: string[] = [];
    const apply = (event: Parameters<typeof reducePetSession>[1]) => {
      const reduction = reducePetSession(state, event);
      state = reduction.state;
      effects.push(...reduction.effects.map((effect) => (effect.type === 'play' ? `${effect.clip}:${effect.requestId}` : 'placeholder')));
    };
    apply({ type: 'boot' });
    apply({ type: 'click' });
    apply({ type: 'click' });
    apply({ type: 'click' });
    apply({ type: 'clip-ended', requestId: 2, clip: 'reaction' });
    apply({ type: 'clip-failed', requestId: 3, clip: 'reaction' });
    apply({ type: 'clip-ended', requestId: 4, clip: 'reaction' });
    assert.deepEqual(effects, ['idle:1', 'reaction:2', 'reaction:3', 'reaction:4', 'idle:5']);
    assert.equal(state.requestId, 5);
    assert.equal(state.visual, 'idle');
  });

  test('回应失败尝试回待机；待机失败停在占位且不再自动重试', () => {
    const degraded = runSession([
      { type: 'boot' },
      { type: 'clip-failed', requestId: 1, clip: 'idle' },
      { type: 'clip-failed', requestId: 1, clip: 'idle' },
      { type: 'clip-ended', requestId: 1, clip: 'idle' },
    ]);
    assert.deepEqual(degraded.effects, ['idle:1', 'placeholder']);
    assert.equal(degraded.state.visual, 'placeholder');

    const afterClick = runSession([
      { type: 'boot' },
      { type: 'clip-failed', requestId: 1, clip: 'idle' },
      { type: 'click' },
      { type: 'clip-failed', requestId: 2, clip: 'reaction' },
      { type: 'clip-failed', requestId: 3, clip: 'idle' },
      { type: 'clip-failed', requestId: 3, clip: 'idle' },
      { type: 'clip-ended', requestId: 2, clip: 'reaction' },
    ]);
    assert.deepEqual(afterClick.effects, ['idle:1', 'placeholder', 'reaction:2', 'idle:3', 'placeholder']);
    assert.equal(
      afterClick.effects.filter((effect) => effect.startsWith('idle:')).length,
      2,
    );
  });
});
