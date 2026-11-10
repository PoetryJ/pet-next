/**
 * B3 有界队列测试：去重、预算截断、过时重算、即时取消不被排队。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { emptyState } from '../contracts.ts';
import { applyPatch } from '../ledger/patch.ts';
import { reduce, stepEvent } from '../ledger/reduce.ts';
import { fullRebuild } from './rebuild.ts';
import { MaintenanceQueue } from './queue.ts';
import { statement, taskChanged } from '../testing/factory.ts';

function seededState() {
  const events = [
    statement(1, 'e1', '周报先给草稿。', 'pref:weekly-report', '先给草稿'),
    statement(2, 'e2', '签名改短。', 'pref:bio', '简短'),
    statement(3, 'e3', '月报也要草稿。', 'pref:monthly', '先给草稿'),
    statement(4, 'e4', '整理周报。', 'task:weekly-report'),
    taskChanged(5, 'e5', 'weekly-report', 1, 'created'),
  ];
  const base = reduce(events).state;
  const built = fullRebuild(base, 'op-seed');
  const applied = applyPatch(base, built.patch);
  assert.equal(applied.disposition, 'applied');
  return applied.state;
}

describe('B3 有界整理队列', () => {
  test('每轮最多处理固定条数，其余保留为积压', () => {
    const state = seededState();
    const queue = new MaintenanceQueue({ maxNotesPerRound: 2, maxBytesPerRound: 10_000 });
    for (const key of ['pref:weekly-report', 'pref:bio', 'pref:monthly']) queue.enqueue(key, 1);
    const round = queue.drain(state, 'op-q');
    assert.equal(round.processed.length, 2);
    assert.equal(round.backlog, 1);
    assert.ok(round.diagnostics.includes('backlog:1'));
    assert.deepEqual(queue.pendingSubjects(), round.deferred);
  });

  test('同 subject 重复入队被去重，不放大积压', () => {
    const queue = new MaintenanceQueue({ maxNotesPerRound: 10, maxBytesPerRound: 10_000 });
    assert.equal(queue.enqueue('pref:weekly-report', 1).deduped, false);
    assert.equal(queue.enqueue('pref:weekly-report', 2).deduped, true);
    assert.equal(queue.backlog(), 1);
  });

  test('入队后 subject 变化，出队时按当前状态重算而不是写回旧视图', () => {
    const state = seededState();
    const queue = new MaintenanceQueue({ maxNotesPerRound: 5, maxBytesPerRound: 10_000 });
    queue.enqueue('pref:weekly-report', state.subjectVersions['pref:weekly-report'] ?? 0);
    const bumped = stepEvent(state, statement(9, 'e9', '周报直接发。', 'pref:weekly-report', '直接发送')).state;
    const round = queue.drain(bumped, 'op-q2');
    assert.ok(round.revalidated.includes('pref:weekly-report'));
    assert.ok(round.diagnostics.some((item) => item.startsWith('revalidated_on_stale')));
    const note = round.state.notes['n:pref:weekly-report'];
    assert.equal(note?.status, 'active');
    assert.match(note?.text ?? '', /直接发送/);
    assert.equal(note?.dependencyVersions['subject:pref:weekly-report'], bumped.subjectVersions['pref:weekly-report']);
  });

  test('读取字节预算耗尽时剩余项被推迟，顺序不插队', () => {
    const state = seededState();
    const queue = new MaintenanceQueue({ maxNotesPerRound: 10, maxBytesPerRound: 80 });
    queue.enqueue('pref:weekly-report', 1);
    queue.enqueue('pref:bio', 1);
    queue.enqueue('pref:monthly', 1);
    const round = queue.drain(state, 'op-q3');
    assert.equal(round.processed.length, 1);
    assert.ok(round.diagnostics.some((item) => item.startsWith('byte_budget_exhausted')));
    assert.deepEqual(queue.pendingSubjects(), ['pref:bio', 'pref:monthly']);
  });

  test('空队列是合法的，不伪造工作量', () => {
    const round = new MaintenanceQueue({ maxNotesPerRound: 2, maxBytesPerRound: 100 }).drain(emptyState(), 'op-q4');
    assert.equal(round.patch, undefined);
    assert.deepEqual(round.diagnostics, ['queue_empty']);
  });

  test('取消与更正不排队：reducer 当场让旧笔记失效', () => {
    const state = seededState();
    assert.equal(state.notes['n:task:weekly-report']?.status, 'active');
    const cancelled = stepEvent(state, taskChanged(6, 'e6', 'weekly-report', 2, 'cancelled')).state;
    assert.equal(cancelled.notes['n:task:weekly-report']?.status, 'invalidated');
  });
});
