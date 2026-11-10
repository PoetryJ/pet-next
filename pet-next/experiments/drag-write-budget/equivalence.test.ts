/**
 * 等价性：候选只在"何时写"上不同，"写成什么"必须与逐事件直写完全一致。
 *
 * 参考实现直接用真实的 `adapters/window/track.ts#advanceOrigin`（含 clamp 与小数累积），
 * 不复制夹边逻辑；两次夹边的反例必须入测，否则"先求和再夹边"的错误实现会悄悄通过。
 * 时钟仍是注入的假时钟，不依赖真实计时器。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clampPosition } from '../../adapters/window/clamp.ts';
import { advanceOrigin, type TrackedOrigin } from '../../adapters/window/track.ts';
import type { WorkArea } from '../../adapters/window/types.ts';
import { FakeClock } from './fake-clock.ts';
import { createWriteBudget, type DragPosition, type WriteBudget, type WriteBudgetStats } from './scheduler.ts';

interface Size {
  readonly width: number;
  readonly height: number;
}

/** 一条指针输入：位移（DIP，可为小数）与到上一条的时间间隔（ms）。 */
interface DragEvent {
  readonly dx: number;
  readonly dy: number;
  readonly dtMs: number;
}

/** 单条输入算出的逻辑状态：`tracked` 是夹边后的 DIP（保留小数），`position` 交给系统写入。 */
interface Trace {
  readonly tracked: DragPosition;
  readonly position: DragPosition;
}

interface DirectRun {
  readonly trace: readonly Trace[];
  readonly writes: readonly DragPosition[];
}

interface BudgetedRun {
  readonly trace: readonly Trace[];
  readonly writes: readonly DragPosition[];
  readonly stats: WriteBudgetStats;
  readonly armedTimers: number;
  readonly clockMs: number;
}

/** 原路径：每条输入都 advanceOrigin，然后立刻 setPosition（宿主回读就是上一条 position）。 */
function runDirect(events: readonly DragEvent[], workArea: WorkArea, size: Size, start: DragPosition): DirectRun {
  let tracked: TrackedOrigin | null = null;
  let host = { x: start.x, y: start.y };
  const trace: Trace[] = [];
  const writes: DragPosition[] = [];

  for (const event of events) {
    const step = advanceOrigin(tracked, host, event.dx, event.dy, size, workArea);
    tracked = step.tracked;
    trace.push({ tracked: { x: step.tracked.x, y: step.tracked.y }, position: { x: step.position.x, y: step.position.y } });
    host = { x: step.position.x, y: step.position.y };
    writes.push({ x: step.position.x, y: step.position.y });
  }
  return { trace, writes };
}

/**
 * 候选路径：同一条 advanceOrigin，只把 `setPosition` 换成 `budget.submit`。
 * 宿主回读落后到最近一次真实写入（等价于被合并掉的提交从未生效），
 * 因此逐事件的 `tracked`/`position` 若与直写不同，就说明调度器污染了计算。
 */
function runBudgeted(
  events: readonly DragEvent[],
  workArea: WorkArea,
  size: Size,
  start: DragPosition,
  options: { budgetMs?: number } = {},
): BudgetedRun {
  const clock = new FakeClock();
  const writes: DragPosition[] = [];
  const trace: Trace[] = [];
  let tracked: TrackedOrigin | null = null;
  let host = { x: start.x, y: start.y };

  const budget: WriteBudget = createWriteBudget({
    budgetMs: options.budgetMs,
    now: () => clock.now(),
    schedule: (delayMs, run) => clock.schedule(delayMs, run),
    cancel: (handle) => clock.cancel(handle),
    write: (position) => {
      const written = { x: position.x, y: position.y };
      writes.push(written);
      host = written;
    },
  });

  budget.begin();
  for (const event of events) {
    clock.advance(event.dtMs);
    const step = advanceOrigin(tracked, host, event.dx, event.dy, size, workArea);
    tracked = step.tracked;
    trace.push({ tracked: { x: step.tracked.x, y: step.tracked.y }, position: { x: step.position.x, y: step.position.y } });
    budget.submit(step.position);
  }
  budget.end();

  return { trace, writes, stats: budget.stats, armedTimers: clock.armedCount(), clockMs: clock.now() };
}

/** 候选写出的坐标必须是原序列的保序子序列（可以跳过，不能改写、不能换序）。 */
function assertSubsequence(candidate: readonly DragPosition[], baseline: readonly DragPosition[]): void {
  let cursor = 0;
  for (const position of candidate) {
    let matched = -1;
    for (let index = cursor; index < baseline.length; index += 1) {
      const base = baseline[index];
      if (base !== undefined && base.x === position.x && base.y === position.y) {
        matched = index;
        break;
      }
    }
    assert.notEqual(matched, -1, `候选写出的 ${JSON.stringify(position)} 不是原序列的保序子序列`);
    cursor = matched + 1;
  }
}

