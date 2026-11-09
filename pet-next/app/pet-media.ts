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
import type { IdleSuspensionDebugState } from '../contracts/idle-suspension.ts';

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
  /**
   * M3-9：报告窗口隐藏状态。只有单槽 idle 会真的暂停；
   * 双槽/未开开关时是安全 no-op，并在观测面里写明原因。
   */
  setHidden(hidden: boolean): void;
  /** M3-9：只读观测面，供 e2e/bench 断言归属与次数。 */
  idleSuspensionState(): IdleSuspensionDebugState;
}

const PREHEAT_REQUEST_ID = 'preheat-reaction';

/** 开关关闭或双槽模式下的观测面；不参与任何播放决策。 */
function inactiveIdleState(reason: string): IdleSuspensionDebugState {
  return {
    enabled: false,
    revision: null,
    hidden: false,
    generation: null,
    phase: null,
    clip: null,
    lease: null,
    pauseCount: 0,
    resumeCount: 0,
    lastAction: 'none',
    lastSkipReason: reason,
  };
}

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
  /** M3-9：显式预览开关。缺省 false——不创建节能策略。 */
  idlePause?: boolean;
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
  idlePause?: boolean;
  onStatus(status: PetMediaStatus): void;
}): PetMedia {
  const media = createMediaAdapter({
    element: bindElement(options.primary),
    loader: createElementLoader(options.primary),
    clock: systemMediaClock(),
    timeoutMs: options.timeoutMs,
    idlePause: options.idlePause === true,
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
      media.begin({ playbackId: request.requestId, url: request.url, once: request.once, clip: request.clip });
    },
    showPlaceholder() {
      // M3-9：占位层接管后不再恢复被遮住的旧元素（CONTRACT 3）。
      media.releaseIdleLease('placeholder');
      showPlaceholder(options);
    },
    dispose() {
      media.dispose();
    },
    setHidden(hidden) {
      media.setHidden(hidden);
    },
    idleSuspensionState() {
      return media.idleSuspensionState();
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
    // M3-9：双槽不启用该预览（TASKS 明确），只保留观测面供断言，绝不暂停。
    setHidden() {},
    idleSuspensionState() {
      return inactiveIdleState('two-slot');
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
