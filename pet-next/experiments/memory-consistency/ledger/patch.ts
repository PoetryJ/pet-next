/**
 * 补丁校验与单写者原子应用。
 *
 * 顺序永远是：先全量校验并算出下一状态 -> 再整体应用 -> 失败则一个字节都不落。
 * 不相信 patch 自报的版本与依赖：所有依赖从权威状态重新核对。
 *
 * 允许「无关事件让 globalVersion 前进后仍提交」：只有当 patch 依赖的
 * 事件 / subject / 父笔记版本真的变了才拒绝。
 *
 * @module pet-next/experiments/memory-consistency/ledger/patch
 */
import {
  PATCH_SCHEMA_VERSION,
  depIdForEvent,
  depIdForNote,
  depIdForSubject,
  patchDigest,
  type MemoryPatch,
  type MemoryState,
  type Note,
  type NoteDraft,
  type PatchRejectionReason,
  type PatchVerdict,
  type PatchVerdictCode,
} from '../contracts.ts';
import { invalidateNotes } from './invalidate.ts';

export interface PatchOptions {
  /** 校验时允许看见的最大 sequence；超过即 source_not_observed。 */
  readonly openUntilSequence?: number;
}

/** 单个 draft 的依赖重算结果。 */
export interface RecomputedDependencies {
  readonly dependencies: Record<string, number>;
  readonly problems: readonly PatchRejectionReason[];
  readonly code?: PatchVerdictCode;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 从权威来源重算一条 draft 应当声明的依赖。
 * B 构造 patch 时可用同一函数声明依赖；A 校验时据此核对，不信任自报值。
 */
export function recomputeDependencies(
  state: MemoryState,
  draft: NoteDraft,
  options: PatchOptions = {},
): RecomputedDependencies {
  const openUntil = options.openUntilSequence ?? Number.POSITIVE_INFINITY;
  const dependencies: Record<string, number> = {};
  const problems: PatchRejectionReason[] = [];
  let code: PatchVerdictCode | undefined;

  for (const eventId of draft.sourceEventIds) {
    const index = state.eventIndex[eventId];
    if (index === undefined) {
      problems.push({ topic: 'source', detail: `source event not found: ${eventId}`, noteId: draft.noteId });
      code ??= 'unknown_source';
      continue;
    }
    const event = state.events[index];
    if (event === undefined) {
      problems.push({ topic: 'source', detail: `source index broken: ${eventId}`, noteId: draft.noteId });
      code ??= 'unknown_source';
      continue;
    }
    if (event.sequence > openUntil) {
      problems.push({
        topic: 'source',
        detail: `source not observed yet: ${eventId}@seq${event.sequence}>openUntil${openUntil}`,
        noteId: draft.noteId,
      });
      code ??= 'source_not_observed';
      continue;
    }
    // 原始事件不可变，依赖版本恒为 1。
    dependencies[depIdForEvent(eventId)] = 1;
    const scripted = event.payload.scripted;
    if (scripted !== undefined && scripted !== null) {
      dependencies[depIdForSubject(scripted.subjectKey)] = state.subjectVersions[scripted.subjectKey] ?? 0;
    }
  }

  if (draft.subjectKey !== undefined) {
    dependencies[depIdForSubject(draft.subjectKey)] = state.subjectVersions[draft.subjectKey] ?? 0;
  }

  for (const parentId of draft.parentNoteIds) {
    const parent = state.notes[parentId];
    // 同 patch 内新建的父笔记版本从 1 起算；存在性由 validatePatch 统一判定。
    dependencies[depIdForNote(parentId)] = parent === undefined ? 1 : parent.version;
  }

  return code === undefined ? { dependencies, problems } : { dependencies, problems, code };
}

/**
 * 依赖图环检测。用 Kahn 拓扑排序（迭代，不用递归），
 * 剩余节点即处于环上或环下游，只报前几个 id 便于定位。
 */
function detectCycle(state: MemoryState, drafts: readonly NoteDraft[]): string[] | null {
  const parentMap: Record<string, readonly string[]> = {};
  for (const note of Object.values(state.notes)) {
    parentMap[note.noteId] = note.parentNoteIds;
  }
  for (const draft of drafts) {
    parentMap[draft.noteId] = draft.parentNoteIds;
  }

  const childrenOf: Record<string, string[]> = {};
  const pendingParents: Record<string, number> = {};
  for (const [nodeId, parents] of Object.entries(parentMap)) {
    pendingParents[nodeId] = parents.length;
    for (const parent of parents) {
      const list = childrenOf[parent] ?? [];
      list.push(nodeId);
      childrenOf[parent] = list;
    }
  }

  const queue: string[] = [];
  for (const [nodeId, count] of Object.entries(pendingParents)) {
    if (count === 0) queue.push(nodeId);
  }
  let processed = 0;
  while (queue.length > 0) {
    const nodeId = queue.pop();
    if (nodeId === undefined) break;
    processed += 1;
    for (const child of childrenOf[nodeId] ?? []) {
      const remaining = (pendingParents[child] ?? 0) - 1;
      pendingParents[child] = remaining;
      if (remaining === 0) queue.push(child);
    }
  }

  const total = Object.keys(pendingParents).length;
  if (processed === total) return null;
  return Object.entries(pendingParents)
    .filter(([, count]) => count > 0)
    .slice(0, 5)
    .map(([nodeId]) => nodeId);
}

/** 全量校验。不修改任何东西，纯函数。 */
export function validatePatch(
  state: MemoryState,
  patch: MemoryPatch,
  options: PatchOptions = {},
): PatchVerdict {
  const reasons: PatchRejectionReason[] = [];
  const recomputed: Record<string, number> = {};
  let code: PatchVerdictCode = 'ok';

  const fail = (nextCode: PatchVerdictCode, reason: PatchRejectionReason): void => {
    if (code === 'ok') code = nextCode;
    reasons.push(reason);
  };

  if (!isPlainRecord(patch) || patch.schemaVersion !== PATCH_SCHEMA_VERSION) {
    fail('invalid_shape', { topic: 'shape', detail: 'patch schema mismatch' });
    return { accepted: false, code, reasons, recomputedDependencies: recomputed };
  }
  if (!nonEmpty(patch.opId)) {
    fail('invalid_shape', { topic: 'shape', detail: 'opId empty' });
  }
  if (!Number.isInteger(patch.snapshotVersion) || patch.snapshotVersion < 0) {
    fail('invalid_shape', { topic: 'shape', detail: 'snapshotVersion invalid' });
  }
  if (!Array.isArray(patch.notesToUpsert) || !Array.isArray(patch.notesToInvalidate)) {
    fail('invalid_shape', { topic: 'shape', detail: 'notes arrays invalid' });
    return { accepted: false, code, reasons, recomputedDependencies: recomputed };
  }
  if (!isPlainRecord(patch.dependencyVersions)) {
    fail('invalid_shape', { topic: 'shape', detail: 'dependencyVersions invalid' });
  }
  if (reasons.length > 0) {
    return { accepted: false, code, reasons, recomputedDependencies: recomputed };
  }

  const prior = state.appliedOps[patch.opId];
  if (prior !== undefined) {
    if (prior.digest === patchDigest(patch)) {
      fail('op_replay', { topic: 'op', detail: `opId already applied: ${patch.opId}` });
    } else {
      fail('op_conflict', { topic: 'op', detail: `opId reused with different payload: ${patch.opId}` });
    }
    return { accepted: false, code, reasons, recomputedDependencies: recomputed };
  }

  if (patch.snapshotVersion > state.globalVersion) {
    fail('version_mismatch', {
      topic: 'version',
      detail: `patch built from future version ${patch.snapshotVersion} > ${state.globalVersion}`,
    });
  }

  const seenNoteIds = new Set<string>();
  for (const draft of patch.notesToUpsert) {
    if (typeof draft !== 'object' || draft === null || !nonEmpty(draft.noteId)) {
      fail('invalid_shape', { topic: 'shape', detail: 'draft noteId invalid' });
      continue;
    }
    if (!nonEmpty(draft.text)) {
      fail('invalid_shape', { topic: 'shape', detail: `empty note text: ${draft.noteId}`, noteId: draft.noteId });
    }
    if (!Array.isArray(draft.sourceEventIds) || draft.sourceEventIds.length === 0) {
      fail('invalid_shape', {
        topic: 'shape',
        detail: `note needs at least one source event: ${draft.noteId}`,
        noteId: draft.noteId,
      });
    }
    if (draft.generator !== 'scripted' && draft.generator !== 'operator') {
      fail('state_not_allowed', {
        topic: 'status',
        detail: `generator must be scripted|operator: ${String(draft.generator)}`,
        noteId: draft.noteId,
      });
    }
    if (seenNoteIds.has(draft.noteId)) {
      fail('invalid_shape', { topic: 'shape', detail: `duplicate draft: ${draft.noteId}`, noteId: draft.noteId });
    }
    seenNoteIds.add(draft.noteId);

    const recompute = recomputeDependencies(state, draft, options);
    if (recompute.code !== undefined) {
      for (const problem of recompute.problems) {
        fail(recompute.code, problem);
      }
    }
    for (const [depId, version] of Object.entries(recompute.dependencies)) {
      const declared = patch.dependencyVersions[depId];
      if (declared === undefined) {
        fail('dependency_undeclared', {
          topic: 'dependency',
          detail: `undeclared dependency ${depId}`,
          noteId: draft.noteId,
          dependencyId: depId,
        });
        continue;
      }
      if (declared !== version) {
        fail('dependency_stale', {
          topic: 'dependency',
          detail: `dependency moved ${depId}: declared ${declared} != current ${version}`,
          noteId: draft.noteId,
          dependencyId: depId,
        });
      }
      recomputed[depId] = version;
    }
  }

  // 父笔记必须真实存在，或在同一 patch 内新建；不允许悬空父节点。
  const draftIds = new Set(patch.notesToUpsert.map((draft) => draft.noteId));
  for (const draft of patch.notesToUpsert) {
    for (const parentId of draft.parentNoteIds) {
      if (state.notes[parentId] === undefined && !draftIds.has(parentId)) {
        fail('unknown_source', {
          topic: 'graph',
          detail: `parent note not found: ${parentId}`,
          noteId: draft.noteId,
          dependencyId: depIdForNote(parentId),
        });
      }
    }
  }

  for (const invalidation of patch.notesToInvalidate) {
    if (typeof invalidation !== 'object' || invalidation === null || !nonEmpty(invalidation.noteId)) {
      fail('invalid_shape', { topic: 'shape', detail: 'invalidate noteId invalid' });
      continue;
    }
    const target = state.notes[invalidation.noteId];
    if (target === undefined) {
      fail('unknown_source', {
        topic: 'source',
        detail: `note to invalidate not found: ${invalidation.noteId}`,
        noteId: invalidation.noteId,
      });
      continue;
    }
    if (target.status === 'invalidated') {
      fail('state_not_allowed', {
        topic: 'status',
        detail: `note already invalidated: ${invalidation.noteId}`,
        noteId: invalidation.noteId,
      });
      continue;
    }
    if (!nonEmpty(invalidation.reason)) {
      fail('invalid_shape', {
        topic: 'shape',
        detail: `invalidation needs a reason: ${invalidation.noteId}`,
        noteId: invalidation.noteId,
      });
    }
    if (seenNoteIds.has(invalidation.noteId)) {
      fail('invalid_shape', {
        topic: 'shape',
        detail: `cannot upsert and invalidate same note: ${invalidation.noteId}`,
        noteId: invalidation.noteId,
      });
    }
  }

  const cycle = detectCycle(state, patch.notesToUpsert);
  if (cycle !== null) {
    fail('cycle', { topic: 'graph', detail: `dependency cycle: ${cycle.join(' -> ')}` });
  }

  return { accepted: reasons.length === 0, code: reasons.length === 0 ? 'ok' : code, reasons, recomputedDependencies: recomputed };
}

/** applyPatch 结果。replayed 表示同 opId 同载荷重放，未重复生效。 */
export interface ApplyOutcome {
  readonly state: MemoryState;
  readonly verdict: PatchVerdict;
  readonly disposition: 'applied' | 'replayed' | 'rejected';
  readonly invalidatedNoteIds: readonly string[];
}

function removeFromIndex(
  index: Record<string, readonly string[]>,
  noteId: string,
  dependencyIds: readonly string[],
): void {
  for (const depId of dependencyIds) {
    const list = index[depId];
    if (list === undefined) continue;
    const filtered = list.filter((id) => id !== noteId);
    if (filtered.length === 0) {
      delete index[depId];
    } else {
      index[depId] = filtered;
    }
  }
}

function addToIndex(
  index: Record<string, readonly string[]>,
  noteId: string,
  dependencyIds: readonly string[],
): void {
  for (const depId of dependencyIds) {
    const list = index[depId] ?? [];
    if (!list.includes(noteId)) {
      index[depId] = [...list, noteId];
    }
  }
}

/**
 * 单写者原子应用：先校验，再把所有笔记与索引作为一份新状态发布。
 * 失败时不发布，只追加一条拒绝记录。
 */
export function applyPatch(
  state: MemoryState,
  patch: MemoryPatch,
  options: PatchOptions = {},
): ApplyOutcome {
  const verdict = validatePatch(state, patch, options);
  if (!verdict.accepted) {
    if (verdict.code === 'op_replay') {
      return { state, verdict, disposition: 'replayed', invalidatedNoteIds: [] };
    }
    const rejected = {
      opId: patch.opId,
      code: verdict.code,
      sequence: state.lastSequence,
      detail: verdict.reasons.map((reason) => reason.detail).join('; '),
    };
    return {
      state: { ...state, rejectedPatches: [...state.rejectedPatches, rejected] },
      verdict,
      disposition: 'rejected',
      invalidatedNoteIds: [],
    };
  }

  const notes: Record<string, Note> = { ...state.notes };
  const dependents: Record<string, readonly string[]> = {};
  for (const [depId, list] of Object.entries(state.dependents)) {
    dependents[depId] = [...list];
  }

  for (const draft of patch.notesToUpsert) {
    const existing = notes[draft.noteId];
    if (existing !== undefined) {
      removeFromIndex(dependents, draft.noteId, Object.keys(existing.dependencyVersions));
    }
    // 笔记记录的是从来源重算出的依赖，不是草稿自报值（草稿值只用于校验提交声明）。
    const recompute = recomputeDependencies(state, draft, options);
    const nextNote: Note = {
      noteId: draft.noteId,
      text: draft.text,
      sourceEventIds: [...draft.sourceEventIds],
      parentNoteIds: [...draft.parentNoteIds],
      dependencyVersions: { ...recompute.dependencies },
      status: 'active',
      generator: draft.generator,
      ...(draft.subjectKey === undefined ? {} : { subjectKey: draft.subjectKey }),
      version: existing === undefined ? 1 : existing.version + 1,
      createdByOpId: existing?.createdByOpId ?? patch.opId,
    };
    notes[draft.noteId] = nextNote;
    addToIndex(dependents, draft.noteId, Object.keys(nextNote.dependencyVersions));
  }

  const seeds = patch.notesToInvalidate.map((item) => item.noteId);
  const reason =
    patch.notesToInvalidate.length === 0
      ? ''
      : patch.notesToInvalidate.map((item) => `${item.noteId}:${item.reason}`).join(', ');
  const outcome =
    seeds.length === 0
      ? { notes, invalidatedNoteIds: [] as readonly string[] }
      : invalidateNotes({ ...state, notes, dependents }, seeds, `patch_invalidated:${reason}`);

  const commitOrder = Object.keys(state.appliedOps).length + 1;
  const appliedOps = {
    ...state.appliedOps,
    [patch.opId]: {
      opId: patch.opId,
      commitOrder,
      digest: patchDigest(patch),
      stateVersion: state.globalVersion + 1,
    },
  };

  return {
    state: {
      ...state,
      notes: outcome.notes,
      dependents,
      appliedOps,
      globalVersion: state.globalVersion + 1,
    },
    verdict,
    disposition: 'applied',
    invalidatedNoteIds: outcome.invalidatedNoteIds,
  };
}
