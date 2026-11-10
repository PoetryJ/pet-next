/**
 * 恢复实验用的子进程。只做三件事：
 * 1) 按计划执行 append / commitPatch / checkpoint；
 * 2) 每次成功立刻把 ACK 同步写进 acks.ndjson（父进程据此判断「已确认」）；
 * 3) 在指定故障点让进程直接退出，模拟崩溃。
 *
 * 不使用 console 输出 ACK：管道缓冲会在进程退出时丢数据，导致把「已确认」误判成「未确认」。
 *
 * @module pet-next/experiments/memory-consistency/recovery/worker
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATCH_SCHEMA_VERSION, type MemoryEvent, type MemoryPatch, type NoteDraft } from '../contracts.ts';
import { recomputeDependencies } from '../ledger/patch.ts';
import { JsonlStore } from '../storage/store.ts';

interface AppendOp {
  readonly op: 'append';
  readonly event: MemoryEvent;
  readonly crashAt?: string;
}

interface PatchOp {
  readonly op: 'patch';
  readonly opId: string;
  readonly notes: readonly NoteDraft[];
  readonly crashAt?: string;
}

interface CheckpointOp {
  readonly op: 'checkpoint';
  readonly crashAt?: string;
}

type Plan = readonly (AppendOp | PatchOp | CheckpointOp)[];

const dir = process.env['MEMORY_STORE_DIR'];
const planRaw = process.env['WORKER_PLAN'];
if (dir === undefined || planRaw === undefined) {
  process.stderr.write('MEMORY_STORE_DIR and WORKER_PLAN are required\n');
  process.exit(2);
}
const plan = JSON.parse(planRaw) as Plan;
const ackPath = join(dir, 'acks.ndjson');

function ack(record: Record<string, unknown>): void {
  appendFileSync(ackPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function buildPatch(store: JsonlStore, opId: string, notes: readonly NoteDraft[]): MemoryPatch {
  const state = store.getState();
  const dependencyVersions: Record<string, number> = {};
  for (const draft of notes) {
    for (const [depId, version] of Object.entries(recomputeDependencies(state, draft).dependencies)) {
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

const opened = JsonlStore.open(dir);
if (!opened.ok) {
  process.stderr.write(`open failed: ${opened.code}: ${opened.detail}\n`);
  process.exit(3);
}
const store = opened.value;

for (const item of plan) {
  if (item.crashAt !== undefined) {
    process.env['MEMORY_STORE_CRASH_AT'] = item.crashAt;
  } else {
    delete process.env['MEMORY_STORE_CRASH_AT'];
  }
  if (item.op === 'append') {
    const result = store.append(item.event);
    if (!result.ok) {
      process.stderr.write(`append failed: ${result.code}: ${result.detail}\n`);
      process.exit(4);
    }
    ack({ kind: 'append', eventId: item.event.eventId, disposition: result.value.disposition });
    continue;
  }
  if (item.op === 'patch') {
    const patch = buildPatch(store, item.opId, item.notes);
    const result = store.commitPatch(patch);
    if (!result.ok) {
      process.stderr.write(`patch failed: ${result.code}: ${result.detail}\n`);
      process.exit(5);
    }
    ack({ kind: 'patch', opId: item.opId, disposition: result.value.disposition });
    continue;
  }
  const result = store.checkpoint();
  if (!result.ok) {
    process.stderr.write(`checkpoint failed: ${result.code}: ${result.detail}\n`);
    process.exit(6);
  }
  ack({ kind: 'checkpoint', checkpointId: result.value.checkpointId });
}

store.close();
process.exit(0);
