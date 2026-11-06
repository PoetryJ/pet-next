/**
 * M3-9 待机节能预览的真实窗口 e2e。
 *
 * 用真实 Electron 与真实的 `BrowserWindow.hide()/show()/minimize()/restore()` 驱动，
 * 不用 xdotool unmap 冒充窗口信号；每个用例独占运行目录与自起 Xvfb（复用 test-run-context）。
 * @module pet-next/tests/idle-suspension.e2e.test
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { aliveTracked, closePet, evaluate, mouse, openPet, type PetSession } from './platform/session.ts';

// scripts/test-run-context.mjs 是无类型声明的 .mjs 工具；这里只用两个工厂。
// @ts-expect-error 缺少 .d.ts
const isolation = (await import('../scripts/test-run-context.mjs')) as {
  createRunContext(options: { label: string; kind: string }): RunContext;
  startOwnXvfb(options: { label: string }): Promise<OwnDisplay>;
};

interface RunContext {
  dir: string;
  logDir: string;
  cleanup(options?: { keepDir?: boolean }): Promise<void>;
}

interface OwnDisplay {
  display: string;
  stop(): Promise<void>;
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
      DISPLAY: options.display,
      PET_NEXT_USER_DATA: options.userData,
      ...(options.idlePause ? { PET_NEXT_IDLE_PAUSE: '1' } : {}),
    },
  });
}

test('默认关闭：不创建观测面、不加窗口监听，隐藏不影响播放', async () => {
  const ctx = isolation.createRunContext({ label: 'm39-off', kind: 'e2e' });
  const xvfb = await isolation.startOwnXvfb({ label: 'm39-off' });
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
  const xvfb = await isolation.startOwnXvfb({ label: 'm39-on' });
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

    // 失焦不是隐藏。
    await act(session, 'blur');
    await delay(400);
    const blurred = await readState(session);
    assert.equal(blurred?.hidden, false);
    assert.equal(blurred?.pauseCount ?? 0, 0);

    // 真实 hide → 只暂停当前 idle 并取得归属。
    const hiddenInfo = await act(session, 'hide');
    assert.equal(hiddenInfo.visible, false);
    const paused = await waitState(session, 'idle paused', (state) => state.pauseCount >= 1);
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
    const resumed = await waitState(session, 'idle resumed', (state) => state.resumeCount >= 1);
    assert.equal(resumed.hidden, false);
    assert.equal(resumed.phase, 'playing');
    assert.equal(await clipPaused(session), false);

    // 重复 show 不重复 play。
    await act(session, 'show');
    await delay(300);
    assert.equal((await readState(session))?.resumeCount, resumed.resumeCount);

    // 快速反复隐藏 3 次：最终可见且在播，次数单调。
    const before = await readState(session);
    for (let index = 0; index < 3; index += 1) {
      await act(session, 'hide');
      await delay(120);
      await act(session, 'show');
      await delay(160);
    }
    const after = await waitState(session, 'after rapid toggles', (state) => state.hidden === false);
    assert.equal(await clipPaused(session), false);
    assert.equal(after.phase, 'playing');
    assert.equal((after.pauseCount ?? 0) - (before?.pauseCount ?? 0), 3);
    assert.equal((after.resumeCount ?? 0) - (before?.resumeCount ?? 0), 3);

    // 隐藏中点击：一次动作照常播放，不暂停；回到 idle 且仍隐藏时才暂停。
    await act(session, 'hide');
    await waitState(session, 'paused before click', (state) => state.hidden === true);
    const box = await evaluate<{ x: number; y: number }>(
      session.cdp,
      '(() => { const r = document.body.getBoundingClientRect(); return { x: Math.round(r.width / 2), y: Math.round(r.height / 2) }; })()',
    );
    const pausesBeforeClick = (await readState(session))?.pauseCount ?? 0;
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
