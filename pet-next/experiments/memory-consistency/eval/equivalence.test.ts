/**
 * D4a 语义等价门（G2b 的核心）。
 *
 * 做法：同一段事件流，先全量重建一次作为基线；
 * 追加一批新事件后，分别用「全量重建」与「局部重建」产出补丁并应用，
 * 比较可观察的有效事实集合（笔记 id / 文本 / 状态 / 依赖）。
 *
 * 注意边界：这证明两种维护路径在同一份输入上**给出相同状态**，
 * 不证明自然语言摘要忠实，也不证明模型理解。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { emptyState, type MemoryEvent, type MemoryState } from '../contracts.ts';
import { applyPatch } from '../ledger/patch.ts';
import { stepEvent } from '../ledger/reduce.ts';
import { activeFactSet, changeSetOf, fullRebuild, incrementalRebuild, noteView } from '../maintenance/rebuild.ts';
import { acknowledged, generated, presented, statement, taskChanged, toolResult } from '../testing/factory.ts';

const SUBJECTS = 20;
const REQUESTS = 20;

/** 确定性事件流：没有随机数，重复跑完全一致。 */
function makeEvent(index: number): MemoryEvent {
  const phase = index % 5;
  const subject = `pref:p${index % SUBJECTS}`;
  const request = `req-${index % REQUESTS}`;
  const response = `resp-${index}`;
  switch (phase) {
    case 0:
      return statement(index, `e${index}`, `偏好第 ${index} 条`, subject, `值${index}`);
    case 1:
      return generated(index, `e${index}`, request, response, `回答 ${index}`);
    case 2:
      return presented(index, `e${index}`, request, response, 'ui');
    case 3:
      return toolResult(index, `e${index}`, request, (index % REQUESTS) % 2 === 0 ? 'ok' : 'error', 'write_file');
    default:
      return index % 10 === 0
        ? taskChanged(index, `e${index}`, `task-${index % 5}`, Math.floor(index / 10) + 1, 'created')
        : acknowledged(index, `e${index}`, request, response);
  }
}

function applyEvents(state: MemoryState, events: readonly MemoryEvent[]): MemoryState {
  let next = state;
  for (const event of events) {
    const outcome = stepEvent(next, event);
    next = outcome.state;
  }
  return next;
}

function baseline(total: number): { state: MemoryState; events: MemoryEvent[] } {
  const events = Array.from({ length: total }, (_, i) => makeEvent(i + 1));
  const reduced = applyEvents(emptyState(), events);
  const built = fullRebuild(reduced, 'op-baseline');
  const applied = applyPatch(reduced, built.patch);
  assert.equal(applied.disposition, 'applied', JSON.stringify(applied.verdict.reasons));
  return { state: applied.state, events };
}

describe('D4a 维护语义等价', () => {
  test('全量与局部在同一变更集上产出同一有效事实集合', () => {
    const base = baseline(300);
    const newEvents = Array.from({ length: 60 }, (_, i) => makeEvent(301 + i));
    const afterEvents = applyEvents(base.state, newEvents);

    const full = fullRebuild(afterEvents, 'op-full');
    const fullApplied = applyPatch(afterEvents, full.patch);
    assert.equal(fullApplied.disposition, 'applied', JSON.stringify(fullApplied.verdict.reasons));

    const change = changeSetOf(newEvents);
    const inc = incrementalRebuild(afterEvents, change, 'op-inc');
    const incApplied = applyPatch(afterEvents, inc.patch);
    assert.equal(incApplied.disposition, 'applied', JSON.stringify(incApplied.verdict.reasons));

    assert.deepEqual(activeFactSet(fullApplied.state), activeFactSet(incApplied.state));
    assert.deepEqual(noteView(fullApplied.state), noteView(incApplied.state));
  });

  test('局部重建少检查槽位，但事件访问量按「槽位×日志」计', () => {
    const base = baseline(300);
    const newEvents = Array.from({ length: 10 }, (_, i) => makeEvent(301 + i));
    const afterEvents = applyEvents(base.state, newEvents);
    const full = fullRebuild(afterEvents, 'op-full-2');
    const inc = incrementalRebuild(afterEvents, changeSetOf(newEvents), 'op-inc-2');
    assert.ok(inc.stats.notesExamined < full.stats.notesExamined, `${inc.stats.notesExamined} !< ${full.stats.notesExamined}`);
    // 口径：eventsVisited 是真实迭代次数。局部仍按槽位扫日志，不能宣称 O(1)。
    assert.ok(inc.stats.eventsVisited <= full.stats.eventsVisited, `${inc.stats.eventsVisited} !<= ${full.stats.eventsVisited}`);
    assert.ok(inc.stats.eventsVisited >= inc.stats.uniqueEventsTouched, 'visits 不能少于去重条数');
  });

  test('等价门能失败：漏掉变更集的局部重建必须被发现', () => {
    const base = baseline(300);
    const newEvents = Array.from({ length: 20 }, (_, i) => makeEvent(301 + i));
    const afterEvents = applyEvents(base.state, newEvents);

    const fullApplied = applyPatch(afterEvents, fullRebuild(afterEvents, 'op-full-3').patch);
    const blind = incrementalRebuild(afterEvents, { subjectKeys: [], requestKeys: [], eventIds: [] }, 'op-inc-blind');
    const blindApplied = applyPatch(afterEvents, blind.patch);

    assert.equal(blind.patch.notesToUpsert.length, 0);
    assert.notDeepEqual(activeFactSet(fullApplied.state), activeFactSet(blindApplied.state));
  });

  test('无变更时重跑全量重建不产生版本抖动', () => {
    const base = baseline(120);
    const again = fullRebuild(base.state, 'op-idempotent');
    assert.equal(again.patch.notesToUpsert.length, 0);
    assert.equal(again.patch.notesToInvalidate.length, 0);
  });

  test('来源可核对：每条重建笔记都指向真实事件', () => {
    const base = baseline(200);
    for (const note of Object.values(base.state.notes)) {
      assert.ok(note.sourceEventIds.length > 0, note.noteId);
      for (const eventId of note.sourceEventIds) {
        assert.ok(base.state.eventIndex[eventId] !== undefined, `${note.noteId} -> ${eventId}`);
      }
    }
  });
});
