/**
 * M3-11 D：正式入口两臂 e2e（真实 Electron / 真实 preload+main / 真实 X 指针）。
 *
 * 臂 = 关闭（`PET_NEXT_DRAG_WRITE_BUDGET` 未设）与开启（`=1`）。两臂只差这一个环境变量。
 *
 * 证据分层（docs/M3-11-DRAG-WRITE-BUDGET.md 第 6 节）：
 * - 真实指针拖动（xdotool）→ 落点等价 / 点击不误触 / 自主动作恢复 / 时延原始值；
 * - CDP 视口合成拖动 → **只做 500Hz 写入条数机制门**，明确不等于物理鼠标；
 * - 主进程 `{event:'bounds'}` 是 `setPosition` 已返回的软件提交，不是物理呈帧。
 *
 * not-run（本机不可测，不用 Linux 数据替代）：Windows 真实鼠标拖动、物理呈帧。
 *
 * 复跑：
 *   export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
 *   Xvfb :144 -screen 0 1920x1080x24 -nolisten tcp &
 *   DISPLAY=:144 pnpm build
 *   DISPLAY=:144 node --experimental-strip-types --test --test-concurrency=1 --test-reporter spec \
 *     tests/drag-write-budget/two-arm.e2e.test.ts
 * @module pet-next/tests/drag-write-budget/two-arm.e2e
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  dragWithCdp,
  delay,
  installPointerSampler,
  latencyEdges,
  median,
  openSession,
  readTrace,
  readVisual,
  realPointerDrag,
  requireDisplay,
  stopApp,
  waitFor,
  waitQuietWrites,
  wiringPresent,
  type Arm,
  type Point,
  type Session,
} from './support/app.ts';

const PET_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const wiring = wiringPresent();
const display = (() => {
  try {
    return requireDisplay();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
})();
const hasXdotool = (() => {
  try {
    execFileSync('xdotool', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** behavior-demo：自动动作冷却固定 1.6s，拖动后数秒内就能观察到恢复。 */
const BEHAVIOR_PREVIEW = 'short,behavior-demo';
const AUTO_RECOVERY_MS = 8000;

function skipReason(): string | false {
  if (!wiring.present) return wiring.reason;
  if (process.platform !== 'linux') return 'not-run: 真实指针拖动依赖 xdotool（Linux 验收通道）';
  if (!hasXdotool) return 'not-run: 缺少 xdotool';
  if (!display.startsWith(':')) return `not-run: ${display}`;
  return false;
}

const SKIP = skipReason();

let queue: Promise<void> = Promise.resolve();
/** 真实窗口串行：同一显示号上不许两个 Electron 同时抢指针。 */
function serial(body: () => Promise<void>): Promise<void> {
  const previous = queue;
  let release: () => void = () => {};
  queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  return previous.then(body).finally(release);
}

/** 起窗口：默认走已验收路径（无 preview 令牌），行为/companion 用例显式点名。 */
function open(arm: Arm, label: string, extraEnv: NodeJS.ProcessEnv = {}, preview = ''): Promise<Session> {
  return openSession({ arm, label, extraEnv, preview });
}

async function close(session: Session): Promise<Awaited<ReturnType<typeof stopApp>>> {
  return stopApp(session.app);
}

const realDrag = realPointerDrag;

function countClips(trace: string, clip: 'reaction' | 'auto'): number {
  return (trace.match(clip === 'reaction' ? /reaction-\d+/g : /\bauto-\d+/g) ?? []).length;
}

