/**
 * M3-11 D：独立等价验收（不依赖真实窗口，不需要 Xvfb）。
 *
 * 两层，各测各的：
 * - 纯调度器（B，`experiments/drag-write-budget/`）：契约第 2 节逐条语义、旧 timer、flush、dispose；
 * - 适配器（C，`adapters/window/drag-write-budget.ts`）：与**产品现有控制器**逐事件对拍。
 *
 * 参考模型就是 `adapters/window/controller.ts`（逐事件 advanceOrigin + 每次直写），
 * 候选只经公开 API（moveBy/endDrag/noteGeometryChanged/dispose/stats）驱动，
 * 不 import 候选内部私有函数，也不复制夹边/取整逻辑。
 *
 * 依赖缺失时用 `skip` + 明确原因报告，不静默通过。
 * 复跑：node --experimental-strip-types --test --test-reporter spec tests/drag-write-budget/equivalence.test.ts
 * @module pet-next/tests/drag-write-budget/equivalence
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { BudgetedFactory, DragPosition, WriteBudgetStats } from './support/contract.ts';
import { loadCandidate, expectShape } from './support/contract.ts';
import { createFakeClock } from './support/fake-clock.ts';
import {
  assertReadsPerMove,
  assertSameFinal,
  assertSameWrites,
  assertStatsConsistent,
  assertWritesAreSubsequence,
  countOp,
  createRecordingHost,
  runCandidate,
  runReference,
  seededScript,
  type RunOutcome,
  type ScriptEntry,
  type World,
} from './support/harness.ts';
import { expectSchedulerShape, loadScheduler, type SchedulerFactory } from './support/scheduler.ts';

const candidateGate = await loadCandidate();
const schedulerGate = await loadScheduler();

const SKIP_CANDIDATE = candidateGate.factory === null ? candidateGate.reason : false;
const SKIP_SCHEDULER = schedulerGate.factory === null ? schedulerGate.reason : false;

function candidateFactory(): BudgetedFactory {
  const factory = candidateGate.factory;
  if (factory === null) throw new Error(candidateGate.reason);
  return factory;
}

function schedulerFactory(): SchedulerFactory {
  const factory = schedulerGate.factory;
  if (factory === null) throw new Error(schedulerGate.reason);
  return factory;
}

/** 参考序列里相邻重复的坐标：候选会按契约丢弃（"重复坐标不是有效位移"）。 */
function collapseAdjacent(positions: readonly DragPosition[]): DragPosition[] {
  const out: DragPosition[] = [];
  for (const position of positions) {
    const last = out.at(-1);
    if (last !== undefined && last.x === position.x && last.y === position.y) continue;
    out.push({ x: position.x, y: position.y });
  }
  return out;
}

interface Pair {
  readonly clock: ReturnType<typeof createFakeClock>;
  readonly reference: RunOutcome;
  readonly actual: RunOutcome;
}

function pair(world: World, script: readonly ScriptEntry[]): Pair {
  const clock = createFakeClock();
  const reference = runReference(world, script);
  const run = runCandidate({ world, script, factory: candidateFactory(), clock });
  return { clock, reference, actual: run.outcome };
}

const movesIn = (script: readonly ScriptEntry[]): number => script.filter((entry) => entry.type === 'move').length;

/** 工作区大：不夹边，纯位移/小数口径。 */
const PLAIN: World = {
  size: { width: 320, height: 240 },
  start: { x: 80, y: 80 },
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
};

/** 小工作区：左右各只剩 20 DIP 余量，四边都能撞到。 */
const TIGHT: World = {
  size: { width: 320, height: 240 },
  start: { x: 20, y: 20 },
  workArea: { x: 0, y: 0, width: 360, height: 300 },
};

/** 任务书反例 1：x 只有 [0,10] 可用，起点 9，输入 +5,-5 → 逐事件 5（求和夹边会错成 9）。 */
const DOC_ONE: World = {
  size: { width: 320, height: 240 },
  start: { x: 9, y: 60 },
  workArea: { x: 0, y: 0, width: 330, height: 300 },
};

