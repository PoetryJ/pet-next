/**
 * 基础设施自检：**只跑关闭臂**（现有产品路径），验证 e2e 脚手架本身可用。
 *
 * 这不是验收结论：候选臂（开关=1）需要公共接线 + adapters/window/drag-write-budget.ts 落地。
 * 它的用途是在依赖缺席时证明"启动/真实指针拖动/写入计数/时延配对/退出清理"这套测量链路
 * 本身是通的，不是空跑。
 *
 * 复跑：
 *   DISPLAY=:144 node --experimental-strip-types tests/drag-write-budget/selfcheck-off-arm.ts
 * @module pet-next/tests/drag-write-budget/selfcheck-off-arm
 */
import assert from 'node:assert/strict';

import {
  delay,
  installPointerSampler,
  latencyEdges,
  median,
  openSession,
  readTrace,
  readVisual,
  realPointerDrag,
  stopApp,
  waitFor,
  waitQuietWrites,
  type Point,
} from './support/app.ts';

// 首步必须一步越过 5px 拖动阈值：这样"首写"与"第一次 pointermove"是同一个事件，
// 首写时延才不会被阈值前的那几步污染（与 two-arm.e2e 的手势形状一致）。
const steps: Point[] = [{ x: 30, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0 }];

const session = await openSession({ arm: 'off', label: 'selfcheck-off', preview: 'short,behavior-demo' });
try {
  await waitFor('待机首帧', () => readVisual(session.app.cdp), (state) => state.visual === 'idle', 15000);
  await installPointerSampler(session.app.cdp);
  const dragged = await realPointerDrag(session, { steps, stepDelayMs: 16, settleMs: 40 });
  const quiet = await waitQuietWrites(session.app, 200);
  const edge = latencyEdges(dragged.lines, dragged.samples);
  const trace = await readTrace(session.app.cdp);

  assert.ok(dragged.lines.length > 0, '关闭臂必须真的写宿主');
  assert.deepEqual(dragged.lines.at(-1)?.requested, dragged.expectedFinal, '落点必须等于指针位移');
  assert.equal(quiet.after, quiet.before, '拖动结束后不得有迟到写入');
  assert.ok(Number.isFinite(edge.first) && Number.isFinite(edge.last), '手势两端时延必须可测');
  // demo 节奏的自动动作冷却是 1600ms，从松手起算；给足余量再判定。
  const deadline = Date.now() + 8000;
  let afterIdle = await readTrace(session.app.cdp);
  while (!/auto-\d+/.test(afterIdle) && Date.now() < deadline) {
    await delay(120);
    afterIdle = await readTrace(session.app.cdp);
  }
  assert.ok(/auto-\d+/.test(afterIdle), `拖动后自主动作必须恢复（trace=${afterIdle.slice(-120)}）`);

  console.log(
    JSON.stringify({
      event: 'selfcheck-off-arm',
      writes: dragged.lines.length,
      from: dragged.base,
      to: dragged.expectedFinal,
      latency: {
        first: edge.first,
        last: edge.last,
        median: median([edge.first, edge.last]),
        moves: edge.moves,
      },
      trace: trace.slice(-120),
      traceAfterIdle: afterIdle.slice(-160),
    }),
  );
} finally {
  const exit = await stopApp(session.app);
  console.log(JSON.stringify({ event: 'selfcheck-exit', ...exit }));
  assert.equal(exit.exitCode, 0, '关闭臂退出码必须为 0');
  assert.equal(exit.portClosed, true, '调试端口未释放');
  assert.deepEqual(exit.alivePids, [], '退出后有残留进程');
}
