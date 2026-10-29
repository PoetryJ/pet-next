/**
 * 自播动画链：A/B 双缓冲换源、blob 生命周期、点播回执，以及「这一段播完之后该做什么」的判定。
 *
 * 只碰 video 元素与自己的内部状态；React 状态（anim / once / seq / 气泡 / 朝向）不在本模块里改，
 * 需要改的地方以 {@link EndedCue} / {@link FreezeCue} 的形式返回，由组件执行。
 * 请求身份、世代与阶段交给 shared/playback-lifecycle；这里只执行加载、play、清理和上报。
 * 必须始终成立：playing 只在当前世代的 play() 兑现后上报，终态或卸载后的旧回调不再改状态。
 * @module dsh-pet/src/client/pet/animation/animation
 */
import { isEventAnim } from '../../../shared/pickers.ts';
import {
  initialPlaybackState,
  reducePlayback,
  type PlaybackEffect,
  type PlaybackEvent,
  type PlaybackState,
} from '../../../shared/playback-lifecycle.ts';
import { decideEndedCue, type EndedCue, type FreezeCue } from './cues.ts';
import type { ReportableStatus } from '../../../shared/playback.ts';
import type { Animations } from '../../../shared/types.ts';
import type { WorkStatusSnapshot } from '../../../shared/work-status.ts';
import { createAssetLoader, type AssetLoader } from './asset-loader.ts';
import { animationAssetUrl } from './assets.ts';
import { thumbExt } from './media.ts';

export type { EndedCue, FreezeCue };

/** 资源超时（ms）：DSH WebServer 偶发 stalled，超时就丢弃本次换源。 */
const ASSET_FETCH_TIMEOUT_MS = 10_000;

/** 日志时间戳：与其余宠物日志同一格式，便于对照同一次事件。 */
const stamp = (petId: string): string => new Date().toTimeString().slice(0, 8) + ' pet=' + petId;

/** 可注入的加载超时。测试推进回调，生产用全局定时器，不让内核自己读时钟。 */
export interface PlaybackClock {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

/** 一次挂起的加载槽。世代号写在回调里，pending 是否为空不作放行条件。 */
interface LoadSession {
  generation: number;
  index: number;
  el: HTMLVideoElement;
  onReady: () => void;
}

/** 动画链的依赖：全部用取值函数，避免捕获渲染期的快照。 */
export interface OwnAnimationDeps {
  /** A/B 双缓冲的 A 元素。 */
  videoA: () => HTMLVideoElement | null;
  /** A/B 双缓冲的 B 元素。 */
  videoB: () => HTMLVideoElement | null;
  /** 该宠物的成品配置：素材根、id 与动画池都从它取。 */
  cfg: () => { id: string; assetRoot?: string; animations: Animations };
  /** 当前动画名。 */
  currentAnim: () => string;
  /** 工作状态叶子；未启用联动时为空。 */
  workStatus: () => WorkStatusSnapshot | null | undefined;
  /** 当前朝向，决定镜像。 */
  facing: () => 'left' | 'right';
  /** 上报第三方点播的真实状态。 */
  report: (playbackId: string, status: ReportableStatus, reason?: string) => void;
  /** 消费掉点播编号（清 React 状态，避免 effect 再跑一趟）。 */
  clearCuePlayback: () => void;
  /** 新动画已就位：组件在这里补 Q 弹与走位驱动。 */
  onFrontReady: (el: HTMLVideoElement) => void;
  /** 前台播完的判定结果；组件据此改 React 状态。 */
  onEnded: (cue: EndedCue) => void;
  /** 用户是否正按着宠物（拖拽期间不推进动画链）。 */
  isDragging: () => boolean;
  /** 挂载那一刻是否已被锁冻住。 */
  initiallyFrozen: boolean;
  /** 素材加载器；缺省用带超时的默认实现。 */
  loader?: AssetLoader;
  /** 加载超时的时钟；缺省用全局定时器。 */
  clock?: PlaybackClock;
}

/** 动画链对外能力。 */
export interface OwnAnimation {
  /** 换源播放；`cuePlaybackId` 非空表示这是一次第三方点播，要回执。 */
  switchTo: (next: string, once: boolean, cuePlaybackId: string | null) => void;
  /** 前台播完的判定；回执在这里上报，React 状态由组件按 cue 改。 */
  handleEnded: (event?: Event) => EndedCue;
  /** 把前台的循环关掉并挂上 ended：正在循环的档位动画靠它播完即停。 */
  stopLoopingFront: () => void;
  /** 交接下一次换源要用的完整地址（第三方点播的 url 形态）。 */
  setCueUrl: (url: string) => void;
  /** 冻结/解冻；只做播放控制与回执，气泡与动画选择交给组件。显式点播不受冻结阻挡。 */
  setFrozen: (next: boolean) => FreezeCue | null;
  /** 当前是否冻结（随机链与自动来源的门禁）。 */
  isFrozen: () => boolean;
  /** 前台元素；进度服务读它。 */
  frontVideo: () => HTMLVideoElement | null;
  /** 正在播的点播编号；自播动画或尚未 play 兑现时为 `null`。 */
  playingPlayback: () => string | null;
  /** 卸载清理：中断在途请求、释放 blob，之后不可再用。 */
  dispose: () => void;
}

const defaultClock: PlaybackClock = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) handle.unref();
    return handle;
  },
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * 造动画链。
 *
 * @param deps - 元素、配置与回调。
 * @returns 换源、播完判定、冻结控制与清理。
 */
