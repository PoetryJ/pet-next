/**
 * 独立等价脚手架：参考模型 + 候选驱动 + 判定匹配器。
 *
 * 参考模型**就是产品现有代码** `adapters/window/controller.ts`（逐事件 advanceOrigin + 每次直写），
 * 不另写一份夹边/取整逻辑，避免"用我的实现证明我的实现"。
 * 候选只经公开 API（moveBy/endDrag/noteGeometryChanged/dispose/stats）驱动，不 import 其内部私有函数。
 * @module pet-next/tests/drag-write-budget/support/harness
 */
import assert from 'node:assert/strict';

import { createWindowController } from '../../../adapters/window/controller.ts';
import type { WindowHost, WorkArea, WindowBounds } from '../../../adapters/window/types.ts';
import type { BudgetedFactory, BudgetedWindowController, DragPosition, WriteBudgetStats } from './contract.ts';
import { expectShape } from './contract.ts';
import type { FakeClock } from './fake-clock.ts';

export interface World {
  readonly size: { readonly width: number; readonly height: number };
  readonly start: DragPosition;
  readonly workArea: WorkArea;
  /** `geometry` 动作后切换的工作区；缺省保持不变。 */
  readonly workAreaAfterGeometry?: WorkArea;
}

export type ScriptEntry =
  | { readonly type: 'move'; readonly dx: number; readonly dy: number; readonly gapMs?: number }
  | { readonly type: 'end' }
  | { readonly type: 'geometry' }
  | { readonly type: 'dispose' };

export interface WriteRecord {
  readonly x: number;
  readonly y: number;
  /** 写入发生时注入时钟的读数；参考模型没有时钟，记为 null。 */
  readonly at: number | null;
}

export interface HostCall {
  readonly op: 'getBounds' | 'setPosition' | 'workAreaFor' | 'quit';
}

export interface RunOutcome {
  readonly writes: readonly WriteRecord[];
  readonly positions: readonly DragPosition[];
  readonly final: DragPosition;
  readonly calls: readonly HostCall[];
  readonly stats: WriteBudgetStats | null;
  /** 运行结束后仍挂着的定时器条数（参考模型恒为 0）。 */
  readonly timersLeft: number;
}

export interface RecordingHost extends WindowHost {
  readonly writes: readonly WriteRecord[];
  readonly calls: readonly HostCall[];
  bounds(): WindowBounds;
  setWorkArea(area: WorkArea): void;
}

export function createRecordingHost(input: {
  readonly world: World;
  readonly clock?: () => number;
}): RecordingHost {
  let bounds: WindowBounds = {
    x: input.world.start.x,
    y: input.world.start.y,
    width: input.world.size.width,
    height: input.world.size.height,
  };
  let workArea = input.world.workArea;
  const writes: WriteRecord[] = [];
  const calls: HostCall[] = [];
  return {
    getBounds(): WindowBounds {
      calls.push({ op: 'getBounds' });
      return { ...bounds };
    },
    setPosition(x: number, y: number): void {
      calls.push({ op: 'setPosition' });
      writes.push({ x, y, at: input.clock === undefined ? null : input.clock() });
      bounds = { ...bounds, x, y };
    },
    workAreaFor(): WorkArea {
      calls.push({ op: 'workAreaFor' });
      return { ...workArea };
    },
    quit(): void {
      calls.push({ op: 'quit' });
    },
    get writes() {
      return writes;
    },
    get calls() {
      return calls;
    },
    bounds: () => ({ ...bounds }),
    setWorkArea(area: WorkArea) {
      workArea = area;
    },
  };
}

const positionsOf = (writes: readonly WriteRecord[]): DragPosition[] => writes.map(({ x, y }) => ({ x, y }));

/**
 * 参考模型：产品现有控制器，每个事件都直写宿主。
 * 只吃 `move` 动作；`geometry` 会同步换工作区（产品靠 getBounds/workAreaFor 每事件重算）。
 */
