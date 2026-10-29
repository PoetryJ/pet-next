/**
 * 两个槽的运行时。只保存调用方交来的表面，不创建新的媒体元素。
 */
import type { LoadToken, MediaClock } from '../types.ts';
import type { MediaSlotIndex, SlotPlayRequest, SlotToken, TwoSlotNotice } from '../../../contracts/media-slot.ts';
import type { PlaybackEvent, PlaybackState } from '../../../core/playback/types.ts';
import type { SlotSurface } from './types.ts';

export interface SlotOperation {
  readonly token: SlotToken;
  readonly kernelGeneration: number | null;
  readonly request: SlotPlayRequest;
  readonly kind: 'play' | 'preheat';
  phase: 'loading' | 'ready' | 'playing' | 'failed';
  readonly attempt: number;
}

export interface ResidentSource {
  url: string;
  requestId: string;
  src: string;
}

export interface SlotRuntime {
  readonly index: MediaSlotIndex;
  readonly surface: SlotSurface;
  attempt: number;
  op: SlotOperation | null;
  resident: ResidentSource | null;
  heldSrc: string | null;
  timer: unknown;
  cancelFrame: (() => void) | null;
  loadToken: ActiveLoad | null;
}

export interface VisibleClip {
  readonly token: SlotToken;
  readonly requestId: string;
  readonly url: string;
}

/** 适配器闭包里的可变播放状态。停掉之后不再复用同一次驱动。 */
export interface TwoSlotDrive {
  readonly slots: readonly [SlotRuntime, SlotRuntime];
  readonly clock: MediaClock;
  readonly timeoutMs: number;
  kernel: PlaybackState;
  visible: VisibleClip | null;
  disposed: boolean;
  queuedPlay: SlotPlayRequest | null;
  /** 已经用于预热的 requestId。这些编号不能再开始播放。 */
  preheatIds: string[];
  epoch: number;
  emit(notice: TwoSlotNotice): void;
  dispatch(event: PlaybackEvent): void;
}

interface ActiveLoad extends LoadToken {
  abort(): void;
}

export function createSlots(surfaces: readonly [SlotSurface, SlotSurface]): readonly [SlotRuntime, SlotRuntime] {
  return [blankSlot(0, surfaces[0]), blankSlot(1, surfaces[1])];
}

export function slotAt(drive: TwoSlotDrive, index: MediaSlotIndex): SlotRuntime {
  const slot = drive.slots[index];
  if (!slot) throw new TypeError(`missing media slot ${index}`);
  return slot;
}

export function mintToken(drive: TwoSlotDrive, slot: MediaSlotIndex): SlotToken {
  drive.epoch += 1;
  return { slot, generation: drive.epoch };
}

export function findByKernel(
  drive: TwoSlotDrive,
  kernelGeneration: number,
): { index: MediaSlotIndex; slot: SlotRuntime; op: SlotOperation } | null {
  for (const slot of drive.slots) {
    if (slot.op?.kernelGeneration === kernelGeneration) return { index: slot.index, slot, op: slot.op };
  }
  return null;
}

export function findByRequest(drive: TwoSlotDrive, requestId: string): { index: MediaSlotIndex; slot: SlotRuntime; op: SlotOperation } | null {
  for (const slot of drive.slots) {
    if (slot.op?.request.requestId === requestId) return { index: slot.index, slot, op: slot.op };
  }
  return null;
}

/** 使进行中的加载失效。不暂停可见槽，也不清掉它的画面。 */
export function stopLoading(drive: TwoSlotDrive, slot: SlotRuntime): void {
  slot.attempt += 1;
  slot.loadToken?.abort();
  slot.loadToken = null;
  if (slot.timer !== null) {
    drive.clock.clear(slot.timer);
    slot.timer = null;
  }
  slot.cancelFrame?.();
  slot.cancelFrame = null;
}

export function detachHandlers(slot: SlotRuntime): void {
  slot.surface.element.onended = null;
  slot.surface.element.onerror = null;
}

export function assignSrc(slot: SlotRuntime, src: string): void {
  const element = slot.surface.element;
  if (slot.heldSrc !== null && slot.heldSrc !== src) slot.surface.loader.release(slot.heldSrc);
  slot.heldSrc = src;
  element.muted = true;
  if (element.src !== src) element.src = src;
}

export function createLoadToken(): ActiveLoad {
  const listeners: Array<() => void> = [];
  const token: ActiveLoad = {
    aborted: false,
    onAbort(listener) {
      if (token.aborted) listener();
      else listeners.push(listener);
    },
    abort() {
      if (token.aborted) return;
      token.aborted = true;
      for (const listener of listeners.splice(0)) listener();
    },
  };
  return token;
}

export function releaseSlot(drive: TwoSlotDrive, slot: SlotRuntime): void {
  stopLoading(drive, slot);
  detachHandlers(slot);
  slot.op = null;
  slot.resident = null;
  slot.surface.element.pause();
  slot.surface.element.removeAttribute('src');
  slot.surface.element.load();
  if (slot.heldSrc === null) return;
  const src = slot.heldSrc;
  slot.heldSrc = null;
  slot.surface.loader.release(src);
}

function blankSlot(index: MediaSlotIndex, surface: SlotSurface): SlotRuntime {
  return {
    index,
    surface,
    attempt: 0,
    op: null,
    resident: null,
    heldSrc: null,
    timer: null,
    cancelFrame: null,
    loadToken: null,
  };
}
