/**
 * 把一份夹具跑成原始日志。计时只包住 `step`。
 */
import type {
  Arbiter,
  ArbiterDecision,
  ArbiterEvent,
  ArbiterImplementation,
  ArbiterInput,
  ArbiterRunLog,
  ArbiterStepRecord,
} from '../../../contracts/arbiter.ts';
import type { ArbiterFixture } from '../fixtures/catalog.ts';

/**
 * 从 `initialState()` 起按输入顺序调用 `step`。
 *
 * @param implementation - 写入日志的实现名。
 * @param arbiter - 已构造的仲裁。状态只在返回值里传递。
 * @param fixture - 固定输入。函数会把副本交给 `step`，避免实现改到日志里的事件。
 * @returns 不含内部状态的运行日志。
 */
export function runFixture(implementation: ArbiterImplementation, arbiter: Arbiter<unknown>, fixture: ArbiterFixture): ArbiterRunLog {
  let state = arbiter.initialState();
  const delivered = fixture.inputs.map(copyInput);
  const steps: ArbiterStepRecord[] = [];
  let elapsedNs = 0n;
  for (const input of delivered) {
    const isolated = copyInput(input);
    const started = process.hrtime.bigint();
    const result = arbiter.step(state, isolated);
    elapsedNs += process.hrtime.bigint() - started;
    state = result.state;
    steps.push({
      input,
      decisions: result.decisions.map(copyDecision),
      queueLength: result.queueLength,
    });
  }
  return {
    implementation,
    fixture: fixture.name,
    seed: fixture.seed,
    delivered,
    steps,
    machineElapsedMs: Number(elapsedNs) / 1_000_000,
  };
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