/** RESEARCH 反例 2：x 只有 [0,100]，起点 95，+10,-10 → 90（求和夹边会错成 95）。 */
const DOC_TWO: World = {
  size: { width: 320, height: 240 },
  start: { x: 95, y: 20 },
  workArea: { x: 0, y: 0, width: 420, height: 300 },
};

// ---------------------------------------------------------------------------
// 契约第 2 节：纯调度器语义
// ---------------------------------------------------------------------------

interface SchedulerHarness {
  readonly clock: ReturnType<typeof createFakeClock>;
  readonly writes: DragPosition[];
  readonly budget: ReturnType<typeof expectSchedulerShape>;
  stats(): WriteBudgetStats;
}

function schedulerHarness(options: { readonly budgetMs?: number; readonly start?: number } = {}): SchedulerHarness {
  const clock = createFakeClock(options.start ?? 0);
  const writes: DragPosition[] = [];
  const budget = expectSchedulerShape(
    schedulerFactory()({
      now: () => clock.now(),
      schedule: (delayMs, run) => clock.schedule(delayMs, run),
      cancel: (handle) => clock.cancel(handle),
      write: (position) => {
        writes.push({ x: position.x, y: position.y });
      },
      ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    }),
  );
  return { clock, writes, budget, stats: () => budget.stats };
}

