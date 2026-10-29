/**
 * 核对通过后切换可见槽，再暂停旧槽并开始这次播放请求。
 */
import type { SlotOperation, SlotRuntime, TwoSlotDrive, VisibleClip } from './slot-runtime.ts';
import { detachHandlers, slotAt } from './slot-runtime.ts';
import { tokenIsCurrent } from './token.ts';

export function handoff(drive: TwoSlotDrive, operation: SlotOperation): void {
  const slot = slotAt(drive, operation.token.slot);
  if (drive.disposed || slot.op !== operation || operation.kind !== 'play') return;
  if (operation.kernelGeneration === null) return;
  const previous = drive.visible;
  const next: VisibleClip = {
    token: operation.token,
    requestId: operation.request.requestId,
    url: operation.request.url,
  };
  drive.visible = next;
  drive.emit({ type: 'shown', token: operation.token, requestId: operation.request.requestId });
  // 暂停必须落在切换之后，否则仍在显示的旧槽会被提前停掉。
  if (previous !== null && !tokenIsCurrent(next.token, previous.token, false)) pausePrevious(drive, previous);
  armPlayback(drive, slot, operation);
}

function pausePrevious(drive: TwoSlotDrive, previous: VisibleClip): void {
  const slot = slotAt(drive, previous.token.slot);
  detachHandlers(slot);
  slot.surface.element.pause();
  if (slot.op !== null && tokenIsCurrent(slot.op.token, previous.token, false)) slot.op = null;
}

function armPlayback(drive: TwoSlotDrive, slot: SlotRuntime, operation: SlotOperation): void {
  const element = slot.surface.element;
  const kernelGeneration = operation.kernelGeneration;
  if (kernelGeneration === null) return;
  element.loop = !operation.request.once;
  element.muted = true;
  element.onended = () => onEnded(drive, slot, operation, kernelGeneration);
  element.onerror = () => onDecodeError(drive, slot, operation, kernelGeneration);
  armFirstFrame(drive, slot, operation);
  void element.play().then(
    () => {
      if (!playbackStillCurrent(drive, slot, operation)) return;
      drive.dispatch({ type: 'playResolved', generation: kernelGeneration, ok: true });
    },
    () => {
      if (!playbackStillCurrent(drive, slot, operation)) return;
      drive.dispatch({ type: 'playResolved', generation: kernelGeneration, ok: false });
    },
  );
}

function onEnded(drive: TwoSlotDrive, slot: SlotRuntime, operation: SlotOperation, kernelGeneration: number): void {
  if (!playbackStillCurrent(drive, slot, operation)) return;
  if (!operation.request.once) {
    void slot.surface.element.play().catch(() => {
      if (!playbackStillCurrent(drive, slot, operation)) return;
      drive.dispatch({ type: 'failed', generation: kernelGeneration, reason: 'decode-error' });
    });
    return;
  }
  drive.dispatch({ type: 'ended', generation: kernelGeneration });
}

function onDecodeError(drive: TwoSlotDrive, slot: SlotRuntime, operation: SlotOperation, kernelGeneration: number): void {
  if (!playbackStillCurrent(drive, slot, operation)) return;
  drive.dispatch({ type: 'failed', generation: kernelGeneration, reason: 'decode-error' });
}

function armFirstFrame(drive: TwoSlotDrive, slot: SlotRuntime, operation: SlotOperation): void {
  slot.cancelFrame?.();
  let emitted = false;
  slot.cancelFrame = slot.surface.watchFirstFrame(() => {
    if (emitted || !playbackStillCurrent(drive, slot, operation)) return;
    emitted = true;
    drive.emit({ type: 'first-frame', token: operation.token, requestId: operation.request.requestId });
  });
}

function playbackStillCurrent(drive: TwoSlotDrive, slot: SlotRuntime, operation: SlotOperation): boolean {
  if (slot.op !== operation) return false;
  return tokenIsCurrent(drive.visible?.token ?? null, operation.token, drive.disposed);
}
