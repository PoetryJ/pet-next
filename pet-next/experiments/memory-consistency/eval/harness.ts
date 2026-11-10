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
import { readFileSync } from 'node:fs';
import {
  PATCH_SCHEMA_VERSION,
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
  const stepStates: { sequence: number; state: MemoryState; rejected: { eventId: string; reason: string }[] }[] = [];

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

  const deliver = (spec: TrackPatchSpec): void => {
    const stateAtBuild = reduce(track.events, { openUntilSequence: spec.buildAtSequence }).state;
    const patch = buildPatch(spec, stateAtBuild, appliedOpIds);
    appliedOpIds.push(patch.opId);
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
    for (const spec of pending.get(original.sequence) ?? []) {
      deliver(spec);
    }
    stepStates.push({ sequence: original.sequence, state, rejected: [...rejected] });
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
