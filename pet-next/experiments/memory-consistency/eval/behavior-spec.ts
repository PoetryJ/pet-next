/**
 * 反事实配对的行为判据（R2-B）。
 *
 * 旧实现用 `behaviorDigest(left) !== behaviorDigest(right)` 判「行为不同」，
 * 而摘要里仍含 events/payload/kind —— 只换输入事件就能满足差异，等于没验输出。
 *
 * 这里改成两步，且都只看**预先冻结的 expected 字段**与**实际输出值**：
 * 1. 字段规范：把一对轨迹的断言键取并集，分成
 *    - flip：两侧期望值不同（实际必须不同）
 *    - stable：两侧期望值相同（实际必须相同）
 *    - presence：只在一侧出现（另一侧实际必须是 absent，且两侧实际必须不同）
 * 2. 判定：所有 flip/presence 实际不同、所有 stable 实际相同、且输出投影本身不同。
 * 输入事件、trackId、时间戳、标签一律不参与判定。
 *
 * @module pet-next/experiments/memory-consistency/eval/behavior-spec
 */
import { canonicalJson, type MemoryState } from '../contracts.ts';
import type { TrackObservation } from './harness.ts';
import { scoreTrack, type Check } from './scorer.ts';

/** 把一条断言压成稳定键：kind + 身份字段，不含期望值与标签。 */
export function checkKey(check: Check): string {
  const parts: string[] = [check.kind];
  if (check.noteId !== undefined) parts.push(`note=${check.noteId}`);
  if (check.taskId !== undefined) parts.push(`task=${check.taskId}`);
  if (check.requestId !== undefined) parts.push(`req=${check.requestId}@${check.epoch ?? 1}`);
  if (check.flag !== undefined) parts.push(`flag=${check.flag}`);
  if (check.patchIndex !== undefined) parts.push(`patch#${check.patchIndex}`);
  if (check.index !== undefined) parts.push(`rejected#${check.index}`);
  if (check.subjectKey !== undefined) parts.push(`subject=${check.subjectKey}`);
  return parts.join('|');
}

/** 一个字段的冻结身份。 */
export interface BehaviorField {
  readonly key: string;
  readonly kind: string;
  /** 读取实际值时使用的断言（两侧同 key 时取任意一侧）。 */
  readonly check: Check;
  readonly leftExpected: unknown;
  readonly rightExpected: unknown;
  readonly role: 'flip' | 'stable' | 'presence';
  /** presence 字段只能出现在一侧；记录它在哪一侧。 */
  readonly presentOn: 'both' | 'left' | 'right';
}

/** 一对轨迹的判据规范。 */
export interface PairSpec {
  readonly pairId: string;
  readonly leftTrackId: string;
  readonly rightTrackId: string;
  readonly fields: readonly BehaviorField[];
  readonly flipFields: readonly string[];
  readonly stableFields: readonly string[];
  readonly presenceFields: readonly string[];
  readonly note: string;
}

/** 比对结果。 */
export interface BehaviorComparison {
  readonly pairId: string;
  readonly flipHeld: boolean;
  readonly stableHeld: boolean;
  readonly presenceHeld: boolean;
  readonly outputsDiffer: boolean;
  readonly differingChecks: readonly string[];
  readonly violatedFlip: readonly string[];
  readonly violatedStable: readonly string[];
  readonly violatedPresence: readonly string[];
  readonly satisfiedPresence: readonly string[];
  readonly redundantPresence: readonly string[];
  readonly classifiedDifferent: boolean;
}

