/**
 * 把一个现成的 video 收成槽表面。不创建元素；第二个槽由页面标记提供。
 */
import { createElementLoader } from '../element-loader.ts';
import type { MediaElement } from '../types.ts';
import type { SlotSurface } from './types.ts';

/** 绑定调用方已经放进文档的 video。 */
export function bindTwoSlotSurface(video: HTMLVideoElement): SlotSurface {
  return {
    element: bindElement(video),
    loader: createElementLoader(video),
    watchFirstFrame(listener) {
      if (typeof video.requestVideoFrameCallback !== 'function') return () => undefined;
      const handle = video.requestVideoFrameCallback(() => {
        listener();
      });
      return () => {
        video.cancelVideoFrameCallback(handle);
      };
    },
  };
}

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