test('两臂真实指针拖动：最终窗口位置一致（DIP）、无 timer 残留、干净退出', { timeout: 240000, skip: SKIP }, async () => {
  await serial(async () => {
    const finals: Record<Arm, Point> = { off: { x: Number.NaN, y: Number.NaN }, on: { x: Number.NaN, y: Number.NaN } };
    const writes: Record<Arm, number> = { off: 0, on: 0 };

    for (const arm of ['off', 'on'] as const) {
      const session = await open(arm, `drag-${arm}`);
      let exit: Awaited<ReturnType<typeof stopApp>>;
      try {
        assert.equal(session.app.ready.displayCount, 1, '本轮只验收单屏');
        assert.equal(
          session.app.env['PET_NEXT_DRAG_WRITE_BUDGET'] === '1',
          arm === 'on',
          '两臂只许差 PET_NEXT_DRAG_WRITE_BUDGET 这一个开关',
        );
        const steps: Point[] = [];
        for (let step = 0; step < 6; step += 1) steps.push({ x: 8, y: 4 });
        const dragged = await realDrag(session, { steps, stepDelayMs: 20, settleMs: 60 });
        const last = dragged.lines.at(-1);
        assert.ok(last !== undefined, `臂 ${arm} 必须至少写一次宿主`);
        assert.deepEqual(last.requested, dragged.expectedFinal, `臂 ${arm} 落点必须等于指针位移`);
        finals[arm] = { x: last.requested.x, y: last.requested.y };
        writes[arm] = dragged.lines.length;

        // 松手后静置：候选臂若把 timer 漏在外面，这里会继续看到写入。
        const quiet = await waitQuietWrites(session.app, 300);
        assert.equal(
          quiet.after,
          quiet.before,
          `臂 ${arm} 在拖动结束后仍有 ${quiet.after - quiet.before} 次迟到的 setPosition（疑似 timer 泄漏）`,
        );
        const trace = await readTrace(session.app.cdp);
        console.log(
          JSON.stringify({ event: 'drag-write-budget-arm', arm, final: finals[arm], writes: writes[arm], trace: trace.slice(-160) }),
        );
      } finally {
        exit = await close(session);
      }
      assert.equal(exit.exitCode, 0, `臂 ${arm} 退出码必须为 0`);
      assert.equal(exit.timedOut, false, `臂 ${arm} 未在超时内退出`);
      assert.equal(exit.portClosed, true, `臂 ${arm} 调试端口未释放`);
      assert.deepEqual(exit.alivePids, [], `臂 ${arm} 退出后仍有残留进程`);
      assert.equal(exit.writesAfterQuit, exit.writesAtQuit, `臂 ${arm} 退出过程中不得再写宿主`);
    }

    assert.deepEqual(finals.on, finals.off, `两臂最终位置必须一致：on=${JSON.stringify(finals.on)} off=${JSON.stringify(finals.off)}`);
    console.log(JSON.stringify({ event: 'two-arm-final', off: finals.off, on: finals.on, writes }));
  });
});

test('真实拖动不误触点击：单击恰 1 次 reaction，拖动 0 次', { timeout: 240000, skip: SKIP }, async () => {
  await serial(async () => {
    for (const arm of ['off', 'on'] as const) {
      const session = await open(arm, `click-${arm}`, {}, BEHAVIOR_PREVIEW);
      try {
        await waitFor('待机首帧', () => readVisual(session.app.cdp), (state) => state.visual === 'idle', 15000);
        const { geometry } = session;
        const clickPoint = { x: geometry.x + 40, y: geometry.y + 40 };
        const beforeClick = await readTrace(session.app.cdp);
        execFileSync('xdotool', ['mousemove', '--sync', String(clickPoint.x), String(clickPoint.y)], {
          stdio: 'ignore',
          env: { ...process.env, DISPLAY: display },
        });
        execFileSync('xdotool', ['click', '1'], { stdio: 'ignore', env: { ...process.env, DISPLAY: display } });
        const afterClick = await waitFor(
          '点击回应',
          () => readTrace(session.app.cdp),
          (trace) => countClips(trace, 'reaction') > countClips(beforeClick, 'reaction'),
          8000,
        );
        assert.equal(
          countClips(afterClick, 'reaction') - countClips(beforeClick, 'reaction'),
          1,
          `臂 ${arm}：单击必须恰产生 1 次 reaction`,
        );

        const steps: Point[] = [];
        for (let step = 0; step < 6; step += 1) steps.push({ x: 8, y: 4 });
        await realDrag(session, { steps, stepDelayMs: 20, settleMs: 60 });
        const afterDrag = await readTrace(session.app.cdp);
        assert.equal(
          countClips(afterDrag, 'reaction'),
          countClips(afterClick, 'reaction'),
          `臂 ${arm}：拖动不得误触点击（trace=${afterDrag.slice(-200)}）`,
        );
        console.log(JSON.stringify({ event: 'click-vs-drag', arm, reactions: countClips(afterDrag, 'reaction') }));
      } finally {
        await close(session);
      }
    }
  });
});

test('拖动后 standard 自主动作恢复（拖动不再永久停摆）', { timeout: 240000, skip: SKIP }, async () => {
  await serial(async () => {
    for (const arm of ['off', 'on'] as const) {
      const session = await open(arm, `auto-standard-${arm}`, {}, BEHAVIOR_PREVIEW);
      try {
        await waitFor('待机首帧', () => readVisual(session.app.cdp), (state) => state.visual === 'idle', 15000);
        const steps: Point[] = [];
        for (let step = 0; step < 6; step += 1) steps.push({ x: 6, y: 3 });
        await realDrag(session, { steps, stepDelayMs: 20, settleMs: 60 });
        const state = await readVisual(session.app.cdp);
        assert.equal(state.dragging, false, `臂 ${arm}：松手后 body.dragging 必须清零`);
        const recovered = await waitFor(
          '拖动后自主动作',
          async () => ({ trace: await readTrace(session.app.cdp), visual: await readVisual(session.app.cdp) }),
          (value) => countClips(value.trace, 'auto') > 0,
          AUTO_RECOVERY_MS,
        );
        console.log(
          JSON.stringify({ event: 'auto-recovered', arm, experience: 'standard', visual: recovered.visual.visual }),
        );
      } finally {
        await close(session);
      }
    }
  });
});

