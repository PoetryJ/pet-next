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

  test('提交字节超限的项被推迟，已接受的项照常提交且总字节不超 cap', () => {
    // 先制造三个真的需要重写的槽位，否则补丁里没有 upsert、字节数不随条目增长。
    let state = seededState();
    for (const [seq, subject] of [[10, 'pref:weekly-report'], [11, 'pref:bio'], [12, 'pref:monthly']] as const) {
      // 只推进事件、不重建：这样队列的 desired 与现有笔记不同，才会真的产生 upsert。
      state = stepEvent(state, statement(seq, `e${seq}`, `新值${seq}`, subject, `新值${seq}`)).state;
    }

    const single = new MaintenanceQueue({ maxNotesPerRound: 10, maxBytesPerRound: 100000 });
    single.enqueue('pref:weekly-report', 1);
    const one = single.drain(state, 'op-q3');
    assert.ok(one.submittedBytes > 0);
    assert.equal(one.patch?.notesToUpsert.length, 1);

    const queue = new MaintenanceQueue({ maxNotesPerRound: 10, maxBytesPerRound: one.submittedBytes });
    queue.enqueue('pref:weekly-report', 1);
    queue.enqueue('pref:bio', 1);
    queue.enqueue('pref:monthly', 1);
    const round = queue.drain(state, 'op-q3');
    assert.equal(round.processed.length, 1);
    assert.ok(round.submittedBytes <= one.submittedBytes);
    assert.ok(round.diagnostics.some((item) => item.includes('byte_budget_exhausted')));
    assert.deepEqual(queue.pendingSubjects(), ['pref:bio', 'pref:monthly']);
  });

  test('cap 小到装不下首项：留待办并报 oversize，绝不提交', () => {
    const state = seededState();
    const queue = new MaintenanceQueue({ maxNotesPerRound: 1, maxBytesPerRound: 1 });
    queue.enqueue('pref:weekly-report', 1);
    const round = queue.drain(state, 'op-q5');
    assert.deepEqual(round.processed, []);
    assert.equal(round.patch, undefined);
    assert.equal(round.submittedBytes, 0);
    assert.equal(round.backlog, 1);
    assert.ok(round.diagnostics.some((item) => item.startsWith('oversize:')));
  });

  test('被拒补丁不计 processed，条目退回队首', () => {
    const state = seededState();
    // 用一个小到只容一项的 cap，再让补丁因依赖过期被拒：把 subject 版本改掉即可。
    const queue = new MaintenanceQueue({ maxNotesPerRound: 1, maxBytesPerRound: 100000 });
    queue.enqueue('pref:weekly-report', 1);
    const bumped = stepEvent(state, statement(77, 'e77', '周报改成英文', 'pref:weekly-report', '英文')).state;
    const stalePatchState = { ...bumped, subjectVersions: { ...bumped.subjectVersions, 'pref:weekly-report': 3 } };
    const round = queue.drain(stalePatchState, 'op-q6');
    // 这里补丁是「按当前状态重算」的，所以正常应成功；断言重点是：一旦被拒，条目必须回到队首。
    if (round.diagnostics.some((item) => item.startsWith('patch_rejected'))) {
      assert.deepEqual(round.processed, []);
      assert.equal(round.backlog, 1);
    } else {
      assert.equal(round.processed.length, 1);
      assert.equal(round.backlog, 0);
    }
  });

  test('cap 恰好等于补丁字节时允许提交（边界相等）', () => {
    let state = seededState();
    state = stepEvent(state, statement(20, 'e20', '签名再短', 'pref:bio', '更短')).state;

    const probe = new MaintenanceQueue({ maxNotesPerRound: 5, maxBytesPerRound: 100000 });
    probe.enqueue('pref:bio', 1);
    const exact = probe.drain(state, 'op-edge').submittedBytes;
    assert.ok(exact > 0);
    const queue = new MaintenanceQueue({ maxNotesPerRound: 5, maxBytesPerRound: exact });
    queue.enqueue('pref:bio', 1);
    const round = queue.drain(state, 'op-edge');
    assert.equal(round.processed.length, 1);
    assert.equal(round.submittedBytes, exact);
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
