/**
 * 全量重建与局部重建。
 *
 * 两者共用同一个 desiredFor(state, slot)：
 * 同一个「槽位」在两种路径下产出完全相同的文本、状态与依赖。
 * 差别只在「这一轮重算哪些槽位」以及随之而来的读取/重建/写入量。
 *
 * 槽位是稳定身份，不是内容哈希：
 * - 偏好/任务：subjectKey（如 pref:weekly-report、task:weekly-report）
 * - 请求结算：req:<sessionId>#<epoch>#<requestId>
 * 因此同一事实被更正时是 upsert 同一条笔记，版本 +1，而不是无限追加。
 *
 * @module pet-next/experiments/memory-consistency/maintenance/rebuild
 */
import {
  PATCH_SCHEMA_VERSION,
  depIdForEvent,
  depIdForNote,
  depIdForSubject,
  requestKey,
  type MemoryPatch,
  type MemoryState,
  type Note,
  type NoteDraft,
} from '../contracts.ts';
import { recomputeDependencies } from '../ledger/patch.ts';

/** 一个槽位的期望内容。 */
export interface DesiredNote {
  readonly slot: string;
  readonly draft: NoteDraft;
}

/** 构建统计。只算操作量，不假装是性能结论。 */
export interface BuildStats {
  readonly eventsScanned: number;
  readonly notesExamined: number;
  readonly notesRebuilt: number;
  readonly indexLookups: number;
  readonly bytesRead: number;
  readonly bytesWritten: number;
}

/** 构建输出。 */
export interface BuildOutput {
  readonly patch: MemoryPatch;
  readonly stats: BuildStats;
}

/** 局部重建的变更集。 */
export interface ChangeSet {
  readonly subjectKeys: readonly string[];
  readonly requestKeys: readonly string[];
  readonly eventIds: readonly string[];
}

function noteIdFor(slot: string): string {
  return `n:${slot}`;
}

