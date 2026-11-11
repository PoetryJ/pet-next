/**
 * 轨迹执行器：把「原始事件流 + 补丁草稿」跑成一个可断言的观测。
 *
 * 补丁的构建时刻（buildAtSequence）与交付时刻（applyAtSequence）分开：
 * 前者决定它看到哪些事实与依赖版本，后者决定它落到哪个权威状态上。
 * 这样同一份草稿既能在「取消前构建、取消后到达」时被拒绝，
 * 也能在「取消后重建」时正常提交——不需要为后者打补丁改实现。
 *
 * @module pet-next/experiments/memory-consistency/eval/harness
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PATCH_SCHEMA_VERSION,
  canonicalJson,
  emptyState,
  requestKey,
  sessionKey,
  taskKey,
  type MemoryEvent,
  type MemoryPatch,
  type MemoryState,
  type Note,
  type NoteDraft,
  type PatchVerdictCode,
} from '../contracts.ts';
import { applyPatch, recomputeDependencies, reduce } from '../ledger/index.ts';
import { stepEvent } from '../ledger/reduce.ts';
import { JsonlStore } from '../storage/store.ts';

/** 轨迹里的补丁规格（C 产出的输入，不含依赖版本）。 */
export interface TrackPatchSpec {
  readonly patchId: string;
  readonly buildAtSequence: number;
  readonly applyAtSequence: number | null;
  readonly reusePriorOpId: number | null;
  readonly dropSubjectDependency: boolean;
  readonly notesToUpsert: readonly NoteDraft[];
  readonly notesToInvalidate: readonly { readonly noteId: string; readonly reason: string }[];
}

/** 一条轨迹文件。 */
export interface TrackFile {
  readonly trackId: string;
  readonly pairId: string;
  readonly class: string;
  readonly variant: string;
  readonly keyCondition: string;
  readonly sourceCategory: 'synthetic' | 'product-replay';
  readonly executionCategory: 'scripted' | 'stub' | 'measured';
  readonly events: readonly MemoryEvent[];
  readonly patches: readonly TrackPatchSpec[];
}

/** 单条补丁的执行结果。 */
export interface PatchObservation {
  readonly patchId: string;
  readonly disposition: 'applied' | 'replayed' | 'rejected';
  readonly code: PatchVerdictCode | 'forced';
  readonly reasons: readonly string[];
}

/** 一条轨迹的观测。评分器只看这个对象。 */
export interface TrackObservation {
  readonly trackId: string;
  /** 该轨迹使用的 sessionId；评分器据此查请求/任务键，避免写死单一日志名。 */
  readonly sessionId: string;
  readonly state: MemoryState;
  readonly patchResults: readonly PatchObservation[];
  readonly rejectedEvents: readonly { readonly eventId: string; readonly reason: string }[];
}

/**
 * 负控用的「错误实现」钩子。都为可选，正确实现不传。
 * 这些钩子只改被测行为，不改期望值。
 */
export interface Mutation {
  readonly id: string;
  readonly title: string;
  readonly expectedCaughtBy: readonly string[];
  transformEvent?(event: MemoryEvent, state: MemoryState): MemoryEvent;
  afterStep?(state: MemoryState, event: MemoryEvent): MemoryState;
  /** 被依赖校验拒绝时仍然落盘，模拟「乐观写入」。 */
  readonly forceApplyOnReject?: boolean;
}

/** 读取并解析一条轨迹。字段缺失直接失败，不静默补默认值。 */
export function parseTrack(raw: unknown): TrackFile {
  const record = raw as Record<string, unknown>;
  if (typeof record.trackId !== 'string' || !Array.isArray(record.events)) {
    throw new Error('track file malformed');
  }
  return record as unknown as TrackFile;
}

/** 从磁盘读轨迹。 */
export function loadTrack(path: string): TrackFile {
  return parseTrack(JSON.parse(readFileSync(path, 'utf8')));
}

export interface RunOptions {
  readonly mutation?: Mutation;
}

/** 为一条补丁规格构造可提交的 patch：依赖与版本都从构建时刻的状态重算。 */
function buildPatch(
  spec: TrackPatchSpec,
  stateAtBuild: MemoryState,
  priorOpIds: readonly string[],
): MemoryPatch {
  const dependencyVersions: Record<string, number> = {};
  for (const draft of spec.notesToUpsert) {
    const recompute = recomputeDependencies(stateAtBuild, draft);
    for (const [depId, version] of Object.entries(recompute.dependencies)) {
      if (spec.dropSubjectDependency && depId.startsWith('subject:')) continue;
      dependencyVersions[depId] = version;
    }
  }
  const opId =
    spec.reusePriorOpId !== null ? priorOpIds[spec.reusePriorOpId] ?? spec.patchId : spec.patchId;
  return {
    schemaVersion: PATCH_SCHEMA_VERSION,
    opId,
    snapshotVersion: stateAtBuild.globalVersion,
    dependencyVersions,
    notesToUpsert: spec.notesToUpsert,
    notesToInvalidate: spec.notesToInvalidate,
    producer: 'manual',
  };
}

