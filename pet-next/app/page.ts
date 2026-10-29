/**
 * 页面装配：把手势、会话、媒体元素和预加载桥连起来。
 * 不决定拖动阈值以外的策略，策略在 core。
 * @module pet-next/app/page
 */
import { createMediaAdapter, systemMediaClock } from '../adapters/media/adapter.ts';
import { createElementLoader } from '../adapters/media/element-loader.ts';
import type { MediaElement } from '../adapters/media/types.ts';
import { domScreenPointToDip } from '../adapters/window/pointer-point.ts';
import './bridge.ts';
import { createPetController, parseClipRequest, type PetController } from './wire.ts';

const DRAG_THRESHOLD_PX = 5;
const LOAD_TIMEOUT_MS = 8000;

const params = new URLSearchParams(location.search);
const idleUrl = params.get('idle') ?? new URL('../assets/idle.webm', location.href).href;
const reactionUrl = params.get('reaction') ?? new URL('../assets/reaction.webm', location.href).href;

const video = document.querySelector('#clip');
const placeholder = document.querySelector('#placeholder');
const petEl = document.querySelector('#pet');
if (!(video instanceof HTMLVideoElement) || !(placeholder instanceof HTMLImageElement) || !(petEl instanceof HTMLElement)) {
  throw new Error('pet markup missing');
}

video.muted = true;
video.playsInline = true;
video.autoplay = false;

const showClip = (): void => {
  placeholder.hidden = true;
  video.hidden = false;
};

const showPlaceholder = (): void => {
  video.hidden = true;
  placeholder.hidden = false;
};

const holder: { controller?: PetController } = {};

const media = createMediaAdapter({
  element: bindVideo(video),
  loader: createElementLoader(video),
  clock: systemMediaClock(),
  timeoutMs: LOAD_TIMEOUT_MS,
  onStatus(event) {
    const parsed = parseClipRequest(event.playbackId);
    const controller = holder.controller;
    if (!parsed || !controller) return;
    if (event.status === 'playing') {
      showClip();
      return;
    }
    if (event.status === 'ended') controller.notify({ type: 'clip-ended', requestId: parsed.requestId, clip: parsed.clip });
    if (event.status === 'failed') controller.notify({ type: 'clip-failed', requestId: parsed.requestId, clip: parsed.clip });
  },
});

const controller = createPetController({
  assets: { idleUrl, reactionUrl },
  dragThresholdPx: DRAG_THRESHOLD_PX,
  ports: {
    play(request) {
      media.begin({
        playbackId: `${request.clip}:${request.requestId}`,
        url: request.url,
        once: request.once,
      });
    },
    showPlaceholder() {
      showPlaceholder();
    },
    moveBy(dx, dy) {
      window.pet.moveBy(dx, dy);
    },
    quit() {
      media.dispose();
      window.pet.quit();
    },
    setVisual(visual, requestId) {
      document.documentElement.dataset.visual = visual;
      document.documentElement.dataset.request = String(requestId);
      document.documentElement.dataset.trace = (holder.controller?.trace ?? []).join(',');
    },
    setDragging(dragging) {
      document.body.classList.toggle('dragging', dragging);
    },
  },
});
holder.controller = controller;

petEl.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  ev.preventDefault();
  try {
    petEl.setPointerCapture(ev.pointerId);
  } catch {
    // 合成指针没有底层捕获时仍按坐标判定。
  }
  const dip = domScreenPointToDip({ x: ev.screenX, y: ev.screenY });
  controller.pointer({ type: 'pointerdown', pointerId: ev.pointerId, x: dip.x, y: dip.y });
});

petEl.addEventListener('pointermove', (ev) => {
  const dip = domScreenPointToDip({ x: ev.screenX, y: ev.screenY });
  controller.pointer({ type: 'pointermove', pointerId: ev.pointerId, x: dip.x, y: dip.y });
});

petEl.addEventListener('pointerup', (ev) => {
  const dip = domScreenPointToDip({ x: ev.screenX, y: ev.screenY });
  controller.pointer({ type: 'pointerup', pointerId: ev.pointerId, x: dip.x, y: dip.y });
});

petEl.addEventListener('pointercancel', (ev) => {
  controller.pointer({ type: 'pointercancel', pointerId: ev.pointerId });
});

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') controller.quit();
});

controller.boot();

/** DOM video 的事件签名和适配器契约不同，这里只转发适配器用到的成员。 */
function bindVideo(video: HTMLVideoElement): MediaElement {
  let onended: (() => void) | null = null;
  let onerror: (() => void) | null = null;
  return {
    get src() {
      return video.src;
    },
    set src(value: string) {
      video.src = value;
    },
    get loop() {
      return video.loop;
    },
    set loop(value: boolean) {
      video.loop = value;
    },
    get muted() {
      return video.muted;
    },
    set muted(value: boolean) {
      video.muted = value;
    },
    get paused() {
      return video.paused;
    },
    get onended() {
      return onended;
    },
    set onended(handler: (() => void) | null) {
      onended = handler;
      video.onended = handler;
    },
    get onerror() {
      return onerror;
    },
    set onerror(handler: (() => void) | null) {
      onerror = handler;
      video.onerror = handler;
    },
    play() {
      return video.play();
    },
    pause() {
      video.pause();
    },
    load() {
      video.load();
    },
    removeAttribute(name: string) {
      video.removeAttribute(name);
    },
  };
}