test('拖动后 companion 自主动作恢复（模型只走本地 fake，零真实 POST）', { timeout: 240000, skip: SKIP }, async () => {
  await serial(async () => {
    const fake = await startFakeModel();
    try {
      for (const arm of ['off', 'on'] as const) {
        const session = await open(arm, `auto-companion-${arm}`, {
          PET_NEXT_EXPERIENCE: 'companion',
          PET_NEXT_CHAT_PREVIEW: '1',
          PET_NEXT_CHAT_FAKE_URL: fake.url,
        }, BEHAVIOR_PREVIEW);
        try {
          assert.equal(session.app.env['PET_NEXT_CHAT_LOCAL'], undefined, '不得注入真实 local 模型地址');
          assert.ok(!session.app.stdout().includes('18872'), '不得出现 18872 相关配置');
          const mode = await waitFor(
            '聊天模式',
            async () => session.app.stdout(),
            (text) => text.includes('"event":"chat-mode"'),
            15000,
          );
          assert.ok(mode.includes('"experience":"companion"'), `companion 臂必须真的进入 companion 体验：${mode.slice(-300)}`);
          await waitFor('待机首帧', () => readVisual(session.app.cdp), (state) => state.visual === 'idle', 15000);
          const steps: Point[] = [];
          for (let step = 0; step < 6; step += 1) steps.push({ x: 6, y: 3 });
          await realDrag(session, { steps, stepDelayMs: 20, settleMs: 60 });
          const recovered = await waitFor(
            '拖动后 companion 自主动作',
            () => readTrace(session.app.cdp),
            (trace) => countClips(trace, 'auto') > 0,
            AUTO_RECOVERY_MS,
          );
          assert.equal(await fake.posts(), 0, '本轮不得有任何模型 POST（自主动作不经过模型）');
          console.log(
            JSON.stringify({
              event: 'auto-recovered',
              arm,
              experience: 'companion',
              trace: recovered.slice(-160),
              fakePosts: await fake.posts(),
            }),
          );
        } finally {
          await close(session);
        }
      }
    } finally {
      await fake.stop();
    }
  });
});

test('500Hz CDP 合成压力臂：主进程写入减少 ≥50%（仅机制门，不等于物理鼠标）', { timeout: 240000, skip: SKIP }, async () => {
  await serial(async () => {
    const observed: Record<Arm, { dispatched: number; writes: number; final: Point | null }> = {
      off: { dispatched: 0, writes: 0, final: null },
      on: { dispatched: 0, writes: 0, final: null },
    };
    for (const arm of ['off', 'on'] as const) {
      const session = await open(arm, `stress-${arm}`);
      try {
        const before = session.app.boundsLines().length;
        const steps: Point[] = [];
        for (let step = 0; step < 400; step += 1) steps.push({ x: 1, y: 0 });
        const run = await dragWithCdp(session.app.cdp, { from: { x: 40, y: 100 }, steps, stepDelayMs: 2 });
        await delay(250);
        const lines = session.app.boundsLines().slice(before);
        observed[arm] = { dispatched: run.dispatched, writes: lines.length, final: lines.at(-1)?.requested ?? null };
        console.log(
          JSON.stringify({
            event: 'stress-500hz',
            arm,
            synthetic: 'cdp-Input.dispatchMouseEvent',
            dispatched: run.dispatched,
            mainWrites: lines.length,
            elapsedMs: run.endedAt - run.startedAt,
            final: observed[arm].final,
          }),
        );
      } finally {
        await close(session);
      }
    }
    assert.ok(observed.off.dispatched > 300, '基线臂必须真的收到压力事件');
    assert.ok(observed.off.writes > 0, '基线臂必须真的有写入');
    const reduction = 1 - observed.on.writes / observed.off.writes;
    assert.ok(
      reduction >= 0.5,
      `机制门未过：开启臂写入 ${observed.on.writes} / 基线 ${observed.off.writes}（减少 ${(reduction * 100).toFixed(1)}%，要求 ≥50%）`,
    );
    console.log(
      JSON.stringify({
        event: 'stress-500hz-summary',
        off: observed.off,
        on: observed.on,
        reductionPercent: Number((reduction * 100).toFixed(1)),
        note: 'CDP 合成输入；screenX 由窗口原点推出，与物理鼠标不同口径，仅用于机制门',
      }),
    );
  });
});

