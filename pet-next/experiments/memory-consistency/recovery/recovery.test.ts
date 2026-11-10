/**
 * D2 进程崩溃恢复。
 *
 * 判定口径（刻意不写「必须等于最后一次 ACK 之前」）：
 * - 已返回确认的事件与补丁必须能恢复；
 * - 崩溃时在途的那个操作允许「已落盘」或「未落盘」；
 * - 对在途 id 重试必须安全：要么 replayed/duplicate，要么补上且只生效一次；
 * - 绝不因为「多恢复了一条未确认记录」判失败。
 *
 * 这是进程崩溃实验，不是断电或文件系统永久损坏实验。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import type { MemoryEvent, NoteDraft } from '../contracts.ts';
import { canonicalJson } from '../contracts.ts';
import { generated, presented, statement } from '../testing/factory.ts';
import { JsonlStore } from '../storage/store.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'worker.ts');
const CRASH_EXIT = 97;

interface AckRecord {
  readonly kind: 'append' | 'patch' | 'checkpoint';
  readonly eventId?: string;
  readonly opId?: string;
  readonly disposition?: string;
  readonly checkpointId?: string;
}

function note(noteId: string, text: string, sources: readonly string[], subjectKey?: string): NoteDraft {
  return {
    noteId,
    text,
    sourceEventIds: sources,
    parentNoteIds: [],
    dependencyVersions: {},
    generator: 'scripted',
    ...(subjectKey === undefined ? {} : { subjectKey }),
  };
}

/** 跑一个子进程计划，返回退出码与已确认记录。 */
function runPlan(dir: string, plan: readonly object[]): { status: number; acks: AckRecord[] } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', WORKER], {
    env: { ...process.env, MEMORY_STORE_DIR: dir, WORKER_PLAN: JSON.stringify(plan) },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const ackPath = join(dir, 'acks.ndjson');
  const acks = existsSync(ackPath)
    ? readFileSync(ackPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as AckRecord)
    : [];
  return { status: result.status ?? -1, acks };
}

function openStore(dir: string): JsonlStore {
  const opened = JsonlStore.open(dir);
  assert.equal(opened.ok, true, opened.ok ? '' : `${opened.code}: ${opened.detail}`);
  if (!opened.ok) throw new Error('unreachable');
  return opened.value;
}

const EVENTS = [
  statement(1, 'e1', '以后周报先给草稿。', 'pref:weekly-report', '先给草稿'),
  generated(2, 'e2', 'req-1', 'resp-1'),
  presented(3, 'e3', 'req-1', 'resp-1'),
  statement(4, 'e4', '签名改短。', 'pref:bio', '简短'),
];

