/**
 * 单写者磁盘存取：JSONL 日志 + 版本化快照/清单。
 *
 * 写入顺序固定：先纯计算并校验下一状态 -> 再写事务记录并 fsync -> 成功后才发布内存并确认。
 * 写失败或进程退出时内存不前进，磁盘上可能留着一条完整记录（允许，见 crash 语义）。
 *
 * 日志同时保存原始事件与 acceptedPatch（带 opId、提交顺序与完整补丁），
 * 因此恢复既不会丢已确认的笔记，也不需要重放「修补丁」这种不存在的东西。
 *
 * 保证范围：被测过的进程崩溃恢复。没有断电/文件系统损坏测试，不宣称断电耐久。
 *
 * @module pet-next/experiments/memory-consistency/storage/store
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  canonicalJson,
  emptyState,
  payloadHash,
  sha256Hex,
  STATE_SCHEMA_VERSION,
  type AppendValue,
  type CheckpointManifest,
  type CommitValue,
  type LoadValue,
  type MemoryEvent,
  type MemoryPatch,
  type MemoryState,
  type MemoryStore,
  type StoreErrorCode,
  type StoreResult,
} from '../contracts.ts';
import { applyPatch } from '../ledger/patch.ts';
import { stepEvent } from '../ledger/reduce.ts';
import { crashAt } from './crash-hook.ts';

const LOG_FILE = 'events.log';
const SNAPSHOT_PREFIX = 'state-';
const MANIFEST_FILE = 'checkpoint.json';
const LOCK_FILE = 'writer.lock';

const EVENT_RECORD = 'event';
const PATCH_RECORD = 'patch';

interface EventRecord {
  readonly type: typeof EVENT_RECORD;
  readonly event: MemoryEvent;
}

interface PatchRecord {
  readonly type: typeof PATCH_RECORD;
  readonly opId: string;
  readonly commitOrder: number;
  readonly patch: MemoryPatch;
}

type LogRecord = EventRecord | PatchRecord;

/** 快照文件名由 checkpointId 推导；清单是唯一切换点。 */
function snapshotFileName(checkpointId: string): string {
  return `${SNAPSHOT_PREFIX}${checkpointId}.json`;
}

function err(code: StoreErrorCode, detail: string, offset?: number): StoreResult<never> {
  return offset === undefined ? { ok: false, code, detail } : { ok: false, code, detail, offset };
}

function encodeRecord(record: LogRecord): { readonly line: string; readonly body: string } {
  const body = canonicalJson(record as unknown);
  const line = canonicalJson({ ...(record as unknown as Record<string, unknown>), lineSha256: sha256Hex(body) });
  return { line: `${line}\n`, body };
}

/** 打开状态的存储。dir 不存在会创建。 */
export class JsonlStore implements MemoryStore {
  private state: MemoryState = emptyState();
  private eventCount = 0;
  private appliedPatchCount = 0;
  private logBytes = 0;
  private closed = false;
  private lastCheckpointId: string | undefined;
  private readonly diagnostics: string[] = [];
  private lastIsolatedTailBytes = 0;

  private readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  /** 打开并加写锁，随后立即 load() 恢复。 */
  static open(dir: string): StoreResult<JsonlStore> {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (cause) {
      return err('io_error', `cannot create dir: ${String(cause)}`);
    }
    const lockPath = join(dir, LOCK_FILE);
    const lock = acquireLock(lockPath);
    if (!lock.ok) return lock;
    const store = new JsonlStore(dir);
    const loaded = store.load();
    if (!loaded.ok) {
      releaseLock(lockPath);
      return loaded;
    }
    return { ok: true, value: store, durable: true };
  }

  /** 当前权威状态（只读快照引用）。 */
  getState(): MemoryState {
    return this.state;
  }

