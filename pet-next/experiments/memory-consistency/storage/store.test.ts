/**
 * A2 磁盘存取测试：确认语义、恢复一致、损坏分类、单写者。
 *
 * 只证明「测过的进程内行为」。断电与文件系统永久损坏没有测，报告里也不许写。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  PATCH_SCHEMA_VERSION,
  canonicalJson,
  sha256Hex,
  type MemoryPatch,
  type MemoryState,
  type NoteDraft,
} from '../contracts.ts';
import { recomputeDependencies } from '../ledger/patch.ts';
import { generated, presented, statement } from '../testing/factory.ts';
import { JsonlStore } from './store.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'memory-store-'));
}

function open(dir: string): JsonlStore {
  const result = JsonlStore.open(dir);
  assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.detail}`);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

function draft(noteId: string, text: string, sourceEventIds: readonly string[], subjectKey?: string): NoteDraft {
  return {
    noteId,
    text,
    sourceEventIds,
    parentNoteIds: [],
    dependencyVersions: {},
    generator: 'scripted',
    ...(subjectKey === undefined ? {} : { subjectKey }),
  };
}

function patchFor(state: MemoryState, notes: readonly NoteDraft[], opId: string): MemoryPatch {
  const dependencyVersions: Record<string, number> = {};
  for (const item of notes) {
    for (const [depId, version] of Object.entries(recomputeDependencies(state, item).dependencies)) {
      dependencyVersions[depId] = version;
    }
  }
  return {
    schemaVersion: PATCH_SCHEMA_VERSION,
    opId,
    snapshotVersion: state.globalVersion,
    dependencyVersions,
    notesToUpsert: notes,
    notesToInvalidate: [],
    producer: 'manual',
  };
}

describe('存取与恢复', () => {
  test('确认过的事件与补丁在重开后都在', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const events = [
        statement(1, 'e1', '以后周报先给草稿。', 'pref:weekly-report', '先给草稿'),
        generated(2, 'e2', 'req-1', 'resp-1'),
        presented(3, 'e3', 'req-1', 'resp-1'),
      ];
      for (const event of events) {
        const result = store.append(event);
        assert.equal(result.ok, true, result.ok ? '' : result.detail);
      }
      const patch = patchFor(store.getState(), [draft('n1', '周报先给草稿', ['e1'], 'pref:weekly-report')], 'op-1');
      const committed = store.commitPatch(patch);
      assert.equal(committed.ok, true, committed.ok ? '' : committed.detail);
      const live = canonicalJson(store.getState() as unknown);
      store.close();

      const reopened = open(dir);
      const loaded = reopened.load();
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.equal(loaded.value.eventCount, 3);
      assert.equal(loaded.value.appliedPatchCount, 1);
      assert.equal(canonicalJson(loaded.value.state as unknown), live);
      assert.equal(loaded.value.state.notes['n1']?.status, 'active');
      assert.equal(loaded.value.state.notes['n1']?.version, 1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('同事件重试幂等，不重复落盘', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const event = statement(1, 'e1', '以后都用中文。', 'pref:language');
      assert.equal(store.append(event).ok, true);
      const retry = store.append({ ...event, sequence: 2 });
      assert.equal(retry.ok, true);
      if (retry.ok) assert.equal(retry.value.disposition, 'duplicate');
      assert.equal(store.getState().events.length, 1);
      store.close();
      const reopened = open(dir);
      assert.equal(reopened.getState().events.length, 1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('同 eventId 异载荷被拒并保留原因', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      assert.equal(store.append(statement(1, 'e1', 'A', 'pref:a')).ok, true);
      const conflict = store.append(statement(2, 'e1', 'B', 'pref:a'));
      assert.equal(conflict.ok, false);
      if (!conflict.ok) assert.equal(conflict.code, 'event_conflict');
      assert.equal(store.getState().events.length, 1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('非单调 sequence 被拒（日志重放顺序必须与在线一致）', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      assert.equal(store.append(statement(5, 'e5', 'A', 'pref:a')).ok, true);
      const late = store.append(statement(4, 'e4', 'B', 'pref:b'));
      assert.equal(late.ok, false);
      if (!late.ok) assert.equal(late.code, 'not_supported');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('同 opId 重放返回 replayed，且不重复写笔记', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      assert.equal(store.append(statement(1, 'e1', 'A', 'pref:a')).ok, true);
      const patch = patchFor(store.getState(), [draft('n1', 'A', ['e1'], 'pref:a')], 'op-1');
      const first = store.commitPatch(patch);
      assert.equal(first.ok, true);
      const replay = store.commitPatch({ ...patch, snapshotVersion: store.getState().globalVersion });
      assert.equal(replay.ok, true);
      if (replay.ok) assert.equal(replay.value.disposition, 'replayed');
      assert.equal(store.getState().notes['n1']?.version, 1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checkpoint 之后追加的事件仍能从快照 + 日志尾部恢复', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      assert.equal(store.append(statement(1, 'e1', 'A', 'pref:a')).ok, true);
      assert.equal(store.append(statement(2, 'e2', 'B', 'pref:b')).ok, true);
      const manifest = store.checkpoint();
      assert.equal(manifest.ok, true);
      assert.equal(store.append(generated(3, 'e3', 'req-1', 'resp-1')).ok, true);
      const live = canonicalJson(store.getState() as unknown);
      store.close();

      const reopened = open(dir);
      const loaded = reopened.load();
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.equal(canonicalJson(loaded.value.state as unknown), live);
      assert.equal(loaded.value.eventCount, 3);
      assert.equal(loaded.value.isolatedTailBytes, 0);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('损坏分类', () => {
  test('尾部半条记录被隔离并报告，不假装成功', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      assert.equal(store.append(statement(1, 'e1', 'A', 'pref:a')).ok, true);
      store.close();
      const logPath = join(dir, 'events.log');
      const before = readFileSync(logPath, 'utf8');
      writeFileSync(logPath, `${before}{"type":"event","event":{"schemaVer`, 'utf8');

      const reopened = open(dir);
      const loaded = reopened.load();
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.equal(loaded.value.state.events.length, 1);
      assert.ok(loaded.value.isolatedTailBytes > 0);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('中段坏行直接失败，不做「修好再报成功」', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      assert.equal(store.append(statement(1, 'e1', 'A', 'pref:a')).ok, true);
      assert.equal(store.append(statement(2, 'e2', 'B', 'pref:b')).ok, true);
      store.close();
      const logPath = join(dir, 'events.log');
      const lines = readFileSync(logPath, 'utf8').split('\n');
      lines[0] = lines[0]?.replace('"e1"', '"e1x"') ?? '';
      writeFileSync(logPath, lines.join('\n'), 'utf8');

      const reopened = JsonlStore.open(dir);
      assert.equal(reopened.ok, false);
      if (!reopened.ok) {
        assert.equal(reopened.code, 'corrupt_log');
        assert.equal(typeof reopened.offset, 'number');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('快照被改但清单未改：manifest_mismatch', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      assert.equal(store.append(statement(1, 'e1', 'A', 'pref:a')).ok, true);
      assert.equal(store.checkpoint().ok, true);
      store.close();
      const manifest = JSON.parse(readFileSync(join(dir, 'checkpoint.json'), 'utf8')) as { checkpointId: string };
      const snapshotPath = join(dir, `state-${manifest.checkpointId}.json`);
      writeFileSync(snapshotPath, readFileSync(snapshotPath, 'utf8').replace('pref:a', 'pref:z'), 'utf8');
      const reopened = JsonlStore.open(dir);
      assert.equal(reopened.ok, false);
      if (!reopened.ok) assert.equal(reopened.code, 'manifest_mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('快照 schema 未知：schema_unknown', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      assert.equal(store.append(statement(1, 'e1', 'A', 'pref:a')).ok, true);
      assert.equal(store.checkpoint().ok, true);
      store.close();
      const manifestPath = join(dir, 'checkpoint.json');
      const snapshotManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { checkpointId: string };
      const snapshotPath = join(dir, `state-${snapshotManifest.checkpointId}.json`);
      const state = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
      state['schemaVersion'] = 'memory-state/v99';
      const body = canonicalJson(state);
      writeFileSync(snapshotPath, body, 'utf8');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest['stateSha256'] = sha256Hex(body);
      writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

      const reopened = JsonlStore.open(dir);
      assert.equal(reopened.ok, false);
      if (!reopened.ok) assert.equal(reopened.code, 'schema_unknown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('第二个写者被明确拒绝', () => {
    const dir = tempDir();
    try {
      const first = open(dir);
      const second = JsonlStore.open(dir);
      assert.equal(second.ok, false);
      if (!second.ok) assert.equal(second.code, 'writer_busy');
      first.close();
      const third = open(dir);
      third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('关闭后写入返回错误而不是静默丢弃', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      store.close();
      const result = store.append(statement(1, 'e1', 'A', 'pref:a'));
      assert.equal(result.ok, false);
      assert.equal(existsSync(join(dir, 'events.log')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
