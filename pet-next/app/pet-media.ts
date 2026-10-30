/**
 * 按预览选择单槽或双槽。
 * 未点名双槽时只绑定 `#clip`。准备失败且仍有画面时不改可见槽。
 * @module pet-next/app/pet-media
 */
import { createMediaAdapter, systemMediaClock } from '../adapters/media/adapter.ts';
import { createElementLoader } from '../adapters/media/element-loader.ts';
import type { MediaElement } from '../adapters/media/types.ts';
import { bindTwoSlotSurface, createTwoSlotAdapter, twoSlotModeForPreview } from '../adapters/media/two-slot/index.ts';
import type { PlaybackMode } from '../contracts/preview.ts';
import type { SlotClip } from '../contracts/media-slot.ts';

export interface PetMediaRequest {
  requestId: string;
  clip: SlotClip;
  url: string;
  once: boolean;
}

export interface PetMediaStatus {
  requestId: string;
  /** `resolved` 是准备完成、播放已兑现（仅单槽转发）；`ended`/`failed` 是终态。 */
  status: 'resolved' | 'ended' | 'failed';
  /** 双槽准备失败时仍在画面上的请求。单槽失败为 null。 */
  keptRequestId: string | null;
}

export interface PetMedia {
  begin(request: PetMediaRequest): void;
  showPlaceholder(): void;
  dispose(): void;
}

const PREHEAT_REQUEST_ID = 'preheat-reaction';

/**
 * 装配页面上的两个 video。`playback` 为 `single` 时不创建双槽适配器。
 *
 * @param timeoutMs - 准备阶段超时，毫秒。
 */
export function attachPetMedia(options: {
  playback: PlaybackMode;
  primary: HTMLVideoElement;
  standby: HTMLVideoElement;
  placeholder: HTMLImageElement;
  timeoutMs: number;
  reactionUrl: string;
  onStatus(status: PetMediaStatus): void;
}): PetMedia {
  const mode = twoSlotModeForPreview(options.playback);
  prepareElement(options.primary);
  prepareElement(options.standby);
  if (mode === null) return attachSingle(options);
  return attachTwoSlot(options, mode);
}

function attachSingle(options: {
  primary: HTMLVideoElement;
  standby: HTMLVideoElement;
  placeholder: HTMLImageElement;
  timeoutMs: number;
  onStatus(status: PetMediaStatus): void;
}): PetMedia {
  const media = createMediaAdapter({
    element: bindElement(options.primary),
    loader: createElementLoader(options.primary),
    clock: systemMediaClock(),
    timeoutMs: options.timeoutMs,
    onStatus(event) {
      if (event.status === 'playing') {
        showSlot(options, 0);
        options.onStatus({ requestId: event.playbackId, status: 'resolved', keptRequestId: null });
        return;
      }
      if (event.status !== 'ended' && event.status !== 'failed') return;
      options.onStatus({ requestId: event.playbackId, status: event.status, keptRequestId: null });
    },
  });
  return {
    begin(request) {
      media.begin({ playbackId: request.requestId, url: request.url, once: request.once });
    },
    showPlaceholder() {
      showPlaceholder(options);
    },
    dispose() {
      media.dispose();
    },
  };
}

function attachTwoSlot(
  options: {
    primary: HTMLVideoElement;
    standby: HTMLVideoElement;
    placeholder: HTMLImageElement;
    timeoutMs: number;
    reactionUrl: string;
    onStatus(status: PetMediaStatus): void;
  },
  mode: 'two-slot' | 'two-slot-preheat',
): PetMedia {
  const slots = [bindTwoSlotSurface(options.primary), bindTwoSlotSurface(options.standby)] as const;
  const media = createTwoSlotAdapter({
    mode,
    slots,
    clock: systemMediaClock(),
    timeoutMs: options.timeoutMs,
    onNotice(notice) {
      if (notice.type === 'shown') {
        showSlot(options, notice.token.slot);
        return;
      }
      if (notice.type === 'playing') {
        showSlot(options, notice.token.slot);
        return;
      }
      if (notice.type === 'ended') {
        options.onStatus({ requestId: notice.requestId, status: 'ended', keptRequestId: null });
        return;
      }
      if (notice.type === 'failed' && notice.requestId !== PREHEAT_REQUEST_ID) {
        options.onStatus({
          requestId: notice.requestId,
          status: 'failed',
          keptRequestId: notice.keptRequestId,
        });
      }
    },
  });
  if (mode === 'two-slot-preheat') {
    media.preheat({
      requestId: PREHEAT_REQUEST_ID,
      url: options.reactionUrl,
      once: true,
      clip: 'reaction',
    });
  }
  return {
    begin(request) {
      media.begin(request);
    },
    showPlaceholder() {
      showPlaceholder(options);
    },
    dispose() {
      media.dispose();
    },
  };
}

function showSlot(
  options: { primary: HTMLVideoElement; standby: HTMLVideoElement; placeholder: HTMLImageElement },
  slot: 0 | 1,
): void {
  options.placeholder.hidden = true;
  options.primary.hidden = slot !== 0;
  options.standby.hidden = slot !== 1;
}

function showPlaceholder(options: {
  primary: HTMLVideoElement;
  standby: HTMLVideoElement;
  placeholder: HTMLImageElement;
}): void {
  options.primary.hidden = true;
  options.standby.hidden = true;
  options.placeholder.hidden = false;
}

function prepareElement(video: HTMLVideoElement): void {
  video.muted = true;
  video.playsInline = true;
  video.autoplay = false;
}

/** DOM video 的事件签名和适配器契约不同，这里只转发适配器用到的成员。 */
function bindElement(video: HTMLVideoElement): MediaElement {
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
