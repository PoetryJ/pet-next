/**
 * 指针手势归约。阈值由调用方传入，拖动松开和 pointercancel 不产生点击。
 * @module pet-next/core/interaction/gesture
 */
import type { GestureEvent, GestureReduction, GestureState } from './types.ts';

/** 尚未按下的手势。 */
export function initialGestureState(): GestureState {
  throw new Error('not implemented');
}

/**
 * 折叠一条指针事件。
 *
 * @param dragThresholdPx - 按下到松开的位移达到该像素值才算拖动。
 */
export function reduceGesture(
  _state: GestureState,
  _event: GestureEvent,
  _dragThresholdPx: number,
): GestureReduction {
  throw new Error('not implemented');
}
