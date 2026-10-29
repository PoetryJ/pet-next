/**
 * 产品行为的纯函数步进。
 * 时间只认输入的 `nowMs`。随机数只在多个未过期自动动作都可以开始时取下标。
 * @module pet-next/core/behavior/reduce
 */
import { autoMayStart, BEHAVIOR_LIMITS, indexFromRandom, isExpired, isIdle } from './policy.ts';
import type {
  ActiveBehavior,
  BehaviorEffect,
  BehaviorHistoryEntry,
  BehaviorInput,
  BehaviorState,
  BehaviorStep,
  PendingBehavior,
} from './types.ts';

/** 空闲起点。每次调用都返回新的数组。 */
export function initialBehaviorState(): BehaviorState {
  return {
    dragging: false,
    active: null,
    pendingClick: null,
    pendingAutos: [],
    history: [],
  };
}

/**
 * 推进一步。不修改 `state`。
 * 完成或失败只发出 `idle`，同一步不会接着开始待处理的自动动作。
 * 拖动结束或新接纳的自动动作，才可能在空闲时开始下一条。
 */
export function stepBehavior(
  state: BehaviorState,
  input: BehaviorInput,
  random: () => number,
): BehaviorStep<BehaviorState> {
  const draft = cloneState(state);
  const effects: BehaviorEffect[] = [];
  let promote = false;
  expirePending(draft, input.nowMs, effects);
  switch (input.type) {
    case 'click':
      acceptClick(draft, input, effects);
      break;
    case 'drag':
      promote = acceptDrag(draft, input, effects);
      break;
    case 'auto':
      promote = acceptAuto(draft, input, effects);
      break;
    case 'settled':
      acceptSettled(draft, input, effects);
      break;
    default: {
      const unreachable: never = input;
      return unreachable;
    }
  }
  trimPending(draft, input.nowMs);
  if (promote) promoteNext(draft, input.nowMs, random, effects);
  return {
    state: draft,
    effects,
    pending: pendingCount(draft),
    history: draft.history.length,
  };
}

function cloneState(state: BehaviorState): BehaviorState {
  return {
    dragging: state.dragging,
    active: state.active === null ? null : { requestId: state.active.requestId, kind: state.active.kind },
    pendingClick: state.pendingClick === null ? null : copyPending(state.pendingClick),
    pendingAutos: state.pendingAutos.map(copyPending),
    history: state.history.map(copyHistory),
  };
}

function copyPending(request: PendingBehavior): PendingBehavior {
  return {
    requestId: request.requestId,
    kind: request.kind,
    expiresAtMs: request.expiresAtMs,
    admittedAtMs: request.admittedAtMs,
  };
}

function copyHistory(entry: BehaviorHistoryEntry): BehaviorHistoryEntry {
  return {
    requestId: entry.requestId,
    kind: entry.kind,
    outcome: entry.outcome,
    ok: entry.ok,
    atMs: entry.atMs,
  };
}

function pendingCount(state: BehaviorState): number {
  return state.pendingAutos.length + (state.pendingClick === null ? 0 : 1);
}

function seen(state: BehaviorState, requestId: string): boolean {
  if (state.active?.requestId === requestId) return true;
  if (state.pendingClick?.requestId === requestId) return true;
  if (state.pendingAutos.some((item) => item.requestId === requestId)) return true;
  return state.history.some((item) => item.requestId === requestId);
}

function admit(kind: 'click' | 'auto', requestId: string, nowMs: number, expiresAtMs: number): PendingBehavior {
  return { requestId, kind, expiresAtMs, admittedAtMs: nowMs };
}

function remember(state: BehaviorState, entry: BehaviorHistoryEntry): void {
  const next = state.history.concat(entry);
  state.history = next.length <= BEHAVIOR_LIMITS.history ? next : next.slice(next.length - BEHAVIOR_LIMITS.history);
}

function expirePending(state: BehaviorState, nowMs: number, effects: BehaviorEffect[]): void {
  if (state.pendingClick !== null && isExpired(nowMs, state.pendingClick.expiresAtMs)) {
    const click = state.pendingClick;
    state.pendingClick = null;
    cancelUnstarted(state, click, nowMs, effects);
  }
  const kept: PendingBehavior[] = [];
  for (const auto of state.pendingAutos) {
    if (isExpired(nowMs, auto.expiresAtMs)) cancelUnstarted(state, auto, nowMs, effects);
    else kept.push(auto);
  }
  state.pendingAutos = kept;
}

function cancelUnstarted(state: BehaviorState, request: PendingBehavior, nowMs: number, effects: BehaviorEffect[]): void {
  remember(state, { requestId: request.requestId, kind: request.kind, outcome: 'expired', ok: null, atMs: nowMs });
  effects.push({ type: 'cancel', requestId: request.requestId, reason: 'expired' });
}