describe('契约 2 调度器语义', () => {
  test('2.1 一次拖动首写即时，且不挂 timer', { skip: SKIP_SCHEDULER }, () => {
    const h = schedulerHarness({ start: 1000 });
    h.budget.begin();
    h.budget.submit({ x: 5, y: 5 });
    assert.deepEqual(h.writes, [{ x: 5, y: 5 }], 'begin 后首个 submit 必须立即写出');
    assert.equal(h.clock.pending().length, 0, '首写不得挂定时器（否则首动被延迟一个 budget）');
    assert.equal(h.clock.nowMs, 1000, '首写不得推进注入时钟');
  });

  test('2.3 重复坐标丢弃（无 pending 时不算有效位移）', { skip: SKIP_SCHEDULER }, () => {
    const h = schedulerHarness();
    h.budget.begin();
    h.budget.submit({ x: 7, y: 8 });
    h.budget.submit({ x: 7, y: 8 });
    h.budget.submit({ x: 7, y: 8 });
    assert.deepEqual(h.writes, [{ x: 7, y: 8 }], '同一坐标只写一次');
    assert.equal(h.stats().duplicateDropped, 2, '重复坐标要计数，不能静默丢弃');
    assert.equal(h.clock.pending().length, 0, '丢弃不得留下定时器');
  });

  test('2.3/2.4 budget 内合并为一次末位写，到期只写一次', { skip: SKIP_SCHEDULER }, () => {
    const h = schedulerHarness();
    h.budget.begin();
    h.budget.submit({ x: 0, y: 0 });
    h.clock.advance(1);
    h.budget.submit({ x: 1, y: 0 });
    assert.deepEqual(h.writes, [{ x: 0, y: 0 }], '8ms 内不得立刻写第二条');
    const scheduled = h.clock.pending();
    assert.equal(scheduled.length, 1, '只允许挂一个 timer');
    assert.equal(scheduled[0]?.delayMs, 7, '延时必须是 budgetMs-(now-lastWriteAt)');
    h.clock.advance(2);
    h.budget.submit({ x: 2, y: 0 });
    assert.equal(h.clock.pending().length, 1, 'pending 覆盖时不得再挂第二个 timer');
    h.clock.advance(20);
    assert.deepEqual(h.writes, [{ x: 0, y: 0 }, { x: 2, y: 0 }], '到期只写当前 pending（末位），中间态不补写');
    // 口径：coalesced 数"被取代而从未写出的坐标条数"（B 的实现），因此这里是 1 而不是 2；
    // 两条读法对写行为没有影响，见 harness.assertStatsConsistent 的说明。
    assert.ok(h.stats().coalesced >= 1, '被合并掉的坐标要计数');
    assert.equal(
      h.stats().submitted,
      h.stats().written + h.stats().coalesced + h.stats().duplicateDropped,
      '静息时必须守恒：submitted === written + coalesced + duplicateDropped',
    );
  });

  test('2.8 定时器从未触发也要在 end 时写出 pending', { skip: SKIP_SCHEDULER }, () => {
    const h = schedulerHarness();
    h.budget.begin();
    h.budget.submit({ x: 0, y: 0 });
    h.clock.advance(1);
    h.budget.submit({ x: 4, y: 0 });
    h.budget.end();
    assert.deepEqual(h.writes, [{ x: 0, y: 0 }, { x: 4, y: 0 }], 'end 必须 flush（即使距上次 < budget）');
    assert.equal(h.clock.pending().length, 0, 'end 后不得留 timer');
    h.clock.advance(50);
    assert.equal(h.writes.length, 2, 'end 之后旧 timer 不得补写');
  });

  test('2.6 cancel 同样 flush 有效 pending', { skip: SKIP_SCHEDULER }, () => {
    const h = schedulerHarness();
    h.budget.begin();
    h.budget.submit({ x: 0, y: 0 });
    h.clock.advance(1);
    h.budget.submit({ x: 3, y: 3 });
    h.budget.cancel();
    assert.deepEqual(h.writes, [{ x: 0, y: 0 }, { x: 3, y: 3 }], '取消拖动也要把已算出的位置落地');
    assert.equal(h.clock.pending().length, 0);
  });

  test('2.6 无 pending 时 end/cancel 不补写', { skip: SKIP_SCHEDULER }, () => {
    const h = schedulerHarness();
    h.budget.begin();
    h.budget.submit({ x: 1, y: 1 });
    h.budget.end();
    h.budget.cancel();
    h.budget.end();
    assert.deepEqual(h.writes, [{ x: 1, y: 1 }], '没有 pending 时只撤 timer');
  });

  test('2.4/2.7 旧 timer 即使真被触发也不得写宿主（epoch 守卫）', { skip: SKIP_SCHEDULER }, () => {
    const h = schedulerHarness();
    h.budget.begin();
    h.budget.submit({ x: 0, y: 0 });
    h.clock.advance(1);
    h.budget.submit({ x: 2, y: 0 });
    h.budget.end();
    const afterEnd = h.writes.length;
    const revived = h.clock.resurrectAll();
    assert.ok(revived >= 1, '本次应至少撤销过一个 timer，否则这条用例没有验证力');
    assert.equal(h.writes.length, afterEnd, 'end 之后被撤销的 timer 回调不得写宿主');

    h.budget.begin();
    h.budget.submit({ x: 9, y: 9 });
    h.clock.advance(1);
    h.budget.submit({ x: 10, y: 9 });
    h.budget.dispose();
    const afterDispose = h.writes.length;
    h.clock.resurrectAll();
    assert.equal(h.writes.length, afterDispose, 'dispose 之后任何回调都无权写宿主');
    h.budget.submit({ x: 11, y: 9 });
    assert.equal(h.writes.length, afterDispose, 'dispose 之后 submit 必须被忽略');
    assert.equal(h.clock.pending().length, 0, 'dispose 必须撤 timer');
  });

  test('2.2 已 dispose 的 submit 不写也不挂 timer', { skip: SKIP_SCHEDULER }, () => {
    const h = schedulerHarness();
    h.budget.begin();
    h.budget.dispose();
    h.budget.submit({ x: 1, y: 2 });
    assert.deepEqual(h.writes, [], 'dispose 后不得写宿主');
    assert.equal(h.clock.pending().length, 0, 'dispose 后不得挂 timer');
  });

  test('2.2 下一次 begin 重置首写即时（第二次拖动不被上一轮预算拖住）', { skip: SKIP_SCHEDULER }, () => {
    const h = schedulerHarness();
    h.budget.begin();
    h.budget.submit({ x: 0, y: 0 });
    h.clock.advance(1);
    h.budget.submit({ x: 1, y: 0 });
    h.budget.end();
    h.clock.advance(1);
    h.budget.begin();
    const before = h.writes.length;
    h.budget.submit({ x: 2, y: 0 });
    assert.equal(h.writes.length, before + 1, '新拖动首写必须即时');
    assert.equal(h.clock.pending().length, 0, '新拖动首写不得挂 timer');
  });
});

