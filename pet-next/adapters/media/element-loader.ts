/**
 * 把 HTMLVideoElement 的加载和释放收成 MediaLoader。播放和世代由适配器负责。
 * @module pet-next/adapters/media/element-loader
 */
import type { LoadToken, MediaLoader } from './types.ts';

/** 监听 loadeddata / error；中止时卸下监听并拒绝 Promise。 */
export function createElementLoader(video: HTMLVideoElement): MediaLoader {
  return {
    load(url, token) {
      return loadUrl(video, url, token);
    },
    release(src) {
      const current = video.currentSrc || video.src;
      if (src && current && current !== src && video.getAttribute('src') !== src) return;
      video.onended = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
    },
  };
}

function loadUrl(video: HTMLVideoElement, url: string, token: LoadToken): Promise<{ src: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('error', onError);
      settle();
    };
    const onReady = () => {
      finish(() => {
        if (token.aborted) reject(abortedError());
        else resolve({ src: url });
      });
    };
    const onError = () => {
      finish(() => {
        reject(Object.assign(new Error('asset-load'), { reason: 'asset-load' }));
      });
    };
    token.onAbort(() => {
      finish(() => {
        reject(abortedError());
      });
    });
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('error', onError);
    video.src = url;
    video.load();
  });
}

function abortedError(): Error {
  return Object.assign(new Error('aborted'), { reason: 'aborted' });
}
