/**
 * 有界后台整理队列。
 *
 * 规则（刻意保持简单，不做学习型优先级）：
 * - FIFO + 同 subject 去重：同一 subject 只保留最新一次请求。
 * - 每轮最多处理固定条数与固定读取字节；没轮到的留在队里并标 stale，不能标成最新。
 * - 即时事实（取消/更正）由 reducer 同步处理，不排在这个队列后面。
 * - 每轮出队时按当前权威状态重新验证；过时信息不会被当成最新写回。
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

/** 队列配置。 */
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
}

/** 队列本体。只保存待办 subject，不保存任何状态快照。 */
export class MaintenanceQueue {
  private readonly items: QueueItem[] = [];
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

  /**
   * 跑一轮：按 FIFO 最多取 maxNotesPerRound 项、最多读 maxBytesPerRound 字节。
   * 被推迟的项保持原顺序，不插队。
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
      };
    }

    const batch = this.items.splice(0, Math.min(this.config.maxNotesPerRound, this.items.length));
    const accepted: QueueItem[] = [];
    let bytes = 0;
    const deferred: string[] = [];
    const revalidated: string[] = [];
    const diagnostics: string[] = [];

    for (const item of batch) {
      const cost = Buffer.byteLength(item.subjectKey, 'utf8') + 64;
      if (accepted.length > 0 && bytes + cost > this.config.maxBytesPerRound) {
        this.items.push(item);
        deferred.push(item.subjectKey);
        continue;
      }
      bytes += cost;
      const currentVersion = state.subjectVersions[item.subjectKey] ?? 0;
      if (currentVersion !== item.enqueuedAtVersion) {
        // 入队后 subject 又变了：按当前状态重算，而不是拿旧视图写回。
        revalidated.push(item.subjectKey);
      }
      accepted.push({ ...item, attempts: item.attempts + 1 });
    }

    if (deferred.length > 0) diagnostics.push(`byte_budget_exhausted:${deferred.length}`);
    if (revalidated.length > 0) diagnostics.push(`revalidated_on_stale:${revalidated.join(',')}`);
    if (this.items.length > 0) diagnostics.push(`backlog:${this.items.length}`);

    let nextState = state;
    let patch: MemoryPatch | undefined;
    if (accepted.length > 0) {
      const built = incrementalRebuild(
        state,
        { subjectKeys: accepted.map((item) => item.subjectKey), requestKeys: [], eventIds: [] },
        `${opIdPrefix}-${accepted.map((item) => item.subjectKey).join('+').slice(0, 48)}`,
      );
      patch = built.patch;
      if (built.patch.notesToUpsert.length > 0 || built.patch.notesToInvalidate.length > 0) {
        const applied = applyPatch(state, built.patch);
        if (applied.disposition === 'applied') {
          nextState = applied.state;
        } else {
          diagnostics.push(`patch_rejected:${applied.verdict.code}`);
        }
      }
    }

    return {
      state: nextState,
      patch,
      processed: accepted.map((item) => item.subjectKey),
      deferred: [...deferred, ...this.items.map((item) => item.subjectKey)],
      deduped: [],
      revalidated,
      diagnostics,
      backlog: this.items.length,
    };
  }

  /** 被推迟项的诊断：仍待办，不能当最新。 */
  pendingSubjects(): readonly string[] {
    return this.items.map((item) => item.subjectKey);
  }
}
