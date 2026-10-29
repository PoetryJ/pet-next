/**
 * 产品自主行为的输入、效果和状态。
 * 字段与 `contracts/behavior.ts` 对齐；本目录不能 import 契约。
 * 实验仲裁的同级点击排队不是这里的状态。
 * @module pet-next/core/behavior/types
 */

/** 待机循环、点击回应、自动动作。调度器开始点击时用 `reaction`，开始自动动作时用 `auto`。 */
export type BehaviorClip = 'idle' | 'reaction' | 'auto';

export interface BehaviorDeps {
  /**
   * 提议下一次自动动作时读取。
   * `step` 只使用输入里的 `nowMs`。
   */
  nowMs(): number;
  /** 返回 [0, 1)。只在多个可开始的自动动作之间取下标。 */
  random(): number;
}

export type BehaviorInput =
  | { type: 'click'; requestId: string; nowMs: number; expiresAtMs: number }
  | { type: 'drag'; phase: 'start' | 'end'; nowMs: number }
  | { type: 'auto'; requestId: string; nowMs: number; expiresAtMs: number }
  | { type: 'settled'; requestId: string; ok: boolean; nowMs: number };

export type BehaviorCancelReason = 'superseded' | 'expired' | 'drag';

export type BehaviorEffect =
  | { type: 'start'; requestId: string; clip: BehaviorClip }
  | { type: 'cancel'; requestId: string; reason: BehaviorCancelReason }
  | { type: 'idle' };

export interface BehaviorStep<TState> {
  state: TState;
  effects: readonly BehaviorEffect[];
  /** 尚未开始的点击与自动动作。不含活动请求，不含历史。 */
  pending: number;
  /** 仍保留的历史条数。 */
  history: number;
}

export interface BehaviorScheduler<TState> {
  /** 没有活动请求、待处理为空、历史为空。 */
  initialState(): TState;
  /**
   * 推进一步。返回的状态不与入参共享数组或请求对象。
   * 同一仍留在状态里的 `requestId` 不会第二次 `start`。
   */
  step(state: TState, input: BehaviorInput): BehaviorStep<TState>;
}

export type BehaviorFactory = (deps: BehaviorDeps) => BehaviorScheduler<unknown>;

/** 尚未开始的点击或自动动作。 */
export interface PendingBehavior {
  requestId: string;
  kind: 'click' | 'auto';
  expiresAtMs: number;
  /** 接纳这条请求的输入时间。容量淘汰按接纳次序，不按这个字段重排。 */
  admittedAtMs: number;
}

/** 已经离开待处理或活动槽的请求。历史被挤出后，该 id 不再占幂等窗口。 */
export interface BehaviorHistoryEntry {
  requestId: string;
  kind: 'click' | 'auto';
  outcome: 'settled' | BehaviorCancelReason | 'dropped';
  /** `settled` 时为输入的 `ok`，其余为 null。 */
  ok: boolean | null;
  atMs: number;
}

export interface ActiveBehavior {
  requestId: string;
  kind: 'click' | 'auto';
}

/**
 * 调度器内存。调用方应把它当作不可变值传递。
 * 待处理点击最多一条：新点击替换它，而不是排成同级队列。
 */
export interface BehaviorState {
  dragging: boolean;
  active: ActiveBehavior | null;
  /** 只在拖动期间保留。非拖动时点击会立刻开始，不进这条槽。 */
  pendingClick: PendingBehavior | null;
  /** 按接纳次序排列。 */
  pendingAutos: PendingBehavior[];
  /** 最旧在前。超过上限时丢掉开头。 */
  history: BehaviorHistoryEntry[];
}

/** 提议器的一条自动动作候选。请求身份由调用方分配。 */
export interface AutoCandidate {
  requestId: string;
  /** 此候选从该时刻起可以提议。 */
  readyAtMs: number;
  expiresAtMs: number;
}
