/**
 * 失效传播。取消/更正必须立即生效，且不能只停在直接依赖上。
 *
 * 传播规则：种子笔记标记 invalidated 后，反向依赖索引里依赖它的笔记一并失效，
 * 直到没有新的下游。已失效的笔记不再重复写原因，保留第一次原因。
 *
 * @module pet-next/experiments/memory-consistency/ledger/invalidate
 */
import { depIdForNote, type MemoryState, type Note } from '../contracts.ts';

export interface InvalidationOutcome {
  readonly notes: Record<string, Note>;
  readonly invalidatedNoteIds: readonly string[];
}

/**
 * 把 seeds 及其全部下游派生笔记置为 invalidated。
 * 原因写进 note.invalidationReason；不修改 sourceEventIds。
 */
export function invalidateNotes(
  state: MemoryState,
  seeds: readonly string[],
  reason: string,
): InvalidationOutcome {
  const notes: Record<string, Note> = { ...state.notes };
  const invalidated: string[] = [];
  const queue = [...seeds];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const noteId = queue.shift();
    if (noteId === undefined || seen.has(noteId)) continue;
    seen.add(noteId);
    const note = notes[noteId];
    if (note === undefined) continue;
    if (note.status !== 'invalidated') {
      notes[noteId] = { ...note, status: 'invalidated', invalidationReason: reason };
      invalidated.push(noteId);
    }
    const downstream = state.dependents[depIdForNote(noteId)];
    if (downstream !== undefined) {
      for (const child of downstream) {
        if (!seen.has(child)) queue.push(child);
      }
    }
  }

  return { notes, invalidatedNoteIds: invalidated };
}

/** 收集当前仍可作为当前事实的笔记（active）。 */
export function activeNotes(state: MemoryState): readonly Note[] {
  return Object.values(state.notes)
    .filter((note) => note.status === 'active')
    .sort((a, b) => (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0));
}