describe('D2 崩溃恢复', () => {
  test('append.before-write：崩溃点之前的确认事件全部恢复', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-'));
    try {
      const plan = [
        { op: 'append', event: EVENTS[0] },
        { op: 'append', event: EVENTS[1] },
        { op: 'append', event: EVENTS[2], crashAt: 'append.before-write' },
      ];
      const { status, acks } = runPlan(dir, plan);
      assert.equal(status, CRASH_EXIT);
      assert.equal(acks.length, 2);

      const store = openStore(dir);
      const loaded = store.load();
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      for (const record of acks) {
        assert.ok(loaded.value.state.eventIndex[record.eventId ?? ''] !== undefined, `lost ${record.eventId}`);
      }
      assert.equal(loaded.value.state.eventIndex['e3'], undefined);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('append.after-write.before-ack：在途事件可已落盘，重试只生效一次', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-'));
    try {
      const plan = [
        { op: 'append', event: EVENTS[0] },
        { op: 'append', event: EVENTS[1] },
        { op: 'append', event: EVENTS[2], crashAt: 'append.after-write.before-ack' },
      ];
      const { status, acks } = runPlan(dir, plan);
      assert.equal(status, CRASH_EXIT);
      assert.equal(acks.length, 2, 'after-write crash must not have acknowledged');

      const store = openStore(dir);
      const loaded = store.load();
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      for (const record of acks) {
        assert.ok(loaded.value.state.eventIndex[record.eventId ?? ''] !== undefined, `lost ${record.eventId}`);
      }
      const present = loaded.value.state.eventIndex['e3'] !== undefined;
      // 允许两种结果，但都不许出现重复生效。
      const retry = store.append(EVENTS[2] as MemoryEvent);
      assert.equal(retry.ok, true, retry.ok ? '' : retry.detail);
      if (retry.ok && present) assert.equal(retry.value.disposition, 'duplicate');
      const occurrences = store.getState().events.filter((event) => event.eventId === 'e3').length;
      assert.equal(occurrences, 1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('append.after-ack：确认后崩溃，事件必须在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-'));
    try {
      const plan = [
        { op: 'append', event: EVENTS[0] },
        { op: 'append', event: EVENTS[1] },
        { op: 'append', event: EVENTS[2], crashAt: 'append.after-ack' },
      ];
      const { status, acks } = runPlan(dir, plan);
      assert.equal(status, CRASH_EXIT);
      // crashAt 在返回确认之前触发，所以这里仍然只有两条确认。
      assert.equal(acks.length, 2);
      const store = openStore(dir);
      const loaded = store.load();
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.ok(loaded.value.state.eventIndex['e3'] !== undefined);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('patch.before-write：已确认补丁必须恢复，在途补丁不落地', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-'));
    try {
      const plan = [
        { op: 'append', event: EVENTS[0] },
        { op: 'append', event: EVENTS[1] },
        { op: 'patch', opId: 'op-1', notes: [note('n1', '周报先给草稿', ['e1'], 'pref:weekly-report')] },
        { op: 'patch', opId: 'op-2', notes: [note('n2', '请求已生成', ['e2'])], crashAt: 'patch.before-write' },
      ];
      const { status, acks } = runPlan(dir, plan);
      assert.equal(status, CRASH_EXIT);
      assert.equal(acks.filter((item) => item.kind === 'patch').length, 1);

      const store = openStore(dir);
      const loaded = store.load();
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.ok(loaded.value.state.appliedOps['op-1'] !== undefined);
      assert.equal(loaded.value.state.notes['n1']?.status, 'active');
      assert.equal(loaded.value.state.notes['n2'], undefined);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('patch.after-write.before-ack：在途补丁可已落盘，重试幂等且版本不翻倍', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-'));
    try {
      const plan = [
        { op: 'append', event: EVENTS[0] },
        { op: 'append', event: EVENTS[1] },
        { op: 'patch', opId: 'op-1', notes: [note('n1', '周报先给草稿', ['e1'], 'pref:weekly-report')] },
        {
          op: 'patch',
          opId: 'op-2',
          notes: [note('n2', '请求已生成', ['e2'])],
          crashAt: 'patch.after-write.before-ack',
        },
      ];
      const { status, acks } = runPlan(dir, plan);
      assert.equal(status, CRASH_EXIT);
      assert.equal(acks.filter((item) => item.kind === 'patch').length, 1, 'after-write crash must not acknowledge');

      const store = openStore(dir);
      const loaded = store.load();
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.ok(loaded.value.state.appliedOps['op-1'] !== undefined, 'acknowledged patch lost');
      assert.equal(loaded.value.state.notes['n1']?.status, 'active');
      const inFlightPresent = loaded.value.state.appliedOps['op-2'] !== undefined;
      if (inFlightPresent) assert.equal(loaded.value.state.notes['n2']?.version, 1);

      const retry = store.commitPatch({
        schemaVersion: 'memory-patch/v1',
        opId: 'op-2',
        snapshotVersion: store.getState().globalVersion,
        dependencyVersions: { 'event:e2': 1 },
        notesToUpsert: [note('n2', '请求已生成', ['e2'])],
        notesToInvalidate: [],
        producer: 'manual',
      });
      assert.equal(retry.ok, true, retry.ok ? '' : retry.detail);
      if (retry.ok) {
        assert.equal(retry.value.disposition, inFlightPresent ? 'replayed' : 'applied');
      }
      assert.equal(store.getState().notes['n2']?.version, 1, 'in-flight patch applied twice');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checkpoint.after-snapshot：清单未切换，仍能靠日志完整恢复', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-'));
    try {
      const plan = [
        { op: 'append', event: EVENTS[0] },
        { op: 'append', event: EVENTS[1] },
        { op: 'patch', opId: 'op-1', notes: [note('n1', '周报先给草稿', ['e1'], 'pref:weekly-report')] },
        { op: 'checkpoint', crashAt: 'checkpoint.after-snapshot' },
      ];
      const { status, acks } = runPlan(dir, plan);
      assert.equal(status, CRASH_EXIT);
      assert.equal(acks.filter((item) => item.kind === 'checkpoint').length, 0);

      const store = openStore(dir);
      const loaded = store.load();
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.equal(loaded.value.eventCount, 2);
      assert.equal(loaded.value.appliedPatchCount, 1);
      assert.equal(loaded.value.state.notes['n1']?.status, 'active');
      assert.equal(loaded.value.checkpointId, undefined);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checkpoint.after-manifest.before-ack：走快照路径也能得到同样状态', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-'));
    try {
      const plan = [
        { op: 'append', event: EVENTS[0] },
        { op: 'append', event: EVENTS[1] },
        { op: 'patch', opId: 'op-1', notes: [note('n1', '周报先给草稿', ['e1'], 'pref:weekly-report')] },
        { op: 'checkpoint', crashAt: 'checkpoint.after-manifest.before-ack' },
      ];
      const { status, acks } = runPlan(dir, plan);
      assert.equal(status, CRASH_EXIT);
      assert.equal(acks.filter((item) => item.kind === 'checkpoint').length, 0);

      const store = openStore(dir);
      const loaded = store.load();
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.ok(loaded.value.checkpointId !== undefined, 'manifest should be visible after switch');
      assert.equal(loaded.value.eventCount, 2);
      assert.equal(loaded.value.state.notes['n1']?.status, 'active');
      const live = canonicalJson(loaded.value.state as unknown);
      store.close();

      // 快照路径与全量日志重放必须一致：删掉清单后再开一次，比较状态。
      rmSync(join(dir, 'checkpoint.json'), { force: true });
      const replayOnly = openStore(dir);
      const replayed = replayOnly.load();
      assert.equal(replayed.ok, true);
      if (!replayed.ok) return;
      assert.equal(canonicalJson(replayed.value.state as unknown), live);
      replayOnly.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