/** 负控专用：无视拒绝，强行把草稿写成有效笔记。 */
function forceUpsert(state: MemoryState, patch: MemoryPatch): MemoryState {
  const notes: Record<string, Note> = { ...state.notes };
  for (const draft of patch.notesToUpsert) {
    const existing = notes[draft.noteId];
    const recompute = recomputeDependencies(state, draft);
    notes[draft.noteId] = {
      noteId: draft.noteId,
      text: draft.text,
      sourceEventIds: [...draft.sourceEventIds],
      parentNoteIds: [...draft.parentNoteIds],
      dependencyVersions: { ...recompute.dependencies },
      status: 'active',
      generator: draft.generator,
      ...(draft.subjectKey === undefined ? {} : { subjectKey: draft.subjectKey }),
      version: existing === undefined ? 1 : existing.version + 1,
      createdByOpId: patch.opId,
    };
  }
  return { ...state, notes, globalVersion: state.globalVersion + 1 };
}

/** 逐步轨迹：每一步之后的状态，供演示与反事实比对使用。 */
export interface TrackTrace {
  readonly trackId: string;
  readonly sessionId: string;
  readonly steps: readonly {
    readonly sequence: number;
    readonly state: MemoryState;
    readonly rejected: readonly { readonly eventId: string; readonly reason: string }[];
    /** 这一步交付的补丁（含补丁本体），用于「事件 + 补丁」完整重放。 */
    readonly delivered: readonly { readonly patchId: string; readonly patch: MemoryPatch }[];
  }[];
  readonly patchResults: readonly PatchObservation[];
  readonly rejectedEvents: readonly { readonly eventId: string; readonly reason: string }[];
  /** 尾部补丁也交付之后的终态。演示用每步状态，判分用终态。 */
  readonly finalState: MemoryState;
}

/** 执行一条轨迹，并留下每一步之后的状态（演示与反事实比对用）。 */
export function traceTrack(track: TrackFile, options: RunOptions = {}): TrackTrace {
  const mutation = options.mutation;
  const events = [...track.events].sort((a, b) => a.sequence - b.sequence);
  const specs = [...track.patches];
  const patchResults: PatchObservation[] = [];
  const rejected: { eventId: string; reason: string }[] = [];
  const appliedOpIds: string[] = [];
  const stepStates: {
    sequence: number;
    state: MemoryState;
    rejected: { eventId: string; reason: string }[];
    delivered: { patchId: string; patch: MemoryPatch }[];
  }[] = [];

  const pending = new Map<number, TrackPatchSpec[]>();
  const tail: TrackPatchSpec[] = [];
  for (const spec of specs) {
    if (spec.applyAtSequence === null) {
      tail.push(spec);
    } else {
      const list = pending.get(spec.applyAtSequence) ?? [];
      list.push(spec);
      pending.set(spec.applyAtSequence, list);
    }
  }

  let state = emptyState();

  let currentDelivered: { patchId: string; patch: MemoryPatch }[] = [];
  const deliver = (spec: TrackPatchSpec): void => {
    const stateAtBuild = reduce(track.events, { openUntilSequence: spec.buildAtSequence }).state;
    const patch = buildPatch(spec, stateAtBuild, appliedOpIds);
    appliedOpIds.push(patch.opId);
    currentDelivered.push({ patchId: spec.patchId, patch });
    const outcome = applyPatch(state, patch);
    if (!outcome.verdict.accepted && mutation?.forceApplyOnReject === true) {
      state = forceUpsert(state, patch);
      patchResults.push({ patchId: spec.patchId, disposition: 'applied', code: 'forced', reasons: [] });
      return;
    }
    patchResults.push({
      patchId: spec.patchId,
      disposition: outcome.disposition,
      code: outcome.verdict.code,
      reasons: outcome.verdict.reasons.map((reason) => reason.detail),
    });
    state = outcome.state;
  };

  for (const original of events) {
    const event = mutation?.transformEvent === undefined ? original : mutation.transformEvent(original, state);
    const outcome = stepEvent(state, event);
    state = outcome.state;
    if (outcome.disposition === 'rejected') {
      rejected.push({ eventId: event.eventId, reason: outcome.reason ?? 'rejected' });
    }
    if (mutation?.afterStep !== undefined) {
      state = mutation.afterStep(state, event);
    }
    currentDelivered = [];
    for (const spec of pending.get(original.sequence) ?? []) {
      deliver(spec);
    }
    stepStates.push({ sequence: original.sequence, state, rejected: [...rejected], delivered: currentDelivered });
  }
  for (const spec of tail) {
    deliver(spec);
  }

  return {
    trackId: track.trackId,
    sessionId: events[0]?.sessionId ?? '',
    steps: stepStates,
    patchResults,
    finalState: state,
    rejectedEvents: rejected,
  };
}