  append(event: MemoryEvent): StoreResult<AppendValue> {
    if (this.closed) return err('io_error', 'store closed');
    if (event.sequence <= this.state.lastSequence && this.state.eventIndex[event.eventId] === undefined) {
      // 日志按接收顺序落盘，重放必须与在线一致，所以拒绝非单调 sequence。
      return err('not_supported', `sequence_not_monotonic:${event.sequence}<=${this.state.lastSequence}`);
    }
    const outcome = stepEvent(this.state, event);
    if (outcome.disposition === 'rejected') {
      const code: StoreErrorCode = outcome.reason === 'event_id_conflict' ? 'event_conflict' : 'not_supported';
      return err(code, outcome.reason ?? 'rejected');
    }
    if (outcome.disposition === 'duplicate') {
      return {
        ok: true,
        durable: true,
        value: {
          eventId: event.eventId,
          sequence: event.sequence,
          globalVersion: this.state.globalVersion,
          disposition: 'duplicate',
        },
      };
    }

    crashAt('append.before-write');
    try {
      this.writeLine({ type: EVENT_RECORD, event });
    } catch (cause) {
      return err('io_error', `append write failed: ${String(cause)}`);
    }
    crashAt('append.after-write.before-ack');

    this.state = outcome.state;
    this.eventCount += 1;
    crashAt('append.after-ack');
    return {
      ok: true,
      durable: true,
      value: {
        eventId: event.eventId,
        sequence: event.sequence,
        globalVersion: this.state.globalVersion,
        disposition: 'appended',
      },
    };
  }

  commitPatch(patch: MemoryPatch): StoreResult<CommitValue> {
    if (this.closed) return err('io_error', 'store closed');
    const outcome = applyPatch(this.state, patch);
    if (outcome.disposition === 'replayed') {
      const prior = this.state.appliedOps[patch.opId];
      return {
        ok: true,
        durable: true,
        value: {
          opId: patch.opId,
          commitOrder: prior?.commitOrder ?? 0,
          globalVersion: this.state.globalVersion,
          disposition: 'replayed',
          invalidatedNoteIds: [],
        },
      };
    }
    if (outcome.disposition === 'rejected') {
      const code: StoreErrorCode = outcome.verdict.code === 'op_conflict' ? 'patch_conflict' : 'patch_rejected';
      return err(code, `${outcome.verdict.code}: ${outcome.verdict.reasons.map((item) => item.detail).join('; ')}`);
    }

    const commitOrder = Object.keys(this.state.appliedOps).length + 1;
    crashAt('patch.before-write');
    try {
      this.writeLine({ type: PATCH_RECORD, opId: patch.opId, commitOrder, patch });
    } catch (cause) {
      return err('io_error', `patch write failed: ${String(cause)}`);
    }
    crashAt('patch.after-write.before-ack');

    this.state = outcome.state;
    this.appliedPatchCount += 1;
    crashAt('patch.after-ack');
    return {
      ok: true,
      durable: true,
      value: {
        opId: patch.opId,
        commitOrder,
        globalVersion: this.state.globalVersion,
        disposition: 'applied',
        invalidatedNoteIds: outcome.invalidatedNoteIds,
      },
    };
  }

