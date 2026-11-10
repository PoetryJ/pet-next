/**
 * M3-11 A：trace 生成器 + 纯分析函数 + 纯 trace 回放的结构性单测。
 *
 * 这些用例不碰 Electron、不 sleep、不用真实时钟：
 * - 生成器/分析函数是 bench 侧唯一的判定逻辑，错了会直接把结论带偏；
 * - 回放用例把固定 seed 的位移序列喂给**产品原样的** gesture + window controller，
 *   用假宿主记录 setPosition 次数，给出“每条输入一次写”的结构事实（不是运行时测量）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowController } from '../../adapters/window/controller.ts';
import { initialGestureState, reduceGesture } from '../../core/interaction/gesture.ts';
import {
  analyzePointerEvents,
  analyzeWrites,
  bucketCounts,
  collectWrites,
  cpuDelta,
  duplicateWrites,
  inputToWriteLatency,
  intervalsOf,
  median,
  parseProcStat,
  projectBudget,
  sameWindowPairs,
  summarize,
} from './lib/analysis.mjs';
import { DEFAULT_SEED, buildScreenPath, generateTrace, parseTrace, serializeTrace, sumDelta } from './lib/trace.mjs';

const DRAG_THRESHOLD_PX = 5;

test('trace 生成器：同 seed 同序列，换 seed 变序列', () => {
  const a = generateTrace({ seed: 7, hz: 125, moves: 64 });
  const b = generateTrace({ seed: 7, hz: 125, moves: 64 });
  const c = generateTrace({ seed: 8, hz: 125, moves: 64 });
  assert.deepEqual(a.steps, b.steps);
  assert.notDeepEqual(a.steps, c.steps);
  assert.equal(a.steps.length, 64);
  assert.equal(DEFAULT_SEED, 20261110);
});

test('trace 生成器：每 8 步零和循环，整条 trace 有界', () => {
  const trace = generateTrace({ seed: DEFAULT_SEED, hz: 500, moves: 320 });
  const firstCycle = trace.steps.slice(0, 8);
  const sum = sumDelta(firstCycle);
  assert.equal(sum.dx, 0);
  assert.equal(sum.dy, 0);
  let x = 0;
  let y = 0;
  let maxAbs = 0;
  for (const step of trace.steps) {
    x += step.dx;
    y += step.dy;
    maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y));
  }
  assert.ok(maxAbs <= 24, `轨迹必须有界（实际最大偏移 ${maxAbs}）`);
  assert.ok(
    trace.steps.some((step) => !Number.isInteger(step.dx) || !Number.isInteger(step.dy)),
    '必须含小数增量（覆盖取整后的重复坐标）',
  );
  assert.ok(trace.steps.some((step) => step.dx === 0 && step.dy === 0), '必须含零位移步骤（gesture 不产生 drag-move）');
});

test('trace 序列化可往返；坏数值要被拒绝', () => {
  const trace = generateTrace({ seed: 3, hz: 60, moves: 24 });
  const parsed = parseTrace(serializeTrace(trace));
  assert.equal(parsed.seed, 3);
  assert.equal(parsed.hz, 60);
  assert.deepEqual(parsed.steps, trace.steps);
  assert.throws(() => parseTrace('{"event":"trace-step","i":0,"dtMs":1,"dx":"x","dy":0}\n'), TypeError);
});

test('cdp 屏幕轨迹净位移有界且递推自洽', () => {
  const steps = buildScreenPath({ hz: 125, moves: 200, ax: 60, ay: 40, f: 0.6 });
  let x = 0;
  let y = 0;
  for (const step of steps) {
    x += step.dx;
    y += step.dy;
  }
  const last = steps.at(-1);
  assert.ok(last);
  const t = last.tMs / 1000;
  assert.ok(Math.abs(x - 60 * Math.sin(2 * Math.PI * 0.6 * t)) < 1e-3);
  assert.ok(Math.abs(y - 40 * Math.sin(2 * Math.PI * 0.9 * t)) < 1e-3);
  assert.ok(Math.abs(x) <= 60.001 && Math.abs(y) <= 40.001);
});

test('median/summarize/intervalsOf 只报中位数与原始值', () => {
  assert.equal(median([]), null);
  assert.equal(median([3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.deepEqual(intervalsOf([10, 16, 30]), [6, 14]);
  const summary = summarize([1, 2, 3]);
  assert.equal(summary.count, 3);
  assert.equal(summary.medianMs, 2);
  assert.equal(summary.minMs, 1);
  assert.equal(summary.maxMs, 3);
  assert.equal('p95Ms' in summary, false);
});

test('同 8ms 窗口判定：严格小于，恰好 8ms 不算', () => {
  const pairs = sameWindowPairs([0, 16.7, 33.4], 8);
  assert.equal(pairs.pairCount, 0);
  const tight = sameWindowPairs([0, 2, 4, 20], 8);
  assert.equal(tight.pairCount, 2);
  assert.equal(tight.ratioOfWrites, 0.5);
  assert.equal(sameWindowPairs([0, 8], 8).pairCount, 0);
  assert.equal(sameWindowPairs([0, 7.999], 8).pairCount, 1);
  const buckets = bucketCounts([0, 1, 2, 9], 8);
  assert.equal(buckets.maxPerBucket, 3);
  assert.equal(buckets.writesInMultiBucket, 3);
});

test('离线 8ms 投影：首写即时、按预算写 pending、结束 flush（纸面值）', () => {
  assert.equal(projectBudget([], 8).projectedWrites, 0);
  // 0 立即写；1/2/3 进 pending；定时器在 8 写出 3；20 距 8 有 12ms 再写 → 3 次。
  assert.equal(projectBudget([0, 1, 2, 3, 20], 8).projectedWrites, 3);
  // 成对突发的真实形状：写 0；timer@8 写 pending；8.4 进 pending；timer@16 写；结束 flush 17.1。
  assert.equal(projectBudget([0, 0.3, 8.4, 8.7, 16.8, 17.1], 8).projectedWrites, 4);
  // 0 立即写；2/4/6 都进 pending，序列结束 flush 一次 → 2 次。
  assert.equal(projectBudget([0, 2, 4, 6], 8).projectedWrites, 2);
  // 60Hz 输入本来就不该被合并。
  const sixty = projectBudget(Array.from({ length: 61 }, (_, i) => i * 16.7), 8);
  assert.equal(sixty.projectedWrites, 61);
  assert.equal(sixty.reduction, 0);
  // 500Hz 输入：只剩 ~125Hz。
  const fiveHundred = projectBudget(Array.from({ length: 501 }, (_, i) => i * 2), 8);
  assert.ok(fiveHundred.reduction >= 0.7, `500Hz 投影应显著减少（实际 ${fiveHundred.reduction}）`);
});

test('相同坐标重复写只算相邻重复', () => {
  const writes = [
    { at: 1, requested: { x: 10, y: 10 } },
    { at: 2, requested: { x: 10, y: 10 } },
    { at: 3, requested: { x: 11, y: 10 } },
    { at: 4, requested: { x: 10, y: 10 } },
  ];
  const dup = duplicateWrites(writes);
  assert.equal(dup.count, 1);
  assert.equal(dup.distinctCoordinates, 2);
  assert.equal(dup.pairs[0]?.index, 1);
});

test('/proc stat 解析能吃下带空格/括号的 comm', () => {
  const line =
    '4242 (electron main (x)) S 1 4242 4242 0 -1 4194304 12345 0 0 0 137 42 0 0 20 0 12 0 999 123456789 1234 18446744073709551615';
  const stat = parseProcStat(line);
  assert.equal(stat.utime, 137);
  assert.equal(stat.stime, 42);
  assert.equal(stat.ticks, 179);
  const cpu = cpuDelta({ ticks: 179 }, { ticks: 379 }, { hz: 100, wallMs: 2000, writes: 100 });
  assert.equal(cpu.cpuSeconds, 2);
  assert.equal(cpu.cpuPercentOfWall, 100);
  assert.equal(cpu.cpuSecondsPerWrite, 0.02);
});

test('collectWrites 只认 main 自己打印的 bounds 行', () => {
  const records = [
    // 入口链会给子进程每行加 `[electron] ` 前缀，必须照样认出来。
    {
      at: 1,
      chunkSeq: 0,
      line: '[electron] {"event":"bounds","bounds":{"x":1,"y":2},"requested":{"x":1,"y":2},"physical":{"x":1,"y":2}}\r',
    },
    { at: 2, chunkSeq: 0, line: '{"event":"chat-mode","mode":"local"}' },
    { at: 3, chunkSeq: 1, line: 'not json' },
    { at: 4, chunkSeq: 1, line: '{"event":"bounds","requested":{"x":null,"y":2}}' },
    { at: 5, chunkSeq: 1, line: '{"event":"bounds","requested":{"x":3,"y":4},"bounds":{"x":3,"y":4}}' },
  ];
  const collected = collectWrites(records as never);
  assert.equal(collected.writes.length, 2);
  assert.equal(collected.rows.length, 2);
});

test('analyzeWrites / analyzePointerEvents：60Hz 与 500Hz 的间隔差直接被看到', () => {
  const at60 = Array.from({ length: 61 }, (_, i) => i * (1000 / 60));
  const at500 = Array.from({ length: 61 }, (_, i) => i * 2);
  const writes60 = analyzeWrites(at60.map((at) => ({ at, requested: { x: 1, y: 1 } })));
  const writes500 = analyzeWrites(at500.map((at, i) => ({ at, requested: { x: i, y: 1 } })));
  assert.equal(writes60.sameWindow.pairCount, 0);
  assert.ok(writes500.sameWindow.pairCount > 50);
  assert.ok((writes60.intervalMs.medianMs ?? 0) > 16);
  assert.equal(writes500.intervalMs.medianMs, 2);

  const pointer = analyzePointerEvents(
    [
      { type: 'pointerdown', t: 0, screenX: 100, screenY: 100 },
      { type: 'pointermove', t: 2, screenX: 100, screenY: 100 },
      { type: 'pointermove', t: 4, screenX: 106, screenY: 100 },
      { type: 'pointermove', t: 6, screenX: 112, screenY: 100 },
      { type: 'pointerup', t: 8, screenX: 112, screenY: 100 },
    ],
    { thresholdPx: DRAG_THRESHOLD_PX },
  );
  assert.equal(pointer.pointermove, 3);
  assert.equal(pointer.dragStartMoveIndex, 1);
  assert.equal(pointer.moveAfterDragStart, 2);
  assert.equal(pointer.moveWithNonZeroScreenDelta, 2);
  assert.equal(pointer.arrivalRateHz, 500);
});

test('输入→写入延迟配对：不配对的部分要显式报出来', () => {
  const result = inputToWriteLatency([100, 200, 300], [110, 215]);
  assert.equal(result.paired, 2);
  assert.equal(result.unpairedInputs, 1);
  assert.equal(result.latencyMs.medianMs, 12.5);
});

/** 假宿主：setPosition 立即改变 getBounds 的回读，等价真实窗口行为。 */
function createHost(options: { x: number; y: number; width: number; height: number; workArea: { x: number; y: number; width: number; height: number } }) {
  const bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
  const writes: Array<{ x: number; y: number }> = [];
  const host = {
    getBounds() {
      return { ...bounds };
    },
    setPosition(x: number, y: number) {
      bounds.x = x;
      bounds.y = y;
      writes.push({ x, y });
    },
    workAreaFor() {
      return options.workArea;
    },
    quit() {
      /* 回放不退出 */
    },
  };
  return { host, writes, bounds };
}

