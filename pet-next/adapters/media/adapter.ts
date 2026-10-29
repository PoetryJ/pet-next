/**
 * 唯一的媒体加载、播放、取消和回调入口。副作用只发生在注入的元素、加载器和时钟上。
 * @module pet-next/adapters/media/adapter
 */
import type { MediaAdapter, MediaAdapterOptions } from './types.ts';

/** 创建媒体适配器。内核状态留在闭包内，调用方只看到 begin 和 dispose。 */
export function createMediaAdapter(_options: MediaAdapterOptions): MediaAdapter {
  throw new Error('not implemented');
}
