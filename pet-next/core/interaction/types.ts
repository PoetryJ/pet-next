/**
 * 点击、拖动和待机/回应切换的输入输出。坐标单位是像素。
 * @module pet-next/core/interaction/types
 */

export interface GestureState {
  phase: 'idle' | 'tracking';
  pointerId: number | null;
  originX: number;
  originY: number;
  lastX: number;
  lastY: number;
  /** 按下后位移已达到拖动阈值。 */
  dragged: boolean;
}

export type GestureEvent =
  | { type: 'pointerdown'; pointerId: number; x: number; y: number }
  | { type: 'pointermove'; pointerId: number; x: number; y: number }
  | { type: 'pointerup'; pointerId: number; x: number; y: number }
  | { type: 'pointercancel'; pointerId: number };

export type GestureEffect =
  | { type: 'click' }
  | { type: 'drag-start' }
  | { type: 'drag-move'; dx: number; dy: number }
  | { type: 'drag-end' };

export interface GestureReduction {
  state: GestureState;
  effects: readonly GestureEffect[];
}

export type ClipKind = 'idle' | 'reaction';

export type PetVisual = 'idle' | 'reaction' | 'placeholder';

export interface PetSessionState {
  /** 最新一次播放请求的编号。0 表示尚未开机。 */
  requestId: number;
  visual: PetVisual;
}

export type PetSessionEvent =
  | { type: 'boot' }
  | { type: 'click' }
  | { type: 'clip-ended'; requestId: number; clip: ClipKind }
  | { type: 'clip-failed'; requestId: number; clip: ClipKind };

export type PetSessionEffect = { type: 'play'; requestId: number; clip: ClipKind } | { type: 'placeholder' };

export interface PetSessionReduction {
  state: PetSessionState;
  effects: readonly PetSessionEffect[];
}