/** 把 trace 的位移序列喂给产品原样的 gesture → controller。 */
function replay(options: {
  steps: Array<{ dx: number; dy: number }>;
  start: { x: number; y: number };
  workArea: { x: number; y: number; width: number; height: number };
}) {
  const { host, writes } = createHost({ ...options.start, width: 320, height: 240, workArea: options.workArea });
  const controller = createWindowController(host as never);
  let state = initialGestureState();
  let x = 500;
  let y = 300;
  state = reduceGesture(state, { type: 'pointerdown', pointerId: 1, x, y }, DRAG_THRESHOLD_PX).state;
  for (const step of options.steps) {
    x += step.dx;
    y += step.dy;
    const reduction = reduceGesture(state, { type: 'pointermove', pointerId: 1, x, y }, DRAG_THRESHOLD_PX);
    state = reduction.state;
    for (const effect of reduction.effects) {
      if (effect.type === 'drag-move') controller.moveBy(effect.dx, effect.dy);
    }
  }
  state = reduceGesture(state, { type: 'pointerup', pointerId: 1, x, y }, DRAG_THRESHOLD_PX).state;
  assert.equal(state.phase, 'idle');
  return { writes };
}

test('纯 trace 回放：每条非零位移恰一次 setPosition，零位移不写', () => {
  const trace = generateTrace({ seed: DEFAULT_SEED, hz: 125, moves: 96 });
  const { writes } = replay({
    steps: trace.steps,
    start: { x: 200, y: 200 },
    workArea: { x: 0, y: 0, width: 4000, height: 3000 },
  });
  const nonZero = trace.steps.filter((step) => step.dx !== 0 || step.dy !== 0).length;
  // 第一步位移超过阈值 → 产生 drag-start + drag-move（各一次），所以写数 = 非零步数。
  assert.equal(writes.length, nonZero);
});