export function runReference(world: World, script: readonly ScriptEntry[]): RunOutcome {
  const host = createRecordingHost({ world });
  const controller = createWindowController(host);
  for (const entry of script) {
    if (entry.type === 'move') controller.moveBy(entry.dx, entry.dy);
    else if (entry.type === 'geometry' && world.workAreaAfterGeometry !== undefined) {
      host.setWorkArea(world.workAreaAfterGeometry);
    }
  }
  const bounds = host.bounds();
  return {
    writes: [...host.writes],
    positions: positionsOf(host.writes),
    final: { x: bounds.x, y: bounds.y },
    calls: [...host.calls],
    stats: null,
    timersLeft: 0,
  };
}

export interface CandidateRun {
  readonly outcome: RunOutcome;
  readonly controller: BudgetedWindowController;
  readonly host: RecordingHost;
  readonly clock: FakeClock;
}

/** 候选驱动：只用公开 API；时间推进由假时钟负责（永不真实 sleep）。 */
export function runCandidate(input: {
  readonly world: World;
  readonly script: readonly ScriptEntry[];
  readonly factory: BudgetedFactory;
  readonly clock: FakeClock;
  readonly budgetMs?: number;
}): CandidateRun {
  const host = createRecordingHost({ world: input.world, clock: () => input.clock.now() });
  const options = input.budgetMs === undefined
    ? { clock: input.clock }
    : { clock: input.clock, budgetMs: input.budgetMs };
  const controller = expectShape(input.factory(host, options));
  for (const entry of input.script) {
    switch (entry.type) {
      case 'move':
        controller.moveBy(entry.dx, entry.dy);
        if (entry.gapMs !== undefined && entry.gapMs > 0) input.clock.advance(entry.gapMs);
        break;
      case 'end':
        controller.endDrag();
        break;
      case 'geometry':
        if (input.world.workAreaAfterGeometry !== undefined) host.setWorkArea(input.world.workAreaAfterGeometry);
        controller.noteGeometryChanged();
        break;
      case 'dispose':
        controller.dispose();
        break;
      default: {
        const unreachable: never = entry;
        throw new Error(`未知动作 ${JSON.stringify(unreachable)}`);
      }
    }
  }
  const bounds = host.bounds();
  return {
    outcome: {
      writes: [...host.writes],
      positions: positionsOf(host.writes),
      final: { x: bounds.x, y: bounds.y },
      calls: [...host.calls],
      stats: controller.stats,
      timersLeft: input.clock.pending().length,
    },
    controller,
    host,
    clock: input.clock,
  };
}

/** 逐条相等：稀疏输入（间隔 ≥ budgetMs）下候选必须与参考模型 1:1。 */
export function assertSameWrites(actual: readonly DragPosition[], expected: readonly DragPosition[], note: string): void {
  assert.equal(
    actual.length,
    expected.length,
    `${note}：写入条数 actual=${actual.length} expected=${expected.length}\nactual=${JSON.stringify(actual)}\nexpected=${JSON.stringify(expected)}`,
  );
  actual.forEach((write, index) => {
    assert.deepEqual(write, expected[index], `${note}：第 ${index} 条写入不一致`);
  });
}

/**
 * 子序列 + 末态：密集输入下允许丢弃中间写入，但
 * ① 每条写出的位置必须真的在某一步被逐事件算出来过（不得凭空插值/合并 dx）；
 * ② 顺序不得倒置（不能回退到更早的坐标）；
 * ③ 收尾 flush 后末写等于参考末态。
 */
