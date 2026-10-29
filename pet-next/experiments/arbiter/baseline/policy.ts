/**
 * 最小优先级规则。过期清理先于本步的投递或完成。
 */
import { ARBITER_RANK, type ArbiterDecision, type ArbiterEvent, type ArbiterInput, type ArbiterReason, type ArbiterStep } from '../../../contracts/arbiter.ts';

/**
 * 基线这一侧的内存。日志不比较它；状态机不必使用同一形状。
 * @internal
 */
export interface BaselineState {
  active: ArbiterEvent | null;
  queue: readonly ArbiterEvent[];
  /** 本场投递过的 id，含到达即过期和被抢占的事件。 */
  seen: ReadonlySet<string>;
}

interface Draft {
  active: ArbiterEvent | null;
  queue: ArbiterEvent[];
  seen: Set<string>;
}

/** 空场。每次返回新的队列和 seen。 */
export function initialBaselineState(): BaselineState {
  return { active: null, queue: [], seen: new Set() };
}

/**
 * 推进一步。入参不会被修改，返回值也不与入参共享队列或 seen。
 *
 * @param state - 上一步的状态。
 * @param input - 一条投递或完成。`nowMs` 是本步唯一时间。
 * @returns 新状态、按协议顺序排列的决策，以及等待数。
 */
export function stepBaseline(state: BaselineState, input: ArbiterInput): ArbiterStep<BaselineState> {
  const draft = cloneState(state);
  const decisions: ArbiterDecision[] = [];
  expireWaiting(draft, input.nowMs, decisions);
  if (input.type === 'complete') {
    if (finishActive(draft, input.actionId, decisions)) promote(draft, decisions);
    return pack(draft, decisions);
  }
  if (input.type === 'deliver') {
    acceptDeliver(draft, input.event, input.nowMs, decisions);
    if (draft.active === null) promote(draft, decisions);
    return pack(draft, decisions);
  }
  return assertNever(input);
}

function cloneState(state: BaselineState): Draft {
  return {
    active: state.active === null ? null : copyEvent(state.active),
    queue: state.queue.map(copyEvent),
    seen: new Set(state.seen),
  };
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

function expireWaiting(draft: Draft, nowMs: number, decisions: ArbiterDecision[]): void {
  const expired = draft.queue.filter((event) => nowMs >= event.expiresAtMs).sort(compareQueueOrder);
  if (expired.length === 0) return;
  const dropping = new Set(expired);
  draft.queue = draft.queue.filter((event) => !dropping.has(event));
  for (const event of expired) decisions.push(decide('discard', 'expired', event.id, null));
}

function finishActive(draft: Draft, actionId: string, decisions: ArbiterDecision[]): boolean {
  if (draft.active === null || draft.active.id !== actionId) {
    decisions.push(decide('discard', 'stale-completion', null, actionId));
    return false;
  }
  const id = draft.active.id;
  decisions.push(decide('execute', 'completed', id, id));
  draft.active = null;
  return true;
}

function acceptDeliver(draft: Draft, incoming: ArbiterEvent, nowMs: number, decisions: ArbiterDecision[]): void {
  const event = copyEvent(incoming);
  if (draft.seen.has(event.id)) {
    decisions.push(decide('discard', 'duplicate', event.id, null));
    return;
  }
  draft.seen.add(event.id);
  if (nowMs >= event.expiresAtMs || event.timeMs >= event.expiresAtMs) {
    decisions.push(decide('discard', 'expired', event.id, null));
    return;
  }
  if (draft.active === null) {
    start(draft, event, decisions);
    return;
  }
  if (ARBITER_RANK[event.source] > ARBITER_RANK[draft.active.source]) {
    preempt(draft, event, decisions);
    return;
  }
  enqueue(draft, event, decisions);
}

function preempt(draft: Draft, event: ArbiterEvent, decisions: ArbiterDecision[]): void {
  const previous = draft.active;
  if (previous === null) return;
  decisions.push(decide('discard', 'preempted', previous.id, previous.id));
  start(draft, event, decisions);
}

function enqueue(draft: Draft, event: ArbiterEvent, decisions: ArbiterDecision[]): void {
  const active = draft.active;
  if (active === null) return;
  draft.queue.push(event);
  decisions.push(decide('wait', waitReason(event, active), event.id, null));
}

function waitReason(event: ArbiterEvent, active: ArbiterEvent): ArbiterReason {
  if (event.source === 'auto' && active.source === 'drag') return 'drag-blocks-auto';
  if (ARBITER_RANK[event.source] === ARBITER_RANK[active.source]) return 'queued-same-rank';
  return 'queued-lower-rank';
}

function promote(draft: Draft, decisions: ArbiterDecision[]): void {
  if (draft.active !== null || draft.queue.length === 0) return;
  const next = pickNext(draft.queue);
  draft.queue = draft.queue.filter((event) => event !== next);
  start(draft, next, decisions);
}

function start(draft: Draft, event: ArbiterEvent, decisions: ArbiterDecision[]): void {
  draft.active = event;
  decisions.push(decide('execute', 'started', event.id, event.id));
}

function pickNext(queue: readonly ArbiterEvent[]): ArbiterEvent {
  let best: ArbiterEvent | null = null;
  for (const event of queue) {
    if (best === null || compareStart(event, best) < 0) best = event;
  }
  if (best === null) throw new Error('空的等待队列不能开始动作');
  return best;
}

function compareStart(left: ArbiterEvent, right: ArbiterEvent): number {
  const byRank = ARBITER_RANK[right.source] - ARBITER_RANK[left.source];
  if (byRank !== 0) return byRank;
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

function pack(draft: Draft, decisions: readonly ArbiterDecision[]): ArbiterStep<BaselineState> {
  return { state: { active: draft.active, queue: draft.queue, seen: draft.seen }, decisions, queueLength: draft.queue.length };
}

function assertNever(value: never): never {
  throw new Error(`未处理的仲裁输入：${JSON.stringify(value)}`);
}
