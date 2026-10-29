/**
 * 协议的独立参照实现，用来核对基线和状态机。
 * 不引用这两边的源码，时间只取输入里的 `nowMs`。
 * @module pet-next/experiments/arbiter/check/oracle
 */
import { ARBITER_RANK, type ArbiterDecision, type ArbiterEvent, type ArbiterInput, type ArbiterReason, type ArbiterStep } from '../../../contracts/arbiter.ts';

/** 参照实现的内存。只比较对外的决策和等待数。 */
export interface OracleState {
  active: ArbiterEvent | null;
  waiting: readonly ArbiterEvent[];
  seen: ReadonlySet<string>;
}

interface Draft {
  active: ArbiterEvent | null;
  waiting: ArbiterEvent[];
  seen: Set<string>;
}

/** 空场。 */
export function oracleInitial(): OracleState {
  return { active: null, waiting: [], seen: new Set() };
}

/**
 * 按协议推进一步。
 *
 * @param state - 上一步的状态。
 * @param input - 一条投递或完成。
 * @returns 新状态、决策和等待数。入参不会被改写。
 */
export function oracleStep(state: OracleState, input: ArbiterInput): ArbiterStep<OracleState> {
  const draft = cloneState(state);
  const decisions: ArbiterDecision[] = [];
  expireWaiting(draft, input.nowMs, decisions);
  if (input.type === 'complete') {
    if (completeActive(draft, input.actionId, decisions)) promote(draft, decisions);
    return publish(draft, decisions);
  }
  const delivery = acceptDelivery(draft, input.event, input.nowMs, decisions);
  // 重复投递要求其余状态保持原样，不能趁当前为空时把等待者补上去。
  if (delivery !== 'duplicate' && draft.active === null) promote(draft, decisions);
  return publish(draft, decisions);
}

/** 从空场回放整段输入，只留下可比的决策和等待数。 */
export function replayOracle(inputs: readonly ArbiterInput[]): { decisions: readonly ArbiterDecision[]; queueLength: number }[] {
  let state = oracleInitial();
  const steps = [];
  for (const input of inputs) {
    const result = oracleStep(state, copyInput(input));
    state = result.state;
    steps.push({ decisions: result.decisions, queueLength: result.queueLength });
  }
  return steps;
}

function cloneState(state: OracleState): Draft {
  return {
    active: state.active === null ? null : copyEvent(state.active),
    waiting: state.waiting.map(copyEvent),
    seen: new Set(state.seen),
  };
}

function expireWaiting(draft: Draft, nowMs: number, decisions: ArbiterDecision[]): void {
  const expired = draft.waiting.filter((event) => nowMs >= event.expiresAtMs).sort(compareQueueOrder);
  if (expired.length === 0) return;
  const dropping = new Set(expired);
  draft.waiting = draft.waiting.filter((event) => !dropping.has(event));
  for (const event of expired) decisions.push(decide('discard', 'expired', event.id, null));
}

function completeActive(draft: Draft, actionId: string, decisions: ArbiterDecision[]): boolean {
  if (draft.active === null || draft.active.id !== actionId) {
    decisions.push(decide('discard', 'stale-completion', null, actionId));
    return false;
  }
  const eventId = draft.active.id;
  decisions.push(decide('execute', 'completed', eventId, eventId));
  draft.active = null;
  return true;
}

function acceptDelivery(draft: Draft, incoming: ArbiterEvent, nowMs: number, decisions: ArbiterDecision[]): 'duplicate' | 'accepted' {
  const event = copyEvent(incoming);
  if (draft.seen.has(event.id)) {
    decisions.push(decide('discard', 'duplicate', event.id, null));
    return 'duplicate';
  }
  draft.seen.add(event.id);
  if (nowMs >= event.expiresAtMs || event.timeMs >= event.expiresAtMs) {
    decisions.push(decide('discard', 'expired', event.id, null));
    return 'accepted';
  }
  if (draft.active === null) {
    start(draft, event, decisions);
    return 'accepted';
  }
  if (ARBITER_RANK[event.source] > ARBITER_RANK[draft.active.source]) {
    const previous = draft.active;
    decisions.push(decide('discard', 'preempted', previous.id, previous.id));
    start(draft, event, decisions);
    return 'accepted';
  }
  draft.waiting.push(event);
  decisions.push(decide('wait', waitReason(event, draft.active), event.id, null));
  return 'accepted';
}

function waitReason(event: ArbiterEvent, active: ArbiterEvent): ArbiterReason {
  if (event.source === 'auto' && active.source === 'drag') return 'drag-blocks-auto';
  if (ARBITER_RANK[event.source] === ARBITER_RANK[active.source]) return 'queued-same-rank';
  return 'queued-lower-rank';
}

function promote(draft: Draft, decisions: ArbiterDecision[]): void {
  if (draft.active !== null || draft.waiting.length === 0) return;
  const next = pickNext(draft.waiting);
  draft.waiting = draft.waiting.filter((event) => event !== next);
  start(draft, next, decisions);
}

function start(draft: Draft, event: ArbiterEvent, decisions: ArbiterDecision[]): void {
  draft.active = event;
  decisions.push(decide('execute', 'started', event.id, event.id));
}

function pickNext(waiting: readonly ArbiterEvent[]): ArbiterEvent {
  let best: ArbiterEvent | null = null;
  for (const event of waiting) {
    if (best === null || compareStart(event, best) < 0) best = event;
  }
  if (best === null) throw new Error('空的等待队列不能开始动作');
  return best;
}

function compareStart(left: ArbiterEvent, right: ArbiterEvent): number {
  const rankGap = ARBITER_RANK[right.source] - ARBITER_RANK[left.source];
  if (rankGap !== 0) return rankGap;
  return compareQueueOrder(left, right);
}

function compareQueueOrder(left: ArbiterEvent, right: ArbiterEvent): number {
  if (left.seq !== right.seq) return left.seq < right.seq ? -1 : 1;
  if (left.timeMs !== right.timeMs) return left.timeMs < right.timeMs ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

function decide(outcome: ArbiterDecision['outcome'], reason: ArbiterReason, eventId: string | null, actionId: string | null): ArbiterDecision {
  return { outcome, reason, eventId, actionId };
}

function publish(draft: Draft, decisions: readonly ArbiterDecision[]): ArbiterStep<OracleState> {
  return {
    state: { active: draft.active, waiting: draft.waiting, seen: draft.seen },
    decisions,
    queueLength: draft.waiting.length,
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
