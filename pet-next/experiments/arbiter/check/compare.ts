/**
 * 比较决策和等待数。不比较仲裁内部状态。
 */
import type { ArbiterDecision } from '../../../contracts/arbiter.ts';

/** 一步里能拿来对照的部分。 */
export interface ComparableStep {
  decisions: readonly ArbiterDecision[];
  queueLength: number;
}

/** 两条决策在结果、原因和两个 id 上是否相同。顺序也要相同。 */
export function sameDecisions(left: readonly ArbiterDecision[], right: readonly ArbiterDecision[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftDecision = left[index];
    const rightDecision = right[index];
    if (leftDecision === undefined || rightDecision === undefined) return false;
    if (
      leftDecision.outcome !== rightDecision.outcome ||
      leftDecision.reason !== rightDecision.reason ||
      leftDecision.eventId !== rightDecision.eventId ||
      leftDecision.actionId !== rightDecision.actionId
    ) {
      return false;
    }
  }
  return true;
}

/** 等待数和决策都相同。 */
export function sameStep(left: ComparableStep | undefined, right: ComparableStep | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  return left.queueLength === right.queueLength && sameDecisions(left.decisions, right.decisions);
}

/**
 * 第一条对不上的下标。参照可以有多份，任一份不同就算。
 *
 * @param actual - 实现走出的步骤。
 * @param references - 规范性期望、独立参照，以及 runner 日志。缺一份就不参与。
 * @returns 没有差异时为 null。
 */
export function firstMismatch(actual: readonly ComparableStep[], references: readonly (readonly ComparableStep[] | null)[]): number | null {
  const indexes = mismatchIndexes(actual, references);
  return indexes[0] ?? null;
}

/** 对不上的输入下标。同一步只出现一次。 */
export function mismatchIndexes(actual: readonly ComparableStep[], references: readonly (readonly ComparableStep[] | null)[]): number[] {
  const present = references.filter((reference): reference is readonly ComparableStep[] => reference !== null);
  const length = Math.max(actual.length, ...present.map((reference) => reference.length));
  const indexes: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const got = actual[index];
    const failed = present.some((reference) => !sameStep(got, reference[index]));
    if (failed) indexes.push(index);
  }
  return indexes;
}

/** 两边第一次走出不同决策或等待数的下标。 */
export function firstDivergence(left: readonly ComparableStep[], right: readonly ComparableStep[]): number | null {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (!sameStep(left[index], right[index])) return index;
  }
  return null;
}

/** 把一步收成一行，便于写进失败说明。 */
export function formatStep(step: ComparableStep | undefined): string {
  if (step === undefined) return '缺少步骤';
  if (step.decisions.length === 0) return `queueLength=${step.queueLength}，decisions=[]`;
  const decisions = step.decisions
    .map((decision) => `${decision.outcome}/${decision.reason}/${decision.eventId ?? 'null'}/${decision.actionId ?? 'null'}`)
    .join(',');
  return `queueLength=${step.queueLength}，decisions=${decisions}`;
}
