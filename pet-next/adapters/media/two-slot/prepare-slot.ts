/**
 * 在隐藏槽上准备下一次画面。失败只作废这次准备，不撤掉正在显示的槽。
 */
import type { MediaSlotIndex, SlotFailureReason, SlotPlayRequest } from '../../../contracts/media-slot.ts';
import { canReusePreparedSource, rememberPreheatRequest, selectPlaySlot, selectPreheatSlot } from './select-slot.ts';
import {
  assignSrc,
  createLoadToken,
  mintToken,
  slotAt,
  stopLoading,
  type SlotOperation,
  type SlotRuntime,
  type TwoSlotDrive,
} from './slot-runtime.ts';
import { readFailureReason } from './token.ts';

export function startPlayPrepare(drive: TwoSlotDrive, kernelGeneration: number): void {
  const request = drive.queuedPlay;
  if (request === null || drive.disposed) return;
  const visibleIndex = drive.visible?.token.slot ?? null;
  const slotIndex = selectPlaySlot(visibleIndex, reusableUrls(drive), request);
  if (visibleIndex !== null && slotIndex === visibleIndex) return;
  beginOnSlot(drive, slotIndex, request, 'play', kernelGeneration);
}

export function startPreheat(drive: TwoSlotDrive, request: SlotPlayRequest): void {
  if (drive.disposed) return;
  const visibleIndex = drive.visible?.token.slot ?? null;
  const slotIndex = selectPreheatSlot(visibleIndex, playBusy(drive));
  if (slotIndex === null) return;
  beginOnSlot(drive, slotIndex, request, 'preheat', null);
}

function beginOnSlot(
  drive: TwoSlotDrive,
  slotIndex: MediaSlotIndex,
  request: SlotPlayRequest,
  kind: 'play' | 'preheat',
  kernelGeneration: number | null,
): void {
  const slot = slotAt(drive, slotIndex);
  if (kind === 'preheat') rememberPreheatRequest(drive.preheatIds, request.requestId);
  const decision = canReusePreparedSource(residentIdentity(slot), request, inflightIdentity(slot));
  if (decision !== 'inflight') {
    stopLoading(drive, slot);
    slot.op = null;
    slot.surface.element.onended = null;
    slot.surface.element.onerror = null;
    if (decision === 'load') slot.resident = null;
  }
  if (decision === 'load') slot.attempt += 1;
  const operation: SlotOperation = {
    token: mintToken(drive, slotIndex),
    kernelGeneration,
    request,
    kind,
    phase: 'loading',
    attempt: slot.attempt,
  };
  slot.op = operation;
  if (decision === 'resident') {
    settleReady(drive, slot, operation);
    return;
  }
  if (decision === 'inflight') {
    armTimer(drive, slot, operation);
    return;
  }
  startLoad(drive, slot, slotIndex, operation);
}

function startLoad(drive: TwoSlotDrive, slot: SlotRuntime, slotIndex: MediaSlotIndex, operation: SlotOperation): void {
  armTimer(drive, slot, operation);
  const loadToken = createLoadToken();
  const attempt = slot.attempt;
  slot.loadToken = loadToken;
  void slot.surface.loader.load(operation.request.url, loadToken).then(
    (result) => {
      if (loadToken.aborted) return;
      finishLoad(drive, slotIndex, attempt, null, result.src);
    },
    (error: unknown) => {
      if (loadToken.aborted) return;
      const reason = readFailureReason(error);
      if (reason === 'asset-load' && isAborted(error)) return;
      finishLoad(drive, slotIndex, attempt, reason, null);
    },
  );
}

