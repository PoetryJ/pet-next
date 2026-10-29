/**
 * 产品自主行为的公共形状。实验仲裁的同级点击排队不能当作本模块的规则。
 * 实现放在 `core/behavior/`。`core` 不能 import 本文件，契约测试在 `tests/contracts/` 做结构核对。
 * 调度器由调用方注入时钟和随机数。默认启动不创建调度器。
 * @module pet-next/contracts/behavior
 */

/** 待处理动作和历史的硬上限。超出时丢掉最旧的一条，而不是无限增长。 */
export const BEHAVIOR_LIMITS = { pending: 8, history: 32 } as const;

/** 产品规则。与 `contracts/arbiter.ts` 的实验协议分开冻结。 */
export const PRODUCT_BEHAVIOR_RULES = [
  'drag-priority',
  'latest-click-overrides',
  'auto-only-when-idle',
  'no-auto-start-during-drag',
  'expired-auto-discarded',
  'idle-after-settle',
  'idempotent-request',
  'bounded-capacity',
] as const;

export type ProductBehaviorRule = (typeof PRODUCT_BEHAVIOR_RULES)[number];

export type BehaviorClip = 'idle' | 'reaction' | 'auto';

export interface BehaviorDeps {
  /**
   * 提议下一次自动动作时使用。
   * `step` 的时间只认输入里的 `nowMs`，不读这只时钟，也不读 `Date.now`。
   */
  nowMs(): number;
  /** 返回 [0, 1)。只在多个到期自动动作里挑选，不生成请求身份。 */
  random(): number;
}

export type BehaviorInput =
  | { type: 'click'; requestId: string; nowMs: number; expiresAtMs: number }
  | { type: 'drag'; phase: 'start' | 'end'; nowMs: number }
  | { type: 'auto'; requestId: string; nowMs: number; expiresAtMs: number }
  | { type: 'settled'; requestId: string; ok: boolean; nowMs: number };

export type BehaviorEffect =
  | { type: 'start'; requestId: string; clip: BehaviorClip }
  | { type: 'cancel'; requestId: string; reason: 'superseded' | 'expired' | 'drag' }
  | { type: 'idle' };

export interface BehaviorStep<TState> {
  state: TState;
  effects: readonly BehaviorEffect[];
  /** 本步结束后仍待处理的动作数，含尚未开始的自动动作，不含已经结束的历史。 */
  pending: number;
  /** 本步结束后保留的历史条数。 */
  history: number;
}

export interface BehaviorScheduler<TState> {
  /** 没有活动请求、待处理为空、历史为空。 */
  initialState(): TState;
  /**
   * 推进一步。返回的状态不与入参共享可变引用。
   * 同一 `requestId` 再次出现时不得第二次 `start`。
   * 新的点击取消上一个未完成的点击（`superseded`），不进入同级队列。
   * 自动动作只在空闲时 `start`；拖动进行中不 `start` 自动动作。
   * `nowMs >= expiresAtMs` 的自动动作是 `expired`，不能开始。
   * `settled` 之后回到待机（`idle`）。拖动本身不产生点击。
   */
  step(state: TState, input: BehaviorInput): BehaviorStep<TState>;
}

export type BehaviorFactory = (deps: BehaviorDeps) => BehaviorScheduler<unknown>;
