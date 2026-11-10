/**
 * A1 补丁路径测试：先全验证后整体应用，失败不留半个补丁。
 * 依赖版本一律从权威状态重算，不相信 patch 自报值。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PATCH_SCHEMA_VERSION,
  depIdForSubject,
  type MemoryPatch,
  type MemoryState,
  type NoteDraft,
} from '../contracts.ts';
import { applyPatch, recomputeDependencies, validatePatch } from './patch.ts';
import { reduce, stepEvent } from './reduce.ts';
import { statement, toolResult } from '../testing/factory.ts';

function draft(noteId: string, text: string, sourceEventIds: readonly string[], subjectKey?: string, parentNoteIds: readonly string[] = []): NoteDraft {
  return {
    noteId,
    text,
    sourceEventIds,
    parentNoteIds,
    dependencyVersions: {},
    generator: 'scripted',
    ...(subjectKey === undefined ? {} : { subjectKey }),
  };
}

let opCounter = 0;
/** 按 B 的方式构造 patch：依赖由权威状态重算后声明。 */
function buildPatch(
  state: MemoryState,
  notesToUpsert: readonly NoteDraft[],
  notesToInvalidate: readonly { noteId: string; reason: string }[] = [],
  override: Partial<MemoryPatch> = {},
): MemoryPatch {
  const dependencyVersions: Record<string, number> = {};
  for (const item of notesToUpsert) {
    for (const [depId, version] of Object.entries(recomputeDependencies(state, item).dependencies)) {
      dependencyVersions[depId] = version;
    }
  }
  opCounter += 1;
  return {
    schemaVersion: PATCH_SCHEMA_VERSION,
    opId: `op-${opCounter}`,
    snapshotVersion: state.globalVersion,
    dependencyVersions,
    notesToUpsert,
    notesToInvalidate,
    producer: 'manual',
    ...override,
  };
}

function stateWithStatement() {
  return reduce([statement(1, 'e1', '以后周报先给草稿。', 'pref:weekly-report', '先给草稿')]).state;
}

describe('patch 基本应用', () => {
  test('合法 patch 整体生效，笔记版本从 1 开始', () => {
    const state = stateWithStatement();
    const outcome = applyPatch(state, buildPatch(state, [draft('n1', '周报先给草稿', ['e1'], 'pref:weekly-report')]));
    assert.equal(outcome.disposition, 'applied');
    const note = outcome.state.notes['n1'];
    assert.equal(note?.status, 'active');
    assert.equal(note?.version, 1);
    assert.equal(note?.generator, 'scripted');
    assert.equal(outcome.state.globalVersion, state.globalVersion + 1);
  });

  test('同 opId 同载荷重放不重复生效', () => {
    const state = stateWithStatement();
    const patch = buildPatch(state, [draft('n1', '周报先给草稿', ['e1'], 'pref:weekly-report')]);
    const first = applyPatch(state, patch);
    const second = applyPatch(first.state, { ...patch, snapshotVersion: first.state.globalVersion });
    assert.equal(first.disposition, 'applied');
    assert.equal(second.disposition, 'replayed');
    assert.equal(second.state.notes['n1']?.version, 1);
    assert.equal(second.state.globalVersion, first.state.globalVersion);
  });

  test('同 opId 不同载荷显式冲突', () => {
    const state = stateWithStatement();
    const patch = buildPatch(state, [draft('n1', '周报先给草稿', ['e1'], 'pref:weekly-report')]);
    const first = applyPatch(state, patch);
    const replay = applyPatch(first.state, buildPatch(first.state, [draft('n1', '别的文本', ['e1'], 'pref:weekly-report')], [], { opId: patch.opId }));
    assert.equal(replay.disposition, 'rejected');
    assert.equal(replay.verdict.code, 'op_conflict');
  });

  test('拒绝后状态与笔记完全不变，只留拒绝记录', () => {
    const state = stateWithStatement();
    const patch = buildPatch(state, [draft('n1', 'x', ['missing-event'], 'pref:weekly-report')]);
    const outcome = applyPatch(state, patch);
    assert.equal(outcome.disposition, 'rejected');
    assert.deepEqual(outcome.state.notes, {});
    assert.equal(outcome.state.globalVersion, state.globalVersion);
    assert.equal(outcome.state.rejectedPatches.length, 1);
    assert.equal(outcome.state.rejectedPatches[0]?.code, 'unknown_source');
  });
});