/** 执行一条轨迹，只取终态。 */
export function runTrack(track: TrackFile, options: RunOptions = {}): TrackObservation {
  const trace = traceTrack(track, options);
  return {
    trackId: trace.trackId,
    sessionId: trace.sessionId,
    state: trace.finalState,
    patchResults: trace.patchResults,
    rejectedEvents: trace.rejectedEvents,
  };
}

/** 观测里常用键的取值工具，供评分器使用。 */
export function describeObservation(observation: TrackObservation): Record<string, unknown> {
  const { state } = observation;
  return {
    trackId: observation.trackId,
    eventCount: state.events.length,
    conflictCount: state.conflicts.length,
    globalVersion: state.globalVersion,
    patchResults: observation.patchResults.map((item) => ({
      patchId: item.patchId,
      disposition: item.disposition,
      code: item.code,
    })),
    requests: Object.values(state.requests).map((view) => ({
      key: view.requestKey,
      generated: view.generated,
      presented: view.presented,
      acknowledged: view.acknowledged,
      cancelled: view.cancelled,
      toolOutcome: view.toolOutcome,
    })),
    tasks: Object.values(state.tasks).map((task) => ({
      taskId: task.taskId,
      change: task.change,
      revision: task.revision,
    })),
    notes: Object.values(state.notes).map((note) => ({
      noteId: note.noteId,
      status: note.status,
      version: note.version,
    })),
    rejectedEvents: observation.rejectedEvents,
  };
}

/** 便于调试：某条请求视图。 */
export function requestOf(state: MemoryState, sessionId: string, epoch: number, requestId: string) {
  return state.requests[requestKey(sessionId, epoch, requestId)];
}

/** 便于调试：某条任务视图。 */
export function taskOf(state: MemoryState, sessionId: string, taskId: string) {
  return state.tasks[taskKey(sessionId, taskId)];
}

/** 便于调试：某条会话视图。 */
export function sessionOf(state: MemoryState, sessionId: string, epoch: number) {
  return state.sessions[sessionKey(sessionId, epoch)];
}

/**
 * 行为投影：只保留「实现行为」相关字段，排除 trackId / 时间戳这类身份信息。
 *
 * 反事实比较必须用这个：同内容换名不能产生行为差异。
 * 状态里的 notes 连文本、版本、依赖一起算，避免「笔记丢了但摘要一样」。
 */
export function behaviorProjection(observation: TrackObservation): Record<string, unknown> {
  const state = observation.state;
  return {
    events: state.events.map((event) => ({
      eventId: event.eventId,
      sequence: event.sequence,
      kind: event.kind,
      sessionId: event.sessionId,
      sessionEpoch: event.sessionEpoch,
      ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
      ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      ...(event.taskRevision === undefined ? {} : { taskRevision: event.taskRevision }),
      payload: event.payload,
    })),
    requests: state.requests,
    tasks: state.tasks,
    subjectVersions: state.subjectVersions,
    sessions: state.sessions,
    notes: Object.values(state.notes)
      .sort((a, b) => (a.noteId < b.noteId ? -1 : 1))
      .map((note) => ({
        noteId: note.noteId,
        text: note.text,
        status: note.status,
        version: note.version,
        dependencyVersions: note.dependencyVersions,
        parentNoteIds: note.parentNoteIds,
        sourceEventIds: note.sourceEventIds,
        invalidationReason: note.invalidationReason ?? '',
      })),
    appliedOps: Object.values(state.appliedOps).sort((a, b) => a.commitOrder - b.commitOrder),
    rejectedPatches: state.rejectedPatches,
    conflicts: state.conflicts,
    patchResults: observation.patchResults.map((item) => ({
      patchId: item.patchId,
      disposition: item.disposition,
      code: item.code,
    })),
    rejectedEvents: observation.rejectedEvents,
  };
}

/** 行为摘要（不含身份字段）。 */
export function behaviorDigest(observations: readonly TrackObservation[]): string {
  return canonicalJson(observations.map((item) => behaviorProjection(item)));
}