function finishLoad(
  drive: TwoSlotDrive,
  slotIndex: MediaSlotIndex,
  attempt: number,
  reason: SlotFailureReason | null,
  src: string | null,
): void {
  if (drive.disposed) return;
  const slot = slotAt(drive, slotIndex);
  if (slot.attempt !== attempt) return;
  const operation = slot.op;
  if (operation === null || operation.phase !== 'loading' || operation.attempt !== attempt) return;
  if (operation.token.slot !== slotIndex) return;
  clearTimer(drive, slot);
  if (reason !== null || src === null) {
    failPrepare(drive, slot, operation, reason ?? 'asset-load');
    return;
  }
  slot.resident = { url: operation.request.url, requestId: operation.request.requestId, src };
  assignSrc(slot, src);
  settleReady(drive, slot, operation);
}

function settleReady(drive: TwoSlotDrive, slot: SlotRuntime, operation: SlotOperation): void {
  if (drive.disposed || slot.op !== operation) return;
  operation.phase = 'ready';
  if (operation.kind === 'preheat') {
    // 预热只表示槽已备好。调用 play() 会进入 playing，这里必须停在暂停。
    const element = slot.surface.element;
    element.loop = false;
    element.onended = null;
    element.onerror = null;
    element.pause();
    drive.emit({ type: 'prepared', token: operation.token, requestId: operation.request.requestId });
    return;
  }
  drive.emit({ type: 'prepared', token: operation.token, requestId: operation.request.requestId });
  if (operation.kernelGeneration === null) return;
  drive.dispatch({ type: 'loaded', generation: operation.kernelGeneration });
}

function failPrepare(drive: TwoSlotDrive, slot: SlotRuntime, operation: SlotOperation, reason: SlotFailureReason): void {
  operation.phase = 'failed';
  slot.resident = null;
  if (operation.kind === 'preheat' || operation.kernelGeneration === null) {
    drive.emit({
      type: 'failed',
      token: operation.token,
      requestId: operation.request.requestId,
      reason,
      keptRequestId: drive.visible?.requestId ?? null,
    });
    return;
  }
  drive.dispatch({ type: 'failed', generation: operation.kernelGeneration, reason });
}

function armTimer(drive: TwoSlotDrive, slot: SlotRuntime, operation: SlotOperation): void {
  clearTimer(drive, slot);
  slot.timer = drive.clock.set(() => {
    slot.timer = null;
    if (drive.disposed || slot.op !== operation || operation.phase !== 'loading') return;
    if (operation.kind === 'preheat' || operation.kernelGeneration === null) {
      stopLoading(drive, slot);
      failPrepare(drive, slot, operation, 'timeout');
      return;
    }
    drive.dispatch({ type: 'failed', generation: operation.kernelGeneration, reason: 'timeout' });
  }, drive.timeoutMs);
}

function clearTimer(drive: TwoSlotDrive, slot: SlotRuntime): void {
  if (slot.timer === null) return;
  drive.clock.clear(slot.timer);
  slot.timer = null;
}

function reusableUrls(drive: TwoSlotDrive): [string | null, string | null] {
  return [reusableUrl(slotAt(drive, 0)), reusableUrl(slotAt(drive, 1))];
}

function reusableUrl(slot: SlotRuntime): string | null {
  if (slot.resident !== null) return slot.resident.url;
  if (slot.op?.kind === 'preheat' && slot.op.phase === 'loading') return slot.op.request.url;
  return null;
}

function residentIdentity(slot: SlotRuntime): { url: string; requestId: string } | null {
  if (slot.resident === null) return null;
  return { url: slot.resident.url, requestId: slot.resident.requestId };
}

function inflightIdentity(slot: SlotRuntime): { url: string; requestId: string; kind: 'play' | 'preheat' } | null {
  if (slot.op === null || slot.op.phase !== 'loading') return null;
  return { url: slot.op.request.url, requestId: slot.op.request.requestId, kind: slot.op.kind };
}

function playBusy(drive: TwoSlotDrive): [boolean, boolean] {
  return [isPlayBusy(slotAt(drive, 0)), isPlayBusy(slotAt(drive, 1))];
}

function isPlayBusy(slot: SlotRuntime): boolean {
  return slot.op?.kind === 'play' && (slot.op.phase === 'loading' || slot.op.phase === 'ready');
}

function isAborted(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'reason' in error && error.reason === 'aborted';
}