test('纯 trace 回放：夹边会产成相同坐标的重复写（结构事实，不是运行时结论）', () => {
  const steps = Array.from({ length: 6 }, () => ({ dx: 6, dy: 0 }));
  // 工作区右边界 1000，窗口宽 320 → 最大 x = 680；起点 670 一路向右，从第三次起被夹住。
  const { writes } = replay({ steps, start: { x: 670, y: 100 }, workArea: { x: 0, y: 0, width: 1000, height: 800 } });
  assert.equal(writes.length, 6);
  const dup = duplicateWrites(writes.map((write, index) => ({ at: index, requested: write })));
  assert.ok(dup.count >= 3, `夹边后必须出现重复坐标写（实际 ${dup.count}）`);
});

test('纯 trace 回放：小数增量累积后整数取整也会产生重复写', () => {
  // 拖动阈值 5px：0.4 步进要到第 13 步才越过阈值，所以序列必须长于阈值所需的步数。
  const steps = Array.from({ length: 24 }, () => ({ dx: 0.4, dy: 0 }));
  const { writes } = replay({ steps, start: { x: 200, y: 100 }, workArea: { x: 0, y: 0, width: 4000, height: 3000 } });
  const dup = duplicateWrites(writes.map((write, index) => ({ at: index, requested: write })));
  assert.ok(dup.count > 0, '0.4 DIP 步进在 round 后必然出现相邻相同坐标');
});
