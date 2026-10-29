/**
 * 候选双槽适配器：旧槽保持显示，新槽准备，核对世代与槽身份后再切换并暂停旧槽。
 * 不替换单槽内核；播放阶段仍交给 reducePlayback。预热不进入内核，因此不会发出 playing / ended。
 * 默认路径不创建本适配器。调用方只注入两个槽，准备失败时保留可见画面。
 * @module pet-next/adapters/media/two-slot
 */
import type { SlotPlayRequest, SlotToken, TwoSlotAdapter, TwoSlotNotice } from '../../../contracts/media-slot.ts';
import type { PlaybackEffect, PlaybackRequest } from '../../../core/playback/types.ts';
import { initialPlaybackState, reducePlayback } from '../../../core/playback/reduce.ts';
import { handoff } from './present-slot.ts';
import { startPlayPrepare, startPreheat } from './prepare-slot.ts';
import { assertTwoSlots, blocksPlaybackRequest } from './select-slot.ts';
import {
  createSlots,
  detachHandlers,
  findByKernel,
  findByRequest,
  releaseSlot,
  stopLoading,
  type TwoSlotDrive,
} from './slot-runtime.ts';
import { noticeFailureReason, tokenIsCurrent } from './token.ts';
import type { TwoSlotRuntime } from './types.ts';

/** 创建双槽适配器。`mode` 为 `two-slot` 时 preheat 不准备资源。 */
export function createTwoSlotAdapter(options: TwoSlotRuntime): TwoSlotAdapter {
  assertTwoSlots(options.slots.length);
  const first = options.slots[0];
  const second = options.slots[1];
  if (first === undefined || second === undefined) {
    throw new TypeError('expected 2 media slots');
  }
  const drive: TwoSlotDrive = {
    slots: createSlots([first, second]),
    clock: options.clock,
    timeoutMs: options.timeoutMs,
    kernel: initialPlaybackState(),
    visible: null,
    disposed: false,
    queuedPlay: null,
    preheatIds: [],
    epoch: 0,
    emit(notice) {
      if (drive.disposed) return;
      options.onNotice(notice);
    },
    dispatch(event) {
      const reduction = reducePlayback(drive.kernel, event);
      drive.kernel = reduction.state;
      for (const effect of reduction.effects) applyEffect(drive, effect);
    },
  };

  return {
    mode: options.mode,
    begin(request) {
      if (drive.disposed) return;
      if (blocksPlaybackRequest(drive.preheatIds, request.requestId)) return;
      if (drive.kernel.request?.playbackId === request.requestId) return;
      drive.queuedPlay = request;
      drive.dispatch({ type: 'begin', request: toKernelRequest(request) });
      drive.queuedPlay = null;
    },
    preheat(request) {
      if (drive.disposed || options.mode !== 'two-slot-preheat') return;
      if (request.clip !== 'reaction') return;
      if (blocksPlaybackRequest(drive.preheatIds, request.requestId)) return;
      startPreheat(drive, request);
    },
    dispose() {
      if (drive.kernel.phase === 'disposed') return;
      drive.disposed = true;
      drive.dispatch({ type: 'dispose' });
    },
  };
}

function applyEffect(drive: TwoSlotDrive, effect: PlaybackEffect): void {
  switch (effect.type) {
    case 'load':
      startPlayPrepare(drive, effect.generation);
      return;
    case 'play':
      playPrepared(drive, effect.generation);
      return;
    case 'abort':
      abortHidden(drive, effect.generation);
      return;
    case 'pause':
      // 内核只在冻结取消时暂停。双槽没有这条路径，可见槽要留到切换之后再停。
      return;
    case 'cleanup':
      cleanup(drive);
      return;
    case 'report':
      report(drive, effect);
      return;
    default: {
      const unreachable: never = effect;
      return unreachable;
    }
  }
}

function playPrepared(drive: TwoSlotDrive, kernelGeneration: number): void {
  const found = findByKernel(drive, kernelGeneration);
  if (found === null) return;
  if (found.op.token.slot !== found.index) return;
  handoff(drive, found.op);
}

function abortHidden(drive: TwoSlotDrive, kernelGeneration: number): void {
  const found = findByKernel(drive, kernelGeneration);
  if (found === null) return;
  if (tokenIsCurrent(drive.visible?.token ?? null, found.op.token, false)) return;
  stopLoading(drive, found.slot);
  detachHandlers(found.slot);
  if (drive.visible?.token.slot !== found.index) found.slot.surface.element.pause();
}

function report(drive: TwoSlotDrive, effect: Extract<PlaybackEffect, { type: 'report' }>): void {
  if (effect.status === 'cancelled') return;
  const found = findByRequest(drive, effect.playbackId);
  if (found === null || found.op.kind !== 'play' || drive.disposed) return;
  if (effect.status === 'playing' || effect.status === 'ended') {
    if (!tokenIsCurrent(drive.visible?.token ?? null, found.op.token, drive.disposed)) return;
    drive.emit({ type: effect.status, token: found.op.token, requestId: found.op.request.requestId });
    return;
  }
  drive.emit(failureNotice(drive, found.op.token, found.op.request.requestId, effect.reason));
  if (!tokenIsCurrent(drive.visible?.token ?? null, found.op.token, false)) found.slot.op = null;
}

function failureNotice(
  drive: TwoSlotDrive,
  token: SlotToken,
  requestId: string,
  reason: string | undefined,
): Extract<TwoSlotNotice, { type: 'failed' }> {
  return {
    type: 'failed',
    token,
    requestId,
    reason: noticeFailureReason(reason),
    keptRequestId: drive.visible?.requestId ?? null,
  };
}

function cleanup(drive: TwoSlotDrive): void {
  for (const slot of drive.slots) releaseSlot(drive, slot);
  drive.visible = null;
}

function toKernelRequest(request: SlotPlayRequest): PlaybackRequest {
  return {
    playbackId: request.requestId,
    asset: { url: request.url, once: request.once },
  };
}
