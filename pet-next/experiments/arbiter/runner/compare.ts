/**
 * 比较一步的决策和等待数。不比较仲裁内部状态。
 */
import type { ArbiterDecision, ArbiterImplementation, ArbiterRunLog, ArbiterStepExpectation } from '../../../contracts/arbiter.ts';

/**
 * 第一条对不上规范性期望的输入下标。
 *
 * @param log - 一次运行的原始步骤。
 * @param expected - 与输入等长的期望。
 * @returns 没有差异时为 null。
 */
export function firstExpectedMismatch(log: ArbiterRunLog, expected: readonly ArbiterStepExpectation[]): number | null {
  const length = Math.max(log.steps.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    const want = expected[index];
    const got = log.steps[index];
    if (want === undefined || got === undefined || !sameStep(want, got)) return index;
  }
  return null;
}

/**
 * 两条日志第一次分叉的输入下标。
 *
 * @param left - 通常是基线。
 * @param right - 另一侧实现。
 * @returns 决策和等待数都相同则为 null。
 */
export function firstDivergence(left: ArbiterRunLog, right: ArbiterRunLog): number | null {
  const length = Math.max(left.steps.length, right.steps.length);
  for (let index = 0; index < length; index += 1) {
    const leftStep = left.steps[index];
    const rightStep = right.steps[index];
    if (leftStep === undefined || rightStep === undefined || !sameStep(leftStep, rightStep)) return index;
  }
  return null;
}

/**
 * 描述一条规范性差异，供 runner 写到 stderr。
 *
 * @param implementation - 哪一侧对不上。
 * @param fixture - 夹具名。
 * @param index - `firstExpectedMismatch` 的下标。
 * @param expected - 该夹具的期望。
 * @param log - 实际日志。
 * @returns 一行说明。
 */
export function explainExpectedMismatch(
  implementation: ArbiterImplementation,
  fixture: string,
  index: number,
  expected: readonly ArbiterStepExpectation[],
  log: ArbiterRunLog,
): string {
  const want = expected[index];
  const got = log.steps[index];
  const wantText = want === undefined ? '缺少期望' : `queueLength=${want.queueLength}，decisions=${formatDecisions(want.decisions)}`;
  const gotText = got === undefined ? '缺少实际步骤' : `queueLength=${got.queueLength}，decisions=${formatDecisions(got.decisions)}`;
  return `${implementation} 夹具 ${fixture} 在输入下标 ${index} 与规范性例子不一致。期望 ${wantText}。实际 ${gotText}。`;
}

/**
 * 描述持续负载上的分叉。
 *
 * @param fixture - 夹具名。
 * @param index - 第一条不同的输入下标。
 * @returns 一行说明。两边谁对不在这里判断。
 */
export function explainDivergence(fixture: string, index: number): string {
  return `baseline 与 state-machine 在夹具 ${fixture} 的输入下标 ${index} 分叉。`;
}

function sameStep(
  left: { decisions: readonly ArbiterDecision[]; queueLength: number },
  right: { decisions: readonly ArbiterDecision[]; queueLength: number },
): boolean {
  return left.queueLength === right.queueLength && sameDecisions(left.decisions, right.decisions);
}

function sameDecisions(left: readonly ArbiterDecision[], right: readonly ArbiterDecision[]): boolean {
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

function formatDecisions(decisions: readonly ArbiterDecision[]): string {
  if (decisions.length === 0) return '[]';
  return decisions
    .map((decision) => `${decision.outcome}/${decision.reason}/${decision.eventId ?? 'null'}/${decision.actionId ?? 'null'}`)
    .join(',');
}
