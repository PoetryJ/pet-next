/**
 * 在两个槽之间选准备目标，并区分资源复用与播放请求复用。
 */
import { MEDIA_SLOT_COUNT, type MediaSlotIndex, type SlotPlayRequest } from '../../../contracts/media-slot.ts';
import type { PlaybackMode } from '../../../contracts/preview.ts';

const PREHEAT_ID_LIMIT = 32;

/** `single` 返回 null，调用方继续用现有单槽适配器。 */
export function twoSlotModeForPreview(playback: PlaybackMode): 'two-slot' | 'two-slot-preheat' | null {
  if (playback === 'two-slot' || playback === 'two-slot-preheat') return playback;
  return null;
}

export function oppositeSlot(slot: MediaSlotIndex): MediaSlotIndex {
  return slot === 0 ? 1 : 0;
}

/** 预热占用非可见槽。该槽正在准备播放时不再抢，避免开出第三个槽。 */
export function selectPreheatSlot(
  visible: MediaSlotIndex | null,
  playBusy: readonly [boolean, boolean],
): MediaSlotIndex | null {
  const candidate: MediaSlotIndex = visible === null ? 1 : oppositeSlot(visible);
  if (playBusy[candidate]) return null;
  return candidate;
}

/** 有画面时只准备另一槽。没有画面时优先复用已经装好同一地址的槽。 */
export function selectPlaySlot(
  visible: MediaSlotIndex | null,
  residentUrl: readonly [string | null, string | null],
  request: SlotPlayRequest,
): MediaSlotIndex {
  if (visible !== null) return oppositeSlot(visible);
  if (residentUrl[1] === request.url) return 1;
  if (residentUrl[0] === request.url) return 0;
  return 0;
}

export function canReusePreparedSource(
  resident: { url: string; requestId: string } | null,
  request: SlotPlayRequest,
  inflight: { url: string; requestId: string; kind: 'play' | 'preheat' } | null,
): 'resident' | 'inflight' | 'load' {
  if (resident !== null && resident.url === request.url && resident.requestId !== request.requestId && inflight === null) {
    return 'resident';
  }
  if (
    inflight !== null &&
    inflight.kind === 'preheat' &&
    inflight.url === request.url &&
    inflight.requestId !== request.requestId
  ) {
    return 'inflight';
  }
  return 'load';
}

/** 预热用过的 requestId 不能再当作播放请求。只记住最近若干个。 */
export function rememberPreheatRequest(ids: string[], requestId: string): void {
  if (ids.includes(requestId)) return;
  ids.push(requestId);
  if (ids.length > PREHEAT_ID_LIMIT) ids.shift();
}

export function blocksPlaybackRequest(preheatRequestIds: readonly string[], requestId: string): boolean {
  return preheatRequestIds.includes(requestId);
}

/** 运行时槽数必须等于契约上限。多出来的不能静默丢掉。 */
export function assertTwoSlots(count: number): void {
  if (count !== MEDIA_SLOT_COUNT) {
    throw new TypeError(`expected ${MEDIA_SLOT_COUNT} media slots, received ${count}`);
  }
}
