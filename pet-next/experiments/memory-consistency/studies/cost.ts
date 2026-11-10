/**
 * 维护成本研究（D4b）。
 *
 * 结论口径（必须一起报告）：
 * - 主指标是操作量：扫描事件数、检查槽位、重写笔记、读写字节。
 * - 墙钟时间只作参考：本机为共享主机、单核配额、负载波动大，不据此宣布速度提升。
 * - 依赖扇出固定为 1（一个 subject 一条槽位笔记）。高扇出场景本轮没有构造，相关结论 not-run。
 * - 任何一次「局部重建漏掉失效」都会中止性能结论。
 *
 * @module pet-next/experiments/memory-consistency/studies/cost
 */
import { loadavg } from 'node:os';
import { canonicalJson, emptyState, type MemoryEvent, type MemoryState } from '../contracts.ts';
import { applyPatch } from '../ledger/patch.ts';
import { stepEvent } from '../ledger/reduce.ts';
import { activeFactSet, fullRebuild, incrementalRebuild } from '../maintenance/rebuild.ts';
import { acknowledged, generated, presented, statement, taskChanged, toolResult } from '../testing/factory.ts';

/** 线性同余生成器：固定 seed 可复现。 */
function lcg(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

interface StreamOptions {
  readonly events: number;
  readonly subjects: number;
  readonly requests: number;
  readonly seed: number;
}

/** 生成确定性事件流。 */
export function makeStream(options: StreamOptions): MemoryEvent[] {
  const random = lcg(options.seed);
  const out: MemoryEvent[] = [];
  for (let index = 1; index <= options.events; index += 1) {
    const roll = random();
    const subject = `pref:s${Math.floor(roll * options.subjects)}`;
    const request = `req-${Math.floor(random() * options.requests)}`;
    if (roll < 0.45) {
      out.push(statement(index, `e${index}`, `陈述 ${index}`, subject, `值${index}`));
    } else if (roll < 0.65) {
      out.push(taskChanged(index, `e${index}`, `task-${index % 7}`, Math.floor(index / 7) + 1, 'created'));
    } else if (roll < 0.8) {
      out.push(generated(index, `e${index}`, request, `resp-${index}`, `回答 ${index}`));
    } else if (roll < 0.9) {
      out.push(presented(index, `e${index}`, request, `resp-${index}`, 'ui'));
    } else {
      out.push(toolResult(index, `e${index}`, request, index % 2 === 0 ? 'ok' : 'error', 'write_file'));
    }
  }
  return out;
}

function applyEvents(state: MemoryState, events: readonly MemoryEvent[]): MemoryState {
  let next = state;
  for (const event of events) next = stepEvent(next, event).state;
  return next;
}

/** 一轮操作的测量。 */
export interface OpMeasure {
  readonly op: 'full' | 'incremental';
  readonly correction: number;
  readonly elapsedMs: number;
  readonly eventsScanned: number;
  readonly notesExamined: number;
  readonly notesRebuilt: number;
  readonly bytesRead: number;
  readonly bytesWritten: number;
}

/** 机制验证：同一批更正，两条路径必须等价。 */
export interface MechanismReport {
  readonly seeds: number;
  readonly eventsPerSeed: number;
  readonly correctionsPerSeed: number;
  readonly totalEvents: number;
  readonly equivalent: boolean;
  readonly mismatchedSeeds: readonly number[];
}

/** 规模比较。 */
export interface ScaleCell {
  readonly size: number;
  readonly reps: number;
  readonly buildMs: number;
  readonly measures: readonly OpMeasure[];
  readonly peakRssMb: number;
  readonly equivalent: boolean;
}

/** 主报告。 */
export interface CostReport {
  readonly generatedAt: string;
  readonly node: string;
  readonly cpuCount: number;
  readonly loadAverage: readonly number[];
  readonly mechanism: MechanismReport;
  readonly scale: readonly ScaleCell[];
  readonly limits: readonly string[];
  readonly speedClaimAllowed: boolean;
}

function now(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

function rssMb(): number {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
}

/** 在一份状态上做 n 次更正，交替跑全量与局部。 */
function measureCorrections(
  base: MemoryState,
  size: number,
  corrections: number,
  reps: number,
): { measures: OpMeasure[]; equivalent: boolean } {
  const measures: OpMeasure[] = [];
  let equivalent = true;
  let state = base;

  for (let rep = 0; rep < reps; rep += 1) {
    for (let index = 0; index < corrections; index += 1) {
      const subject = `pref:s${index % 5}`;
      const event = statement(
        100_000 + rep * 100 + index,
        `c-${size}-${rep}-${index}`,
        `更正 ${rep}-${index}`,
        subject,
        `新值${rep}-${index}`,
      );
      state = stepEvent(state, event).state;

      const order: readonly ('full' | 'incremental')[] = rep % 2 === 0 ? ['full', 'incremental'] : ['incremental', 'full'];
      const results: Record<string, { state: MemoryState; measure: OpMeasure }> = {};
      for (const op of order) {
        const started = now();
        const built = op === 'full' ? fullRebuild(state, `op-${op}-${size}-${rep}-${index}`) : incrementalRebuild(state, { subjectKeys: [subject], requestKeys: [], eventIds: [event.eventId] }, `op-${op}-${size}-${rep}-${index}`);
        const applied = applyPatch(state, built.patch);
        const elapsed = now() - started;
        results[op] = {
          state: applied.state,
          measure: {
            op,
            correction: index,
            elapsedMs: Math.round(elapsed * 100) / 100,
            eventsScanned: built.stats.eventsScanned,
            notesExamined: built.stats.notesExamined,
            notesRebuilt: built.stats.notesRebuilt,
            bytesRead: built.stats.bytesRead,
            bytesWritten: built.stats.bytesWritten,
          },
        };
        measures.push(results[op]?.measure as OpMeasure);
      }

      const full = results['full'];
      const incremental = results['incremental'];
      if (full !== undefined && incremental !== undefined) {
        if (canonicalJson(activeFactSet(full.state)) !== canonicalJson(activeFactSet(incremental.state))) {
          equivalent = false;
        }
        state = full.state;
      }
    }
  }
  return { measures, equivalent };
}

/** 机制验证：16 seed × 500 事件。 */
export function mechanismCheck(seeds = 16, eventsPerSeed = 500, corrections = 5): MechanismReport {
  const mismatched: number[] = [];
  for (let seed = 1; seed <= seeds; seed += 1) {
    const events = makeStream({ events: eventsPerSeed, subjects: 20, requests: 12, seed });
    const reduced = applyEvents(emptyState(), events);
    const baseline = applyPatch(reduced, fullRebuild(reduced, `op-base-${seed}`).patch);
    const result = measureCorrections(baseline.state, eventsPerSeed, corrections, 1);
    if (!result.equivalent) mismatched.push(seed);
  }
  return {
    seeds,
    eventsPerSeed,
    correctionsPerSeed: corrections,
    totalEvents: seeds * eventsPerSeed,
    equivalent: mismatched.length === 0,
    mismatchedSeeds: mismatched,
  };
}

/** 规模比较：100 / 1000 / 10000 事件，各 10 次更正 × 3 次交替。 */
export function scaleCheck(sizes: readonly number[] = [100, 1000, 10_000], corrections = 10, reps = 3): ScaleCell[] {
  const cells: ScaleCell[] = [];
  for (const size of sizes) {
    const events = makeStream({ events: size, subjects: Math.max(5, Math.round(size / 50)), requests: Math.max(4, Math.round(size / 100)), seed: 7 + size });
    const reduced = applyEvents(emptyState(), events);
    const buildStarted = now();
    const baseline = applyPatch(reduced, fullRebuild(reduced, `op-base-${size}`).patch);
    const buildMs = Math.round((now() - buildStarted) * 100) / 100;
    const before = rssMb();
    const result = measureCorrections(baseline.state, size, corrections, reps);
    const after = rssMb();
    cells.push({
      size,
      reps,
      buildMs,
      measures: result.measures,
      peakRssMb: Math.max(before, after),
      equivalent: result.equivalent,
    });
  }
  return cells;
}

/** 汇总：只在等价成立时才允许讨论效率方向。 */
export function runCostStudy(): CostReport {
  const mechanism = mechanismCheck();
  const scale = scaleCheck();
  const equivalent = mechanism.equivalent && scale.every((cell) => cell.equivalent);
  const loads = loadavg();
  return {
    generatedAt: new Date().toISOString(),
    node: process.version,
    cpuCount: 1,
    loadAverage: loads.map((value: number) => Math.round(value * 100) / 100),
    mechanism,
    scale,
    limits: [
      '依赖扇出固定为 1（每 subject 一条槽位笔记）；高扇出未构造，相关结论 not-run。',
      '墙钟时间来自共享主机上的单核配额进程，负载波动大，不据此宣布速度提升。',
      '8000 事件是机制样本，不是 8000 个独立模型样本。',
    ],
    speedClaimAllowed: equivalent,
  };
}

/** 把测量聚合成中位数，避免个别抖动主导。 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}
