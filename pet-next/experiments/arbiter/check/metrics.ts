/**
 * 从一步步的决策里计算实验指标。模拟等待不混入墙钟时间。
 */
import {
  ARBITER_RANK,
  type ArbiterDecision,
  type ArbiterEvent,
  type ArbiterInput,
  type ArbiterOutcome,
  type ArbiterReason,
} from '../../../contracts/arbiter.ts';

/** 指标用得上的一步。`nowMs` 来自该步输入。 */
export interface MetricStep {
  nowMs: number;
  decisions: readonly ArbiterDecision[];
  queueLength: number;
}

const RESOLVED: readonly ArbiterReason[] = ['started', 'expired', 'duplicate'];

/**
 * 每个事件从 `timeMs` 到首次开始、过期或重复的 `nowMs`，差小于 0 时按 0。
 * 一直停在等待里的事件用最后一步的 `nowMs`。
 *
 * @param inputs - 同一场的输入。同一 id 只取第一次投递的 `timeMs`。
 * @param steps - 与输入等长的决策。
 * @returns 全部事件的模拟等待之和，单位毫秒。
 */
export function simulatedWaitMs(inputs: readonly ArbiterInput[], steps: readonly MetricStep[]): number {
  const events = firstDeliveries(inputs);
  const lastNow = steps.length === 0 ? 0 : (steps[steps.length - 1]?.nowMs ?? 0);
  let total = 0;
  for (const event of events.values()) {
    const resolved = firstResolvedNow(event.id, steps);
    const end = resolved === null ? lastNow : resolved;
    total += Math.max(0, end - event.timeMs);
  }
  return total;
}

/**
 * `started` 落在已过期事件上的次数。
 *
 * @param inputs - 用来找回事件的到期时刻。
 * @param steps - 实际决策。
 * @returns 通过规则时为 0。
 */
export function expiredExecutions(inputs: readonly ArbiterInput[], steps: readonly MetricStep[]): number {
  const events = firstDeliveries(inputs);
  let count = 0;
  for (const step of steps) {
    for (const decision of step.decisions) {
      if (decision.reason !== 'started' || decision.eventId === null) continue;
      const event = events.get(decision.eventId);
      if (event === undefined) continue;
      if (event.expiresAtMs <= step.nowMs || event.timeMs >= event.expiresAtMs) count += 1;
    }
  }
  return count;
}

/**
 * 先等待、最终过期，且等待期间有严格更高优先级事件开始的个数。
 * 饥饿只记录，不单独当失败。
 *
 * @param inputs - 用来找回来源等级。
 * @param steps - 实际决策。过期那一步里排在过期之后的开始不算等待期间。
 * @returns 事件个数。
 */
export function starvationCount(inputs: readonly ArbiterInput[], steps: readonly MetricStep[]): number {
  const events = firstDeliveries(inputs);
  let count = 0;
  for (const event of events.values()) {
    // 协议里的 wait 是 outcome。排队原因是 queued-* 或 drag-blocks-auto。
    const waitedAt = firstOutcomeIndex(event.id, 'wait', steps);
    const expiredAt = firstReasonIndex(event.id, 'expired', steps);
    if (waitedAt === null || expiredAt === null || expiredAt < waitedAt) continue;
    if (higherStartedWhileWaiting(event, waitedAt, expiredAt, steps, events)) count += 1;
  }
  return count;
}

/** 各步等待数的最大值。没有步骤时为 0。 */
export function queuePeak(steps: readonly Pick<MetricStep, 'queueLength'>[]): number {
  let peak = 0;
  for (const step of steps) {
    if (step.queueLength > peak) peak = step.queueLength;
  }
  return peak;
}

function firstDeliveries(inputs: readonly ArbiterInput[]): Map<string, ArbiterEvent> {
  const events = new Map<string, ArbiterEvent>();
  for (const input of inputs) {
    if (input.type !== 'deliver' || events.has(input.event.id)) continue;
    events.set(input.event.id, input.event);
  }
  return events;
}

function firstResolvedNow(eventId: string, steps: readonly MetricStep[]): number | null {
  for (const step of steps) {
    for (const decision of step.decisions) {
      if (decision.eventId !== eventId) continue;
      if (RESOLVED.includes(decision.reason)) return step.nowMs;
    }
  }
  return null;
}

function firstOutcomeIndex(eventId: string, outcome: ArbiterOutcome, steps: readonly MetricStep[]): number | null {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step === undefined) continue;
    for (const decision of step.decisions) {
      if (decision.eventId === eventId && decision.outcome === outcome) return index;
    }
  }
  return null;
}

function firstReasonIndex(eventId: string, reason: ArbiterReason, steps: readonly MetricStep[]): number | null {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step === undefined) continue;
    for (const decision of step.decisions) {
      if (decision.eventId === eventId && decision.reason === reason) return index;
    }
  }
  return null;
}

function higherStartedWhileWaiting(
  event: ArbiterEvent,
  waitedAt: number,
  expiredAt: number,
  steps: readonly MetricStep[],
  events: ReadonlyMap<string, ArbiterEvent>,
): boolean {
  for (let index = waitedAt; index <= expiredAt; index += 1) {
    const step = steps[index];
    if (step === undefined) continue;
    for (const decision of step.decisions) {
      if (index === expiredAt && decision.eventId === event.id && decision.reason === 'expired') return false;
      if (decision.reason !== 'started' || decision.eventId === null || decision.eventId === event.id) continue;
      const started = events.get(decision.eventId);
      if (started !== undefined && ARBITER_RANK[started.source] > ARBITER_RANK[event.source]) return true;
    }
  }
  return false;
}