function acceptClick(
  state: BehaviorState,
  input: Extract<BehaviorInput, { type: 'click' }>,
  effects: BehaviorEffect[],
): void {
  if (seen(state, input.requestId)) return;
  const request = admit('click', input.requestId, input.nowMs, input.expiresAtMs);
  if (isExpired(input.nowMs, input.expiresAtMs)) {
    cancelUnstarted(state, request, input.nowMs, effects);
    return;
  }
  if (state.pendingClick !== null) {
    const previous = state.pendingClick;
    state.pendingClick = null;
    remember(state, {
      requestId: previous.requestId,
      kind: 'click',
      outcome: 'superseded',
      ok: null,
      atMs: input.nowMs,
    });
    effects.push({ type: 'cancel', requestId: previous.requestId, reason: 'superseded' });
  }
  if (state.dragging) {
    state.pendingClick = request;
    return;
  }
  // 点击替换活动中的点击或自动动作。自动动作没有单独的打断理由，同样记 superseded。
  if (state.active !== null) cancelActive(state, 'superseded', input.nowMs, effects);
  start(state, request, effects);
}

function acceptDrag(
  state: BehaviorState,
  input: Extract<BehaviorInput, { type: 'drag' }>,
  effects: BehaviorEffect[],
): boolean {
  if (input.phase === 'start') {
    if (state.dragging) return false;
    state.dragging = true;
    if (state.active !== null) {
      cancelActive(state, 'drag', input.nowMs, effects);
      effects.push({ type: 'idle' });
    }
    return false;
  }
  const wasDragging = state.dragging;
  state.dragging = false;
  return wasDragging;
}

function acceptAuto(
  state: BehaviorState,
  input: Extract<BehaviorInput, { type: 'auto' }>,
  effects: BehaviorEffect[],
): boolean {
  if (seen(state, input.requestId)) return false;
  const request = admit('auto', input.requestId, input.nowMs, input.expiresAtMs);
  if (isExpired(input.nowMs, input.expiresAtMs)) {
    cancelUnstarted(state, request, input.nowMs, effects);
    return false;
  }
  state.pendingAutos.push(request);
  return true;
}

function acceptSettled(
  state: BehaviorState,
  input: Extract<BehaviorInput, { type: 'settled' }>,
  effects: BehaviorEffect[],
): void {
  if (state.active === null || state.active.requestId !== input.requestId) return;
  const current = state.active;
  state.active = null;
  remember(state, {
    requestId: current.requestId,
    kind: current.kind,
    outcome: 'settled',
    ok: input.ok,
    atMs: input.nowMs,
  });
  effects.push({ type: 'idle' });
}

function cancelActive(
  state: BehaviorState,
  reason: 'superseded' | 'drag',
  nowMs: number,
  effects: BehaviorEffect[],
): void {
  if (state.active === null) return;
  const current = state.active;
  state.active = null;
  remember(state, { requestId: current.requestId, kind: current.kind, outcome: reason, ok: null, atMs: nowMs });
  effects.push({ type: 'cancel', requestId: current.requestId, reason });
}

function trimPending(state: BehaviorState, nowMs: number): void {
  while (pendingCount(state) > BEHAVIOR_LIMITS.pending) {
    const oldest = state.pendingAutos[0];
    if (oldest === undefined) break;
    state.pendingAutos = state.pendingAutos.slice(1);
    remember(state, { requestId: oldest.requestId, kind: 'auto', outcome: 'dropped', ok: null, atMs: nowMs });
  }
}

function promoteNext(state: BehaviorState, nowMs: number, random: () => number, effects: BehaviorEffect[]): void {
  if (state.dragging || !isIdle(state.active)) return;
  if (state.pendingClick !== null) {
    const click = state.pendingClick;
    state.pendingClick = null;
    start(state, click, effects);
    return;
  }
  const ready = state.pendingAutos.filter((auto) => autoMayStart(state.active, state.dragging, nowMs, auto.expiresAtMs));
  if (ready.length === 0) return;
  const chosen = ready[indexFromRandom(ready.length, random)];
  if (chosen === undefined) return;
  state.pendingAutos = state.pendingAutos.filter((auto) => auto.requestId !== chosen.requestId);
  start(state, chosen, effects);
}

function start(state: BehaviorState, request: PendingBehavior, effects: BehaviorEffect[]): void {
  const active: ActiveBehavior = { requestId: request.requestId, kind: request.kind };
  state.active = active;
  effects.push({
    type: 'start',
    requestId: request.requestId,
    clip: request.kind === 'click' ? 'reaction' : 'auto',
  });
}
