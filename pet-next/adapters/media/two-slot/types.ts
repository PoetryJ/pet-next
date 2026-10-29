/**
 * 双槽适配器的注入面。通知形状以媒体槽契约为准，这里只补元素、加载器和时钟。
 */
import type { MediaClock, MediaElement, MediaLoader } from '../types.ts';
import type { TwoSlotOptions } from '../../../contracts/media-slot.ts';

/** 一个媒体槽。适配器只接受调用方交来的两个，自己不再创建元素。 */
export interface SlotSurface {
  readonly element: MediaElement;
  readonly loader: MediaLoader;
  /**
   * 该槽下一帧可显示时调用 listener。
   * 返回取消函数。预热阶段适配器不会注册。
   */
  watchFirstFrame(listener: () => void): () => void;
}

export interface TwoSlotRuntime extends TwoSlotOptions {
  /** 来自预览解析。`single` 不走这个工厂。 */
  readonly mode: 'two-slot' | 'two-slot-preheat';
  readonly slots: readonly [SlotSurface, SlotSurface];
  readonly clock: MediaClock;
  /** 准备阶段超时，单位毫秒。到点仍未准备好则失败并保留可见画面。 */
  readonly timeoutMs: number;
}
