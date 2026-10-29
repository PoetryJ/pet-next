/**
 * 产品行为契约替身。只消费 `contracts/behavior.ts` 的输入并交出效果。
 * 时间取输入的 `nowMs`。随机数只在多个未过期的待处理自动动作里挑选。
 * 不沿用实验仲裁的同级点击排队。
 * @module pet-next/tests/contracts/behavior-double
 */
import {
  BEHAVIOR_LIMITS,
  type BehaviorDeps,
  type BehaviorEffect,
  type BehaviorInput,
  type BehaviorScheduler,
  type BehaviorStep,
} from '../../contracts/behavior.ts';

interface ActiveRequest {
  requestId: string;
  kind: 'click' | 'auto';
}

interface PendingAuto {
  requestId: string;
  expiresAtMs: number;
}

interface ContractBehaviorState {
  readonly kind: 'contract-behavior';
  readonly active: ActiveRequest | null;
  readonly dragging: boolean;
  readonly pending: readonly PendingAuto[];
  readonly history: readonly string[];
  readonly seen: ReadonlySet<string>;
}

interface Draft {
  active: ActiveRequest | null;
  dragging: boolean;
  pending: PendingAuto[];
  history: string[];
  seen: Set<string>;
}

/**
 * 调度器替身。`core/behavior/` 还没有工厂时，用例先打在这里。
 * 接入真实 C 时换成 `BehaviorFactory`，断言保持不动。
 */
export function createContractBehavior(deps: BehaviorDeps): BehaviorScheduler<ContractBehaviorState> {
  return {
    initialState() {
      return {
        kind: 'contract-behavior',
        active: null,
        dragging: false,
        pending: [],
        history: [],
        seen: new Set(),
      };
    },
    step(state, input) {
      const draft = thaw(state);
      const effects: BehaviorEffect[] = [];
      expirePending(draft, input.nowMs, effects);
      applyInput(draft, input, effects, deps.random);
      return publish(draft, effects);
    },
  };
}

function applyInput(draft: Draft, input: BehaviorInput, effects: BehaviorEffect[], random: () => number): void {
  switch (input.type) {
    case 'drag':
      if (input.phase === 'start') {
        draft.dragging = true;
        if (draft.active?.kind === 'auto') cancelActive(draft, 'drag', effects);
        return;
      }
      draft.dragging = false;
      startNextAuto(draft, effects, random);
      return;
    case 'click':
      if (draft.seen.has(input.requestId)) return;
      draft.seen.add(input.requestId);
      if (draft.active) cancelActive(draft, 'superseded', effects);
      effects.push({ type: 'start', requestId: input.requestId, clip: 'reaction' });
      draft.active = { requestId: input.requestId, kind: 'click' };
      return;
    case 'auto':
      if (draft.seen.has(input.requestId)) return;
      draft.seen.add(input.requestId);
      if (input.nowMs >= input.expiresAtMs) {
        effects.push({ type: 'cancel', requestId: input.requestId, reason: 'expired' });
        pushHistory(draft, input.requestId);
        return;
      }
      if (draft.dragging) {
        effects.push({ type: 'cancel', requestId: input.requestId, reason: 'drag' });
        pushHistory(draft, input.requestId);
        return;
      }
      enqueue(draft, { requestId: input.requestId, expiresAtMs: input.expiresAtMs });
      if (draft.active === null) startNextAuto(draft, effects, random);
      return;
    case 'settled':
      if (draft.active?.requestId !== input.requestId) return;
      pushHistory(draft, input.requestId);
      draft.active = null;
      effects.push({ type: 'idle' });
      if (!draft.dragging) startNextAuto(draft, effects, random);
      return;
    default: {
      const unreachable: never = input;
      return unreachable;
    }
  }
}

function expirePending(draft: Draft, nowMs: number, effects: BehaviorEffect[]): void {
  const keep: PendingAuto[] = [];
  for (const item of draft.pending) {
    if (nowMs >= item.expiresAtMs) {
      effects.push({ type: 'cancel', requestId: item.requestId, reason: 'expired' });
      pushHistory(draft, item.requestId);
    } else {
      keep.push(item);
    }
  }
  draft.pending = keep;
}

/** 新点击替换当前动作。未完成的点击和进行中的自动动作都用 `superseded`，因为效果里没有第二种替换理由。 */
function cancelActive(draft: Draft, reason: 'superseded' | 'drag', effects: BehaviorEffect[]): void {
  const active = draft.active;
  if (!active) return;
  effects.push({ type: 'cancel', requestId: active.requestId, reason });
  pushHistory(draft, active.requestId);
  draft.active = null;
  if (reason === 'drag') effects.push({ type: 'idle' });
}

function enqueue(draft: Draft, item: PendingAuto): void {
  while (draft.pending.length >= BEHAVIOR_LIMITS.pending) draft.pending.shift();
  draft.pending.push(item);
}

function startNextAuto(draft: Draft, effects: BehaviorEffect[], random: () => number): void {
  if (draft.dragging || draft.active !== null || draft.pending.length === 0) return;
  const index = draft.pending.length === 1 ? 0 : pickIndex(draft.pending.length, random);
  const picked = draft.pending[index];
  if (!picked) return;
  draft.pending.splice(index, 1);
  effects.push({ type: 'start', requestId: picked.requestId, clip: 'auto' });
  draft.active = { requestId: picked.requestId, kind: 'auto' };
}

function pickIndex(count: number, random: () => number): number {
  const sample = random();
  if (sample < 0 || sample >= 1) throw new Error('random() must return [0, 1)');
  return Math.min(count - 1, Math.floor(sample * count));
}

function pushHistory(draft: Draft, requestId: string): void {
  draft.history.push(requestId);
  while (draft.history.length > BEHAVIOR_LIMITS.history) draft.history.shift();
}

function thaw(state: ContractBehaviorState): Draft {
  return {
    active: state.active ? { ...state.active } : null,
    dragging: state.dragging,
    pending: state.pending.map((item) => ({ ...item })),
    history: [...state.history],
    seen: new Set(state.seen),
  };
}

function publish(draft: Draft, effects: readonly BehaviorEffect[]): BehaviorStep<ContractBehaviorState> {
  return {
    state: {
      kind: 'contract-behavior',
      active: draft.active,
      dragging: draft.dragging,
      pending: draft.pending,
      history: draft.history,
      seen: draft.seen,
    },
    effects,
    pending: draft.pending.length,
    history: draft.history.length,
  };
}
