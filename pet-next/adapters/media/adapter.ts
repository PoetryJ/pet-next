/**
 * 唯一的媒体加载、播放、取消和回调入口。
 * 副作用只发生在注入的元素、加载器和时钟上；世代判断交给 reducePlayback。
 *
 * M3-9：呈现暂停（idle suspension）。隐藏时只暂停"当前单槽 idle 且已兑现 play"的元素，
 * 并且只恢复本功能真正 pause 过的那一个；加载中与 once 动作不暂停，聊天/超时/行为时钟不受影响。
 * @module pet-next/adapters/media/adapter
 */
import { initialPlaybackState, reducePlayback } from '../../core/playback/reduce.ts';
import type { PlaybackEffect, PlaybackEvent, PlaybackRequest, PlaybackState } from '../../core/playback/types.ts';
import type { IdlePauseLease, IdleSuspensionDebugState } from '../../contracts/idle-suspension.ts';
import type { SlotClip } from '../../contracts/media-slot.ts';
import { leaseStillCurrent, reconcileIdleSuspension } from '../../core/idle-suspension/policy.ts';
import type { LoadToken, MediaAdapter, MediaAdapterOptions, MediaClock, MediaStatusEvent } from './types.ts';

interface ActiveLoad extends LoadToken {
  abort(): void;
}

const DEFAULT_ELEMENT_IDENTITY = 'single-primary';

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
  const suspensionEnabled = options.idlePause === true;
  const elementIdentity = options.elementIdentity ?? DEFAULT_ELEMENT_IDENTITY;
  let state: PlaybackState = initialPlaybackState();
  const tokens = new Map<number, ActiveLoad>();
  let timer: unknown = null;
  let heldSrc: string | null = null;
  let disposed = false;

  // M3-9 呈现暂停状态。开关关闭时这些量保持初始值，永不被读写。
  let hidden = false;
  let clip: SlotClip | null = null;
  /** 当前绑定的请求是否一次性动作；once 永不暂停。 */
  let once = false;
  /** 只有本功能 pause 过的元素才有 lease；其它原因（cancel/cleanup）产生的暂停不登记。 */
  let lease: IdlePauseLease | null = null;
  let resuming = false;
  let reconciling = false;
  let pauseCount = 0;
  let resumeCount = 0;
  let lastAction: IdleSuspensionDebugState['lastAction'] = 'none';
  let lastSkipReason: string | null = suspensionEnabled ? null : 'disabled';

  function clearTimer(): void {
    if (timer === null) return;
    clock.clear(timer);
    timer = null;
  }

  function dispatch(event: PlaybackEvent): void {
    const before = state.generation;
    const reduction = reducePlayback(state, event);
    state = reduction.state;
    if (state.generation !== before) dropLease('generation-changed');
    // CONTRACT 3：failed 先作废旧归属。否则恢复分支会把已失败的 owner 重新 play，
    // 不产生任何上报，只留下白解码。
    if (state.phase === 'failed') dropLease('failed');
    for (const effect of reduction.effects) applyEffect(effect);
    reconcile();
  }

  function dropLease(reason: string): void {
    if (lease === null) return;
    // 只清标记：旧元素保持原状，绝不替它补 play。
    lease = null;
    resuming = false;
    if (suspensionEnabled) lastSkipReason = reason;
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
        // 取消/冻结等既有原因的暂停：元素停下，但不登记 lease（不归本功能恢复）。
        dropLease('paused-by-cancel');
        element.pause();
        break;
      case 'cleanup':
        dropLease('cleanup');
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
        // 隐藏期的循环重启也要过暂停闸门：不能靠 onended 偷偷恢复解码。
        if (leaseStillCurrent(lease, generation, elementIdentity)) {
          lastSkipReason = 'looping-while-suspended';
          return;
        }
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

  /**
   * 按当前状态收敛暂停/恢复。所有入口（begin/状态变化/setHidden）都走这一处，
   * 保证"隐藏期换素材"和"恢复在途再次隐藏"都由最新状态决定。
   */
  function reconcile(): void {
    if (!suspensionEnabled || reconciling) return;
    if (lease !== null && !leaseStillCurrent(lease, state.generation, elementIdentity)) {
      dropLease('stale-lease');
    }
    reconciling = true;
    try {
      const decision = reconcileIdleSuspension(
        {
          enabled: suspensionEnabled,
          hidden,
          disposed,
          generation: state.generation,
          clip,
          once,
          phase: state.phase,
          lease,
          resuming,
        },
        elementIdentity,
      );
      if (decision.type === 'pause') {
        lease = decision.lease;
        pauseCount += 1;
        lastAction = 'pause';
        lastSkipReason = null;
        element.pause();
        return;
      }
      if (decision.type === 'resume') {
        resuming = true;
        lastAction = 'resume';
        lastSkipReason = null;
        const target = decision.lease;
        void element.play().then(
          () => {
            resuming = false;
            if (disposed || !leaseStillCurrent(lease, target.generation, elementIdentity)) return;
            // 恢复完成即释放归属：此后重复的 visible 事件不会再 play 一次。
            lease = null;
            resumeCount += 1;
            // 恢复在途时又隐藏：按最新状态立即重新收敛（会再次 pause，不重发请求）。
            reconcile();
          },
          () => {
            resuming = false;
            if (disposed || !leaseStillCurrent(lease, target.generation, elementIdentity)) return;
            lease = null;
            lastAction = 'none';
            // 恢复失败沿既有失败路径：报 failed → 页面占位，不留下永久冻帧。
            dispatch({ type: 'failed', generation: target.generation, reason: 'decode-error' });
          },
        );
        return;
      }
      lastAction = 'none';
      lastSkipReason = decision.reason;
    } finally {
      reconciling = false;
    }
  }

  return {
    begin(request) {
      if (disposed) return;
      // 新绑定拥有新生命周期：旧 lease 先作废（不替旧元素补 play）。
      lease = null;
      resuming = false;
      clip = request.clip;
      once = request.once;
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
      lease = null;
      dispatch({ type: 'dispose' });
    },
    setHidden(next) {
      if (!suspensionEnabled || disposed) return;
      if (hidden === next) {
        reconcile();
        return;
      }
      hidden = next;
      reconcile();
    },
    releaseIdleLease(reason = 'placeholder') {
      if (!suspensionEnabled) return;
      // CONTRACT 3：占位层接管后旧归属作废；只清标记，不替旧元素补 play。
      dropLease(reason);
    },
    idleSuspensionState() {
      return {
        enabled: suspensionEnabled,
        revision: null,
        hidden,
        generation: state.generation === 0 ? null : state.generation,
        phase: state.phase,
        clip,
        lease,
        pauseCount,
        resumeCount,
        lastAction,
        lastSkipReason,
      };
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