function requestSlot(key: string): string {
  return `req:${key}`;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * 计算某个槽位当前应有的笔记。
 * 同一 subject 以「已接受的最后一条事实」为准；任务权威状态优先于自然语言陈述。
 */
function desiredFor(state: MemoryState, slot: string): DesiredNote | undefined {
  if (slot.startsWith('req:')) {
    return desiredRequest(state, slot);
  }
  return desiredSubject(state, slot);
}

function desiredSubject(state: MemoryState, subjectKey: string): DesiredNote | undefined {
  const version = state.subjectVersions[subjectKey];
  if (version === undefined) return undefined;

  // 任务槽位：以 task.changed 权威事件为准（自然语言候选不算）。
  let taskEventId: string | undefined;
  let taskRevision = -1;
  let taskChange = '';
  const taskId = subjectKey.startsWith('task:') ? subjectKey.slice('task:'.length) : undefined;
  if (taskId !== undefined) {
    for (const event of state.events) {
      if (event.kind !== 'task.changed' || event.taskId !== taskId) continue;
      if (event.payload.authority !== 'explicit') continue;
      const revision = event.taskRevision ?? 0;
      if (revision > taskRevision) {
        taskRevision = revision;
        taskEventId = event.eventId;
        taskChange = event.payload.change ?? 'unknown';
      }
    }
  }

  // 文本槽位：该 subject 最后一条带脚本抽取的陈述。
  let statementEventId: string | undefined;
  let statementText = '';
  for (const event of state.events) {
    const scripted = event.payload.scripted;
    if (event.kind !== 'user.statement' || scripted === undefined || scripted === null) continue;
    if (scripted.subjectKey !== subjectKey) continue;
    statementEventId = event.eventId;
    statementText = scripted.valueText;
  }

  const sources: string[] = [];
  let text: string;
  if (taskEventId !== undefined) {
    sources.push(taskEventId);
    text = `${subjectKey} = ${taskChange}@r${taskRevision}`;
    if (statementText !== '') {
      text = `${text}; evidence: ${statementText}`;
      if (statementEventId !== undefined && !sources.includes(statementEventId)) sources.push(statementEventId);
    }
  } else if (statementEventId !== undefined) {
    sources.push(statementEventId);
    text = `${subjectKey} = ${statementText}`;
  } else {
    return undefined;
  }

  return {
    slot: subjectKey,
    draft: {
      noteId: noteIdFor(subjectKey),
      text,
      sourceEventIds: sources,
      parentNoteIds: [],
      dependencyVersions: {},
      generator: 'scripted',
      subjectKey,
    },
  };
}

function desiredRequest(state: MemoryState, slot: string): DesiredNote | undefined {
  const key = slot.slice('req:'.length);
  const view = state.requests[key];
  if (view === undefined) return undefined;
  const flags = [
    view.generated ? 'generated' : 'ungenerated',
    view.presented ? 'presented' : 'unpresented',
    view.acknowledged ? 'acknowledged' : 'unacknowledged',
    view.cancelled ? 'cancelled' : '',
    view.failed ? 'failed' : '',
    view.toolOutcome === 'none' ? '' : `tool=${view.toolOutcome}`,
  ].filter((part) => part !== '');
  const sources: string[] = [];
  for (const event of state.events) {
    if (event.requestId === undefined) continue;
    if (event.sessionId !== view.sessionId || event.sessionEpoch !== view.sessionEpoch) continue;
    if (event.requestId !== view.requestId) continue;
    if (!sources.includes(event.eventId)) sources.push(event.eventId);
  }
  if (sources.length === 0) return undefined;
  return {
    slot,
    draft: {
      noteId: noteIdFor(slot),
      text: `${requestKey(view.sessionId, view.sessionEpoch, view.requestId)} = ${flags.join(' ')}`,
      sourceEventIds: sources,
      parentNoteIds: [],
      dependencyVersions: {},
      generator: 'scripted',
    },
  };
}

/** 全量：枚举全部槽位并重算。 */
function allSlots(state: MemoryState): string[] {
  const slots: string[] = [];
  for (const subjectKey of Object.keys(state.subjectVersions)) slots.push(subjectKey);
  for (const key of Object.keys(state.requests)) slots.push(requestSlot(key));
  return slots.sort();
}

/** 从当前状态收集变更相关的槽位（局部重建用）。 */
function affectedSlots(state: MemoryState, change: ChangeSet): Set<string> {
  const affected = new Set<string>();
  for (const subjectKey of change.subjectKeys) affected.add(subjectKey);
  for (const key of change.requestKeys) affected.add(requestSlot(key));
  for (const event of state.events) {
    if (!change.eventIds.includes(event.eventId)) continue;
    const scripted = event.payload.scripted;
    if (scripted !== undefined && scripted !== null) affected.add(scripted.subjectKey);
    if (event.requestId !== undefined) {
      affected.add(requestSlot(requestKey(event.sessionId, event.sessionEpoch, event.requestId)));
    }
    if (event.taskId !== undefined) affected.add(`task:${event.taskId}`);
  }

  // 下游派生笔记：父笔记被改动时一并重算。
  const queue = [...affected];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const slot = queue.shift();
    if (slot === undefined) continue;
    const downstream = state.dependents[depIdForNote(noteIdFor(slot))] ?? [];
    for (const child of downstream) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return affected;
}

function buildPatch(
  state: MemoryState,
  slots: readonly string[],
  opId: string,
  producer: 'full-rebuild' | 'incremental',
): { patch: MemoryPatch; notesRebuilt: number; examined: number; dependents: number } {
  const dependencyVersions: Record<string, number> = {};
  const notesToUpsert: NoteDraft[] = [];
  const notesToInvalidate: { noteId: string; reason: string }[] = [];
  let examined = 0;

  for (const slot of slots) {
    examined += 1;
    const desired = desiredFor(state, slot);
    const existing: Note | undefined = state.notes[noteIdFor(slot)];
    if (desired === undefined) {
      if (existing !== undefined && existing.status !== 'invalidated') {
        notesToInvalidate.push({ noteId: existing.noteId, reason: `slot_no_longer_desired:${slot}` });
      }
      continue;
    }
    if (
      existing !== undefined &&
      existing.status === 'active' &&
      existing.text === desired.draft.text
    ) {
      // 内容与依赖都没变：不重写，避免无意义版本抖动。
      const recompute = recomputeDependencies(state, desired.draft);
      let unchanged = true;
      for (const [depId, version] of Object.entries(recompute.dependencies)) {
        if (existing.dependencyVersions[depId] !== version) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) continue;
    }
    notesToUpsert.push(desired.draft);
    const recompute = recomputeDependencies(state, desired.draft);
    for (const [depId, version] of Object.entries(recompute.dependencies)) {
      dependencyVersions[depId] = version;
    }
  }

  return {
    patch: {
      schemaVersion: PATCH_SCHEMA_VERSION,
      opId,
      snapshotVersion: state.globalVersion,
      dependencyVersions,
      notesToUpsert,
      notesToInvalidate,
      producer,
    },
    notesRebuilt: notesToUpsert.length,
    examined,
    dependents: Object.keys(state.dependents).length,
  };
}

/** 全量重建：枚举所有槽位。 */
export function fullRebuild(state: MemoryState, opId: string): BuildOutput {
  const slots = allSlots(state);
  const built = buildPatch(state, slots, opId, 'full-rebuild');
  const bytesRead = bytes(JSON.stringify(state.events));
  return {
    patch: built.patch,
    stats: {
      eventsScanned: state.events.length,
      notesExamined: built.examined,
      notesRebuilt: built.notesRebuilt,
      indexLookups: built.dependents,
      bytesRead,
      bytesWritten: bytes(JSON.stringify(built.patch)),
    },
  };
}

/** 局部重建：只重算变更集触及的槽位与其下游。 */
export function incrementalRebuild(state: MemoryState, change: ChangeSet, opId: string): BuildOutput {
  const slots = [...affectedSlots(state, change)].sort();
  const built = buildPatch(state, slots, opId, 'incremental');
  let eventsScanned = 0;
  for (const event of state.events) {
    if (change.eventIds.includes(event.eventId)) eventsScanned += 1;
    else if (
      event.payload.scripted !== undefined &&
      event.payload.scripted !== null &&
      change.subjectKeys.includes(event.payload.scripted.subjectKey)
    ) {
      eventsScanned += 1;
    }
  }
  return {
    patch: built.patch,
    stats: {
      eventsScanned,
      notesExamined: built.examined,
      notesRebuilt: built.notesRebuilt,
      indexLookups: built.dependents,
      bytesRead: bytes(JSON.stringify(change)),
      bytesWritten: bytes(JSON.stringify(built.patch)),
    },
  };
}

/** 校验用：把状态里的笔记投影成可比较视图（忽略版本与 opId 来源）。 */
export function noteView(state: MemoryState): Record<string, { text: string; status: string; deps: number }> {
  const out: Record<string, { text: string; status: string; deps: number }> = {};
  for (const note of Object.values(state.notes)) {
    out[note.noteId] = { text: note.text, status: note.status, deps: Object.keys(note.dependencyVersions).length };
  }
  return out;
}

/** 校验用：当前有效事实集合。 */
export function activeFactSet(state: MemoryState): string[] {
  return Object.values(state.notes)
    .filter((note) => note.status === 'active')
    .map((note) => `${note.noteId}|${note.text}|${JSON.stringify(note.dependencyVersions)}`)
    .sort();
}

/** 供 D 构造变更集：从一段事件里取 subject/request 标识。 */
export function changeSetOf(events: readonly { payload: { scripted?: { subjectKey: string } | null }; requestId?: string; sessionId: string; sessionEpoch: number; eventId: string; taskId?: string }[]): ChangeSet {
  const subjectKeys = new Set<string>();
  const requestKeys = new Set<string>();
  const eventIds: string[] = [];
  for (const event of events) {
    eventIds.push(event.eventId);
    const scripted = event.payload.scripted;
    if (scripted !== undefined && scripted !== null) subjectKeys.add(scripted.subjectKey);
    if (event.taskId !== undefined) subjectKeys.add(`task:${event.taskId}`);
    if (event.requestId !== undefined) requestKeys.add(requestKey(event.sessionId, event.sessionEpoch, event.requestId));
  }
  return { subjectKeys: [...subjectKeys], requestKeys: [...requestKeys], eventIds };
}

/** 依赖节点工具，供测试核对来源。 */
export const deps = { depIdForEvent, depIdForSubject, depIdForNote };