  load(): StoreResult<LoadValue> {
    this.diagnostics.length = 0;
    let state = emptyState();
    let offset = 0;
    let checkpointId: string | undefined;

    const manifestPath = join(this.dir, MANIFEST_FILE);
    if (existsSync(manifestPath)) {
      let manifest: CheckpointManifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CheckpointManifest;
      } catch (cause) {
        return err('corrupt_log', `manifest unreadable: ${String(cause)}`);
      }
      if (manifest.schemaVersion !== 'memory-checkpoint/v1') {
        return err('schema_unknown', `manifest schema ${String(manifest.schemaVersion)}`);
      }
      const snapshotPath = join(this.dir, snapshotFileName(manifest.checkpointId));
      if (!existsSync(snapshotPath)) {
        return err('manifest_mismatch', `snapshot missing: ${manifest.checkpointId}`);
      }
      const snapshotRaw = readFileSync(snapshotPath, 'utf8');
      if (sha256Hex(snapshotRaw) !== manifest.stateSha256) {
        return err('manifest_mismatch', 'snapshot sha mismatch');
      }
      let parsed: MemoryState;
      try {
        parsed = JSON.parse(snapshotRaw) as MemoryState;
      } catch (cause) {
        return err('corrupt_log', `snapshot unreadable: ${String(cause)}`);
      }
      if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
        return err('schema_unknown', `state schema ${String(parsed.schemaVersion)}`);
      }
      state = parsed;
      checkpointId = manifest.checkpointId;
      this.lastCheckpointId = manifest.checkpointId;
      offset = manifest.logBytes;
      this.diagnostics.push(`checkpoint:${manifest.checkpointId}@v${manifest.stateVersion}`);
    }

    const logPath = join(this.dir, LOG_FILE);
    if (!existsSync(logPath) && offset > 0) {
      return err('manifest_mismatch', 'checkpoint references a log file that is missing');
    }
    if (existsSync(logPath)) {
      const buffer = readFileSync(logPath);
      const prefix = buffer.subarray(0, Math.min(offset, buffer.length));
      if (Buffer.byteLength(prefix) !== offset) {
        return err('manifest_mismatch', `log shorter than checkpoint offset ${offset}`);
      }
      if (offset > 0) {
        const manifestRaw = readFileSync(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestRaw) as CheckpointManifest;
        if (sha256Hex(prefix.toString('utf8')) !== manifest.logSha256) {
          return err('manifest_mismatch', 'log prefix sha mismatch');
        }
      }
      const tail = buffer.subarray(offset);
      const parsedTail = this.replayTail(state, tail, offset);
      if (!parsedTail.ok) return parsedTail;
      state = parsedTail.value.state;
      this.diagnostics.push(`tail:${parsedTail.value.isolatedTailBytes}b isolated`);
    }

    this.state = state;
    this.eventCount = state.events.length;
    this.appliedPatchCount = Object.keys(state.appliedOps).length;
    this.logBytes = existsSync(logPath) ? statSync(logPath).size : 0;

    return {
      ok: true,
      durable: true,
      value: {
        state: this.state,
        eventCount: this.eventCount,
        appliedPatchCount: this.appliedPatchCount,
        ...(checkpointId === undefined ? {} : { checkpointId }),
        isolatedTailBytes: this.lastIsolatedTailBytes,
        diagnostics: [...this.diagnostics],
      },
    };
  }

  checkpoint(): StoreResult<CheckpointManifest> {
    if (this.closed) return err('io_error', 'store closed');
    const stateRaw = canonicalJson(this.state as unknown);
    // 快照文件名由 checkpointId 推导，清单是唯一切换点：
    // 先落快照再原子切清单，中途崩溃只会留下一个孤儿快照，不会让存储打不开。
    const checkpointId = `cp-${this.state.globalVersion}-${this.state.lastSequence}`;
    const statePath = join(this.dir, snapshotFileName(checkpointId));
    const tmpState = `${statePath}.tmp`;
    try {
      writeFileSync(tmpState, stateRaw, 'utf8');
      const fd = openSync(tmpState, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmpState, statePath);
    } catch (cause) {
      return err('io_error', `snapshot write failed: ${String(cause)}`);
    }
    crashAt('checkpoint.after-snapshot');

    const logPath = join(this.dir, LOG_FILE);
    const logRaw = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    const manifest: CheckpointManifest = {
      schemaVersion: 'memory-checkpoint/v1',
      checkpointId,
      stateVersion: this.state.globalVersion,
      lastSequence: this.state.lastSequence,
      eventCount: this.state.events.length,
      logFile: LOG_FILE,
      logBytes: Buffer.byteLength(logRaw, 'utf8'),
      logSha256: sha256Hex(logRaw),
      stateSha256: sha256Hex(stateRaw),
      createdAt: new Date().toISOString(),
      ...(this.lastCheckpointId === undefined ? {} : { previousCheckpointId: this.lastCheckpointId }),
    };
    const manifestPath = join(this.dir, MANIFEST_FILE);
    const tmpManifest = `${manifestPath}.tmp`;
    try {
      writeFileSync(tmpManifest, canonicalJson(manifest as unknown), 'utf8');
      const fd = openSync(tmpManifest, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmpManifest, manifestPath);
    } catch (cause) {
      return err('io_error', `manifest write failed: ${String(cause)}`);
    }
    crashAt('checkpoint.after-manifest.before-ack');

    this.lastCheckpointId = manifest.checkpointId;
    this.logBytes = manifest.logBytes;
    return { ok: true, durable: true, value: manifest };
  }

  close(): StoreResult<{ readonly closed: true }> {
    if (this.closed) return { ok: true, durable: true, value: { closed: true } };
    this.closed = true;
    releaseLock(join(this.dir, LOCK_FILE));
    return { ok: true, durable: true, value: { closed: true } };
  }

  private writeLine(record: LogRecord): void {
    const { line } = encodeRecord(record);
    const logPath = join(this.dir, LOG_FILE);
    const fd = openSync(logPath, 'a');
    try {
      const bytes = Buffer.from(line, 'utf8');
      writeSync(fd, bytes);
      fsyncSync(fd);
      this.logBytes += bytes.length;
    } finally {
      closeSync(fd);
    }
  }

  /** 只解析日志尾部；半条尾记录隔离，中段损坏直接失败。 */
  private replayTail(
    base: MemoryState,
    tail: Buffer,
    absoluteOffset: number,
  ): StoreResult<{ state: MemoryState; isolatedTailBytes: number }> {
    this.lastIsolatedTailBytes = 0;
    if (tail.length === 0) return { ok: true, durable: true, value: { state: base, isolatedTailBytes: 0 } };
    const text = tail.toString('utf8');
    const endsWithNewline = text.endsWith('\n');
    const rawLines = text.split('\n');
    const lines = rawLines.slice(0, -1);
    const leftover = endsWithNewline ? '' : (rawLines[rawLines.length - 1] ?? '');
    if (!endsWithNewline && leftover.length > 0) {
      this.lastIsolatedTailBytes = Buffer.byteLength(leftover, 'utf8');
    }

    let state = base;
    let consumed = 0;
    for (const line of lines) {
      consumed += Buffer.byteLength(line, 'utf8') + 1;
      if (line.trim() === '') continue;
      const parsed = parseLine(line);
      if (typeof parsed === 'string') {
        return err('corrupt_log', `bad log line: ${parsed}`, absoluteOffset + consumed - line.length - 1);
      }
      if (parsed.type === EVENT_RECORD) {
        const outcome = stepEvent(state, parsed.event);
        if (outcome.disposition !== 'applied') {
          return err(
            'corrupt_log',
            `log event not applicable: ${parsed.event.eventId} (${outcome.disposition} ${outcome.reason ?? ''})`,
            absoluteOffset + consumed,
          );
        }
        state = outcome.state;
        continue;
      }
      const applied = applyPatch(state, parsed.patch);
      if (applied.disposition === 'replayed') continue;
      if (applied.disposition === 'rejected') {
        return err(
          'corrupt_log',
          `log patch rejected: ${parsed.opId} (${applied.verdict.code})`,
          absoluteOffset + consumed,
        );
      }
      state = applied.state;
    }
    return { ok: true, durable: true, value: { state, isolatedTailBytes: this.lastIsolatedTailBytes } };
  }
}

