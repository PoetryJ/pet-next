/**
 * M3-11 候选：拖动写入预算接线（薄适配）的纯单测。
 * 只注入假时钟，不 sleep、不起窗口、不发网络；等价性用 `createWindowController` 当参照。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createWindowController } from './controller.ts';
import { createBudgetedWindowController } from './drag-write-budget.ts';
import type { WindowBounds, WindowHost, WorkArea } from './types.ts';

const area: WorkArea = { x: 10, y: 20, width: 800, height: 600 };

interface Point {
  x: number;
  y: number;
}

/** 假时钟：时间只在 `advance` 里前进，到期定时器按 (at, 注册序) 触发。 */
function fakeClock(): {
  clock: { now(): number; schedule(delayMs: number, run: () => void): unknown; cancel(handle: unknown): void };
  advance(ms: number): void;
  pending(): number;
} {
  let now = 0;
  let seq = 0;
  const timers: Array<{ id: number; at: number; run: () => void }> = [];
  return {
    clock: {
      now: () => now,
      schedule(delayMs, run) {
        seq += 1;
        timers.push({ id: seq, at: now + delayMs, run });
        return seq;
      },
      cancel(handle) {
        const index = timers.findIndex((timer) => timer.id === handle);
        if (index >= 0) timers.splice(index, 1);
      },
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next: { id: number; at: number; run: () => void } | undefined;
        for (const timer of timers) {
          if (timer.at > target) continue;
          if (next === undefined || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) next = timer;
        }
        if (next === undefined) break;
        timers.splice(timers.indexOf(next), 1);
        now = next.at;
        next.run();
      }
      now = target;
    },
    pending: () => timers.length,
  };
}

/** 记录每次 `setPosition` 的假宿主；`getBounds` 只反映已提交的位置。 */
function harness(initial: WindowBounds, workArea: WorkArea = area) {
  let bounds: WindowBounds = { ...initial };
  let quits = 0;
  const writes: Point[] = [];
  const host: WindowHost = {
    getBounds: () => ({ ...bounds }),
    setPosition(x, y) {
      writes.push({ x, y });
      bounds = { ...bounds, x, y };
    },
    workAreaFor: () => workArea,
    quit() {
      quits += 1;
    },
  };
  return { host, writes, bounds: () => bounds, quits: () => quits };
}

/** 相邻重复坐标压掉，用于和"预算器不重复写同一坐标"对齐。 */
function compress(writes: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const write of writes) {
    const last = out.at(-1);
    if (last !== undefined && last.x === write.x && last.y === write.y) continue;
    out.push(write);
  }
  return out;
}

