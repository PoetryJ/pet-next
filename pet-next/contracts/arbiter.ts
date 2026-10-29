/**
 * 行为仲裁实验的共享形状。基线和状态机都实现 {@link Arbiter}。
 * 规则、随机序列和规范性例子分别在协议文档、`mulberry32` 和 `arbiter-examples`。
 * 默认启动路径不引用本模块。
 * @module pet-next/contracts/arbiter
 */

/** 数值越大越优先。同级不互相抢占。 */
export const ARBITER_RANK = { drag: 3, click: 2, auto: 1 } as const;

export const REQUIRED_FIXTURE_NAMES = [
  'normal',
  'conflict',
  'expired',
  'cancel',
  'duplicate',
  'reordered',
  'sustained-high-priority',
] as const;

/**
 * 持续高优先级负载的造数参数。
 * 随机算法见 `docs/arbiter-protocol.md`。阈值用同一个随机数按顺序比较：
 * 小于 `dragBelow` 为 drag，小于 `clickBelow` 为 click，其余为 auto。
 */
export const SUSTAINED_LOAD = {
  fixture: 'sustained-high-priority',
  seed: 20261029,
  count: 100,
  timeStepMs: 10,
  ttlMs: 50,
  dragBelow: 0.7,
  clickBelow: 0.85,
} as const;

export type ArbiterSource = keyof typeof ARBITER_RANK;

export interface ArbiterEvent {
  /** 本场实验内唯一。再次出现同一 id 视为重复投递。 */
  id: string;
  source: ArbiterSource;
  /** 队列次序。它不等于 runner 的投递顺序。 */
  seq: number;
  /** 事件时间，毫秒。实现不得另读时钟。 */
  timeMs: number;
  /** 到期时刻，毫秒。`nowMs >= expiresAtMs` 时不得开始执行。 */
  expiresAtMs: number;
}

export type ArbiterInput =
  | { type: 'deliver'; event: ArbiterEvent; nowMs: number }
  | { type: 'complete'; actionId: string; nowMs: number };

export type ArbiterOutcome = 'execute' | 'wait' | 'discard';

export type ArbiterReason =
  | 'started'
  | 'queued-same-rank'
  | 'queued-lower-rank'
  | 'preempted'
  | 'expired'
  | 'duplicate'
  | 'stale-completion'
  | 'drag-blocks-auto'
  | 'completed';

export interface ArbiterDecision {
  outcome: ArbiterOutcome;
  reason: ArbiterReason;
  /** 这条决策作用的事件。对不上的完成回调为 null。 */
  eventId: string | null;
  /**
   * 动作 id，等于使之开始的事件 id。
   * 尚未开始的等待、过期和重复为 null。对不上的完成回调填入参里的 actionId。
   */
  actionId: string | null;
}

export interface ArbiterStep<TState> {
  state: TState;
  decisions: readonly ArbiterDecision[];
  /** 本步结束后仍在等待的事件数，不含正在执行的动作。 */
  queueLength: number;
}

export interface Arbiter<TState> {
  /** 没有活动动作、等待队列为空、也没有见过任何 id。 */
  initialState(): TState;
  /**
   * 推进一步。`input` 上的 `nowMs` 是本步唯一时间。
   *
   * @param state - 上一步的状态。第一步用 `initialState`。返回值不与入参共享可变引用。
   * @param input - 一条投递或一条完成回调。
   * @returns 新状态、按协议顺序排列的决策，以及等待队列长度。
   */
  step(state: TState, input: ArbiterInput): ArbiterStep<TState>;
}

export type ArbiterFactory<TState = unknown> = () => Arbiter<TState>;

export type ArbiterImplementation = 'baseline' | 'state-machine';

export interface ArbiterStepRecord {
  input: ArbiterInput;
  decisions: readonly ArbiterDecision[];
  queueLength: number;
}

export interface ArbiterRunLog {
  implementation: ArbiterImplementation;
  fixture: string;
  /** 手写例子为 null。持续负载使用 {@link SUSTAINED_LOAD.seed}。 */
  seed: number | null;
  delivered: readonly ArbiterInput[];
  steps: readonly ArbiterStepRecord[];
  /** 只包含调用 `step` 的墙钟毫秒，不含造数和写文件。 */
  machineElapsedMs: number;
}

export interface ArbiterCheckReport {
  fixture: string;
  implementation: ArbiterImplementation;
  /** 与规则核对不一致的步数。一步算一次。 */
  ruleViolations: number;
  /** `started` 落在已过期事件上的次数。通过时为 0。 */
  expiredExecutions: number;
  /** 事件时间到开始、过期或重复判定的模拟毫秒，不含机器耗时。 */
  simulatedWaitMs: number;
  machineElapsedMs: number;
  starvationCount: number;
  queuePeak: number;
  /** 第一条对不上的输入下标。没有则为 null。 */
  firstFailureIndex: number | null;
}

export interface ArbiterComparison {
  fixture: string;
  baseline: ArbiterCheckReport;
  stateMachine: ArbiterCheckReport;
  /** 两条实现第一次分叉的输入下标。一致则为 null。 */
  firstDivergenceIndex: number | null;
}

export interface ArbiterStepExpectation {
  decisions: readonly ArbiterDecision[];
  queueLength: number;
}

export interface ArbiterExample {
  name: Exclude<(typeof REQUIRED_FIXTURE_NAMES)[number], 'sustained-high-priority'>;
  inputs: readonly ArbiterInput[];
  expected: readonly ArbiterStepExpectation[];
}
