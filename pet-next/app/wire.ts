/**
 * 把指针、会话和端口接在一起。不碰 DOM 和 Electron。
 * @module pet-next/app/wire
 */
import { initialGestureState, reduceGesture } from '../core/interaction/gesture.ts';
import { initialPetSessionState, reducePetSession } from '../core/interaction/session.ts';
import type { ClipKind, GestureEvent, PetSessionEvent, PetVisual } from '../core/interaction/types.ts';
import type { PetAssets, PetPorts } from './types.ts';

export interface PetController {
  boot(): void;
  pointer(event: GestureEvent): void;
  notify(event: Extract<PetSessionEvent, { type: 'clip-ended' | 'clip-failed' }>): void;
  quit(): void;
  readonly trace: readonly string[];
  readonly requestId: number;
  readonly visual: PetVisual;
}

/** 从 `idle:3` 这种播放编号还原片段和请求。格式不对时返回 null。 */
export function parseClipRequest(playbackId: string): { clip: ClipKind; requestId: number } | null {
  const match = /^(idle|reaction):(\d+)$/.exec(playbackId);
  const clip = match?.[1];
  const rawId = match?.[2];
  if ((clip !== 'idle' && clip !== 'reaction') || rawId === undefined) return null;
  return { clip, requestId: Number(rawId) };
}

/**
 * 装配一只宠物的交互。
 *
 * @param dragThresholdPx - 传给手势归约的拖动阈值。
 */
export function createPetController(options: {
  assets: PetAssets;
  dragThresholdPx: number;
  ports: PetPorts;
}): PetController {
  let gesture = initialGestureState();
  let session = initialPetSessionState();
  const trace: string[] = [];
  let dragging = false;

  function applySession(event: PetSessionEvent): void {
    const reduction = reducePetSession(session, event);
    session = reduction.state;
    for (const effect of reduction.effects) {
      if (effect.type === 'play') {
        trace.push(`${effect.clip}:${effect.requestId}`);
        options.ports.setVisual(effect.clip, effect.requestId);
        const url = effect.clip === 'idle' ? options.assets.idleUrl : options.assets.reactionUrl;
        options.ports.play({
          requestId: effect.requestId,
          clip: effect.clip,
          url,
          once: effect.clip === 'reaction',
        });
      } else {
        trace.push('placeholder');
        options.ports.setVisual('placeholder', session.requestId);
        options.ports.showPlaceholder();
      }
    }
  }

  function setDragging(next: boolean): void {
    if (dragging === next) return;
    dragging = next;
    options.ports.setDragging(next);
  }

  return {
    boot() {
      applySession({ type: 'boot' });
    },
    pointer(event) {
      const reduction = reduceGesture(gesture, event, options.dragThresholdPx);
      gesture = reduction.state;
      for (const effect of reduction.effects) {
        if (effect.type === 'click') applySession({ type: 'click' });
        else if (effect.type === 'drag-start') setDragging(true);
        else if (effect.type === 'drag-end') setDragging(false);
        else if (effect.type === 'drag-move') options.ports.moveBy(effect.dx, effect.dy);
      }
    },
    notify(event) {
      applySession(event);
    },
    quit() {
      options.ports.quit();
    },
    get trace() {
      return trace;
    },
    get requestId() {
      return session.requestId;
    },
    get visual() {
      return session.visual;
    },
  };
}