/** 输出投影：只含行为输出，不含输入事件与身份。 */
export function outputProjection(observation: TrackObservation): Record<string, unknown> {
  const state: MemoryState = observation.state;
  return {
    requests: state.requests,
    tasks: state.tasks,
    notes: state.notes,
    conflicts: state.conflicts,
    appliedOps: state.appliedOps,
    patchResults: observation.patchResults,
    rejectedEvents: observation.rejectedEvents,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** 读出一条断言在该观测上的实际值（复用评分器，不另写一套语义）。 */
export function readActual(observation: TrackObservation, check: Check): unknown {
  return scoreTrack(observation, { why: '', checks: [check] }).checks[0]?.actual ?? 'absent';
}

/** 由两侧独立期望构建判据规范。 */
export function buildPairSpec(
  pairId: string,
  leftTrackId: string,
  leftChecks: readonly Check[],
  rightTrackId: string,
  rightChecks: readonly Check[],
): PairSpec {
  const left = new Map(leftChecks.map((check) => [checkKey(check), check]));
  const right = new Map(rightChecks.map((check) => [checkKey(check), check]));
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();

  const fields = keys.map((key): BehaviorField => {
    const l = left.get(key);
    const r = right.get(key);
    if (l !== undefined && r !== undefined) {
      const same = sameJson(l.value, r.value);
      return {
        key,
        kind: l.kind,
        check: l,
        leftExpected: l.value,
        rightExpected: r.value,
        role: same ? 'stable' : 'flip',
        presentOn: 'both',
      };
    }
    const only = (l ?? r) as Check;
    return {
      key,
      kind: only.kind,
      check: only,
      leftExpected: l?.value,
      rightExpected: r?.value,
      role: 'presence',
      presentOn: l !== undefined ? 'left' : 'right',
    };
  });

  return {
    pairId,
    leftTrackId,
    rightTrackId,
    fields,
    flipFields: fields.filter((field) => field.role === 'flip').map((field) => field.key),
    stableFields: fields.filter((field) => field.role === 'stable').map((field) => field.key),
    presenceFields: fields.filter((field) => field.role === 'presence').map((field) => field.key),
    note: 'flip=期望不同必须实际不同；stable=期望相同必须实际相同；presence=只在一侧断言，另一侧必须是 absent。',
  };
}

/**
 * 按规范比对两条观测。
 *
 * `classifiedDifferent` 必须同时满足：输出投影不同、所有 flip 实际不同、
 * 所有 stable 实际相同、所有 presence 满足「一侧 absent、两侧不同」。
 * 任何一条不满足都判「没有可验收的行为差异」。
 */
export function compareBehavior(left: TrackObservation, right: TrackObservation, spec: PairSpec): BehaviorComparison {
  const violatedFlip: string[] = [];
  const violatedStable: string[] = [];
  const violatedPresence: string[] = [];
  const satisfiedPresence: string[] = [];
  const redundantPresence: string[] = [];
  const differingChecks: string[] = [];

  for (const field of spec.fields) {
    const leftActual = readActual(left, field.check);
    const rightActual = readActual(right, field.check);
    const differ = !sameJson(leftActual, rightActual);
    if (field.role === 'flip') {
      if (differ) differingChecks.push(field.key);
      else violatedFlip.push(field.key);
      continue;
    }
    if (field.role === 'stable') {
      if (!differ) differingChecks.push(field.key);
      else violatedStable.push(field.key);
      continue;
    }
    // presence：断言只在一侧出现。
    // - 另一侧读出来是 absent 且两侧不同 => 这是有效证据（例如「有无 rejectedEvent」）。
    // - 另一侧该字段其实存在（只是没写断言）=> 中性，不参与判定。
    // - 另一侧 absent 但两侧相同 => 说明这对写得没意义，记为违规。
    const absentSide = field.presentOn === 'left' ? rightActual : leftActual;
    if (differ && absentSide === 'absent') {
      differingChecks.push(field.key);
      satisfiedPresence.push(field.key);
    } else {
      // 另一侧也有这个字段（只是没写断言），或者两侧都是 absent：都不构成差异证据。
      // 这类字段只做记录，不参与判定；「没有正证据」由 hasPositiveEvidence 兜底。
      redundantPresence.push(field.key);
    }
  }

  const outputsDiffer = !sameJson(outputProjection(left), outputProjection(right));
  const flipHeld = violatedFlip.length === 0;
  const stableHeld = violatedStable.length === 0;
  const presenceHeld = violatedPresence.length === 0;
  // 正证据：至少有一个「两侧都断言且期望不同」的字段，或一个「另一侧确实 absent」的仅一侧断言。
  const hasPositiveEvidence = spec.flipFields.length > 0 || satisfiedPresence.length > 0;

  return {
    pairId: spec.pairId,
    flipHeld,
    stableHeld,
    presenceHeld,
    outputsDiffer,
    differingChecks,
    violatedFlip,
    violatedStable,
    violatedPresence,
    satisfiedPresence,
    redundantPresence,
    classifiedDifferent: outputsDiffer && flipHeld && stableHeld && presenceHeld && hasPositiveEvidence,
  };
}

/**
 * 负控 1：输入不同、输出被冻结相同。
 * 只替换事件数组，其余输出原样保留——必须判「没有行为差异」。
 */
export function withFrozenOutputs(observation: TrackObservation, donor: TrackObservation): TrackObservation {
  return { ...observation, state: { ...observation.state, events: donor.state.events } };
}

/**
 * 负控 2：应保持不变的字段被额外改动。
 * 找一个 stable 字段，把它的实际值改掉；此后比对必须判 stable 不成立。
 */
export function tamperStableField(
  observation: TrackObservation,
  spec: PairSpec,
): { observation: TrackObservation; field: string } | undefined {
  for (const field of spec.fields) {
    if (field.role !== 'stable') continue;
    const state = observation.state;
    const check = field.check;

    if (check.kind === 'req.flag' || check.kind === 'req.toolOutcome') {
      const key = Object.keys(state.requests).find((item) => state.requests[item]?.requestId === check.requestId);
      const view = key === undefined ? undefined : state.requests[key];
      if (key !== undefined && view !== undefined) {
        const requests =
          check.kind === 'req.flag'
            ? {
                ...state.requests,
                [key]: { ...view, [check.flag ?? 'generated']: !view[check.flag ?? 'generated'] },
              }
            : {
                ...state.requests,
                [key]: {
                  ...view,
                  toolOutcome: (view.toolOutcome === 'ok' ? 'error' : 'ok') as typeof view.toolOutcome,
                },
              };
        return { observation: { ...observation, state: { ...state, requests } }, field: field.key };
      }
    }

    if (check.kind === 'task.change' || check.kind === 'task.revision') {
      const key = Object.keys(state.tasks).find((item) => state.tasks[item]?.taskId === check.taskId);
      const task = key === undefined ? undefined : state.tasks[key];
      if (key !== undefined && task !== undefined) {
        const tasks =
          check.kind === 'task.change'
            ? {
                ...state.tasks,
                [key]: {
                  ...task,
                  change: (task.change === 'cancelled' ? 'created' : 'cancelled') as typeof task.change,
                },
              }
            : { ...state.tasks, [key]: { ...task, revision: task.revision + 1 } };
        return { observation: { ...observation, state: { ...state, tasks } }, field: field.key };
      }
    }

    if (check.kind === 'note.version') {
      const note = check.noteId === undefined ? undefined : state.notes[check.noteId];
      if (note !== undefined) {
        const notes = { ...state.notes, [note.noteId]: { ...note, version: note.version + 1 } };
        return { observation: { ...observation, state: { ...state, notes } }, field: field.key };
      }
    }

    if (check.kind === 'event.count') {
      const last = state.events[state.events.length - 1];
      if (last !== undefined) {
        const events = [...state.events, { ...last, eventId: `${last.eventId}-tamper`, sequence: last.sequence + 1 }];
        return { observation: { ...observation, state: { ...state, events } }, field: field.key };
      }
    }

    if (check.kind === 'note.status' || check.kind === 'note.text') {
      const note = check.noteId === undefined ? undefined : state.notes[check.noteId];
      if (note !== undefined) {
        const notes =
          check.kind === 'note.status'
            ? {
                ...state.notes,
                [note.noteId]: {
                  ...note,
                  status: (note.status === 'active' ? 'invalidated' : 'active') as typeof note.status,
                },
              }
            : { ...state.notes, [note.noteId]: { ...note, text: `${note.text} (tampered)` } };
        return { observation: { ...observation, state: { ...state, notes } }, field: field.key };
      }
    }
  }
  return undefined;
}