// ---------------------------------------------------------------------------
// 契约第 3 节：适配器 vs 产品现有控制器
// ---------------------------------------------------------------------------

describe('契约 3 适配器等价', () => {
  test('稀疏拖动的四边往返：与参考模型逐条相等', { skip: SKIP_CANDIDATE }, () => {
    const script: ScriptEntry[] = [];
    for (let step = 0; step < 12; step += 1) script.push({ type: 'move', dx: 3, dy: 3, gapMs: 10 });
    for (let step = 0; step < 24; step += 1) script.push({ type: 'move', dx: -3, dy: -3, gapMs: 10 });
    for (let step = 0; step < 6; step += 1) script.push({ type: 'move', dx: 2, dy: 1, gapMs: 10 });
    const { reference, actual } = pair(TIGHT, script);
    assertSameWrites(actual.positions, collapseAdjacent(reference.positions), '四边往返（稀疏）');
    assertSameFinal(actual, reference, '四边往返（稀疏）');
    assertReadsPerMove(actual, movesIn(script), '四边往返（稀疏）');
    assertStatsConsistent(actual.stats ?? fail('缺少 stats'), countOp(actual, 'setPosition'), '四边往返（稀疏）');
    assert.ok(reference.positions.some((position) => position.x === 0), '用例必须真的撞到左边');
    assert.ok(reference.positions.some((position) => position.x === 40), '用例必须真的撞到右边');
  });

  test('任务书反例 1：+5,-5 逐事件 9→10→5，不得求和后夹边成 9', { skip: SKIP_CANDIDATE }, () => {
    const script: ScriptEntry[] = [
      { type: 'move', dx: 5, dy: 0, gapMs: 10 },
      { type: 'move', dx: -5, dy: 0, gapMs: 10 },
    ];
    const { reference, actual } = pair(DOC_ONE, script);
    assert.deepEqual(reference.positions, [{ x: 10, y: 60 }, { x: 5, y: 60 }], '参考模型必须复现逐事件结果');
    assert.deepEqual(actual.positions, [{ x: 10, y: 60 }, { x: 5, y: 60 }], '候选不得退化成 sum(dx) 后夹边');
    assert.equal(actual.final.x, 5, '终点必须是 5（求和夹边会得到 9）');
    assertSameFinal(actual, reference, '反例 1');
  });

  test('RESEARCH 反例 2：95 +10,-10 → 100→90', { skip: SKIP_CANDIDATE }, () => {
    const script: ScriptEntry[] = [
      { type: 'move', dx: 10, dy: 0, gapMs: 10 },
      { type: 'move', dx: -10, dy: 0, gapMs: 10 },
    ];
    const { reference, actual } = pair(DOC_TWO, script);
    assert.deepEqual(actual.positions, [{ x: 100, y: 20 }, { x: 90, y: 20 }]);
    assert.equal(actual.final.x, 90, '终点必须是 90（求和夹边会得到 95）');
    assertSameFinal(actual, reference, '反例 2');
  });

  test('小数 0.125：稀疏逐条等价，密集合并不丢余数', { skip: SKIP_CANDIDATE }, () => {
    const sparse: ScriptEntry[] = [];
    for (let step = 0; step < 8; step += 1) sparse.push({ type: 'move', dx: 0.125, dy: 0.125, gapMs: 10 });
    const sparsePair = pair(PLAIN, sparse);
    assertSameWrites(sparsePair.actual.positions, collapseAdjacent(sparsePair.reference.positions), '小数 0.125（稀疏）');
    assertSameFinal(sparsePair.actual, sparsePair.reference, '小数 0.125（稀疏）');
    assert.deepEqual(sparsePair.actual.final, { x: 81, y: 81 }, '8×0.125 必须精确累加到 +1 DIP');

    const dense: ScriptEntry[] = [];
    for (let step = 0; step < 8; step += 1) dense.push({ type: 'move', dx: 0.125, dy: 0.125, gapMs: 1 });
    dense.push({ type: 'end' });
    const densePair = pair(PLAIN, dense);
    assertWritesAreSubsequence(
      densePair.actual.positions,
      collapseAdjacent(densePair.reference.positions),
      '小数 0.125（密集）',
      { requireFinal: true },
    );
    assert.deepEqual(densePair.actual.final, { x: 81, y: 81 }, '合并不得吃掉小数余数');
    assert.ok(densePair.actual.positions.length < densePair.reference.positions.length, '密集输入应当真的合并掉一些写入');
  });

  test('小数 0.5：四舍五入边界与参考模型一致', { skip: SKIP_CANDIDATE }, () => {
    const script: ScriptEntry[] = [];
    for (let step = 0; step < 10; step += 1) script.push({ type: 'move', dx: 0.5, dy: 0.5, gapMs: 10 });
    const { reference, actual } = pair(PLAIN, script);
    assertSameWrites(actual.positions, collapseAdjacent(reference.positions), '小数 0.5');
    assertSameFinal(actual, reference, '小数 0.5');
    assert.deepEqual(actual.final, { x: 85, y: 85 }, '10×0.5 必须精确累加到 +5 DIP');
  });

  test('零位移不写宿主、不误触点击语义', { skip: SKIP_CANDIDATE }, () => {
    const script: ScriptEntry[] = [
      { type: 'move', dx: 10, dy: 0, gapMs: 10 },
      { type: 'move', dx: 0, dy: 0, gapMs: 10 },
      { type: 'move', dx: 0, dy: 0, gapMs: 10 },
    ];
    const { reference, actual } = pair(PLAIN, script);
    const repeated = actual.positions.filter((position) => position.x === 90 && position.y === 80);
    assert.equal(repeated.length, 1, '同一坐标不得重复写宿主');
    assertSameWrites(actual.positions, collapseAdjacent(reference.positions), '零位移');
    assert.equal(actual.final.x, 90, '零位移不得改变位置');
  });

  test('点击（无指针位移）两臂都零写入、零几何回读', { skip: SKIP_CANDIDATE }, () => {
    const { reference, actual } = pair(PLAIN, []);
    assert.equal(reference.writes.length, 0, '参考模型：点击不写宿主');
    assert.equal(actual.writes.length, 0, '候选：点击不写宿主');
    assert.deepEqual(actual.calls, [], '没有任何 moveBy 时不得触碰宿主（拖动预算不得自作主张 begin）');
    assert.deepEqual(actual.final, reference.final);
  });

  test('非有限位移逐字等价地忽略，不进入预算', { skip: SKIP_CANDIDATE }, () => {
    const script: ScriptEntry[] = [
      { type: 'move', dx: Number.NaN, dy: 0, gapMs: 10 },
      { type: 'move', dx: 0, dy: Number.POSITIVE_INFINITY, gapMs: 10 },
      { type: 'move', dx: 1, dy: 0, gapMs: 10 },
      { type: 'move', dx: 0, dy: Number.NEGATIVE_INFINITY, gapMs: 10 },
    ];
    const { reference, actual } = pair(PLAIN, script);
    assert.equal(reference.positions.length, 1, '参考模型只执行唯一一条有限位移');
    assertSameWrites(actual.positions, reference.positions, '非有限位移');
    assertReadsPerMove(actual, 1, '非有限位移');
    assert.equal(actual.stats?.submitted, 1, '契约第 3 节要求 moveBy 逐字等价：非有限位移不得计入 submitted');
  });

  test('固定 seed 密集拖动：写入是参考序列的子序列，末态一致', { skip: SKIP_CANDIDATE }, () => {
    for (const [label, world] of [['大工作区', PLAIN], ['贴边工作区', TIGHT]] as const) {
      const script = seededScript({ seed: 0x5eed, count: 240, gapMs: 2, trailing: [{ type: 'end' }] });
      const { reference, actual } = pair(world, script);
      assertWritesAreSubsequence(actual.positions, collapseAdjacent(reference.positions), `密集随机（${label}）`, {
        requireFinal: true,
      });
      assertSameFinal(actual, reference, `密集随机（${label}）`);
      assertReadsPerMove(actual, movesIn(script), `密集随机（${label}）`);
      assertStatsConsistent(
        actual.stats ?? fail('缺少 stats'),
        countOp(actual, 'setPosition'),
        `密集随机（${label}）`,
      );
      assert.ok(actual.positions.length < reference.positions.length, `密集随机（${label}）应当合并掉一部分写入`);
    }
  });

  test('固定 seed 稀疏拖动：与参考模型逐条相等', { skip: SKIP_CANDIDATE }, () => {
    const script = seededScript({ seed: 0x1234, count: 120, gapMs: 9, trailing: [{ type: 'end' }] });
    const { reference, actual } = pair(TIGHT, script);
    assertSameWrites(actual.positions, collapseAdjacent(reference.positions), '稀疏随机');
    assertSameFinal(actual, reference, '稀疏随机');
  });

  test('500Hz 纯 trace 机制门：写入减少 ≥50%，末态不变', { skip: SKIP_CANDIDATE }, () => {
    const script: ScriptEntry[] = [];
    for (let step = 0; step < 500; step += 1) script.push({ type: 'move', dx: 1, dy: 0, gapMs: 2 });
    script.push({ type: 'end' });
    const { reference, actual } = pair(PLAIN, script);
    const baseline = reference.positions.length;
    const budgeted = actual.positions.length;
    const reduction = 1 - budgeted / baseline;
    assert.equal(baseline, 500, '基线写入数应等于事件数');
    assert.ok(
      reduction >= 0.5,
      `机制门未过：写入 ${budgeted}/${baseline}（减少 ${(reduction * 100).toFixed(1)}%，要求 ≥50%）`,
    );
    assertSameFinal(actual, reference, '500Hz 纯 trace');
    assertWritesAreSubsequence(actual.positions, collapseAdjacent(reference.positions), '500Hz 纯 trace', {
      requireFinal: true,
    });
  });

  test('两次拖动之间 endDrag 不丢累积原点（余数不重置）', { skip: SKIP_CANDIDATE }, () => {
    const script: ScriptEntry[] = [
      { type: 'move', dx: 0.125, dy: 0.125, gapMs: 10 },
      { type: 'move', dx: 0.125, dy: 0.125, gapMs: 10 },
      { type: 'end' },
      { type: 'move', dx: 0.125, dy: 0.125, gapMs: 10 },
      { type: 'move', dx: 0.125, dy: 0.125, gapMs: 10 },
      { type: 'end' },
    ];
    const { reference, actual } = pair(PLAIN, script);
    // 这里**不要求**逐条相等：契约 2.6 要求 end() 无条件 flush pending，
    // 因此"松手时把与上次相同的整数坐标再写一次"是契约允许的（基线在同一时刻也写）。
    // 需要守的是：每条写入都必须是某一步的逐事件结果（不许插值/求和），且末态不丢余数。
    assertWritesAreSubsequence(actual.positions, reference.positions, '跨拖动小数累积', { requireFinal: true });
    assert.equal(
      reference.positions.length,
      4,
      '参考模型应逐事件写 4 次（其中 3 次是同一个整数坐标）',
    );
    assert.deepEqual(actual.final, { x: 81, y: 81 }, '跨拖动累积仍是 +1 DIP');
    assertSameFinal(actual, reference, '跨拖动小数累积');
  });

  test('工作区变更：先 flush，再本拖动内回退逐事件直写', { skip: SKIP_CANDIDATE }, () => {
    const world: World = {
      ...PLAIN,
      workAreaAfterGeometry: { x: 0, y: 0, width: 800, height: 600 },
    };
    const clock = createFakeClock();
    const host = createRecordingHost({ world, clock: () => clock.now() });
    const controller = expectShape(candidateFactory()(host, { clock }));

    controller.moveBy(5, 0);
    assert.equal(host.writes.length, 1, '首写即时');
    clock.advance(1);
    controller.moveBy(5, 0);
    assert.equal(host.writes.length, 1, '1ms 内的第二笔应进入 pending');
    clock.advance(2);

    host.setWorkArea(world.workAreaAfterGeometry ?? PLAIN.workArea);
    controller.noteGeometryChanged();
    assert.equal(host.writes.length, 2, 'noteGeometryChanged 必须先 flush 有效 pending');
    assert.equal(clock.pending().length, 0, 'flush 后不得留 timer');

    const afterFlush = host.writes.length;
    controller.moveBy(1, 0);
    assert.equal(host.writes.length, afterFlush + 1, 'passthrough 期间必须逐事件直写（即使距上次 < budget）');
    assert.equal(clock.pending().length, 0, 'passthrough 期间不得挂 timer');
    controller.moveBy(1, 0);
    assert.equal(host.writes.length, afterFlush + 2, 'passthrough 逐事件直写持续到 endDrag');

    controller.endDrag();
    const afterEnd = host.writes.length;
    controller.moveBy(1, 0);
    assert.equal(host.writes.length, afterEnd + 1, 'endDrag 后新拖动首写即时');

    const reference = runReference(world, [
      { type: 'move', dx: 5, dy: 0 },
      { type: 'move', dx: 5, dy: 0 },
      { type: 'geometry' },
      { type: 'move', dx: 1, dy: 0 },
      { type: 'move', dx: 1, dy: 0 },
      { type: 'move', dx: 1, dy: 0 },
    ]);
    assert.deepEqual(host.bounds(), { ...reference.final, width: 320, height: 240 }, 'passthrough 的落点仍按新工作区夹紧');
  });

  test('dispose 不写宿主，之后 moveBy 也不再写', { skip: SKIP_CANDIDATE }, () => {
    const clock = createFakeClock();
    const host = createRecordingHost({ world: PLAIN, clock: () => clock.now() });
    const controller = expectShape(candidateFactory()(host, { clock }));
    controller.moveBy(4, 0);
    clock.advance(1);
    controller.moveBy(4, 0);
    assert.equal(host.writes.length, 1, '第二笔在 pending 中');
    controller.dispose();
    assert.equal(host.writes.length, 1, 'dispose 只清不写');
    assert.equal(clock.pending().length, 0, 'dispose 必须撤 timer');
    clock.resurrectAll();
    assert.equal(host.writes.length, 1, 'dispose 之后任何回调都无权写宿主');
    controller.moveBy(4, 0);
    assert.equal(host.writes.length, 1, 'dispose 之后 moveBy 必须被忽略');
  });

  test('参考模型自洽：匹配器本身能区分等/不等（不为空集通过）', { skip: SKIP_CANDIDATE }, () => {
    const script = seededScript({ seed: 0xabcd, count: 40, gapMs: 10, trailing: [{ type: 'end' }] });
    const { reference, actual } = pair(TIGHT, script);
    assertSameWrites(reference.positions, reference.positions, '自洽：参考 vs 参考');
    assertWritesAreSubsequence(actual.positions, collapseAdjacent(reference.positions), '自洽：候选 ⊆ 参考');
    const wrong = reference.positions.map((position) => ({ x: position.x + 1, y: position.y }));
    assert.throws(() => assertSameWrites(actual.positions, wrong, '自洽反例'), /写入条数|不一致/, '匹配器必须能报错');
    const fabricated = [...actual.positions.slice(0, 1), { x: -12345, y: -12345 }];
    assert.throws(
      () => assertWritesAreSubsequence(fabricated, collapseAdjacent(reference.positions), '自洽反例'),
      /不是任何一步的逐事件结果/,
      '子序列匹配器必须拒绝凭空插值的位置',
    );
  });
});

