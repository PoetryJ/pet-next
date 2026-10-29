/**
 * 规范性场景。两边实现都要逐步对上这里的决策和队列长度。
 * @module pet-next/contracts/arbiter-examples
 */
import type { ArbiterDecision, ArbiterEvent, ArbiterExample, ArbiterInput, ArbiterStepExpectation } from './arbiter.ts';

function ev(
  id: string,
  source: ArbiterEvent['source'],
  seq: number,
  timeMs: number,
  expiresAtMs: number,
): ArbiterEvent {
  return { id, source, seq, timeMs, expiresAtMs };
}

function deliver(event: ArbiterEvent, nowMs: number): ArbiterInput {
  return { type: 'deliver', event, nowMs };
}

function complete(actionId: string, nowMs: number): ArbiterInput {
  return { type: 'complete', actionId, nowMs };
}

function decided(
  outcome: ArbiterDecision['outcome'],
  reason: ArbiterDecision['reason'],
  eventId: string | null,
  actionId: string | null,
): ArbiterDecision {
  return { outcome, reason, eventId, actionId };
}

function started(eventId: string): ArbiterDecision {
  return decided('execute', 'started', eventId, eventId);
}

function step(decisions: readonly ArbiterDecision[], queueLength: number): ArbiterStepExpectation {
  return { decisions, queueLength };
}

const click = (id: string, seq: number, timeMs: number, expiresAtMs: number, nowMs: number): ArbiterInput =>
  deliver(ev(id, 'click', seq, timeMs, expiresAtMs), nowMs);

const auto = (id: string, seq: number, timeMs: number, expiresAtMs: number, nowMs: number): ArbiterInput =>
  deliver(ev(id, 'auto', seq, timeMs, expiresAtMs), nowMs);

const drag = (id: string, seq: number, timeMs: number, expiresAtMs: number, nowMs: number): ArbiterInput =>
  deliver(ev(id, 'drag', seq, timeMs, expiresAtMs), nowMs);

/** 手写例子。持续负载由 `SUSTAINED_LOAD` 造数，不在这里展开。 */
export const NORMATIVE_EXAMPLES = [
  {
    name: 'normal',
    inputs: [click('c', 0, 0, 200, 0), auto('a', 1, 5, 200, 5), complete('c', 20), complete('a', 40)],
    expected: [
      step([started('c')], 0),
      step([decided('wait', 'queued-lower-rank', 'a', null)], 1),
      step([decided('execute', 'completed', 'c', 'c'), started('a')], 0),
      step([decided('execute', 'completed', 'a', 'a')], 0),
    ],
  },
  {
    name: 'conflict',
    inputs: [auto('a', 0, 0, 100, 0), click('b', 1, 10, 100, 10), drag('d', 2, 20, 100, 20)],
    expected: [
      step([started('a')], 0),
      step([decided('discard', 'preempted', 'a', 'a'), started('b')], 0),
      step([decided('discard', 'preempted', 'b', 'b'), started('d')], 0),
    ],
  },
  {
    name: 'expired',
    inputs: [
      drag('d', 0, 0, 1000, 0),
      auto('gone', 1, 5, 5, 5),
      auto('a', 2, 6, 30, 6),
      click('c', 3, 7, 100, 7),
      complete('d', 30),
    ],
    expected: [
      step([started('d')], 0),
      step([decided('discard', 'expired', 'gone', null)], 0),
      step([decided('wait', 'drag-blocks-auto', 'a', null)], 1),
      step([decided('wait', 'queued-lower-rank', 'c', null)], 2),
      step([decided('discard', 'expired', 'a', null), decided('execute', 'completed', 'd', 'd'), started('c')], 0),
    ],
  },
  {
    name: 'cancel',
    inputs: [click('c1', 0, 0, 100, 0), complete('c1', 10), click('c2', 1, 11, 100, 11), complete('c1', 12), complete('c2', 13)],
    expected: [
      step([started('c1')], 0),
      step([decided('execute', 'completed', 'c1', 'c1')], 0),
      step([started('c2')], 0),
      step([decided('discard', 'stale-completion', null, 'c1')], 0),
      step([decided('execute', 'completed', 'c2', 'c2')], 0),
    ],
  },
  {
    name: 'duplicate',
    inputs: [click('c', 0, 0, 100, 0), click('c', 1, 5, 100, 5), complete('c', 10)],
    expected: [
      step([started('c')], 0),
      step([decided('discard', 'duplicate', 'c', null)], 0),
      step([decided('execute', 'completed', 'c', 'c')], 0),
    ],
  },
  {
    name: 'reordered',
    inputs: [click('late', 2, 0, 100, 0), click('early', 0, 5, 100, 5), complete('late', 10)],
    expected: [
      step([started('late')], 0),
      step([decided('wait', 'queued-same-rank', 'early', null)], 1),
      step([decided('execute', 'completed', 'late', 'late'), started('early')], 0),
    ],
  },
] as const satisfies readonly ArbiterExample[];
