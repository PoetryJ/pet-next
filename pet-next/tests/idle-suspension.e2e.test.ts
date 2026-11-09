/**
 * M3-9 待机节能预览的真实窗口 e2e。
 *
 * 用真实 Electron 与真实的 `BrowserWindow.hide()/show()/minimize()/restore()` 驱动，
 * 不用 xdotool unmap 冒充窗口信号；每个用例独占运行目录与自起 Xvfb（复用 test-run-context）。
 * @module pet-next/tests/idle-suspension.e2e.test
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { aliveTracked, closePet, evaluate, mouse, openPet, type PetSession } from './platform/session.ts';

// scripts/test-run-context.mjs 是无类型声明的 .mjs 工具；这里只用两个工厂。
// @ts-expect-error 缺少 .d.ts
const isolation = (await import('../scripts/test-run-context.mjs')) as {
  createRunContext(options: { label: string; kind: string }): RunContext;
  startOwnXvfb(options: { label: string }): Promise<OwnDisplay>;
};

const IS_WINDOWS = process.platform === 'win32';

interface RunContext {
  dir: string;
  logDir: string;
  cleanup(options?: { keepDir?: boolean }): Promise<void>;
}

interface OwnDisplay {
  display: string;
  stop(): Promise<void>;
}

/**
 * 独占显示器：Windows 用原生桌面，不强制 Xvfb/openbox（也不改系统显示设置），
 * 因此 win32 返回空 display 且 stop 为 no-op；Linux 仍由 test-run-context 起本轮独占 Xvfb。
 */
async function startOwnXvfb(options: { label: string }): Promise<OwnDisplay> {
  if (IS_WINDOWS) return { display: '', stop: async () => {} };
  return isolation.startOwnXvfb(options);
}

interface DebugState {
  enabled: boolean;
  revision: number | null;
  hidden: boolean;
  generation: number | null;
  phase: string | null;
  clip: string | null;
  lease: { generation: number; slot: string; elementIdentity: string } | null;
  pauseCount: number;
  resumeCount: number;
  lastAction: string;
  lastSkipReason: string | null;
}

const READ_STATE =
  'window.__petIdleSuspension ? JSON.parse(JSON.stringify(window.__petIdleSuspension)) : null';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readState(session: PetSession): Promise<DebugState | null> {
  return evaluate<DebugState | null>(session.cdp, READ_STATE);
}

/** 读一次计数基线：读不到就失败，不用 0 兜底（否则相对断言会变成空断言）。 */
async function readRequired(session: PetSession, label: string): Promise<DebugState> {
  const state = await readState(session);
  if (state === null) throw new Error(`${label}: 观测面未就绪`);
  return state;
}

async function waitState(
  session: PetSession,
  label: string,
  ok: (state: DebugState) => boolean,
  timeoutMs = 20000,
): Promise<DebugState> {
  const deadline = Date.now() + timeoutMs;
  let last: DebugState | null = null;
  while (Date.now() < deadline) {
    last = await readState(session);
    if (last !== null && ok(last)) return last;
    await delay(50);
  }
  throw new Error(`${label} state=${JSON.stringify(last)}\nstdout=${session.stdout()}\nstderr=${session.stderr()}`);
}

async function act(session: PetSession, action: string): Promise<{ visible: boolean; minimized: boolean }> {
  return evaluate<{ visible: boolean; minimized: boolean }>(
    session.cdp,
    `window.petTestWindow.act(${JSON.stringify(action)})`,
  );
}

async function clipPaused(session: PetSession): Promise<boolean> {
  return evaluate<boolean>(session.cdp, 'document.querySelector("#clip").paused');
}

async function launch(options: {
  label: string;
  display: string;
  userData: string;
  idlePause: boolean;
}): Promise<PetSession> {
  return openPet({
    label: options.label,
    forced: null,
    env: {
      // win32 走原生桌面，不注入空的 DISPLAY（空串会让 X 相关代码路径误判）。
      ...(options.display === '' ? {} : { DISPLAY: options.display }),
      PET_NEXT_USER_DATA: options.userData,
      ...(options.idlePause ? { PET_NEXT_IDLE_PAUSE: '1' } : {}),
    },
  });
}

interface WindowManager {
  /** openbox 不存在时 false：本用例会 skip，而不是把机制缺失伪装成绿灯。 */
  available: boolean;
  stop(): void;
}

/**
 * 最小化必须有窗口管理器才会真正翻转 `isMinimized()`：裸 Xvfb 下
 * `XIconifyWindow` 无人处理，`win.minimize()` 后 `isMinimized()` 仍为 false。
 * 实测（无 WM 的 :122）minimize 后 15s 内 minimized 始终 false；:121+openbox 下立即变 true。
 * Windows 自带窗口管理器，不需要也不应起 openbox：直接按可用处理。
 */
