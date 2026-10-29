/**
 * 页面装配：把手势、会话、媒体元素和预加载桥连起来。
 * 预览未点名时走已验收的单槽会话。双槽、行为和候选素材只在对应令牌下创建。
 * @module pet-next/app/page
 */
import { domScreenPointToDip } from '../adapters/window/pointer-point.ts';
import { parsePreview, PREVIEW_QUERY } from '../contracts/preview.ts';
import { createBehaviorPet, type BehaviorPet } from './behavior-pet.ts';
import './bridge.ts';
import { attachPetMedia, type PetMedia } from './pet-media.ts';
import { previewDataset } from './preview-gate.ts';
import { createPetController, parseClipRequest, type PetController } from './wire.ts';

const DRAG_THRESHOLD_PX = 5;
const LOAD_TIMEOUT_MS = 8000;
const CANDIDATE_REACTION = new URL('../assets/candidates/reaction/reaction.webm', location.href).href;

const params = new URLSearchParams(location.search);
const selection = parsePreview(params.get(PREVIEW_QUERY));
const idleUrl = params.get('idle') ?? new URL('../assets/idle.webm', location.href).href;
const shippedReaction = new URL('../assets/reaction.webm', location.href).href;
const reactionUrl = params.get('reaction') ?? (selection.candidate ? CANDIDATE_REACTION : shippedReaction);

const video = document.querySelector('#clip');
const standby = document.querySelector('#clip-next');
const placeholder = document.querySelector('#placeholder');
const petEl = document.querySelector('#pet');
if (
  !(video instanceof HTMLVideoElement) ||
  !(standby instanceof HTMLVideoElement) ||
  !(placeholder instanceof HTMLImageElement) ||
  !(petEl instanceof HTMLElement)
) {
  throw new Error('pet markup missing');
}

const previewMark = previewDataset(location.search);
if (previewMark !== null) {
  document.documentElement.dataset.previewRequested = previewMark.previewRequested;
  document.documentElement.dataset.previewActive = previewMark.previewActive;
}

const holder: { controller?: PetController; behavior?: BehaviorPet } = {};

const media: PetMedia = attachPetMedia({
  playback: selection.playback,
  primary: video,
  standby,
  placeholder,
  timeoutMs: LOAD_TIMEOUT_MS,
  reactionUrl,
  onStatus(event) {
    if (holder.behavior) {
      holder.behavior.onMedia(event);
      return;
    }
    const parsed = parseClipRequest(event.requestId);
    const controller = holder.controller;
    if (!parsed || !controller) return;
    if (event.status === 'ended') controller.notify({ type: 'clip-ended', requestId: parsed.requestId, clip: parsed.clip });
    if (event.status === 'failed') {
      controller.notify({ type: 'clip-failed', requestId: parsed.requestId, clip: parsed.clip });
    }
  },
});

const surface = {
  moveBy(dx: number, dy: number) {
    window.pet.moveBy(dx, dy);
  },
  quit() {
    media.dispose();
    window.pet.quit();
  },
  setVisual(visual: string, requestId: string) {
    document.documentElement.dataset.visual = visual;
    document.documentElement.dataset.request = requestId;
    if (previewMark !== null) {
      console.log(JSON.stringify({ event: 'preview', visual, requestId }));
    }
  },
  setTrace(trace: readonly string[]) {
    document.documentElement.dataset.trace = trace.join(',');
  },
  setDragging(dragging: boolean) {
    document.body.classList.toggle('dragging', dragging);
  },
};

if (selection.behavior) {
  const behavior = createBehaviorPet({
    media,
    idleUrl,
    reactionUrl,
    dragThresholdPx: DRAG_THRESHOLD_PX,
    moveBy: surface.moveBy,
    quit() {
      window.pet.quit();
    },
    setVisual: surface.setVisual,
    setTrace: surface.setTrace,
    setDragging: surface.setDragging,
  });
  holder.behavior = behavior;
  behavior.boot();
} else {
  const controller = createPetController({
    assets: { idleUrl, reactionUrl },
    dragThresholdPx: DRAG_THRESHOLD_PX,
    ports: {
      play(request) {
        media.begin({
          requestId: `${request.clip}:${request.requestId}`,
          clip: request.clip,
          url: request.url,
          once: request.once,
        });
      },
      showPlaceholder() {
        media.showPlaceholder();
      },
      moveBy: surface.moveBy,
      quit: surface.quit,
      setVisual(visual, requestId) {
        surface.setVisual(visual, String(requestId));
        surface.setTrace(holder.controller?.trace ?? []);
      },
      setDragging: surface.setDragging,
    },
  });
  holder.controller = controller;
  controller.boot();
}

petEl.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  ev.preventDefault();
  try {
    petEl.setPointerCapture(ev.pointerId);
  } catch {
    // 合成指针没有底层捕获时仍按坐标判定。
  }
  dispatchPointer(ev, 'pointerdown');
});

petEl.addEventListener('pointermove', (ev) => {
  dispatchPointer(ev, 'pointermove');
});

petEl.addEventListener('pointerup', (ev) => {
  dispatchPointer(ev, 'pointerup');
});

petEl.addEventListener('pointercancel', (ev) => {
  activePet().pointer({ type: 'pointercancel', pointerId: ev.pointerId });
});

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') activePet().quit();
  if ((ev.key === 'f' || ev.key === 'F') && holder.behavior) holder.behavior.failNext();
});

function activePet(): { pointer(event: Parameters<PetController['pointer']>[0]): void; quit(): void } {
  if (holder.behavior) return holder.behavior;
  if (holder.controller) return holder.controller;
  throw new Error('pet session missing');
}

function dispatchPointer(ev: PointerEvent, type: 'pointerdown' | 'pointermove' | 'pointerup'): void {
  const dip = domScreenPointToDip({ x: ev.screenX, y: ev.screenY });
  activePet().pointer({ type, pointerId: ev.pointerId, x: dip.x, y: dip.y });
}
