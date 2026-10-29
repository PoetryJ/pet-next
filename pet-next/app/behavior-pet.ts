/**
 * 预览令牌 `behavior` 打开时的页面会话。
 * 手势仍用现有判定；播放和空闲提议交给产品调度器。默认路径不创建本会话。
 * @module pet-next/app/behavior-pet
 */
import { createDesktopPetBehavior } from '../core/behavior/desktop.ts';
import type { AutoCandidate } from '../core/behavior/types.ts';
import { initialGestureState, reduceGesture } from '../core/interaction/gesture.ts';
import type { GestureEvent } from '../core/interaction/types.ts';
import type { PetMedia, PetMediaStatus } from './pet-media.ts';

const CLICK_TTL_MS = 10_000;
const AUTO_TTL_MS = 8_000;
const AUTO_IDLE_MS = 1_600;
const MISSING_REACTION_URL = 'file:///tmp/pet-next-preview-missing-reaction.webm';

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
 * @param dragThresholdPx - 传给手势归约的拖动阈值。
 * @param schedule - 空闲定时器。返回取消函数。测试可注入。
 */
export function createBehaviorPet(options: {
  media: PetMedia;
  idleUrl: string;
  reactionUrl: string;
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
  const trace: string[] = [];
  let gesture = initialGestureState();
  let seq = 0;
  let failArmed = false;
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
        schedulerIds.add(request.requestId);
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

  function remember(entry: string, visual: string, requestId: string): void {
    trace.push(entry);
    options.setTrace(trace);
    options.setVisual(visual, requestId);
  }

  function playIdle(): void {
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

  function pumpAuto(): void {
    const id = nextId('auto');
    const now = nowMs();
    const candidate: AutoCandidate = {
      requestId: id,
      readyAtMs: now,
      expiresAtMs: now + AUTO_TTL_MS,
    };
    behavior.considerAuto([candidate]);
  }

  return {
    boot() {
      playIdle();
      const schedule = options.schedule ?? defaultSchedule;
      cancelTimer = schedule(AUTO_IDLE_MS, pumpAuto);
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
          trace.push('placeholder');
          options.setTrace(trace);
          options.setVisual('placeholder', status.requestId);
          options.media.showPlaceholder();
        }
        return;
      }
      behavior.settled(status.requestId, status.status === 'ended');
    },
    failNext() {
      failArmed = true;
      behavior.click(nextId('fail'), CLICK_TTL_MS);
    },
    quit() {
      cancelTimer?.();
      cancelTimer = null;
      options.media.dispose();
      options.quit();
    },
  };
}

function defaultSchedule(delayMs: number, tick: () => void): () => void {
  const handle = setInterval(tick, delayMs);
  return () => {
    clearInterval(handle);
  };
}