async function startWm(display: string): Promise<WindowManager> {
  if (IS_WINDOWS) return { available: true, stop() {} };
  const child = spawn('openbox', [], { env: { ...process.env, DISPLAY: display }, stdio: 'ignore' });
  const spawnError = await new Promise<Error | null>((resolve) => {
    let settled = false;
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      resolve(error);
    };
    child.once('error', (error) => finish(error));
    child.once('exit', () => finish(new Error('openbox 提前退出')));
    setTimeout(() => finish(null), 1200);
  });
  return {
    available: spawnError === null && child.exitCode === null,
    stop() {
      try {
        child.kill('SIGTERM');
      } catch {
        // 已退出。
      }
    },
  };
}

test('默认关闭：不创建观测面、不加窗口监听，隐藏不影响播放', async () => {
  const ctx = isolation.createRunContext({ label: 'm39-off', kind: 'e2e' });
  const xvfb = await startOwnXvfb({ label: 'm39-off' });
  let session: PetSession | undefined;
  try {
    session = await launch({ label: 'm39-off', display: xvfb.display, userData: `${ctx.dir}/userData`, idlePause: false });
    const active = session;
    await delay(1500);
    assert.equal(await evaluate<string>(active.cdp, 'typeof window.__petIdleSuspension'), 'undefined');
    // 主进程未装配发布器：查询通道没有 handler。
    await assert.rejects(() => evaluate(active.cdp, 'window.petWindowVisibility.query()'));
    assert.equal(await clipPaused(active), false);
    await act(active, 'hide');
    await delay(500);
    assert.equal(await clipPaused(active), false, '关闭时隐藏不得暂停');
    await act(active, 'show');
  } finally {
    const record = await closePet(session);
    await xvfb.stop();
    await ctx.cleanup({ keepDir: true });
    assert.ok(record !== null);
  }
});

test('开启后：真实 hide/show 驱动暂停与恢复，失焦不算隐藏，点击动作不被暂停', async () => {
  const ctx = isolation.createRunContext({ label: 'm39-on', kind: 'e2e' });
  const xvfb = await startOwnXvfb({ label: 'm39-on' });
  let session: PetSession | undefined;
  let exited = false;
  try {
    session = await launch({ label: 'm39-on', display: xvfb.display, userData: `${ctx.dir}/userData`, idlePause: true });

    const playing = await waitState(
      session,
      'idle playing',
      (state) => state.phase === 'playing' && state.clip === 'idle',
    );
    assert.equal(playing.enabled, true);
    assert.ok(playing.revision !== null && playing.revision >= 1);
    assert.equal(playing.hidden, false);
    assert.equal(await clipPaused(session), false);

    // 失焦不是隐藏。启动 show:false 在部分平台已合法 pause/resume 各一次，
    // 因此只断言失焦前后计数不变 + hidden=false，不写死从 0 开始。
    const beforeBlur = await readRequired(session, 'before blur');
    await act(session, 'blur');
    await delay(400);
    const blurred = await readRequired(session, 'after blur');
    assert.equal(blurred.hidden, false, '失焦不是隐藏');
    assert.equal(blurred.pauseCount, beforeBlur.pauseCount, '失焦不得增加 pauseCount');
    assert.equal(blurred.resumeCount, beforeBlur.resumeCount, '失焦不得增加 resumeCount');

    // 真实 hide → 只暂停当前 idle 并取得归属；计数以失焦后的真实值为基线。
    const hideBaseline = blurred;
    const hiddenInfo = await act(session, 'hide');
    assert.equal(hiddenInfo.visible, false);
    const paused = await waitState(
      session,
      'idle paused',
      (state) => state.hidden === true && state.pauseCount > hideBaseline.pauseCount,
    );
    assert.equal(paused.hidden, true);
    assert.ok(paused.lease !== null, '必须有暂停归属');
    assert.equal(paused.lease?.elementIdentity, 'single-primary');
    assert.equal(await clipPaused(session), true);

    // 重复 hide 不重复暂停。
    await act(session, 'hide');
    await delay(300);
    assert.equal((await readState(session))?.pauseCount, paused.pauseCount);

    // 真实 show → 只恢复该 owner，且不重报 playing。
    const shownInfo = await act(session, 'show');
    assert.equal(shownInfo.visible, true);
    const resumed = await waitState(
      session,
      'idle resumed',
      (state) => state.hidden === false && state.resumeCount > paused.resumeCount,
    );
    assert.equal(resumed.hidden, false);
    assert.equal(resumed.phase, 'playing');
    assert.equal(await clipPaused(session), false);

    // 重复 show 不重复 play。
    await act(session, 'show');
    await delay(300);
    assert.equal((await readState(session))?.resumeCount, resumed.resumeCount);

    // 快速反复隐藏 3 次：最终可见且在播，次数单调（相对本轮基线）。
    const before = await readRequired(session, 'before rapid toggles');
    for (let index = 0; index < 3; index += 1) {
      await act(session, 'hide');
      await delay(120);
      await act(session, 'show');
      await delay(160);
    }
    const after = await waitState(session, 'after rapid toggles', (state) => state.hidden === false);
    assert.equal(await clipPaused(session), false);
    assert.equal(after.phase, 'playing');
    assert.equal(after.pauseCount - before.pauseCount, 3);
    assert.equal(after.resumeCount - before.resumeCount, 3);

    // 隐藏中点击：一次动作照常播放，不暂停；回到 idle 且仍隐藏时才暂停。
    await act(session, 'hide');
    // 等隐藏导致的暂停真正落地（真实 hidden + 计数增加），再点，避免把暂停判给这次动作。
    await waitState(
      session,
      'paused before click',
      (state) => state.hidden === true && state.pauseCount > after.pauseCount,
    );
    const box = await evaluate<{ x: number; y: number }>(
      session.cdp,
      '(() => { const r = document.body.getBoundingClientRect(); return { x: Math.round(r.width / 2), y: Math.round(r.height / 2) }; })()',
    );
    const pausesBeforeClick = (await readRequired(session, 'before click')).pauseCount;
    await mouse(session.cdp, 'mousePressed', box.x, box.y, 1);
    await mouse(session.cdp, 'mouseReleased', box.x, box.y, 0);
    const reaction = await waitState(
      session,
      'reaction playing',
      (state) => state.clip === 'reaction' && state.phase === 'playing',
    );
    assert.equal(await clipPaused(session), false, '一次动作不得被节能暂停');
    assert.equal(reaction.pauseCount, pausesBeforeClick);
    await waitState(session, 'back to idle paused', (state) => state.clip === 'idle' && state.phase === 'playing', 30000);
    const backToIdle = await waitState(session, 'idle re-paused', (state) => state.pauseCount > pausesBeforeClick, 30000);
    assert.equal(backToIdle.hidden, true);

    // 隐藏中直接退出：无残留。
    await act(session, 'hide');
    await evaluate(session.cdp, 'window.pet.quit()');
    const exit = await session.tracked.untilExit(15000);
    exited = true;
    assert.equal(exit.timedOut, false);
    assert.equal(exit.exitCode, 0);
    assert.equal((await aliveTracked(session.tracked)).length, 0, '退出后不得有存活子进程');
  } finally {
    if (session !== undefined && !exited) await closePet(session);
    await xvfb.stop();
    await ctx.cleanup({ keepDir: true });
  }
});

