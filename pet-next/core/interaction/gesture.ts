/**
 * 指针手势归约。位移达到调用方传入的阈值才算拖动。
 * 拖动松开和 pointercancel 都不产生点击。
 * @module pet-next/core/interaction/gesture
 */
import type { GestureEvent, GestureReduction, GestureState } from './types.ts';

/** 尚未按下的手势。 */
export function initialGestureState(): GestureState {
  return {
    phase: 'idle',
    pointerId: null,
    originX: 0,
    originY: 0,
    lastX: 0,
    lastY: 0,
    dragged: false,
  };
}

/**
 * 折叠一条指针事件。
 *
 * @param dragThresholdPx - 离按下点的直线距离达到该像素值即进入拖动。必须 ≥ 0。
 * @throws {RangeError} 阈值不是有限非负数时。
 */
export function reduceGesture(state: GestureState, event: GestureEvent, dragThresholdPx: number): GestureReduction {
  if (!Number.isFinite(dragThresholdPx) || dragThresholdPx < 0) {
    throw new RangeError('dragThresholdPx must be a finite number >= 0');
  }
  switch (event.type) {
    case 'pointerdown':
      return pointerDown(state, event.pointerId, event.x, event.y);
    case 'pointermove':
      return pointerMove(state, event, dragThresholdPx);
    case 'pointerup':
      return pointerUp(state, event.pointerId);
    case 'pointercancel':
      return pointerCancel(state, event.pointerId);
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

function pointerDown(state: GestureState, pointerId: number, x: number, y: number): GestureReduction {
  if (state.phase === 'tracking') return keep(state);
  return {
    state: {
      phase: 'tracking',
      pointerId,
      originX: x,
      originY: y,
      lastX: x,
      lastY: y,
      dragged: false,
    },
    effects: [],
  };
}

function pointerMove(
  state: GestureState,
  event: Extract<GestureEvent, { type: 'pointermove' }>,
  dragThresholdPx: number,
): GestureReduction {
  if (state.phase !== 'tracking' || event.pointerId !== state.pointerId) return keep(state);
  const { x, y } = event;
  if (!state.dragged) {
    if (Math.hypot(x - state.originX, y - state.originY) < dragThresholdPx) {
      return { state: { ...state, lastX: x, lastY: y }, effects: [] };
    }
    return {
      state: { ...state, lastX: x, lastY: y, dragged: true },
      effects: [
        { type: 'drag-start' },
        { type: 'drag-move', dx: x - state.originX, dy: y - state.originY },
      ],
    };
  }
  const dx = x - state.lastX;
  const dy = y - state.lastY;
  if (dx === 0 && dy === 0) return { state: { ...state, lastX: x, lastY: y }, effects: [] };
  return {
    state: { ...state, lastX: x, lastY: y },
    effects: [{ type: 'drag-move', dx, dy }],
  };
}

function pointerUp(state: GestureState, pointerId: number): GestureReduction {
  if (state.phase !== 'tracking' || pointerId !== state.pointerId) return keep(state);
  if (state.dragged) return { state: initialGestureState(), effects: [{ type: 'drag-end' }] };
  return { state: initialGestureState(), effects: [{ type: 'click' }] };
}

function pointerCancel(state: GestureState, pointerId: number): GestureReduction {
  if (state.phase !== 'tracking' || pointerId !== state.pointerId) return keep(state);
  if (state.dragged) return { state: initialGestureState(), effects: [{ type: 'drag-end' }] };
  return { state: initialGestureState(), effects: [] };
}

function keep(state: GestureState): GestureReduction {
  return { state, effects: [] };
}
