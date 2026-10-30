/**
 * 预览令牌 `behavior` / `behavior-demo` 打开时的页面会话。
 * 手势仍用现有判定；播放和空闲提议交给产品调度器。默认路径不创建本会话。
 * 自动动作节奏由调用方注入（`DAILY_CADENCE` / `DEMO_CADENCE`），冷却从回到待机起算，
 * 定时器是一次性链：每次到期只提议一次，忙或拖动时改期重来。
 * @module pet-next/app/behavior-pet
 */
import type { BehaviorCadence } from '../contracts/behavior.ts';
import { BEHAVIOR_LIMITS } from '../contracts/behavior.ts';
import { createDesktopPetBehavior } from '../core/behavior/desktop.ts';
import type { AutoCandidate } from '../core/behavior/types.ts';
import { initialGestureState, reduceGesture } from '../core/interaction/gesture.ts';
import type { GestureEvent } from '../core/interaction/types.ts';
import type { PetMedia, PetMediaStatus } from './pet-media.ts';

const CLICK_TTL_MS = 10_000;
const AUTO_TTL_MS = 8_000;
const MISSING_REACTION_URL = 'file:///tmp/pet-next-preview-missing-reaction.webm';
/** 页面侧追踪的请求身份上限。超过时丢最旧的，防止长会话泄漏。 */
const REMEMBERED_IDS_LIMIT = 64;

export interface BehaviorPet {
  boot(): void;
  pointer(event: GestureEvent): void;
  onMedia(status: PetMediaStatus): void;
  failNext(): void;
  quit(): void;
}

/**
 * 创建预览行为会话。
 *
 * @param cadence - 自动动作冷却节奏。`min === max` 时不消耗随机数。
 * @param dragThresholdPx - 传给手势归约的拖动阈值。
 * @param schedule - 一次性定时器。到期只调一次 `tick`。返回取消函数。测试可注入。
 */
export function createBehaviorPet(options: {
  media: PetMedia;
  idleUrl: string;
  reactionUrl: string;
  cadence: BehaviorCadence;
  dragThresholdPx: number;
  nowMs?: () => number;
  random?: () => number;
  schedule?: (delayMs: number, tick: () => void) => () => void;
  moveBy(dx: number, dy: number): void;
  quit(): void;
  setVisual(visual: string, requestId: string): void;
  setTrace(trace: readonly string[]): void;
  setDragging(dragging: boolean): void;
}): BehaviorPet {
  const nowMs = options.nowMs ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const cadence = options.cadence;
  const trace: string[] = [];
  let gesture = initialGestureState();
  let seq = 0;
  let failArmed = false;
  let disposed = false;
  let cancelTimer: (() => void) | null = null;
  const schedulerIds = new Set<string>();

  const behavior = createDesktopPetBehavior({
    deps: { nowMs, random },
    assets: {
      idleUrl: options.idleUrl,
      reactionUrl: options.reactionUrl,
      autoUrl: options.reactionUrl,
    },
    ports: {
      play(request) {
        rememberId(request.requestId);
        const failThis = failArmed && request.clip !== 'idle';
        if (failThis) failArmed = false;
        const url = failThis ? MISSING_REACTION_URL : request.url;
        remember(`${request.clip}:${request.requestId}`, request.clip, request.requestId);
        options.media.begin({
          requestId: request.requestId,
          clip: request.clip,
          url,
          once: request.once,
        });
      },
      cancel() {
        return undefined;
      },
      showIdle() {
        playIdle();
      },
    },
  });

  function rememberId(requestId: string): void {
    if (schedulerIds.has(requestId)) return;
    if (schedulerIds.size >= REMEMBERED_IDS_LIMIT) {
      const oldest = schedulerIds.values().next().value;
      if (oldest !== undefined) schedulerIds.delete(oldest);
    }
    schedulerIds.add(requestId);
  }

  function remember(entry: string, visual: string, requestId: string): void {
    if (trace.length >= BEHAVIOR_LIMITS.history) trace.shift();
    trace.push(entry);
    options.setTrace(trace);
    options.setVisual(visual, requestId);
  }

  function playIdle(): void {
    if (disposed) return;
    seq += 1;
    const requestId = `idle-${seq}`;
    remember(`idle:${requestId}`, 'idle', requestId);
    options.media.begin({
      requestId,
      clip: 'idle',
      url: options.idleUrl,
      once: false,
    });
  }

  function nextId(prefix: string): string {
    seq += 1;
    return `${prefix}-${seq}`;
  }

  /** 下一次自动动作的等待时长。`min === max` 时固定，否则均匀取整区间。 */
  function nextAutoDelayMs(): number {
    const { autoCooldownMinMs: min, autoCooldownMaxMs: max } = cadence;
    if (max <= min) return min;
    return min + Math.floor(random() * (max - min + 1));
  }

  /**
   * 重挂一次性定时器。先取消旧定时器，保证至多一个在途；
   * `disposed` 后不再挂，防止退出后被媒体回调复活。
   * 挂表期间不再重入（防同步触发型 schedule 实现造成递归）。
   */
  let arming = false;
  function rearmNextAuto(): void {
    if (disposed || arming) return;
    cancelTimer?.();
    arming = true;
    try {
      const schedule = options.schedule ?? defaultSchedule;
      cancelTimer = schedule(nextAutoDelayMs(), () => {
        cancelTimer = null;
        if (disposed) return;
        if (!pumpAuto()) rearmNextAuto();
      });
    } finally {
      arming = false;
    }
  }

  function pumpAuto(): boolean {
    const id = nextId('auto');
    const now = nowMs();
    const candidate: AutoCandidate = {
      requestId: id,
      readyAtMs: now,
      expiresAtMs: now + AUTO_TTL_MS,
    };
    return behavior.considerAuto([candidate]);
  }

  return {
    boot() {
      playIdle();
      rearmNextAuto();
    },
    pointer(event) {
      const reduction = reduceGesture(gesture, event, options.dragThresholdPx);
      gesture = reduction.state;
      for (const effect of reduction.effects) {
        if (effect.type === 'click') behavior.click(nextId('click'), CLICK_TTL_MS);
        else if (effect.type === 'drag-start') {
          behavior.dragStart();
          options.setDragging(true);
        } else if (effect.type === 'drag-end') {
          behavior.dragEnd();
          options.setDragging(false);
        } else if (effect.type === 'drag-move') options.moveBy(effect.dx, effect.dy);
      }
    },
    onMedia(status) {
      if (!schedulerIds.has(status.requestId)) {
        if (status.status === 'failed') {
          if (trace.length >= BEHAVIOR_LIMITS.history) trace.shift();
          trace.push('placeholder');
          options.setTrace(trace);
          options.setVisual('placeholder', status.requestId);
          options.media.showPlaceholder();
        }
        return;
      }
      if (status.status !== 'ended' && status.status !== 'failed') return;
      schedulerIds.delete(status.requestId);
      behavior.settled(status.requestId, status.status === 'ended');
      rearmNextAuto();
    },
    failNext() {
      failArmed = true;
      behavior.click(nextId('fail'), CLICK_TTL_MS);
    },
    quit() {
      if (disposed) return;
      disposed = true;
      cancelTimer?.();
      cancelTimer = null;
      options.media.dispose();
      options.quit();
    },
  };
}

function defaultSchedule(delayMs: number, tick: () => void): () => void {
  const handle = setTimeout(tick, delayMs);
  return () => {
    clearTimeout(handle);
  };
}
