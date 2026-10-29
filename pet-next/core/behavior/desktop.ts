/**
 * 真实桌宠的接入会话。
 * 把点击、拖动、播放结果和空闲提议交给纯函数调度器，再把效果交给宿主端口。
 * 不读取 Electron、DOM、`Date.now` 或 `Math.random`。默认路径不应创建本会话。
 * @module pet-next/core/behavior/desktop
 */
import { createBehaviorScheduler } from './scheduler.ts';
import { mayProposeAuto } from './policy.ts';
import { proposeNextAuto } from './propose.ts';
import type { AutoCandidate, BehaviorClip, BehaviorDeps, BehaviorEffect, BehaviorInput, BehaviorState } from './types.ts';

export interface BehaviorAssets {
  idleUrl: string;
  reactionUrl: string;
  autoUrl: string;
}

/** 宿主要执行的一次播放。`idle` 循环，回应和自动动作播完即止。 */
export interface BehaviorPlayRequest {
  requestId: string;
  clip: BehaviorClip;
  url: string;
  once: boolean;
}

/**
 * 副作用端口。实现不得同步再进入本会话。
 * `showIdle` 只切回待机画面，不分配新的请求身份。
 */
export interface BehaviorPorts {
  play(request: BehaviorPlayRequest): void;
  cancel(requestId: string, reason: 'superseded' | 'expired' | 'drag'): void;
  showIdle(): void;
}

export interface DesktopPetBehavior {
  /**
   * 手势已经判定为点击之后调用。拖动不调用这里。
   * `ttlMs` 从注入时钟的当前时刻起算。
   */
  click(requestId: string, ttlMs: number): void;
  dragStart(): void;
  dragEnd(): void;
  /**
   * 定时器入口。忙或拖动时返回 false，并且不读时钟。
   * 返回 true 表示已经把一条自动动作交给调度器。
   */
  considerAuto(candidates: readonly AutoCandidate[]): boolean;
  /** 播放完成传 `true`，失败传 `false`。两者都回待机。 */
  settled(requestId: string, ok: boolean): void;
  readonly phase: 'idle' | 'active';
  readonly dragging: boolean;
  readonly pending: number;
  readonly history: number;
  readonly activeRequestId: string | null;
}

/**
 * 创建一只桌宠的行为会话。
 * 预览令牌 `behavior` 未打开时不要调用。
 *
 * @throws {RangeError} `click` 的 `ttlMs` 不是有限非负数。
 * @throws {Error} 端口在回调里再次进入本会话。
 */
export function createDesktopPetBehavior(options: {
  deps: BehaviorDeps;
  assets: BehaviorAssets;
  ports: BehaviorPorts;
}): DesktopPetBehavior {
  const scheduler = createBehaviorScheduler(options.deps);
  let state: BehaviorState = scheduler.initialState();
  let pending = 0;
  let history = 0;
  let applying = false;

  function deliver(effect: BehaviorEffect): void {
    if (effect.type === 'start') {
      options.ports.play({
        requestId: effect.requestId,
        clip: effect.clip,
        url: urlFor(options.assets, effect.clip),
        once: effect.clip !== 'idle',
      });
      return;
    }
    if (effect.type === 'cancel') {
      options.ports.cancel(effect.requestId, effect.reason);
      return;
    }
    options.ports.showIdle();
  }

  function apply(input: BehaviorInput): void {
    if (applying) throw new Error('behavior ports must not re-enter the session');
    applying = true;
    try {
      const step = scheduler.step(state, input);
      state = step.state;
      pending = step.pending;
      history = step.history;
      for (const effect of step.effects) deliver(effect);
    } finally {
      applying = false;
    }
  }

  return {
    click(requestId, ttlMs) {
      assertTtl(ttlMs);
      const nowMs = options.deps.nowMs();
      apply({ type: 'click', requestId, nowMs, expiresAtMs: nowMs + ttlMs });
    },
    dragStart() {
      apply({ type: 'drag', phase: 'start', nowMs: options.deps.nowMs() });
    },
    dragEnd() {
      apply({ type: 'drag', phase: 'end', nowMs: options.deps.nowMs() });
    },
    considerAuto(candidates) {
      if (!mayProposeAuto(state.active, state.dragging)) return false;
      const proposal = proposeNextAuto(candidates, options.deps);
      if (proposal === null) return false;
      apply(proposal);
      return true;
    },
    settled(requestId, ok) {
      apply({ type: 'settled', requestId, ok, nowMs: options.deps.nowMs() });
    },
    get phase() {
      return state.active === null ? 'idle' : 'active';
    },
    get dragging() {
      return state.dragging;
    },
    get pending() {
      return pending;
    },
    get history() {
      return history;
    },
    get activeRequestId() {
      return state.active?.requestId ?? null;
    },
  };
}

function urlFor(assets: BehaviorAssets, clip: BehaviorClip): string {
  if (clip === 'reaction') return assets.reactionUrl;
  if (clip === 'auto') return assets.autoUrl;
  return assets.idleUrl;
}

function assertTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new RangeError('ttlMs must be a finite number >= 0');
  }
}
