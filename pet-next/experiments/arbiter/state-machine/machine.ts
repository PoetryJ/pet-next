/**
 * 四态阶段机：投递按阶段和来源查表，完成只结束对得上的活动动作。
 * 时间只来自输入的 nowMs。被抢占的动作不回到等待队列。
 */
import {
  ARBITER_RANK,
  type ArbiterDecision,
  type ArbiterEvent,
  type ArbiterInput,
  type ArbiterReason,
  type ArbiterSource,
  type ArbiterStep,
} from '../../../contracts/arbiter.ts';

/** 空闲没有活动动作；其余阶段等于活动动作的来源。 */
export type MachinePhase = 'idle' | ArbiterSource;

/**
 * 阶段机这一侧的内存。日志不比较它。
 * @internal
 */
export interface MachineState {
  readonly phase: MachinePhase;
  readonly active: ArbiterEvent | null;
  /** 尚未开始的事件，不含活动动作。 */
  readonly queue: readonly ArbiterEvent[];
  /** 本场见过的 id，含到达即过期和被抢占的事件。 */
  readonly seen: ReadonlySet<string>;
}

interface Draft {
  phase: MachinePhase;
  active: ArbiterEvent | null;
  queue: ArbiterEvent[];
  seen: Set<string>;
}

type WaitReason = Extract<ArbiterReason, 'queued-same-rank' | 'queued-lower-rank' | 'drag-blocks-auto'>;

type DeliverEffect = { kind: 'start' } | { kind: 'preempt' } | { kind: 'wait'; reason: WaitReason };

/**
 * 新事件尚未过期时，当前阶段与来源决定下一格。
 * 拖动期间的自动提醒单独记为 `drag-blocks-auto`。
 */
const DELIVER_EFFECT = {
  idle: {
    drag: { kind: 'start' },
    click: { kind: 'start' },
    auto: { kind: 'start' },
  },
  drag: {
    drag: { kind: 'wait', reason: 'queued-same-rank' },
    click: { kind: 'wait', reason: 'queued-lower-rank' },
    auto: { kind: 'wait', reason: 'drag-blocks-auto' },
  },
  click: {
    drag: { kind: 'preempt' },
    click: { kind: 'wait', reason: 'queued-same-rank' },
    auto: { kind: 'wait', reason: 'queued-lower-rank' },
  },
  auto: {
    drag: { kind: 'preempt' },
    click: { kind: 'preempt' },
    auto: { kind: 'wait', reason: 'queued-same-rank' },
  },
} as const satisfies Record<MachinePhase, Record<ArbiterSource, DeliverEffect>>;

/** 空场。每次返回新的队列和 seen。 */
export function initialMachineState(): MachineState {
  return { phase: 'idle', active: null, queue: [], seen: new Set() };
}

/**
 * 推进一步。入参不会被修改，返回值也不与入参共享队列、seen 或事件。
 *
 * @param state - 上一步的状态。阶段与活动动作不一致时，以活动动作的来源为准。
 * @param input - 一条投递或完成。`nowMs` 是本步唯一时间。
 * @returns 新状态、按协议顺序排列的决策，以及等待数。
 */
export function stepMachine(state: MachineState, input: ArbiterInput): ArbiterStep<MachineState> {
  const draft = cloneState(state);
  const decisions: ArbiterDecision[] = [];
  // 过期只清等待队列，必须先于本步输入；活动动作留到完成或抢占。
  discardExpired(draft, input.nowMs, decisions);
  if (input.type === 'complete') {
    if (acceptCompletion(draft, input.actionId, decisions)) admitNext(draft, decisions);
    return publish(draft, decisions);
  }
  acceptDelivery(draft, input.event, input.nowMs, decisions);
  if (draft.phase === 'idle') admitNext(draft, decisions);
  return publish(draft, decisions);
}

