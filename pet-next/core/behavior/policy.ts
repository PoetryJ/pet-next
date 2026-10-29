/**
 * 产品调度策略。
 *
 * 实验仲裁把同级点击留在队列里，等当前点击结束后按 seq 再开始（`queued-same-rank`）。
 * 产品不沿用那条：新的点击取消上一个未完成的点击，待处理点击始终只有最新一条。
 * 拖动优先于点击和自动动作；自动动作只在空闲且不拖动时开始。
 * @module pet-next/core/behavior/policy
 */

/** 待处理动作和历史的硬上限。超出时丢掉最旧的一条。 */
export const BEHAVIOR_LIMITS = { pending: 8, history: 32 } as const;

/** 产品规则。与实验协议分开冻结，名字与契约一致。 */
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

/**
 * 实验里同级点击的等待理由。产品效果和规则列表都不会使用它。
 * 保留这个名字，是为了标明产品有意不实现该分支。
 */
export const EXPERIMENT_SAME_RANK_QUEUE = 'queued-same-rank' as const;

/**
 * `nowMs >= expiresAtMs`，或时间不是有限数时，请求不能开始。
 * 相等算过期，避免把刚好到期的自动动作放出去。
 */
export function isExpired(nowMs: number, expiresAtMs: number): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresAtMs)) return true;
  return nowMs >= expiresAtMs;
}

/** 没有活动请求时才算空闲。拖动与否另行判断。 */
export function isIdle(active: unknown): boolean {
  return active === null;
}

/**
 * 自动动作可以开始的条件：空闲、不在拖动中、还没过期。
 * 拖动进行中即使已经空闲，也不能开始。
 */
export function autoMayStart(active: unknown, dragging: boolean, nowMs: number, expiresAtMs: number): boolean {
  return isIdle(active) && !dragging && !isExpired(nowMs, expiresAtMs);
}

/** 宿主定时器只在空闲且未拖动时提议。忙或拖动时不读取候选。 */
export function mayProposeAuto(active: unknown, dragging: boolean): boolean {
  return isIdle(active) && !dragging;
}

/**
 * 在 `count` 个已按接纳次序排好的自动动作里取下标。
 * 只有一个时不调用 `random`。`random()` 必须落在 [0, 1)。
 *
 * @throws {RangeError} 个数不是正整数，或随机数超出 [0, 1)。
 */
export function indexFromRandom(count: number, random: () => number): number {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError('count must be a positive integer');
  }
  if (count === 1) return 0;
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError('random() must return a finite number in [0, 1)');
  }
  const index = Math.floor(sample * count);
  return index >= count ? count - 1 : index;
}