/** 保序子序列（同值多次出现按顺序消费）。 */
function isOrderedSubsequence(candidate: readonly Point[], original: readonly Point[]): boolean {
  let cursor = 0;
  for (const item of candidate) {
    let found = false;
    while (cursor < original.length) {
      const entry = original[cursor];
      cursor += 1;
      if (entry !== undefined && entry.x === item.x && entry.y === item.y) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/** 固定输入序列：亚像素位移 + 越界夹边 + 反向回来。 */
const STEPS: ReadonlyArray<readonly [number, number]> = [
  [5.2, -4.4],
  [0.5, 0.25],
  [0.25, 0.75],
  [-3.7, 2.3],
  [-1000, 5000],
  [20, -20],
  [0.5, 0.5],
  [0.25, -0.5],
  [-6, -6],
  [1.5, 1.5],
];

describe('createBudgetedWindowController：逐事件等价', () => {
  test('budgetMs=0 时每条输入都立即写，写入序列与 createWindowController 逐条相同', () => {
    const baseline = harness({ x: 40, y: 50, width: 100, height: 80 });
    const candidate = harness({ x: 40, y: 50, width: 100, height: 80 });
    const reference = createWindowController(baseline.host);
    const budgeted = createBudgetedWindowController(candidate.host, {
      budgetMs: 0,
      clock: fakeClock().clock,
    });

    for (const [dx, dy] of STEPS) {
      reference.moveBy(dx, dy);
      budgeted.moveBy(dx, dy);
    }

    assert.deepEqual(candidate.bounds(), baseline.bounds());
    assert.deepEqual(candidate.writes, compress(baseline.writes));
    assert.deepEqual(candidate.writes, baseline.writes);
    budgeted.endDrag();
    assert.deepEqual(candidate.bounds(), baseline.bounds());
  });

  test('budgetMs=8 合帧：候选写入是原序列的保序子序列，末项等于最终 position', () => {
    const baseline = harness({ x: 40, y: 50, width: 100, height: 80 });
    const candidate = harness({ x: 40, y: 50, width: 100, height: 80 });
    const reference = createWindowController(baseline.host);
    const { clock, advance } = fakeClock();
    const budgeted = createBudgetedWindowController(candidate.host, { budgetMs: 8, clock });

    for (const [dx, dy] of STEPS) {
      reference.moveBy(dx, dy);
      budgeted.moveBy(dx, dy);
      advance(3);
    }
    budgeted.endDrag();

    assert.deepEqual(candidate.bounds(), baseline.bounds());
    assert.deepEqual(candidate.writes.at(-1), baseline.writes.at(-1));
    assert.ok(isOrderedSubsequence(candidate.writes, baseline.writes), '候选写入必须保序');
    assert.ok(candidate.writes.length < baseline.writes.length, '3ms 输入应被合帧');
    assert.ok(budgeted.stats.submitted >= STEPS.length);
  });
});

describe('createBudgetedWindowController：首写与 flush', () => {
  test('begin 后第一条立即写，8ms 内的第二条只 pending，到期才写', () => {
    const host = harness({ x: 100, y: 100, width: 100, height: 80 });
    const { clock, advance } = fakeClock();
    const controller = createBudgetedWindowController(host.host, { budgetMs: 8, clock });

    controller.moveBy(5, 0);
    assert.deepEqual(host.writes, [{ x: 105, y: 100 }]);

    controller.moveBy(5, 0);
    advance(2);
    assert.equal(host.writes.length, 1, '8ms 内不得再写宿主');

    advance(6);
    assert.deepEqual(host.writes, [
      { x: 105, y: 100 },
      { x: 110, y: 100 },
    ]);
  });

  test('无 tick 时 endDrag 立刻 flush 最后一个位置，且旧 timer 不再写', () => {
    const host = harness({ x: 100, y: 100, width: 100, height: 80 });
    const { clock, advance, pending } = fakeClock();
    const controller = createBudgetedWindowController(host.host, { budgetMs: 8, clock });

    controller.moveBy(5, 0);
    advance(2);
    controller.moveBy(5, 0);
    controller.moveBy(5, 0);
    assert.equal(host.writes.length, 1);
    assert.equal(pending(), 1);

    controller.endDrag();
    assert.deepEqual(host.writes, [
      { x: 105, y: 100 },
      { x: 115, y: 100 },
    ]);
    assert.equal(pending(), 0, 'endDrag 必须撤掉本次拖动的 timer');

    advance(100);
    assert.equal(host.writes.length, 2, 'epoch 失效后不得补写');
  });

  test('endDrag 后再次 moveBy 自动 begin：首写即时、第二条 pending', () => {
    const host = harness({ x: 100, y: 100, width: 100, height: 80 });
    const { clock, advance } = fakeClock();
    const controller = createBudgetedWindowController(host.host, { budgetMs: 8, clock });

    controller.moveBy(5, 0);
    controller.endDrag();
    advance(1);
    controller.moveBy(5, 0);
    assert.deepEqual(host.writes, [
      { x: 105, y: 100 },
      { x: 110, y: 100 },
    ]);
    controller.moveBy(5, 0);
    advance(1);
    assert.equal(host.writes.length, 2, '新 epoch 的首写之后仍合帧');
  });

  test('重复 drag-end 不产生额外写入', () => {
    const host = harness({ x: 100, y: 100, width: 100, height: 80 });
    const { clock } = fakeClock();
    const controller = createBudgetedWindowController(host.host, { budgetMs: 8, clock });
    controller.endDrag();
    controller.moveBy(5, 0);
    controller.endDrag();
    controller.endDrag();
    assert.deepEqual(host.writes, [{ x: 105, y: 100 }]);
  });
});

describe('createBudgetedWindowController：dispose / passthrough', () => {
  test('dispose 丢弃 pending 且之后不再写宿主（含旧 timer 与再次 moveBy）', () => {
    const host = harness({ x: 100, y: 100, width: 100, height: 80 });
    const { clock, advance, pending } = fakeClock();
    const controller = createBudgetedWindowController(host.host, { budgetMs: 8, clock });

    controller.moveBy(5, 0);
    advance(2);
    controller.moveBy(5, 0);
    controller.dispose();
    assert.equal(pending(), 0);

    advance(100);
    controller.moveBy(5, 0);
    controller.endDrag();
    advance(100);

    assert.deepEqual(host.writes, [{ x: 105, y: 100 }]);
  });

  test('noteGeometryChanged 先 flush pending，再 passthrough 直写；endDrag 后恢复合帧', () => {
    const host = harness({ x: 100, y: 100, width: 100, height: 80 });
    const { clock, advance } = fakeClock();
    const controller = createBudgetedWindowController(host.host, { budgetMs: 8, clock });

    controller.moveBy(5, 0);
    advance(2);
    controller.moveBy(5, 0);
    assert.equal(host.writes.length, 1);

    controller.noteGeometryChanged();
    assert.deepEqual(host.writes, [
      { x: 105, y: 100 },
      { x: 110, y: 100 },
    ], '几何变化必须先 flush 有效 pending');

    // passthrough：8ms 内也逐条直写。
    controller.moveBy(5, 0);
    controller.moveBy(5, 0);
    assert.deepEqual(host.writes.slice(2), [
      { x: 115, y: 100 },
      { x: 120, y: 100 },
    ]);
    assert.equal(host.writes.length, 4);

    // endDrag 结束回退；下一次拖动重新合帧。
    controller.endDrag();
    advance(1);
    controller.moveBy(5, 0);
    assert.equal(host.writes.length, 5, '新一轮首写即时');
    controller.moveBy(5, 0);
    assert.equal(host.writes.length, 5, '恢复合帧后 8ms 内不再写');
    advance(8);
    assert.deepEqual(host.writes.at(-1), { x: 130, y: 100 });
  });

  test('passthrough 期间往返夹边仍不复用求和（tracked 来自 advanceOrigin）', () => {
    const tight: WorkArea = { x: 0, y: 0, width: 10, height: 10 };
    const host = harness({ x: 9, y: 0, width: 1, height: 1 }, tight);
    const { clock } = fakeClock();
    const controller = createBudgetedWindowController(host.host, { budgetMs: 8, clock });

    controller.noteGeometryChanged();
    controller.moveBy(5, 0);
    controller.moveBy(-5, 0);
    assert.deepEqual(host.writes, [
      { x: 9, y: 0 },
      { x: 4, y: 0 },
    ]);
    assert.deepEqual(host.bounds(), { x: 4, y: 0, width: 1, height: 1 });
  });
});

describe('createBudgetedWindowController：重复坐标与小数累积', () => {
  test('夹边产生相同绝对 position 时不重复写', () => {
    const host = harness({ x: 40, y: 50, width: 100, height: 80 });
    const { clock } = fakeClock();
    const controller = createBudgetedWindowController(host.host, { budgetMs: 8, clock });

    controller.moveBy(10_000, 0);
    controller.moveBy(20, 0);
    controller.moveBy(20, 0);
    controller.endDrag();
    assert.deepEqual(host.writes, [{ x: 710, y: 50 }]);
    assert.ok(controller.stats.duplicateDropped >= 1);
  });

  test('0.5/0.25 亚像素逐步累积，写入等于原路径（压缩后）', () => {
    const initial = { x: 100, y: 80, width: 100, height: 80 };
    const baseline = harness(initial);
    const candidate = harness(initial);
    const reference = createWindowController(baseline.host);
    const { clock } = fakeClock();
    const budgeted = createBudgetedWindowController(candidate.host, { budgetMs: 0, clock });

    const steps = [0.5, 0.25, 0.25, 0.5, 0.25, 0.5, -0.25, -0.5, -0.25, 0.5];
    for (const dx of steps) {
      reference.moveBy(dx, 0);
      budgeted.moveBy(dx, 0);
    }

    assert.deepEqual(candidate.writes, compress(baseline.writes));
    assert.deepEqual(candidate.bounds(), baseline.bounds());
    // 0.5*4 = 2 的位移必须逐条累加，而不是按每步取整后丢余数。
    assert.equal(candidate.bounds().x, 102);

    // 靠右边界往返：夹住后反向必须逐条退，不得退化成求和。
    const wall = harness({ x: 709, y: 80, width: 100, height: 80 });
    const wallRef = harness({ x: 709, y: 80, width: 100, height: 80 });
    const wallController = createBudgetedWindowController(wall.host, { budgetMs: 0, clock: fakeClock().clock });
    const wallReference = createWindowController(wallRef.host);
    for (const dx of [1.5, 1.5, -1.5, -1.5, -1.5]) {
      wallController.moveBy(dx, 0);
      wallReference.moveBy(dx, 0);
    }
    assert.deepEqual(wall.bounds(), wallRef.bounds());
    assert.deepEqual(wall.writes, compress(wallRef.writes));
    assert.equal(wall.bounds().x, 706);
  });
});

describe('createBudgetedWindowController：非有限值与退出', () => {
  test('NaN/Infinity 与参考实现一样被忽略，且不开启拖动', () => {
    const host = harness({ x: 100, y: 100, width: 100, height: 80 });
    const reference = harness({ x: 100, y: 100, width: 100, height: 80 });
    const { clock, pending } = fakeClock();
    const controller = createBudgetedWindowController(host.host, { budgetMs: 8, clock });
    const baseline = createWindowController(reference.host);

    for (const [dx, dy] of [
      [Number.NaN, 1],
      [1, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, Number.NaN],
    ] as const) {
      controller.moveBy(dx, dy);
      baseline.moveBy(dx, dy);
    }

    assert.deepEqual(host.writes, reference.writes);
    assert.deepEqual(host.writes, []);
    assert.equal(pending(), 0);
    assert.deepEqual(host.bounds(), reference.bounds());
  });

  test('quit 原样透传宿主退出，不产生位置写入', () => {
    const host = harness({ x: 100, y: 100, width: 100, height: 80 });
    const controller = createBudgetedWindowController(host.host, { clock: fakeClock().clock });
    controller.quit();
    assert.equal(host.quits(), 1);
    assert.deepEqual(host.writes, []);
  });
});
