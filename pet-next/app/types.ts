/**
 * 页面装配用的端口。app 只把核心事件接到这些副作用上。
 * @module pet-next/app/types
 */
import type { ClipKind, PetVisual } from '../core/interaction/types.ts';

export interface PetAssets {
  idleUrl: string;
  reactionUrl: string;
}

export interface PlayClip {
  requestId: number;
  clip: ClipKind;
  url: string;
  once: boolean;
}

export interface PetPorts {
  play(request: PlayClip): void;
  showPlaceholder(): void;
  moveBy(dx: number, dy: number): void;
  quit(): void;
  setVisual(visual: PetVisual, requestId: number): void;
  setDragging(dragging: boolean): void;
}