function cloneState(state: MachineState): Draft {
  const active = state.active === null ? null : copyEvent(state.active);
  return {
    phase: active === null ? 'idle' : active.source,
    active,
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

function discardExpired(draft: Draft, nowMs: number, decisions: ArbiterDecision[]): void {
  const expired = draft.queue.filter((event) => nowMs >= event.expiresAtMs).sort(compareQueueOrder);
  if (expired.length === 0) return;
  const dropping = new Set(expired);
  draft.queue = draft.queue.filter((event) => !dropping.has(event));
  for (const event of expired) decisions.push(decide('discard', 'expired', event.id, null));
}

function acceptCompletion(draft: Draft, actionId: string, decisions: ArbiterDecision[]): boolean {
  if (draft.active === null || draft.active.id !== actionId) {
    decisions.push(decide('discard', 'stale-completion', null, actionId));
    return false;
  }
  const eventId = draft.active.id;
  decisions.push(decide('execute', 'completed', eventId, eventId));
  draft.active = null;
  draft.phase = 'idle';
  return true;
}

function acceptDelivery(draft: Draft, incoming: ArbiterEvent, nowMs: number, decisions: ArbiterDecision[]): void {
  const event = copyEvent(incoming);
  if (draft.seen.has(event.id)) {
    decisions.push(decide('discard', 'duplicate', event.id, null));
    return;
  }
  draft.seen.add(event.id);
  if (isArrivalExpired(event, nowMs)) {
    decisions.push(decide('discard', 'expired', event.id, null));
    return;
  }
  applyEffect(draft, event, DELIVER_EFFECT[draft.phase][event.source], decisions);
}

function applyEffect(draft: Draft, event: ArbiterEvent, effect: DeliverEffect, decisions: ArbiterDecision[]): void {
  if (effect.kind === 'start') {
    begin(draft, event, decisions);
    return;
  }
  if (effect.kind === 'preempt') {
    displace(draft, decisions);
    begin(draft, event, decisions);
    return;
  }
  draft.queue.push(event);
  decisions.push(decide('wait', effect.reason, event.id, null));
}

/** 结束活动动作。被抢占的事件不回到等待队列。 */
function displace(draft: Draft, decisions: ArbiterDecision[]): void {
  const previous = draft.active;
  if (previous === null) return;
  decisions.push(decide('discard', 'preempted', previous.id, previous.id));
  draft.active = null;
  draft.phase = 'idle';
}

function begin(draft: Draft, event: ArbiterEvent, decisions: ArbiterDecision[]): void {
  draft.active = event;
  draft.phase = event.source;
  decisions.push(decide('execute', 'started', event.id, event.id));
}

/** 当前阶段为空时，从等待队列开始一个事件。 */
function admitNext(draft: Draft, decisions: ArbiterDecision[]): void {
  if (draft.phase !== 'idle' || draft.queue.length === 0) return;
  const next = chooseNext(draft.queue);
  draft.queue = draft.queue.filter((event) => event !== next);
  begin(draft, next, decisions);
}

function chooseNext(queue: readonly ArbiterEvent[]): ArbiterEvent {
  let best: ArbiterEvent | null = null;
  for (const event of queue) {
    if (best === null || compareStart(event, best) < 0) best = event;
  }
  if (best === null) throw new Error('空的等待队列不能开始动作');
  return best;
}

function isArrivalExpired(event: ArbiterEvent, nowMs: number): boolean {
  return nowMs >= event.expiresAtMs || event.timeMs >= event.expiresAtMs;
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

function decide(
  outcome: ArbiterDecision['outcome'],
  reason: ArbiterReason,
  eventId: string | null,
  actionId: string | null,
): ArbiterDecision {
  return { outcome, reason, eventId, actionId };
}

function publish(draft: Draft, decisions: readonly ArbiterDecision[]): ArbiterStep<MachineState> {
  return {
    state: { phase: draft.phase, active: draft.active, queue: draft.queue, seen: draft.seen },
    decisions,
    queueLength: draft.queue.length,
  };
}