function fail(message: string): never {
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// 不依赖候选的自检：参考模型口径 + 匹配器判别力
//
// 这一组在 C/B 落地前就能跑，用来证明"等价口径"本身是有判别力的，
// 而不是所有用例都 skip 掉、等着空过。
// ---------------------------------------------------------------------------

describe('参考模型口径与匹配器自检（不依赖候选）', () => {
  test('参考模型复现任务书两个反例与小数累加', () => {
    const docOne = runReference(DOC_ONE, [
      { type: 'move', dx: 5, dy: 0 },
      { type: 'move', dx: -5, dy: 0 },
    ]);
    assert.deepEqual(docOne.positions, [{ x: 10, y: 60 }, { x: 5, y: 60 }]);
    const docTwo = runReference(DOC_TWO, [
      { type: 'move', dx: 10, dy: 0 },
      { type: 'move', dx: -10, dy: 0 },
    ]);
    assert.deepEqual(docTwo.positions, [{ x: 100, y: 20 }, { x: 90, y: 20 }]);
    const fractional: ScriptEntry[] = [];
    for (let step = 0; step < 8; step += 1) fractional.push({ type: 'move', dx: 0.125, dy: 0.125 });
    assert.deepEqual(runReference(PLAIN, fractional).final, { x: 81, y: 81 });
  });

  test('参考模型：逐事件直写（写入数 = 事件数），贴边会写重复坐标', () => {
    const script: ScriptEntry[] = [];
    for (let step = 0; step < 20; step += 1) script.push({ type: 'move', dx: 3, dy: 0 });
    const outcome = runReference(TIGHT, script);
    assert.equal(outcome.positions.length, 20, '参考模型每事件都写一次');
    assert.equal(outcome.positions.at(-1)?.x, 40, '必须撞到右边');
  });

  test('collapseAdjacent 只折叠相邻重复坐标', () => {
    assert.deepEqual(collapseAdjacent([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 1 }]), [
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 1, y: 1 },
    ]);
    assert.deepEqual(collapseAdjacent([]), []);
  });

  test('assertSameWrites / assertWritesAreSubsequence 有判别力', () => {
    const expected: DragPosition[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
    assertSameWrites(expected, expected, '自洽');
    assert.throws(() => assertSameWrites(expected.slice(0, 2), expected, '条数不符'), /写入条数/);
    assert.throws(() => assertSameWrites([{ x: 9, y: 9 }], [{ x: 0, y: 0 }], '坐标不符'), /不一致/);

    // 机制替身：每 4 个事件合并成 1 次末位写 + 收尾 flush —— 只有子序列口径才应通过。
    const coalesced = expected.filter((_, index) => index % 4 === 3);
    assertWritesAreSubsequence(coalesced, expected, '合并子序列', { requireFinal: true });
    assert.throws(() => assertSameWrites(coalesced, expected, '合并后不得逐条相等'), /写入条数/);

    const outOfOrder: DragPosition[] = [{ x: 2, y: 0 }, { x: 1, y: 0 }];
    assert.throws(() => assertWritesAreSubsequence(outOfOrder, expected, '顺序倒置'), /不是任何一步的逐事件结果/);
    const fabricated: DragPosition[] = [{ x: 1.5, y: 0 }];
    assert.throws(
      () => assertWritesAreSubsequence(fabricated, expected, '凭空插值'),
      /不是任何一步的逐事件结果/,
      '合并只允许丢中间态，不允许造出没算过的位置',
    );
    assert.throws(
      () => assertWritesAreSubsequence([{ x: 0, y: 0 }], expected, '丢了末态', { requireFinal: true }),
      /末次写入必须等于参考末态/,
    );
  });

  test('固定 seed 的输入序列可复跑（同 seed 同序列）', () => {
    const first = seededScript({ seed: 0x5eed, count: 32, gapMs: 2, trailing: [{ type: 'end' }] });
    const second = seededScript({ seed: 0x5eed, count: 32, gapMs: 2, trailing: [{ type: 'end' }] });
    const other = seededScript({ seed: 0x5eee, count: 32, gapMs: 2, trailing: [{ type: 'end' }] });
    assert.deepEqual(first, second, '同 seed 必须逐条一致');
    assert.notDeepEqual(first, other, '不同 seed 应产生不同序列');
    assert.equal(first.at(-1)?.type, 'end', '收尾动作必须保留');
    assert.ok(
      first.some((entry) => entry.type === 'move' && (entry.dx === 0.125 || entry.dy === 0.125)),
      '序列里必须真的出现小数位移',
    );
  });
});