function lastOf<T>(items: readonly T[]): T {
  const item = items.at(-1);
  assert.ok(item !== undefined, '序列为空，取不到最后一条');
  return item;
}

function sumOf(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** 固定 seed 的确定性伪随机，避免依赖 Math.random。 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function buildSequence(seed: number): DragEvent[] {
  const random = createRandom(seed);
  const events: DragEvent[] = [];
  const push = (dx: number, dy: number, dtMs: number): void => {
    events.push({ dx, dy, dtMs });
  };

  // 1) 高频细步，含 0.25/0.5 小数与 <8ms 间隔
  for (let index = 0; index < 120; index += 1) push(0.25 + random() * 1.5, 0.5 + random(), 0.5 + random() * 2);
  // 2) 长距离连续拖动（大步、2~4.5ms）
  for (let index = 0; index < 60; index += 1) push(4 + random() * 9, 3 + random() * 7, 2 + random() * 2.5);
  // 3) 右下两边触碰往返
  for (const direction of [1, -1, 1, -1]) push(direction * 60, direction * 40, 3);
  // 4) 左上两边触碰往返
  for (const direction of [-1, 1, -1, 1]) push(direction * 80, direction * 50, 3);
  // 5) 零位移连发（同坐标重复）
  for (let index = 0; index < 6; index += 1) push(0, 0, 1.5);
  // 6) 指针抖回：±0.25 / ±0.5 交替
  for (let index = 0; index < 40; index += 1) {
    push(index % 2 === 0 ? 0.25 : -0.25, index % 3 === 0 ? 0.5 : -0.5, 1);
  }
  // 7) 稀疏帧（16ms）普通拖动，不该被无故延后
  for (let index = 0; index < 10; index += 1) push(1.5, -1.25, 16);

  return events;
}

const TRACK_SIZE: Size = { width: 120, height: 90 };
const TRACK_AREA: WorkArea = { x: 0, y: 0, width: 800, height: 600 };
const TRACK_START: DragPosition = { x: 350, y: 280 };

describe('拖动写入预算 vs 逐事件直写', () => {
  test('反例 1：x∈[0,10]、初始 9、+5,-5 逐事件得 5；先求和再夹边得 9 是错的', () => {
    const workArea: WorkArea = { x: 0, y: 0, width: 110, height: 110 }; // 窗口 100 宽 → 可移动范围 0..10
    const size: Size = { width: 100, height: 100 };
    const events: readonly DragEvent[] = [
      { dx: 5, dy: 0, dtMs: 0 },
      { dx: -5, dy: 0, dtMs: 1 },
    ];

    const direct = runDirect(events, workArea, size, { x: 9, y: 0 });
    assert.deepEqual(
      direct.writes.map((position) => position.x),
      [10, 5],
    );
    assert.equal(lastOf(direct.writes).x, 5);

    // 错误实现：先把增量求和（0）再加到起点（9）再夹边 → 9。
    const summed = clampPosition({ x: 9 + 5 - 5, y: 0 }, size, workArea);
    assert.equal(summed.x, 9);
    assert.notEqual(summed.x, 5);

    // 候选不会退化成求和：它接的是逐事件夹边后的绝对坐标。
    const budgeted = runBudgeted(events, workArea, size, { x: 9, y: 0 });
    assert.deepEqual(
      budgeted.writes.map((position) => position.x),
      [10, 5],
    );
    assert.notEqual(lastOf(budgeted.writes).x, 9);
    assert.deepEqual(budgeted.trace, direct.trace);
    assert.equal(budgeted.stats.written, 2);
    assert.equal(budgeted.stats.flushes, 1); // 松手 flush 出终点 5
    assert.equal(budgeted.armedTimers, 0);
  });

  test('反例 2：x∈[0,100]、起点 95、+10,-10 逐事件得 90；先求和再夹边得 95 是错的', () => {
    const workArea: WorkArea = { x: 0, y: 0, width: 200, height: 200 }; // 窗口 100 宽 → 可移动范围 0..100
    const size: Size = { width: 100, height: 100 };
    const events: readonly DragEvent[] = [
      { dx: 10, dy: 0, dtMs: 0 },
      { dx: -10, dy: 0, dtMs: 0.5 },
    ];

    const direct = runDirect(events, workArea, size, { x: 95, y: 0 });
    assert.deepEqual(
      direct.writes.map((position) => position.x),
      [100, 90],
    );
    assert.equal(lastOf(direct.writes).x, 90);

    const summed = clampPosition({ x: 95 + 10 - 10, y: 0 }, size, workArea);
    assert.equal(summed.x, 95);
    assert.notEqual(summed.x, 90);

    const budgeted = runBudgeted(events, workArea, size, { x: 95, y: 0 });
    assert.deepEqual(
      budgeted.writes.map((position) => position.x),
      [100, 90],
    );
    assert.deepEqual(budgeted.trace, direct.trace);
  });

  for (const seed of [1, 0x5eed, 424242]) {
    test(`固定 seed 序列（${seed}）：逐事件 tracked/position 全等，写出是保序子序列`, () => {
      const events = buildSequence(seed);
      const direct = runDirect(events, TRACK_AREA, TRACK_SIZE, TRACK_START);
      const budgeted = runBudgeted(events, TRACK_AREA, TRACK_SIZE, TRACK_START);

      // 1) 每个事件的逻辑状态完全一致（不只是最后一张截图的落点）。
      assert.equal(direct.trace.length, events.length);
      assert.deepEqual(budgeted.trace, direct.trace);

      // 2) 首写即时：第一条输入的坐标立刻写出。
      assert.deepEqual(budgeted.writes[0], direct.writes[0]);

      // 3) 候选写出的都是原序列的元素，保序、不新增、不改写。
      assertSubsequence(budgeted.writes, direct.writes);

      // 4) 最后一个 write 就是最终 position（松手 flush）。
      assert.deepEqual(lastOf(budgeted.writes), lastOf(direct.writes));

      // 5) 机制门：确实合并了写入，而不是退化成直写。
      assert.ok(budgeted.writes.length < direct.writes.length);
      assert.equal(budgeted.writes.length, budgeted.stats.written);

      // 6) 统计自洽。
      const stats = budgeted.stats;
      assert.equal(stats.submitted, events.length);
      assert.equal(stats.submitted, stats.written + stats.coalesced + stats.duplicateDropped);
      assert.ok(stats.duplicateDropped > 0, '零位移与抖回应产生重复坐标');
      assert.ok(stats.coalesced > 0);

      // 7) 小数累积没被取整：tracked 里保留小数，position 才是整数。
      const fractional = direct.trace.filter((step) => !Number.isInteger(step.tracked.x) || !Number.isInteger(step.tracked.y));
      assert.ok(fractional.length > 10);
      assert.ok(direct.trace.every((step) => Number.isInteger(step.position.x) && Number.isInteger(step.position.y)));

      // 8) 时钟只由假时钟推进：总时长 = 输入间隔之和，结束时无残留 timer。
      assert.equal(budgeted.clockMs, sumOf(events.map((event) => event.dtMs)));
      assert.equal(budgeted.armedTimers, 0);
    });
  }

  test('零位移连发：原路径重复写同一坐标，候选全部记 duplicateDropped 且不写', () => {
    const workArea: WorkArea = { x: 0, y: 0, width: 800, height: 600 };
    const size: Size = { width: 120, height: 90 };
    const start: DragPosition = { x: 200, y: 150 };
    const events: readonly DragEvent[] = [
      { dx: 0, dy: 0, dtMs: 0 },
      { dx: 0, dy: 0, dtMs: 1 },
      { dx: 0, dy: 0, dtMs: 1 },
      { dx: 0, dy: 0, dtMs: 1 },
      { dx: 0, dy: 0, dtMs: 1 },
      { dx: 0, dy: 0, dtMs: 1 },
    ];

    const direct = runDirect(events, workArea, size, start);
    assert.equal(direct.writes.length, 6);

    const budgeted = runBudgeted(events, workArea, size, start);
    assert.deepEqual(budgeted.writes, [{ x: 200, y: 150 }]); // 只有首写
    assert.deepEqual(budgeted.trace, direct.trace);
    assert.equal(budgeted.stats.duplicateDropped, 5);
    assert.equal(budgeted.stats.written, 1);
    assert.equal(budgeted.stats.flushes, 0);
    assert.equal(budgeted.stats.submitted, budgeted.stats.written + budgeted.stats.coalesced + budgeted.stats.duplicateDropped);
  });

  test('预算可注入：4ms 预算下等价性不变，只是写出更少', () => {
    const events = buildSequence(0x5eed);
    const direct = runDirect(events, TRACK_AREA, TRACK_SIZE, TRACK_START);
    const budgeted = runBudgeted(events, TRACK_AREA, TRACK_SIZE, TRACK_START, { budgetMs: 4 });
    const tight = runBudgeted(events, TRACK_AREA, TRACK_SIZE, TRACK_START, { budgetMs: 0 });

    assert.deepEqual(budgeted.trace, direct.trace);
    assertSubsequence(budgeted.writes, direct.writes);
    assert.deepEqual(lastOf(budgeted.writes), lastOf(direct.writes));

    // budgetMs=0 不再排队：只剩"重复坐标"被丢弃，其余每条都直写。
    assertSubsequence(tight.writes, direct.writes);
    assert.deepEqual(lastOf(tight.writes), lastOf(direct.writes));
    assert.equal(tight.stats.coalesced, 0);
    assert.equal(tight.writes.length, direct.writes.length - tight.stats.duplicateDropped);

    // 8ms 预算比 0ms 写得更少（合并确实生效）。
    assert.ok(budgeted.writes.length <= tight.writes.length);
  });
});
