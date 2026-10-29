/**
 * 双槽播放的公共形状。现有单槽内核仍在 `adapters/media/`，本文件不替换它。
 * 实现只放在 `adapters/media/two-slot/`。默认启动不创建双槽适配器。
 * @module pet-next/contracts/media-slot
 */

/** 同时存在的媒体槽上限。预热占用其中一个槽，不能再开第三个。 */
export const MEDIA_SLOT_COUNT = 2 as const;

export type MediaSlotIndex = 0 | 1;

/** 一次准备或播放的槽身份。旧回调带过期 generation 时必须忽略。 */
export interface SlotToken {
  slot: MediaSlotIndex;
  generation: number;
}

export type SlotClip = 'idle' | 'reaction' | 'auto';

export type SlotFailureReason = 'asset-load' | 'decode-error' | 'timeout';

/**
 * 一次播放或预热请求。
 * 资源可以复用，请求不能复用：同一个 `url` 的下一次播放必须使用新的 `requestId`。
 */
export interface SlotPlayRequest {
  requestId: string;
  url: string;
  once: boolean;
  clip: SlotClip;
}

export type TwoSlotNotice =
  | { type: 'prepared'; token: SlotToken; requestId: string }
  | {
      type: 'failed';
      token: SlotToken;
      requestId: string;
      reason: SlotFailureReason;
      /** 仍在画面上的请求。准备失败不得把它换成空白。没有可见画面时为 null。 */
      keptRequestId: string | null;
    }
  | { type: 'shown'; token: SlotToken; requestId: string }
  | { type: 'playing'; token: SlotToken; requestId: string }
  | { type: 'ended'; token: SlotToken; requestId: string }
  | { type: 'first-frame'; token: SlotToken; requestId: string };

/**
 * 预热允许的通知。`playing` 和 `ended` 不在其中。
 * 预热完成只表示槽已准备，不是一次播放请求。
 */
export type PreheatNotice = Extract<TwoSlotNotice, { type: 'prepared' | 'failed' }>;

export interface TwoSlotOptions {
  /**
   * 槽事件。实现在切换前核对 `token` 与当前请求。
   * 对不上的回调不得改变可见画面，也不得结算新请求。
   */
  onNotice(notice: TwoSlotNotice): void;
}

export interface TwoSlotAdapter {
  readonly mode: 'two-slot' | 'two-slot-preheat';
  /** 显示中的槽开始让路：新槽准备，核对 generation 与槽身份，再切换并暂停旧槽。 */
  begin(request: SlotPlayRequest): void;
  /** 只准备 reaction 槽。不得因此发出 `playing` 或 `ended`。 */
  preheat(request: SlotPlayRequest): void;
  dispose(): void;
}

export type TwoSlotFactory = (options: TwoSlotOptions) => TwoSlotAdapter;