test('60/125Hz 真实指针：输入→软件提交时延原始值（首写/末写/中位）+ 不新增 >8ms 主动等待', { timeout: 300000, skip: SKIP }, async () => {
  await serial(async () => {
    /** 每个手势只取两端：首写（越阈值那一下）与末写（松手 flush 落地）。 */
    const GESTURES = 6;
    const steps: Point[] = [{ x: 30, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0 }];

    interface ArmRate {
      readonly arm: Arm;
      readonly hz: number;
      readonly first: number[];
      readonly last: number[];
      readonly writes: number[];
      readonly medianFirst: number;
      readonly medianLast: number;
      readonly medianAll: number;
    }
    const results: ArmRate[] = [];

    for (const arm of ['off', 'on'] as const) {
      const session = await open(arm, `latency-${arm}`);
      try {
        await waitFor('待机首帧', () => readVisual(session.app.cdp), (state) => state.visual === 'idle', 15000);
        await installPointerSampler(session.app.cdp);
        for (const hz of [60, 125] as const) {
          const first: number[] = [];
          const last: number[] = [];
          const writes: number[] = [];
          for (let gesture = 0; gesture < GESTURES; gesture += 1) {
            const dragged = await realDrag(session, { steps, stepDelayMs: Math.round(1000 / hz), settleMs: 120 });
            const edge = latencyEdges(dragged.lines, dragged.samples);
            assert.ok(Number.isFinite(edge.first) && Number.isFinite(edge.last), `臂 ${arm} ${hz}Hz：手势两端必须可配对`);
            assert.equal(
              dragged.lines.at(-1)?.requested.x,
              dragged.expectedFinal.x,
              `臂 ${arm} ${hz}Hz：末次写入必须落在指针终点（不允许等 timer 才提交）`,
            );
            first.push(edge.first);
            last.push(edge.last);
            writes.push(edge.writes);
          }
          const all = [...first, ...last];
          const entry: ArmRate = {
            arm,
            hz,
            first,
            last,
            writes,
            medianFirst: median(first),
            medianLast: median(last),
            medianAll: median(all),
          };
          results.push(entry);
          console.log(JSON.stringify({ event: 'latency-sample', ...entry }));
        }
      } finally {
        await close(session);
      }
    }

    for (const hz of [60, 125] as const) {
      const off = results.find((item) => item.arm === 'off' && item.hz === hz);
      const on = results.find((item) => item.arm === 'on' && item.hz === hz);
      assert.ok(off !== undefined && on !== undefined, `${hz}Hz 两臂样本都要有`);
      assert.ok(
        on.medianAll - off.medianAll <= 8,
        `${hz}Hz 时延中位新增 ${(on.medianAll - off.medianAll).toFixed(1)}ms 超过计划 8ms`,
      );
      assert.ok(on.medianFirst - off.medianFirst <= 8, `${hz}Hz 首写被延迟 ${(on.medianFirst - off.medianFirst).toFixed(1)}ms（首写不得等 timer）`);
      assert.ok(on.medianLast - off.medianLast <= 8, `${hz}Hz 末写被延迟 ${(on.medianLast - off.medianLast).toFixed(1)}ms（末写不得等 timer）`);
    }
    console.log(JSON.stringify({ event: 'latency-summary', results }));
  });
});

interface FakeModel {
  readonly url: string;
  posts(): Promise<number>;
  stop(): Promise<void>;
}

/** 本地 fake 模型服务：只为证明"没有真实 POST"，本轮不会真的发聊天请求。 */
async function startFakeModel(): Promise<FakeModel> {
  const logDir = await mkdtemp(path.join(tmpdir(), 'pet-next-dwb-fake-'));
  const logFile = path.join(logDir, 'requests.ndjson');
  const child = spawn(process.execPath, ['tests/support/fake-model-service.mjs'], {
    cwd: PET_ROOT,
    env: { ...process.env, FAKE_MODEL_ID: 'qwen3.8-27b', FAKE_MODEL_DELAY_MS: '0', FAKE_MODEL_LOG: logFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  const port = await new Promise<number>((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = (): void => {
      const match = /"port":(\d+)/.exec(stdout);
      if (match?.[1] !== undefined) {
        resolve(Number(match[1]));
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`fake model 未就绪：${stdout}`));
        return;
      }
      setTimeout(poll, 30);
    };
    poll();
  });
  return {
    url: `http://127.0.0.1:${port}`,
    async posts() {
      try {
        const text = await readFile(logFile, 'utf8');
        return text.split('\n').filter((line) => line.trim().length > 0).length;
      } catch {
        return 0;
      }
    },
    async stop() {
      child.kill('SIGKILL');
      await delay(80);
      await rm(logDir, { recursive: true, force: true });
    },
  };
}
