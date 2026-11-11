/**
 * D2：依赖链与扇出下的维护等价。
 *
 * 这里先写清楚预期，再看实现：
 * - 3 节点链 root → mid → leaf，外加 root 的 4 个子节点（扇出 5）；
 * - 连续两次更正后，全量与局部的 active 事实集合、笔记视图、版本单调性必须一致；
 * - 局部重建必须把下游笔记算进来（修复前的 noteId/slot 混用会让它漏掉）。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PATCH_SCHEMA_VERSION,
  depIdForNote,
  type MemoryPatch,
  type MemoryState,
  type Note,
  type NoteDraft,
} from '../contracts.ts';
import { applyPatch, recomputeDependencies } from '../ledger/patch.ts';
import { reduce, stepEvent } from '../ledger/reduce.ts';
import { statement } from '../testing/factory.ts';
import { activeFactSet, fullRebuild, incrementalRebuild, noteView } from './rebuild.ts';

function draft(noteId: string, text: string, sources: readonly string[], parents: readonly string[] = []): NoteDraft {
  return {
    noteId,
    text,
    sourceEventIds: [...sources],
    parentNoteIds: [...parents],
    dependencyVersions: {},
    generator: 'scripted',
  };
}

/** 手工补丁：依赖版本由 draft 重算，失效目标显式声明版本。 */
function patchFor(state: MemoryState, opId: string, upserts: readonly NoteDraft[], invalidates: readonly string[] = []): MemoryPatch {
  const dependencyVersions: Record<string, number> = {};
  for (const item of upserts) {
    for (const [depId, version] of Object.entries(recomputeDependencies(state, item).dependencies)) {
      dependencyVersions[depId] = version;
    }
  }
  for (const noteId of invalidates) {
    const target = state.notes[noteId];
    if (target !== undefined) dependencyVersions[depIdForNote(noteId)] = target.version;
  }
  return {
    schemaVersion: PATCH_SCHEMA_VERSION,
    opId,
    snapshotVersion: state.globalVersion,
    dependencyVersions,
    notesToUpsert: [...upserts],
    notesToInvalidate: invalidates.map((noteId) => ({ noteId, reason: 'test-invalidate' })),
    producer: 'manual',
  };
}

/** 建一棵 root → mid → leaf + root 的 4 个直接子节点。 */
function buildGraph(): { state: MemoryState; rootSlot: string } {
  let state = reduce([statement(1, 'g1', '根事实', 'root:topic', 'v1')]).state;
  const upserts = [
    draft('n:root:topic', 'root v1', ['g1']),
    draft('n:mid', 'mid v1', ['g1'], ['n:root:topic']),
    draft('n:leaf', 'leaf v1', ['g1'], ['n:mid']),
    ...Array.from({ length: 4 }, (_, index) => draft(`n:child${index}`, `child${index} v1`, ['g1'], ['n:root:topic'])),
  ];
  const applied = applyPatch(state, patchFor(state, 'op-graph', upserts));
  assert.equal(applied.disposition, 'applied', JSON.stringify(applied.verdict.reasons));
  state = applied.state;
  return { state, rootSlot: 'root:topic' };
}

