/**
 * 回放一个工厂。计时只包住 `step`，造数和拷贝不算进去。
 */
import type { ArbiterDecision, ArbiterEvent, ArbiterInput } from '../../../contracts/arbiter.ts';
import type { MetricStep } from './metrics.ts';

/** 工厂对核对器只暴露初始状态和 `step`。状态类型保持不透明。 */
export type ReplayFactory = () => {
  initialState(): unknown;
  step(state: never, input: ArbiterInput): { state: unknown; decisions: readonly ArbiterDecision[]; queueLength: number };
};

/** 一次回放。抛错时保留已经走出的步骤。 */
export interface ReplayResult {
  steps: MetricStep[];
  /** 只包含 `step` 的墙钟毫秒。 */
  machineElapsedMs: number;
  error: string | null;
  unimplemented: boolean;
}

/**
 * 从 `initialState()` 跑完整段输入。
 *
 * @param factory - 基线或状态机工厂。每次调用都新建一场。
 * @param inputs - 会先拷贝再交给 `step`。
 * @returns 决策、等待数，以及包住 `step` 的耗时。
 */
export function replayFactory(factory: ReplayFactory, inputs: readonly ArbiterInput[]): ReplayResult {
  const steps: MetricStep[] = [];
  let elapsedNs = 0n;
  try {
    const arbiter = factory();
    let state: unknown = arbiter.initialState();
    for (const input of inputs) {
      const isolated = copyInput(input);
      const started = process.hrtime.bigint();
      const result = arbiter.step(state as never, isolated);
      elapsedNs += process.hrtime.bigint() - started;
      state = result.state;
      steps.push({
        nowMs: input.nowMs,
        decisions: result.decisions.map(copyDecision),
        queueLength: result.queueLength,
      });
    }
  } catch (error) {
    return { steps, machineElapsedMs: elapsedMs(elapsedNs), error: messageOf(error), unimplemented: isUnimplemented(error) };
  }
  return { steps, machineElapsedMs: elapsedMs(elapsedNs), error: null, unimplemented: false };
}

function elapsedMs(elapsedNs: bigint): number {
  return Number(elapsedNs) / 1_000_000;
}

function isUnimplemented(error: unknown): boolean {
  return error instanceof Error && error.message.includes('尚未实现');
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function copyInput(input: ArbiterInput): ArbiterInput {
  if (input.type === 'complete') return { type: 'complete', actionId: input.actionId, nowMs: input.nowMs };
  return { type: 'deliver', nowMs: input.nowMs, event: copyEvent(input.event) };
}

function copyEvent(event: ArbiterEvent): ArbiterEvent {
  return {
    id: event.id,
    source: event.source,
    seq: event.seq,
    timeMs: event.timeMs,
    expiresAtMs: event.expiresAtMs,
  };
}

function copyDecision(decision: ArbiterDecision): ArbiterDecision {
  return {
    outcome: decision.outcome,
    reason: decision.reason,
    eventId: decision.eventId,
    actionId: decision.actionId,
  };
}