test('最小化：真实 minimize 算隐藏并暂停，restore 恢复且重复调用不重复计数', async (t) => {
  const ctx = isolation.createRunContext({ label: 'm39-min', kind: 'e2e' });
  const xvfb = await startOwnXvfb({ label: 'm39-min' });
  const wm = await startWm(xvfb.display);
  let session: PetSession | undefined;
  try {
    if (!wm.available) {
      t.skip('openbox 不可用：裸 Xvfb 下 isMinimized() 不翻转，机制未证明');
      return;
    }
    session = await launch({ label: 'm39-min', display: xvfb.display, userData: `${ctx.dir}/userData`, idlePause: true });

    await waitState(session, 'min playing', (state) => state.phase === 'playing' && state.clip === 'idle');
    // 先证明初始态可观测：未最小化、未暂停。启动 show:false 可能已合法 pause/resume 各一次，
    // 所以计数只作相对基线，不写死为 0。
    const baseline = await readRequired(session, 'minimize baseline');
    const initial = await act(session, 'state');
    assert.equal(initial.minimized, false);
    assert.equal(baseline.hidden, false);
    assert.equal(await clipPaused(session), false);

    // 真实 minimize：主进程 isMinimized() 必须真的翻转，页面才收到 hidden=true。
    await act(session, 'minimize');
    const paused = await waitState(
      session,
      'minimized paused',
      (state) => state.hidden === true && state.pauseCount > baseline.pauseCount,
    );
    const minimized = await act(session, 'state');
    assert.equal(minimized.minimized, true, '真实最小化后 isMinimized() 必须为 true');
    assert.equal(minimized.visible, false);
    const snapshot = await evaluate<{ hidden: boolean; reason: string }>(
      session.cdp,
      'window.petWindowVisibility.query()',
    );
    assert.equal(snapshot.hidden, true);
    assert.equal(snapshot.reason, 'minimized', '最小化原因必须可区分于普通隐藏');
    assert.ok(paused.lease !== null, '最小化暂停也必须有归属');
    assert.equal(await clipPaused(session), true);

    // 重复 minimize 不重复暂停。
    await act(session, 'minimize');
    await delay(300);
    assert.equal((await readState(session))?.pauseCount, paused.pauseCount);

    // 真实 restore：恢复可见、回到 playing、clip 继续播。
    await act(session, 'restore');
    const resumed = await waitState(
      session,
      'restored',
      (state) => state.hidden === false && state.resumeCount > paused.resumeCount,
    );
    const restored = await act(session, 'state');
    assert.equal(restored.minimized, false);
    assert.equal(restored.visible, true);
    assert.equal(resumed.phase, 'playing');
    assert.equal(resumed.clip, 'idle');
    assert.equal(await clipPaused(session), false);

    // 重复 restore 不重复 resume。
    await act(session, 'restore');
    await delay(300);
    const after = await readState(session);
    assert.equal(after?.resumeCount, resumed.resumeCount);
    assert.equal(after?.hidden, false);
    assert.equal(await clipPaused(session), false);
  } finally {
    if (session !== undefined) await closePet(session);
    wm.stop();
    await xvfb.stop();
    await ctx.cleanup({ keepDir: true });
  }
});
