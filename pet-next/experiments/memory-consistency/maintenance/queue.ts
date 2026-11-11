/**
 * 有界后台整理队列。
 *
 * 规则（刻意保持简单，不做学习型优先级）：
 * - FIFO + 同 subject 去重：同一 subject 只保留最新一次请求。
 * - 每轮最多处理固定条数，并且**提交补丁的 UTF-8 序列化字节**不得超过 cap。
 *   这两条都是硬边界：首项就超限时留待办并报 oversize，不能「先做了再说」。
 * - 被拒绝的补丁不算 processed，条目退回队首，等下一轮重来。
 * - 即时事实（取消/更正）由 reducer 同步处理，不排在这个队列后面。
 *
 * @module pet-next/experiments/memory-consistency/maintenance/queue
 */
import type { MemoryPatch, MemoryState } from '../contracts.ts';
import { applyPatch } from '../ledger/patch.ts';
import { incrementalRebuild } from './rebuild.ts';

/** 队列项：以 subject 为单位，不存事件副本，避免把旧视图当权威。 */
export interface QueueItem {
  readonly subjectKey: string;
  readonly enqueuedAtVersion: number;
  readonly attempts: number;
}

/** 队列配置。maxBytesPerRound 计的是提交补丁的 UTF-8 字节。 */
export interface QueueConfig {
  readonly maxNotesPerRound: number;
  readonly maxBytesPerRound: number;
}

/** 一轮的结果。 */
export interface QueueRoundResult {
  readonly state: MemoryState;
  readonly patch: MemoryPatch | undefined;
  readonly processed: readonly string[];
  readonly deferred: readonly string[];
  readonly deduped: readonly string[];
  readonly revalidated: readonly string[];
  readonly diagnostics: readonly string[];
  readonly backlog: number;
  /** 本轮实际提交的补丁字节。必须 <= cap。 */
  readonly submittedBytes: number;
}

/** 队列本体。只保存待办 subject，不保存任何状态快照。 */
export class MaintenanceQueue {
  private items: QueueItem[] = [];
  private readonly config: QueueConfig;

  constructor(config: QueueConfig) {
    this.config = config;
  }

  /** 入队。同 subject 已在队列里就只更新版本并记一次去重。 */
  enqueue(subjectKey: string, currentVersion: number): { deduped: boolean; size: number } {
    const existing = this.items.findIndex((item) => item.subjectKey === subjectKey);
    if (existing >= 0) {
      this.items[existing] = { subjectKey, enqueuedAtVersion: currentVersion, attempts: 0 };
      return { deduped: true, size: this.items.length };
    }
    this.items.push({ subjectKey, enqueuedAtVersion: currentVersion, attempts: 0 });
    return { deduped: false, size: this.items.length };
  }

  /** 当前积压。 */
  backlog(): number {
    return this.items.length;
  }

  /** 用给定条目构造补丁（不提交）。 */
  private build(state: MemoryState, items: readonly QueueItem[], opId: string): MemoryPatch | undefined {
    if (items.length === 0) return undefined;
    const built = incrementalRebuild(
      state,
      { subjectKeys: items.map((item) => item.subjectKey), requestKeys: [], eventIds: [] },
      opId,
    );
    return built.patch;
  }

  private patchBytes(patch: MemoryPatch | undefined): number {
    return patch === undefined ? 0 : Buffer.byteLength(JSON.stringify(patch), 'utf8');
  }

  /**
   * 跑一轮：按 FIFO 最多取 maxNotesPerRound 项，提交补丁字节不超过 maxBytesPerRound。
   * 超限项按原顺序退回队首，不插队、不丢弃。
   */
  drain(state: MemoryState, opIdPrefix: string): QueueRoundResult {
    if (this.items.length === 0) {
      return {
        state,
        patch: undefined,
        processed: [],
        deferred: [],
        deduped: [],
        revalidated: [],
        diagnostics: ['queue_empty'],
        backlog: 0,
        submittedBytes: 0,
      };
    }

    const batch = this.items.slice(0, Math.min(this.config.maxNotesPerRound, this.items.length));
    const rest = this.items.slice(batch.length);
    const accepted: QueueItem[] = [];
    const restore: QueueItem[] = [];
    const deferred: string[] = [];
    const revalidated: string[] = [];
    const diagnostics: string[] = [];

    for (const item of batch) {
      // 用最终 opId 试算，保证「量到的字节」就是「要提交的字节」。
      const trial = this.build(state, [...accepted, item], opIdPrefix);
      const trialBytes = this.patchBytes(trial);
      if (trialBytes > this.config.maxBytesPerRound) {
        restore.push(item);
        if (accepted.length === 0) {
          diagnostics.push(`oversize:${item.subjectKey}:${trialBytes}>${this.config.maxBytesPerRound}`);
        } else {
          deferred.push(item.subjectKey);
          diagnostics.push(`byte_budget_exhausted:${item.subjectKey}:${trialBytes}>${this.config.maxBytesPerRound}`);
        }
        continue;
      }
      const currentVersion = state.subjectVersions[item.subjectKey] ?? 0;
      if (currentVersion !== item.enqueuedAtVersion) {
        // 入队后 subject 又变了：按当前状态重算，而不是拿旧视图写回。
        revalidated.push(item.subjectKey);
      }
      accepted.push({ ...item, attempts: item.attempts + 1 });
    }

    if (revalidated.length > 0) diagnostics.push(`revalidated_on_stale:${revalidated.join(',')}`);

    const patch = this.build(state, accepted, opIdPrefix);
    const submittedBytes = this.patchBytes(patch);
    if (submittedBytes > this.config.maxBytesPerRound) {
      // 理论上不可达（逐项试算已挡住），保留兜底：绝不超 cap 提交。
      this.items = [...batch, ...rest];
      return {
        state,
        patch: undefined,
        processed: [],
        deferred: batch.map((item) => item.subjectKey),
        deduped: [],
        revalidated: [],
        diagnostics: [...diagnostics, `oversize_batch:${submittedBytes}>${this.config.maxBytesPerRound}`],
        backlog: this.items.length,
        submittedBytes: 0,
      };
    }

    let nextState = state;
    let processed: string[] = [];
    if (patch !== undefined && (patch.notesToUpsert.length > 0 || patch.notesToInvalidate.length > 0)) {
      const applied = applyPatch(state, patch);
      if (applied.disposition === 'applied') {
        nextState = applied.state;
        processed = accepted.map((item) => item.subjectKey);
      } else if (applied.disposition === 'replayed') {
        nextState = applied.state;
        processed = accepted.map((item) => item.subjectKey);
      } else {
        // 被拒的补丁不算 processed：条目退回队首，等下一轮。
        diagnostics.push(`patch_rejected:${applied.verdict.code}`);
        restore.unshift(...accepted);
      }
    } else {
      // 没有可提交内容（例如槽位已不需要）：条目视为已处理，不重复堆积。
      processed = accepted.map((item) => item.subjectKey);
    }

    this.items = [...restore, ...rest];
    if (this.items.length > 0) diagnostics.push(`backlog:${this.items.length}`);

    return {
      state: nextState,
      patch,
      processed,
      deferred: this.items.map((item) => item.subjectKey),
      deduped: [],
      revalidated,
      diagnostics,
      backlog: this.items.length,
      submittedBytes: processed.length === 0 ? 0 : submittedBytes,
    };
  }

  /** 被推迟项的诊断：仍待办，不能当最新。 */
  pendingSubjects(): readonly string[] {
    return this.items.map((item) => item.subjectKey);
  }
}