/** store 重放结果。 */
export interface StoreReplayResult {
  readonly ok: boolean;
  readonly equal: boolean;
  readonly notes: readonly string[];
  readonly detail: string;
  readonly error?: string;
}

/**
 * 完整重放：事件与已接受的补丁按原顺序写入 store，close 后开新实例恢复，
 * 再与直接运行的终态逐字段比较（笔记、版本、状态、补丁结论、幂等记录）。
 *
 * 只存事件不存补丁的实现会在这里丢笔记，因此该函数天然是 A1-v1 的负控。
 */
export function replayThroughStore(track: TrackFile): StoreReplayResult {
  const trace = traceTrack(track);
  const direct = trace.finalState;
  const dir = mkdtempSync(join(tmpdir(), 'memory-replay-'));
  try {
    const opened = JsonlStore.open(dir);
    if (!opened.ok) return { ok: false, equal: false, notes: [], detail: `${opened.code}: ${opened.detail}` };
    const store = opened.value;
    const accepted = new Set(trace.finalState.events.map((event) => event.eventId));
    const outcomes: { opId: string; disposition: 'applied' | 'replayed' | 'rejected'; code: string }[] = [];
    let conflictEvents = 0;
    for (const step of trace.steps) {
      const original = track.events.find((item) => item.sequence === step.sequence);
      if (original !== undefined && accepted.has(original.eventId)) {
        const appended = store.append(original);
        if (!appended.ok && appended.code === 'event_conflict') {
          // 冲突事件在内存里进 conflicts 表；store 不持久化该表，这里只核对数量一致。
          conflictEvents += 1;
        } else if (!appended.ok) {
          return { ok: false, equal: false, notes: [], detail: `append ${original.eventId}: ${appended.code}` };
        }
      }
      for (const delivered of step.delivered) {
        const committed = store.commitPatch(delivered.patch);
        outcomes.push({
          opId: delivered.patch.opId,
          disposition: committed.ok ? committed.value.disposition : 'rejected',
          code: committed.ok ? 'ok' : committed.code,
        });
        if (!committed.ok && committed.code !== 'patch_rejected' && committed.code !== 'patch_conflict') {
          return { ok: false, equal: false, notes: [], detail: `commit ${delivered.patchId}: ${committed.detail}` };
        }
      }
    }
    const beforeClose = durableProjection(store.getState());
    store.close();
    const reopened = JsonlStore.open(dir);
    if (!reopened.ok) return { ok: false, equal: false, notes: [], detail: `${reopened.code}: ${reopened.detail}` };
    const restored = reopened.value.getState();
    reopened.value.close();
    const sameMemory = durableProjection(restored) === durableProjection(direct);
    const stableAcrossClose = beforeClose === durableProjection(restored);
    // 补丁结论必须一致：内存判 applied 的，store 里必须有 appliedOps；判 rejected 的必须没有。
    // 幂等重放（同 opId 同载荷）不算新提交；被拒补丁不能出现在 appliedOps 里。
    const dispositionsConsistent = outcomes.every((outcome) => {
      if (outcome.disposition !== 'rejected') return restored.appliedOps[outcome.opId] !== undefined;
      // op_conflict 的语义就是「同名 opId 已被另一份载荷占用」，所以它必须存在；
      // 其它拒绝（依赖过期等）则必须完全没落库。
      return outcome.code === 'patch_conflict'
        ? restored.appliedOps[outcome.opId] !== undefined
        : restored.appliedOps[outcome.opId] === undefined;
    });
    const conflictsConsistent = conflictEvents === direct.conflicts.length;
    return {
      ok: true,
      equal: sameMemory && stableAcrossClose && dispositionsConsistent && conflictsConsistent,
      notes: Object.keys(restored.notes).sort(),
      detail: `events=${restored.events.length} patches=${Object.keys(restored.appliedOps).length} notes=${Object.keys(restored.notes).length}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 持久层可比投影：只比「重开之后还应该存在」的东西。
 *
 * 不比的字段：rejectedPatches（内存审计轨迹，被拒补丁不写日志，重开自然没有）、
 * conflicts（同上，store 不持久化冲突表，由调用方单独核对数量）。
 */
function durableProjection(state: MemoryState): string {
  return canonicalJson({
    events: state.events.map((event) => ({ eventId: event.eventId, sequence: event.sequence })),
    requests: state.requests,
    tasks: state.tasks,
    subjectVersions: state.subjectVersions,
    sessions: state.sessions,
    notes: state.notes,
    appliedOps: state.appliedOps,
    globalVersion: state.globalVersion,
    lastSequence: state.lastSequence,
  });
}
