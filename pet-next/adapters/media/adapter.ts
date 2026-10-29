/**
 * 唯一的媒体加载、播放、取消和回调入口。
 * 副作用只发生在注入的元素、加载器和时钟上；世代判断交给 reducePlayback。
 * @module pet-next/adapters/media/adapter
 */
import { initialPlaybackState, reducePlayback } from '../../core/playback/reduce.ts';
import type { PlaybackEffect, PlaybackEvent, PlaybackRequest, PlaybackState } from '../../core/playback/types.ts';
import type { LoadToken, MediaAdapter, MediaAdapterOptions, MediaClock, MediaStatusEvent } from './types.ts';

interface ActiveLoad extends LoadToken {
  abort(): void;
}

/** 浏览器与 Node 都有的计时器。句柄原样交还 clear。 */
export function systemMediaClock(): MediaClock {
  return {
    set(fn, delayMs) {
      return setTimeout(fn, delayMs);
    },
    clear(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

/** 创建媒体适配器。内核状态留在闭包内。 */
export function createMediaAdapter(options: MediaAdapterOptions): MediaAdapter {
  const { element, loader, clock, timeoutMs, onStatus } = options;
  let state: PlaybackState = initialPlaybackState();
  const tokens = new Map<number, ActiveLoad>();
  let timer: unknown = null;
  let heldSrc: string | null = null;
  let disposed = false;

  function clearTimer(): void {
    if (timer === null) return;
    clock.clear(timer);
    timer = null;
  }

  function dispatch(event: PlaybackEvent): void {
    const reduction = reducePlayback(state, event);
    state = reduction.state;
    for (const effect of reduction.effects) applyEffect(effect);
  }

  function applyEffect(effect: PlaybackEffect): void {
    switch (effect.type) {
      case 'load':
        startLoad(effect.generation, effect.request);
        break;
      case 'play':
        startPlay(effect.generation);
        break;
      case 'abort':
        abortGeneration(effect.generation);
        break;
      case 'pause':
        element.pause();
        break;
      case 'cleanup':
        cleanupElement();
        break;
      case 'report':
        emitStatus(effect.playbackId, effect.status, effect.reason);
        break;
      default: {
        const unreachable: never = effect;
        return unreachable;
      }
    }
  }

  function emitStatus(playbackId: string, status: MediaStatusEvent['status'], reason: string | undefined): void {
    if (reason === undefined) onStatus({ playbackId, status });
    else onStatus({ playbackId, status, reason });
  }

  function startLoad(generation: number, request: PlaybackRequest): void {
    clearTimer();
    const token = createToken();
    tokens.set(generation, token);
    timer = clock.set(() => {
      timer = null;
      dispatch({ type: 'failed', generation, reason: 'timeout' });
    }, timeoutMs);
    void loader.load(request.asset.url, token).then(
      (result) => {
        if (token.aborted || state.generation !== generation) return;
        clearTimer();
        assignSrc(result.src, !request.asset.once);
        armEnded(generation, request.asset.once);
        dispatch({ type: 'loaded', generation });
      },
      (error: unknown) => {
        if (token.aborted || state.generation !== generation) return;
        clearTimer();
        dispatch({
          type: 'failed',
          generation,
          reason: readReason(error) === 'decode-error' ? 'decode-error' : 'asset-load',
        });
      },
    );
  }

  function assignSrc(src: string, loop: boolean): void {
    if (heldSrc !== null && heldSrc !== src) loader.release(heldSrc);
    heldSrc = src;
    element.loop = loop;
    element.muted = true;
    if (element.src !== src) element.src = src;
  }

  function armEnded(generation: number, once: boolean): void {
    element.onended = () => {
      if (!once && state.generation === generation && state.phase === 'playing') {
        void element.play().catch(() => {
          dispatch({ type: 'failed', generation, reason: 'decode-error' });
        });
        return;
      }
      dispatch({ type: 'ended', generation });
    };
    element.onerror = () => {
      if (state.generation !== generation) return;
      if (state.phase !== 'loading' && state.phase !== 'ready' && state.phase !== 'playing') return;
      dispatch({ type: 'failed', generation, reason: 'decode-error' });
    };
  }

  function startPlay(generation: number): void {
    void element.play().then(
      () => {
        dispatch({ type: 'playResolved', generation, ok: true });
      },
      () => {
        dispatch({ type: 'playResolved', generation, ok: false });
      },
    );
  }

  function abortGeneration(generation: number): void {
    const token = tokens.get(generation);
    token?.abort();
    tokens.delete(generation);
    clearTimer();
    element.onended = null;
    element.onerror = null;
    element.pause();
  }

  function cleanupElement(): void {
    clearTimer();
    for (const token of tokens.values()) token.abort();
    tokens.clear();
    element.onended = null;
    element.onerror = null;
    element.pause();
    element.removeAttribute('src');
    element.load();
    if (heldSrc !== null) {
      const src = heldSrc;
      heldSrc = null;
      loader.release(src);
    }
  }

  return {
    begin(request) {
      if (disposed) return;
      dispatch({
        type: 'begin',
        request: {
          playbackId: request.playbackId,
          asset: { url: request.url, once: request.once },
        },
      });
    },
    dispose() {
      if (state.phase === 'disposed') return;
      disposed = true;
      dispatch({ type: 'dispose' });
    },
    get generation() {
      return state.generation;
    },
    get phase() {
      return state.phase;
    },
  };
}

function createToken(): ActiveLoad {
  const listeners: Array<() => void> = [];
  const token: ActiveLoad = {
    aborted: false,
    onAbort(listener) {
      if (token.aborted) listener();
      else listeners.push(listener);
    },
    abort() {
      if (token.aborted) return;
      token.aborted = true;
      for (const listener of listeners.splice(0)) listener();
    },
  };
  return token;
}

function readReason(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'reason' in error) {
    const reason = error.reason;
    if (reason === 'decode-error' || reason === 'asset-load' || reason === 'timeout') return reason;
  }
  return 'asset-load';
}
