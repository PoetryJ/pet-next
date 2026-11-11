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
  type CostCounters,
  type MemoryEvent,
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

/**
 * 构建统计。
 *
 * 口径（与 contracts.CostCounters 一致）：
 * - eventsVisited：真实迭代到的事件对象次数；遍历 3 遍就是 3 倍，不能只算命中；
 * - uniqueEventsTouched：去重后的事件数；
 * - indexBuilds / indexLookups：本轮建立的索引条目数 / 查询次数（当前没有索引，故 builds=0）；
 * - bytesRead：实际读到的唯一事件序列化字节；
 * - bytesWritten：提交补丁的序列化字节。
 */
export type BuildStats = CostCounters;

/** 一次构建的计数器。 */
interface Counter {
  eventsVisited: number;
  readonly unique: Set<string>;
  bytesRead: number;
  indexLookups: number;
}

function newCounter(): Counter {
  return { eventsVisited: 0, unique: new Set<string>(), bytesRead: 0, indexLookups: 0 };
}

/**
 * 把 state.events 包一层计数：每次迭代元素就 +1。
 * 用 Proxy 而不是改所有循环，是为了保证「报出的次数」就是「真实发生的次数」。
 */
function countedState(state: MemoryState, counter: Counter): MemoryState {
  const events = new Proxy(state.events as MemoryEvent[], {
    get(target, property, receiver) {
      if (property === Symbol.iterator) {
        return function* iterator() {
          for (const event of target) {
            counter.eventsVisited += 1;
            if (!counter.unique.has(event.eventId)) {
              counter.unique.add(event.eventId);
              counter.bytesRead += bytes(JSON.stringify(event));
            }
            yield event;
          }
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { ...state, events };
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

/**
 * 从当前状态收集变更相关的槽位（局部重建用）。
 *
 * 修复点：下游依赖遍历原来把 **noteId** 当 **slot** 入队，导致
 * `depIdForNote(noteIdFor(n:x))` 变成 `note:n:n:x`，派生笔记永远找不到；
 * 现在统一在 noteId 空间遍历，出队时再换回 slot，并且真正并入 affected。
 */
function affectedSlots(state: MemoryState, change: ChangeSet, counter: Counter): Set<string> {
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

  // 下游派生笔记：父笔记被改动时一并重算（按 noteId 遍历，避免 slot/noteId 混用）。
  const queue = [...affected].map((slot) => noteIdFor(slot));
  const seenNotes = new Set(queue);
  while (queue.length > 0) {
    const noteId = queue.shift();
    if (noteId === undefined) continue;
    counter.indexLookups += 1;
    const downstream = state.dependents[depIdForNote(noteId)] ?? [];
    for (const child of downstream) {
      if (seenNotes.has(child)) continue;
      seenNotes.add(child);
      queue.push(child);
      const childSlot = child.startsWith('n:') ? child.slice(2) : child;
      affected.add(childSlot);
    }
  }
  return affected;
}

function buildPatch(
  state: MemoryState,
  slots: readonly string[],
  opId: string,
  producer: 'full-rebuild' | 'incremental',
): { patch: MemoryPatch; notesRebuilt: number; examined: number } {
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
        // 失效也是版本断言：必须声明目标版本，否则迟到的失效会删掉新版本。
        dependencyVersions[depIdForNote(existing.noteId)] = existing.version;
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
  };
}

/** 全量重建：枚举所有槽位。 */
export function fullRebuild(state: MemoryState, opId: string): BuildOutput {
  const counter = newCounter();
  const counted = countedState(state, counter);
  const slots = allSlots(counted);
  const built = buildPatch(counted, slots, opId, 'full-rebuild');
  return {
    patch: built.patch,
    stats: {
      eventsVisited: counter.eventsVisited,
      uniqueEventsTouched: counter.unique.size,
      indexBuilds: 0,
      indexLookups: counter.indexLookups + slots.length,
      notesExamined: built.examined,
      notesRebuilt: built.notesRebuilt,
      bytesRead: counter.bytesRead,
      bytesWritten: bytes(JSON.stringify(built.patch)),
    },
  };
}

/**
 * 局部重建：只重算变更集触及的槽位与其下游。
 *
 * 注意：这仍然是「按槽位扫描事件日志」，不是索引查表。
 * 计数如实反映 visits，因此不能用它宣称 O(1) 或索引级加速。
 */
export function incrementalRebuild(state: MemoryState, change: ChangeSet, opId: string): BuildOutput {
  const counter = newCounter();
  const counted = countedState(state, counter);
  const slots = [...affectedSlots(counted, change, counter)].sort();
  const built = buildPatch(counted, slots, opId, 'incremental');
  return {
    patch: built.patch,
    stats: {
      eventsVisited: counter.eventsVisited,
      uniqueEventsTouched: counter.unique.size,
      indexBuilds: 0,
      indexLookups: counter.indexLookups + slots.length,
      notesExamined: built.examined,
      notesRebuilt: built.notesRebuilt,
      bytesRead: counter.bytesRead,
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