describe('D2 依赖链与扇出', () => {
  test('初始图：3 节点链与 4 个扇出子节点都是 active，依赖指向父版本', () => {
    const { state } = buildGraph();
    for (const noteId of ['n:root:topic', 'n:mid', 'n:leaf', 'n:child0', 'n:child1', 'n:child2', 'n:child3']) {
      assert.equal(state.notes[noteId]?.status, 'active', noteId);
    }
    assert.equal(state.notes['n:mid']?.dependencyVersions['note:n:root:topic'], 1);
    assert.equal(state.notes['n:leaf']?.dependencyVersions['note:n:mid'], 1);
    assert.equal(state.dependents['note:n:root:topic']?.length, 5);
  });

  test('父更新后子必须失效（不留下 active 依赖旧版）', () => {
    const { state } = buildGraph();
    const next = applyPatch(state, patchFor(state, 'op-root-v2', [draft('n:root:topic', 'root v2', ['g1'])]));
    assert.equal(next.disposition, 'applied', JSON.stringify(next.verdict.reasons));
    assert.equal(next.state.notes['n:root:topic']?.version, 2);
    for (const noteId of ['n:mid', 'n:child0', 'n:leaf']) {
      const note: Note | undefined = next.state.notes[noteId];
      assert.equal(note?.status, 'invalidated', noteId);
    }
    // 失效原因要能说清是被父更新带下去的。
    assert.match(next.state.notes['n:mid']?.invalidationReason ?? '', /patch_invalidated/);
  });

  test('连续两次更正：全量与局部的 active 集合、笔记视图一致', () => {
    const { state, rootSlot } = buildGraph();
    // 第一次更正：root 文本变化（只推进事件，不重建）。
    let current = stepEvent(state, statement(2, 'g2', '根事实 v2', rootSlot, 'v2')).state;
    const full1 = applyPatch(current, fullRebuild(current, 'op-full-1').patch);
    assert.equal(full1.disposition, 'applied', JSON.stringify(full1.verdict.reasons));

    // 第二次更正：再来一条，随后比较两条路径。
    current = stepEvent(current, statement(3, 'g3', '根事实 v3', rootSlot, 'v3')).state;
    const full2 = applyPatch(current, fullRebuild(current, 'op-full-2').patch);
    const inc2 = applyPatch(
      current,
      incrementalRebuild(current, { subjectKeys: [rootSlot], requestKeys: [], eventIds: ['g3'] }, 'op-inc-2').patch,
    );
    assert.equal(full2.disposition, 'applied', JSON.stringify(full2.verdict.reasons));
    assert.equal(inc2.disposition, 'applied', JSON.stringify(inc2.verdict.reasons));
    assert.deepEqual(activeFactSet(full2.state), activeFactSet(inc2.state));
    assert.deepEqual(noteView(full2.state), noteView(inc2.state));
    // 版本单调：第二次重建后 root 版本不低于第一次。
    assert.ok((full2.state.notes['n:root:topic']?.version ?? 0) >= (full1.state.notes['n:root:topic']?.version ?? 0));
  });

  test('局部重建必须把下游笔记算进来（slot 与 noteId 不能混用）', () => {
    const { state, rootSlot } = buildGraph();
    const bumped = stepEvent(state, statement(9, 'g9', '根事实 v9', rootSlot, 'v9')).state;
    const inc = incrementalRebuild(bumped, { subjectKeys: [rootSlot], requestKeys: [], eventIds: ['g9'] }, 'op-inc-down');
    const touched = inc.patch.notesToUpsert.map((item) => item.noteId);
    assert.ok(touched.includes('n:root:topic'), `root 未重建: ${touched.join(',')}`);
    // 下游被父更新带下去：要么出现在 upsert，要么由 applyPatch 级联失效。
    const applied = applyPatch(bumped, inc.patch);
    assert.equal(applied.disposition, 'applied', JSON.stringify(applied.verdict.reasons));
    for (const noteId of ['n:mid', 'n:leaf', 'n:child0']) {
      const note = applied.state.notes[noteId];
      assert.ok(
        note !== undefined && (note.status !== 'active' || note.dependencyVersions['note:n:root:topic'] === applied.state.notes['n:root:topic']?.version),
        `${noteId} 仍是旧的 active`,
      );
    }
  });

  test('全量重建连续跑两次：第二次不再产生变更（含依赖链）', () => {
    const { state } = buildGraph();
    const first = applyPatch(state, fullRebuild(state, 'op-idempotent-graph-1').patch);
    assert.equal(first.disposition, 'applied', JSON.stringify(first.verdict.reasons));
    const again = fullRebuild(first.state, 'op-idempotent-graph-2');
    assert.equal(again.patch.notesToUpsert.length, 0);
    assert.equal(again.patch.notesToInvalidate.length, 0);
  });
});