export function createOwnAnimation(deps: OwnAnimationDeps): OwnAnimation {
  /** 当前前台槽位：0 = A，1 = B。 */
  let front = 0;
  /** 生命周期内核状态。 */
  let life: PlaybackState = initialPlaybackState();
  /** 待消费的点播地址，一次性取走。 */
  let cueUrl: string | null = null;
  /** 冻结标志：只挡自动来源，显式指令照常。 */
  let frozen = deps.initiallyFrozen;
  /** 两个槽位各自的 blob 地址，换源时先释放旧的。 */
  const blobUrl: { a: string | null; b: string | null } = { a: null, b: null };
  const loader = deps.loader ?? createAssetLoader(ASSET_FETCH_TIMEOUT_MS);
  const clock = deps.clock ?? defaultClock;
  /** 挂载标志：卸载后迟到的加载结果直接丢弃。 */
  let mounted = true;
  /** 当前这一代的后台槽。 */
  let session: LoadSession | null = null;
  /** 加载超时句柄，以及它属于哪一代。 */
  let timer: unknown = null;
  let timerGeneration = 0;

  const slotOf = (index: number): 'a' | 'b' => (index === 0 ? 'a' : 'b');
  const elementOf = (index: number): HTMLVideoElement | null => (index === 0 ? deps.videoA() : deps.videoB());
  const frontVideo = (): HTMLVideoElement | null => elementOf(front);

  const releaseSlot = (index: number): void => {
    const slot = slotOf(index);
    const previous = blobUrl[slot];
    if (previous === null) return;
    loader.release(previous);
    blobUrl[slot] = null;
  };

  const clearTimer = (): void => {
    if (timer === null) return;
    clock.clear(timer);
    timer = null;
  };

  const detach = (current: LoadSession): void => {
    current.el.removeEventListener('loadeddata', current.onReady);
    current.el.onerror = null;
    current.el.onended = null;
  };

  const dispatch = (event: PlaybackEvent): void => {
    const reduced = reducePlayback(life, event);
    life = reduced.state;
    for (const effect of reduced.effects) apply(effect);
  };

  const apply = (effect: PlaybackEffect): void => {
    switch (effect.type) {
      case 'load':
        startLoad(
          effect.generation,
          effect.request.asset.url,
          effect.request.asset.once,
          sessionAnim(effect.generation),
        );
        return;
      case 'play':
        startPlay(effect.generation);
        return;
      case 'abort':
        abortGeneration(effect.generation);
        return;
      case 'pause':
        frontVideo()?.pause();
        return;
      case 'cleanup':
        clearTimer();
        loader.abortAll();
        if (session !== null) detach(session);
        session = null;
        releaseSlot(0);
        releaseSlot(1);
        return;
      case 'report':
        // 素材字节失败在 onError 里带上原始错误；这里补超时与解码，避免同一条失败打两遍。
        if (effect.status === 'failed' && effect.reason !== 'play-rejected' && effect.reason !== 'asset-load') {
          warnFailed(effect.reason ?? 'failed');
        }
        deps.report(effect.playbackId, effect.status, effect.reason);
        return;
      default: {
        const unreachable: never = effect;
        return unreachable;
      }
    }
  };

  /** begin 时记下动画名，供失败日志使用。load 效果本身只有 url。 */
  const animNames = new Map<number, string>();
  const sessionAnim = (generation: number): string => animNames.get(generation) ?? '';

  const warnFailed = (reason: string): void => {
    const cfg = deps.cfg();
    console.warn(
      '[dsh-pet] 素材加载失败 pet=' +
        cfg.id +
        ' anim=' +
        sessionAnim(life.generation) +
        '：' +
        reason +
        '（已释放本次切换）',
    );
  };

  const abortGeneration = (generation: number): void => {
    if (timerGeneration === generation) clearTimer();
    if (session === null || session.generation !== generation) return;
    detach(session);
    if (session.index !== front) releaseSlot(session.index);
    session = null;
  };

  const startLoad = (generation: number, url: string, once: boolean, anim: string): void => {
    const targetIndex = front === 0 ? 1 : 0;
    const el = elementOf(targetIndex);
    if (el === null) {
      dispatch({ type: 'failed', generation, reason: 'asset-load' });
      return;
    }
    el.loop = !once;
    el.muted = true;
    el.autoplay = true;
    el.playsInline = true;
    el.onended = once ? bindEnded(el, generation) : null;
    const onReady = (): void => {
      el.removeEventListener('loadeddata', onReady);
      if (!mounted || life.generation !== generation || life.phase !== 'loading') return;
      dispatch({ type: 'loaded', generation });
    };
    el.onerror = () => {
      if (!mounted || life.generation !== generation) return;
      if (life.phase !== 'loading' && life.phase !== 'ready' && life.phase !== 'playing') return;
      dispatch({ type: 'failed', generation, reason: 'decode-error' });
    };
    session = { generation, index: targetIndex, el, onReady };
    timerGeneration = generation;
    timer = clock.set(() => {
      timer = null;
      if (!mounted || life.generation !== generation || life.phase !== 'loading') return;
      dispatch({ type: 'failed', generation, reason: 'timeout' });
    }, ASSET_FETCH_TIMEOUT_MS);
    el.addEventListener('loadeddata', onReady);
    loader.load(url, {
      onObjectUrl: (objectUrl) => {
        if (!mounted || life.generation !== generation || life.phase !== 'loading') {
          loader.release(objectUrl);
          return;
        }
        const slot = slotOf(targetIndex);
        const previous = blobUrl[slot];
        if (previous !== null) loader.release(previous);
        blobUrl[slot] = objectUrl;
        el.src = objectUrl;
        el.load();
      },
      onError: (error) => {
        if (!mounted || life.generation !== generation || life.phase !== 'loading') return;
        const cfg = deps.cfg();
        console.warn(
          '[dsh-pet] 素材加载失败 pet=' +
            cfg.id +
            ' anim=' +
            anim +
            '：' +
            (error instanceof Error ? error.message : String(error)) +
            '（已释放本次切换）',
        );
        dispatch({ type: 'failed', generation, reason: 'asset-load' });
      },
    });
  };

  const startPlay = (generation: number): void => {
    if (timerGeneration === generation) clearTimer();
    const current = session;
    if (current === null || current.generation !== generation) return;
    const el = current.el;
    const outgoing = elementOf(front);
    el.classList.add('is-front');
    if (outgoing !== null && outgoing !== el) {
      outgoing.classList.remove('is-front');
      outgoing.onended = null;
      outgoing.onerror = null;
      outgoing.pause();
    }
    front = current.index;
    el.style.transform = deps.facing() === 'right' ? 'scaleX(-1)' : '';
    let played: Promise<void>;
    try {
      const result = el.play();
      played = Promise.resolve(result);
    } catch (error) {
      played = Promise.reject(error);
    }
    played.then(
      () => {
        if (!mounted || life.generation !== generation || life.phase !== 'ready') return;
        dispatch({ type: 'playResolved', generation, ok: true });
      },
      () => {
        if (!mounted || life.generation !== generation || life.phase !== 'ready') return;
        dispatch({ type: 'playResolved', generation, ok: false });
      },
    );
    deps.onFrontReady(el);
  };

  const phase = (): PlaybackState['phase'] => life.phase;

  const handleEnded = (event?: Event): EndedCue => {
    const endedOn = event === undefined ? null : (event.currentTarget as HTMLVideoElement | null);
    if (endedOn !== null && !endedOn.classList.contains('is-front')) return { kind: 'ignore' };
    if (phase() !== 'playing') return { kind: 'ignore' };
    const generation = life.generation;
    dispatch({ type: 'ended', generation });
    if (phase() !== 'ended') return { kind: 'ignore' };
    if (deps.isDragging()) return { kind: 'ignore' };
    if (frozen) return { kind: 'ignore' };
    const cue = decideEndedCue({
      animations: deps.cfg().animations,
      current: deps.currentAnim(),
      workState: deps.workStatus()?.state,
    });
    const petId = deps.cfg().id;
    if (cue.kind === 'work-rotate') {
      console.log('[dsh-pet] ' + stamp(petId) + ' workStatus 档内轮换: ' + deps.currentAnim() + ' -> ' + cue.anim);
    } else if (cue.kind === 'work-replay') {
      console.log('[dsh-pet] ' + stamp(petId) + ' workStatus 循环续播: ' + deps.currentAnim());
    } else if (cue.kind === 'event-done') {
      console.log('[dsh-pet] ' + stamp(petId) + ' 事件动画播完 ended anim=' + deps.currentAnim());
    }
    return cue;
  };

  // 双缓冲会把同一元素交给下一代，onended 在赋值时收进当时的 generation 和元素。
  const bindEnded = (el: HTMLVideoElement, generation: number): ((event?: Event) => void) => {
    return (event?: Event) => {
      const isCurrent = generation === life.generation && life.phase === 'playing' && frontVideo() === el;
      const targetMatches = event == null || event.currentTarget === el;
      if (!isCurrent || !targetMatches) return;
      deps.onEnded(handleEnded(event));
    };
  };

  const switchTo = (next: string, nextOnce: boolean, cuePlaybackId: string | null): void => {
    if (cuePlaybackId !== null) deps.clearCuePlayback();
    const cfg = deps.cfg();
    const handed = cueUrl;
    cueUrl = null;
    if (next === '') return;
    if (!mounted) return;
    const url = animationAssetUrl({
      cueUrl: handed,
      assetRoot: cfg.assetRoot ?? '',
      id: cfg.id,
      anim: next,
      ext: thumbExt(),
    });
    if (elementOf(front === 0 ? 1 : 0) === null) return;
    if (isEventAnim(cfg.animations.events, next)) {
      console.log('[dsh-pet] ' + stamp(cfg.id) + ' switch ' + next + ' once=' + nextOnce);
    }
    const generation = life.generation + 1;
    animNames.set(generation, next);
    dispatch({
      type: 'begin',
      request: { playbackId: cuePlaybackId, asset: { url, once: nextOnce } },
    });
  };

  return {
    switchTo,
    handleEnded,
    stopLoopingFront: () => {
      const el = frontVideo();
      if (el === null) return;
      el.loop = false;
      el.onended = bindEnded(el, life.generation);
    },
    setCueUrl: (url) => {
      cueUrl = url;
    },
    setFrozen: (next) => {
      if (frozen === next) return null;
      frozen = next;
      if (next) {
        frontVideo()?.pause();
        dispatch({ type: 'cancel', reason: 'frozen' });
        return { kind: 'frozen' };
      }
      return { kind: 'resumed' };
    },
    isFrozen: () => frozen,
    frontVideo,
    playingPlayback: () => (life.phase === 'playing' ? (life.request?.playbackId ?? null) : null),
    dispose: () => {
      if (!mounted) return;
      mounted = false;
      dispatch({ type: 'dispose' });
    },
  };
}