type ParsedLine = LogRecord | string;

/** 解析并校验一行日志的自校验和。返回 string 表示坏行原因。 */
function parseLine(line: string): ParsedLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    return `not json: ${String(cause)}`;
  }
  if (parsed === null || typeof parsed !== 'object') return 'not object';
  const record = parsed as Record<string, unknown>;
  const lineSha = record['lineSha256'];
  if (typeof lineSha !== 'string') return 'missing sha';
  const rest: Record<string, unknown> = { ...record };
  delete rest['lineSha256'];
  if (sha256Hex(canonicalJson(rest)) !== lineSha) return 'sha mismatch';
  if (record['type'] === EVENT_RECORD && record['event'] !== undefined) {
    return { type: EVENT_RECORD, event: record['event'] as MemoryEvent };
  }
  if (record['type'] === PATCH_RECORD && record['patch'] !== undefined && typeof record['opId'] === 'string') {
    return {
      type: PATCH_RECORD,
      opId: record['opId'],
      commitOrder: Number(record['commitOrder'] ?? 0),
      patch: record['patch'] as MemoryPatch,
    };
  }
  return 'unknown record type';
}

function acquireLock(lockPath: string): StoreResult<{ readonly pid: number }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return { ok: true, durable: true, value: { pid: process.pid } };
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return err('io_error', `lock failed: ${String(cause)}`);
      const holder = Number(readFileSync(lockPath, 'utf8').trim());
      if (Number.isInteger(holder) && holder > 0 && processAlive(holder)) {
        return err('writer_busy', `another writer holds the lock: pid ${holder}`);
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // 另一个进程刚好接管，下一轮会拿到 writer_busy。
      }
    }
  }
  return err('writer_busy', 'could not acquire writer lock');
}

function releaseLock(lockPath: string): void {
  try {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch {
    // 释放失败不影响正确性：残留锁会被下一次 open 判为过期。
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 幂等重试判定用：同 eventId 同载荷才算重复。 */
export function isSamePayload(left: MemoryEvent, right: MemoryEvent): boolean {
  return payloadHash(left) === payloadHash(right);
}