describe('patch 版本与依赖', () => {
  test('无关事件推进版本后仍可提交', () => {
    const state = stateWithStatement();
    const patch = buildPatch(state, [draft('n1', '周报先给草稿', ['e1'], 'pref:weekly-report')]);
    const unrelated = stepEvent(state, statement(2, 'e2', '换个性签名。', 'pref:bio')).state;
    const outcome = applyPatch(unrelated, patch);
    assert.equal(outcome.disposition, 'applied');
    assert.equal(unrelated.globalVersion > patch.snapshotVersion, true);
  });

  test('相关 subject 变了必须拒绝', () => {
    const state = stateWithStatement();
    const patch = buildPatch(state, [draft('n1', '周报先给草稿', ['e1'], 'pref:weekly-report')]);
    const related = stepEvent(state, statement(2, 'e2', '周报直接发。', 'pref:weekly-report')).state;
    const outcome = applyPatch(related, patch);
    assert.equal(outcome.disposition, 'rejected');
    assert.equal(outcome.verdict.code, 'dependency_stale');
    assert.match(outcome.verdict.reasons[0]?.detail ?? '', /pref:weekly-report/);
  });

  test('未声明依赖被拒绝', () => {
    const state = stateWithStatement();
    const patch = buildPatch(state, [draft('n1', '周报先给草稿', ['e1'], 'pref:weekly-report')]);
    const stripped: MemoryPatch = { ...patch, dependencyVersions: {} };
    const verdict = validatePatch(state, stripped);
    assert.equal(verdict.accepted, false);
    assert.equal(verdict.code, 'dependency_undeclared');
  });

  test('补丁自报未来版本被拒绝', () => {
    const state = stateWithStatement();
    const patch = buildPatch(state, [draft('n1', 'x', ['e1'], 'pref:weekly-report')], [], {
      snapshotVersion: state.globalVersion + 3,
    });
    assert.equal(validatePatch(state, patch).code, 'version_mismatch');
  });

  test('引用未开放事件算 source_not_observed', () => {
    const events = [statement(1, 'e1', 'a', 'pref:a'), statement(2, 'e2', 'b', 'pref:b')];
    const state = reduce(events).state;
    const patch = buildPatch(state, [draft('n2', 'b', ['e2'], 'pref:b')]);
    const verdict = validatePatch(state, patch, { openUntilSequence: 1 });
    assert.equal(verdict.accepted, false);
    assert.equal(verdict.code, 'source_not_observed');
  });

  test('依赖环被拒绝', () => {
    const state = stateWithStatement();
    const patch = buildPatch(state, [
      draft('na', 'A', ['e1'], undefined, ['nb']),
      draft('nb', 'B', ['e1'], undefined, ['na']),
    ]);
    const verdict = validatePatch(state, patch);
    assert.equal(verdict.accepted, false);
    assert.equal(verdict.code, 'cycle');
  });

  test('悬空父笔记被拒绝', () => {
    const state = stateWithStatement();
    const patch = buildPatch(state, [draft('na', 'A', ['e1'], undefined, ['nope'])]);
    assert.equal(validatePatch(state, patch).code, 'unknown_source');
  });

  test('失效原因必填', () => {
    const state = stateWithStatement();
    const first = applyPatch(state, buildPatch(state, [draft('n1', 'x', ['e1'], 'pref:weekly-report')]));
    const second = buildPatch(first.state, [], [{ noteId: 'n1', reason: '' }]);
    assert.equal(validatePatch(first.state, second).code, 'invalid_shape');
  });

  test('不能在同一 patch 里既 upsert 又 invalidate 同一条笔记', () => {
    const state = stateWithStatement();
    const first = applyPatch(state, buildPatch(state, [draft('n1', 'x', ['e1'], 'pref:weekly-report')]));
    const second = buildPatch(
      first.state,
      [draft('n1', 'y', ['e1'], 'pref:weekly-report')],
      [{ noteId: 'n1', reason: 'conflict' }],
    );
    assert.equal(validatePatch(first.state, second).code, 'invalid_shape');
  });
});

describe('patch 失效传播', () => {
  test('新陈述令旧笔记失效，并传播到下游派生笔记', () => {
    const state = stateWithStatement();
    const first = applyPatch(
      state,
      buildPatch(state, [
        draft('n1', '周报先给草稿', ['e1'], 'pref:weekly-report'),
        draft('n2', '周报要审批', ['e1'], undefined, ['n1']),
      ]),
    );
    assert.equal(first.state.notes['n2']?.status, 'active');

    const corrected = stepEvent(first.state, statement(2, 'e2', '周报直接发。', 'pref:weekly-report')).state;
    assert.equal(corrected.notes['n1']?.status, 'invalidated');
    assert.match(corrected.notes['n1']?.invalidationReason ?? '', /subject_superseded/);
    assert.equal(corrected.notes['n2']?.status, 'invalidated');
    assert.equal(corrected.notes['n1']?.sourceEventIds[0], 'e1');
  });

  test('任务权威撤销令任务笔记失效，候选撤销不令其失效', () => {
    const base = reduce([
      statement(1, 'e1', '整理周报。', 'task:weekly-report'),
      { ...statement(2, 'e2', '整理周报。', 'task:weekly-report'), kind: 'task.changed', taskId: 'weekly-report', taskRevision: 1, payload: { change: 'created', authority: 'explicit' } },
    ]).state;
    const withNote = applyPatch(
      base,
      buildPatch(base, [draft('n1', '周报任务进行中', ['e1'], 'task:weekly-report')]),
    ).state;
    assert.equal(withNote.notes['n1']?.status, 'active');

    const candidate = stepEvent(
      withNote,
      { ...statement(3, 'e3', '算了别做了', 'task:weekly-report'), kind: 'task.changed', taskId: 'weekly-report', taskRevision: 2, payload: { change: 'cancelled', authority: 'scripted-candidate' } },
    ).state;
    assert.equal(candidate.notes['n1']?.status, 'active');

    const authoritative = stepEvent(
      candidate,
      { ...statement(4, 'e4', '取消', 'task:weekly-report'), kind: 'task.changed', taskId: 'weekly-report', taskRevision: 3, payload: { change: 'cancelled', authority: 'explicit' } },
    ).state;
    assert.equal(authoritative.notes['n1']?.status, 'invalidated');
    assert.match(authoritative.notes['n1']?.invalidationReason ?? '', /subject_superseded:task:weekly-report/);
  });

  test('工具结果可以成为笔记来源，且与呈现独立', () => {
    const state = reduce([toolResult(1, 'e1', 'req-1', 'ok', 'shell')]).state;
    const outcome = applyPatch(state, buildPatch(state, [draft('n1', 'shell 已成功', ['e1'])]));
    assert.equal(outcome.disposition, 'applied');
    assert.equal(outcome.state.requests['sess-1#1#req-1']?.toolOutcome, 'ok');
    assert.equal(outcome.state.requests['sess-1#1#req-1']?.presented, false);
    assert.equal(outcome.state.dependents[depIdForSubject('pref:weekly-report')], undefined);
  });
});