export function assertWritesAreSubsequence(
  actual: readonly DragPosition[],
  expected: readonly DragPosition[],
  note: string,
  options: { readonly requireFinal?: boolean } = {},
): void {
  let cursor = -1;
  for (const [index, write] of actual.entries()) {
    let found = -1;
    for (let probe = cursor + 1; probe < expected.length; probe += 1) {
      const candidate = expected[probe];
      if (candidate !== undefined && candidate.x === write.x && candidate.y === write.y) {
        found = probe;
        break;
      }
    }
    assert.ok(
      found >= 0,
      `${note}：第 ${index} 条写入 ${JSON.stringify(write)} 不是任何一步的逐事件结果（参考序列索引 ${cursor} 之后）\nactual=${JSON.stringify(actual)}\nexpected=${JSON.stringify(expected)}`,
    );
    cursor = found;
  }
  if (options.requireFinal === true && expected.length > 0) {
    assert.deepEqual(
      actual.at(-1),
      expected.at(-1),
      `${note}：收尾后末次写入必须等于参考末态（不能丢位移）\nactual=${JSON.stringify(actual)}`,
    );
  }
}

/** 终态位置必须完全一致（DIP）。 */
export function assertSameFinal(actual: RunOutcome, expected: RunOutcome, note: string): void {
  assert.deepEqual(actual.final, expected.final, `${note}：终态位置不一致 actual=${JSON.stringify(actual.final)} expected=${JSON.stringify(expected.final)}`);
}

/** 逻辑状态照算：每个 moveBy 仍要读一次宿主几何。 */
export function assertReadsPerMove(outcome: RunOutcome, moves: number, note: string): void {
  const reads = outcome.calls.filter((call) => call.op === 'getBounds').length;
  assert.equal(reads, moves, `${note}：每个事件都必须回读 getBounds（actual=${reads} events=${moves}）`);
}

export function countOp(outcome: RunOutcome, op: HostCall['op']): number {
  return outcome.calls.filter((call) => call.op === op).length;
}

/**
 * 统计口径：`written` 与真实写宿主次数的关系只做**安全区间**断言。
 * 契约冻结了 submitted/written/coalesced/duplicateDropped/flushes 五个计数器的存在，
 * 但没有把"flush 写入是否也计入 written"写死，因此这里不断言等式，只断言：
 * 非 flush 写入数不超过宿主写入数，差额由 flushes 解释。
 */
export function assertStatsConsistent(stats: WriteBudgetStats, hostWrites: number, note: string): void {
  for (const key of ['submitted', 'written', 'coalesced', 'duplicateDropped', 'flushes'] as const) {
    assert.equal(typeof stats[key], 'number', `${note}：stats.${key} 必须是数字`);
    assert.ok(Number.isFinite(stats[key]) && stats[key] >= 0, `${note}：stats.${key} 必须是非负有限数，实际 ${String(stats[key])}`);
  }
  assert.ok(stats.written <= hostWrites, `${note}：stats.written=${stats.written} 不得大于宿主写入 ${hostWrites}`);
  assert.ok(
    hostWrites - stats.written <= stats.flushes,
    `${note}：宿主写入 ${hostWrites} 与 stats.written=${stats.written} 的差额必须由 flushes=${stats.flushes} 解释`,
  );
  assert.ok(stats.coalesced + stats.written <= stats.submitted + stats.flushes, `${note}：submitted 与 written+coalesced 不自洽`);
}

/** 固定 seed 的确定性伪随机（不读 Math.random，保证复跑同一条输入序列）。 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从给定步长集合里取位移：含 0、0.125、0.5 这类小数与 ±单位。 */
export function seededScript(input: {
  readonly seed: number;
  readonly count: number;
  readonly gapMs: number;
  readonly units?: readonly number[];
  readonly trailing?: readonly ScriptEntry[];
}): ScriptEntry[] {
  const units = input.units ?? [0, 0.125, 0.5, 1, 3, -0.125, -0.5, -1, -3];
  const random = seededRandom(input.seed);
  const script: ScriptEntry[] = [];
  for (let index = 0; index < input.count; index += 1) {
    const pickX = units[Math.floor(random() * units.length)] ?? 0;
    const pickY = units[Math.floor(random() * units.length)] ?? 0;
    script.push({ type: 'move', dx: pickX, dy: pickY, gapMs: input.gapMs });
  }
  for (const entry of input.trailing ?? []) script.push(entry);
  return script;
}
