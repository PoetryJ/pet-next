/**
 * 槽回调的世代与身份核对。对不上的回调不能切换画面，也不能结算新请求。
 */
import type { SlotFailureReason, SlotToken } from '../../../contracts/media-slot.ts';

/** 回调是否仍属于当前这次准备。销毁、世代或槽任一不符都丢弃。 */
export function tokenIsCurrent(live: SlotToken | null, callback: SlotToken, disposed: boolean): boolean {
  if (disposed || live === null) return false;
  return live.slot === callback.slot && live.generation === callback.generation;
}

/** 把加载器拒绝原因收成契约里的三种。未标明的按资源加载失败。 */
export function readFailureReason(error: unknown): SlotFailureReason {
  if (typeof error === 'object' && error !== null && 'reason' in error) {
    const reason = error.reason;
    if (reason === 'decode-error' || reason === 'asset-load' || reason === 'timeout') return reason;
  }
  return 'asset-load';
}

/**
 * 内核报告里的失败原因落到槽通知。
 * `play-rejected` 不在槽契约里，按解码失败报告，避免另造一种原因。
 */
export function noticeFailureReason(reason: string | undefined): SlotFailureReason {
  if (reason === 'decode-error' || reason === 'asset-load' || reason === 'timeout') return reason;
  return 'decode-error';
}
