/**
 * demo 入口（scripts/demo.mjs）的常驻与收尾：真跑 Electron（Xvfb）验证。
 *
 *   node --experimental-strip-types --test --test-reporter spec tests/demo-entry.e2e.test.ts
 *
 * 覆盖：无参数默认常驻（不被 1.2s 定时杀掉）、SIGTERM 给脚本后自然收尾（写日志、退出码 0、无残留）、
 * 产品内 Esc 退出、--max-duration 到点自动收尾、--record 序列跑完自动收尾。
 * 前提与 tests/electron.e2e.test.ts 一致：先 pnpm build。Xvfb/xdotool 缺失时按 not-run 跳过。
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const demoPath = path.join(petRoot, 'scripts/demo.mjs');
const mainPath = path.join(petRoot, 'dist/electron/main.js');

// 每次测试进程独占一个 display：PID 派生，避免与并行的其它运行撞 Xvfb。
const display = `:${100 + (process.pid % 700)}`;

let xvfb: ChildProcess | undefined;
let displayReady = false;
let xdotoolAvailable = false;

interface DemoSummary {
  event: string;
  asset: string;
  cadence: string;
  record: unknown;
  stopReason: string;
  childExit: { code: number | null; signal: string | null } | string;
  elapsedMs: number;
  logPath: string;
  visuals: string[];
  reactions: number;
  autos: number;
  placeholders: number;
  failures?: string[];
}

interface DemoHandle {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  userData: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasBinary(name: string): boolean {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(finder, [name], { timeout: 5000 }).status === 0;
}

function startXvfb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    xvfb = proc;
    let spawnError: Error | undefined;
    proc.once('error', (error) => {
      spawnError = error;
    });
    const socket = `/tmp/.X11-unix/X${display.slice(1)}`;
    const deadline = Date.now() + 8000;
    const poll = () => {
      if (existsSync(socket)) {
        resolve();
        return;
      }
      if (spawnError !== undefined) {
        reject(new Error(`Xvfb 起不来：${spawnError.message}`));
        return;
      }
      if (proc.exitCode !== null || proc.signalCode !== null) {
        reject(new Error(`Xvfb exited (${proc.exitCode}${proc.signalCode ? `/${proc.signalCode}` : ''})`));
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Xvfb socket missing: ${socket}`));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

before(async () => {
  if (!existsSync(mainPath)) return; // 由 ensure() 统一按 not-run 跳过
  if (!hasBinary('Xvfb')) return;
  try {
    await startXvfb();
    displayReady = true;
  } catch {
    displayReady = false;
  }
  xdotoolAvailable = hasBinary('xdotool');
});

after(async () => {
  if (xvfb === undefined) return;
  xvfb.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000);
    xvfb?.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
});

/** 环境不可用时记 not-run（跳过），而不是误报失败。 */
function ensure(t: { skip(message?: string): unknown }, needXdotool = false): boolean {
  if (!existsSync(mainPath)) {
    t.skip('not-run: dist/electron/main.js 不存在，先 pnpm build');
    return false;
  }
  if (!displayReady) {
    t.skip('not-run: Xvfb 起不来（无显示环境）');
    return false;
  }
  if (needXdotool && !xdotoolAvailable) {
    t.skip('not-run: xdotool 不可用');
    return false;
  }
  return true;
}

function xdoEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DISPLAY: display };
}

function searchWindow(): string | null {
  const result = spawnSync('xdotool', ['search', '--name', 'pet-next'], {
    encoding: 'utf8',
    env: xdoEnv(),
    timeout: 5000,
  });
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout.trim().split('\n').filter(Boolean).at(-1) ?? null;
}

function windowAlive(id: string): boolean {
  return spawnSync('xdotool', ['getwindowname', id], { encoding: 'utf8', env: xdoEnv(), timeout: 5000 }).status === 0;
}

async function waitForWindow(timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const id = searchWindow();
    if (id !== null) return id;
    if (Date.now() > deadline) return null;
    await delay(200);
  }
}

async function waitWindowGone(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (searchWindow() === null) return true;
    await delay(200);
  }
  return searchWindow() === null;
}

function startDemo(args: string[]): DemoHandle {
  const userData = mkdtempSync(path.join(tmpdir(), 'pet-next-demo-entry-'));
  const child = spawn(process.execPath, [demoPath, ...args], {
    cwd: petRoot,
    env: { ...process.env, DISPLAY: display, PET_NEXT_USER_DATA: userData },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const handle: DemoHandle = { child, stdout: '', stderr: '', userData };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    handle.stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    handle.stderr += chunk;
  });
  return handle;
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`demo 脚本 ${timeoutMs}ms 内没退出`));
    }, timeoutMs);
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once('exit', finish);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(child.exitCode, child.signalCode);
    }
  });
}

/** demo 的 summary 是 pretty JSON（末尾输出），从 `"event": "demo-summary"` 回溯到对象开头做括号配平。 */
function parseSummary(stdout: string): DemoSummary {
  const marker = stdout.indexOf('"event": "demo-summary"');
  assert.ok(marker >= 0, `stdout 里没有 demo-summary：\n${stdout.slice(-2000)}`);
  const start = stdout.lastIndexOf('{', marker);
  let depth = 0;
  let end = -1;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stdout.length; i += 1) {
    const ch = stdout[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > start, `summary 括号没配平：\n${stdout.slice(start)}`);
  return JSON.parse(stdout.slice(start, end + 1)) as DemoSummary;
}

function logAbsolutePath(summary: DemoSummary): string {
  return path.join(petRoot, summary.logPath);
}

async function cleanup(handle: DemoHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    handle.child.kill('SIGKILL');
    await waitExit(handle.child, 5000).catch(() => undefined);
  }
  rmSync(handle.userData, { recursive: true, force: true });
}

test('无参数启动默认常驻；SIGTERM 给脚本后写日志、退出码 0、无残留', { timeout: 90000 }, async (t) => {
  if (!ensure(t, true)) return;
  const handle = startDemo([]);
  try {
    const windowId = await waitForWindow(30000);
    assert.ok(windowId, `30s 内没等到 pet-next 窗口\nstdout=${handle.stdout}\nstderr=${handle.stderr}`);
    const seenAt = Date.now();

    // 窗口出来后再观察 5s：旧版会在 1.2s 处 SIGTERM 杀 Electron 后自退，这里必须都还活着。
    await delay(5000);
    assert.equal(handle.child.exitCode, null, `demo 脚本提前退出\nstdout=${handle.stdout}`);
    assert.equal(handle.child.signalCode, null);
    assert.ok(windowAlive(windowId), '5s 后 Electron 窗口不应消失');

    // 用户结束：SIGTERM 给脚本本身。
    handle.child.kill('SIGTERM');
    const result = await waitExit(handle.child, 20000);
    assert.equal(result.code, 0, `stdout=${handle.stdout}`);
    assert.equal(result.signal, null);

    const summary = parseSummary(handle.stdout);
    assert.equal(summary.stopReason, 'signal-SIGTERM');
    assert.equal(summary.failures, undefined);
    // Electron 可能把 SIGTERM 转成正常退出：两种收尾都算干净。
    assert.ok(
      typeof summary.childExit === 'object' && (summary.childExit.signal === 'SIGTERM' || summary.childExit.code === 0),
      `childExit=${JSON.stringify(summary.childExit)}`,
    );

    const logAbs = logAbsolutePath(summary);
    assert.ok(existsSync(logAbs), `日志没写盘：${logAbs}`);
    const logText = readFileSync(logAbs, 'utf8');
    assert.ok(logText.length > 0, '日志是空的');
    assert.ok(
      summary.visuals.includes('idle'),
      `Electron 应真跑起来并记录 idle visual：visuals=${JSON.stringify(summary.visuals)}`,
    );
    assert.ok(Date.now() - seenAt >= 5000, '存活窗口不足 5s');
    assert.ok(await waitWindowGone(10000), '收尾后 Electron 窗口应消失（无残留）');
  } finally {
    await cleanup(handle);
  }
});

test('产品内 Esc 退出：脚本自然收尾、退出码 0、无残留', { timeout: 90000 }, async (t) => {
  if (!ensure(t, true)) return;
  const handle = startDemo([]);
  try {
    const windowId = await waitForWindow(30000);
    assert.ok(windowId, `30s 内没等到 pet-next 窗口\nstdout=${handle.stdout}\nstderr=${handle.stderr}`);
    spawnSync('xdotool', ['windowactivate', '--sync', windowId], { env: xdoEnv(), timeout: 10000 });
    await delay(300);
    const keyed = spawnSync('xdotool', ['key', 'Escape'], { env: xdoEnv(), timeout: 10000 });
    assert.equal(keyed.status, 0, `xdotool key Escape 失败：${String(keyed.stderr)}`);

    // 子进程自己退出（Esc → app.quit()），demo 脚本随之自然收尾，不能再依赖外部信号。
    const result = await waitExit(handle.child, 20000);
    assert.equal(result.code, 0, `stdout=${handle.stdout}`);
    assert.equal(result.signal, null);

    const summary = parseSummary(handle.stdout);
    assert.equal(summary.stopReason, 'child-exit');
    assert.equal(summary.failures, undefined);
    assert.ok(typeof summary.childExit === 'object' && summary.childExit.code === 0);
    assert.ok(existsSync(logAbsolutePath(summary)), '日志没写盘');
    assert.ok(await waitWindowGone(10000), '收尾后 Electron 窗口应消失（无残留）');
  } finally {
    await cleanup(handle);
  }
});

test('--record 中子进程退出会取消剩余输入并统一收尾', { timeout: 90000 }, async (t) => {
  if (!ensure(t, true)) return;
  const handle = startDemo(['--demo', '--asset=short', '--record']);
  try {
    const windowId = await waitForWindow(30000);
    assert.ok(windowId, `30s 内没等到 pet-next 窗口\nstdout=${handle.stdout}\nstderr=${handle.stderr}`);
    spawnSync('xdotool', ['windowactivate', '--sync', windowId], { env: xdoEnv(), timeout: 10000 });
    const keyed = spawnSync('xdotool', ['key', 'Escape'], { env: xdoEnv(), timeout: 10000 });
    assert.equal(keyed.status, 0, `xdotool key Escape 失败：${String(keyed.stderr)}`);

    const result = await waitExit(handle.child, 20000);
    assert.equal(result.code, 1, `录制被提前终止应如实失败：${handle.stdout}`);
    const summary = parseSummary(handle.stdout);
    assert.equal(summary.stopReason, 'child-exit');
    assert.equal(summary.record, 'child-exit');
    assert.ok(summary.failures?.includes('record-child-exit'));
    assert.ok(summary.elapsedMs < 12000, `剩余录制输入未被取消：elapsedMs=${summary.elapsedMs}`);
    assert.ok(existsSync(logAbsolutePath(summary)), '日志没写盘');
    assert.ok(await waitWindowGone(10000), '收尾后 Electron 窗口应消失（无残留）');
  } finally {
    await cleanup(handle);
  }
});

test('--max-duration 到点自动收尾并写日志', { timeout: 90000 }, async (t) => {
  if (!ensure(t, true)) return;
  const handle = startDemo(['--max-duration=6']);
  try {
    const windowId = await waitForWindow(30000);
    assert.ok(windowId, `30s 内没等到 pet-next 窗口\nstdout=${handle.stdout}\nstderr=${handle.stderr}`);

    const result = await waitExit(handle.child, 30000);
    assert.equal(result.code, 0, `stdout=${handle.stdout}`);
    const summary = parseSummary(handle.stdout);
    assert.equal(summary.stopReason, 'max-duration');
    assert.equal(summary.failures, undefined);
    assert.ok(summary.elapsedMs >= 6000, `elapsedMs=${summary.elapsedMs} 不应早于 6s`);
    assert.ok(existsSync(logAbsolutePath(summary)), '日志没写盘');
    assert.ok(await waitWindowGone(10000), '收尾后 Electron 窗口应消失（无残留）');
  } finally {
    await cleanup(handle);
  }
});

test('--record 序列跑完自动收尾、步骤全过并写日志', { timeout: 150000 }, async (t) => {
  if (!ensure(t, true)) return;
  const handle = startDemo(['--demo', '--asset=short', '--record']);
  try {
    const result = await waitExit(handle.child, 120000);
    assert.equal(result.code, 0, `stdout=${handle.stdout}\nstderr=${handle.stderr}`);

    const summary = parseSummary(handle.stdout);
    assert.equal(summary.stopReason, 'record-complete');
    assert.equal(summary.failures, undefined);
    assert.ok(Array.isArray(summary.record), `record=${JSON.stringify(summary.record)}`);
    const steps = summary.record as Array<{
      step: string;
      ok: boolean;
      detail?: string;
      dragStart?: boolean;
      dragEnd?: boolean;
      before?: { X: number; Y: number };
      after?: { X: number; Y: number };
      autoAfterDrag?: string;
    }>;
    assert.deepEqual(
      steps.map((item) => item.step),
      ['activate', 'click', 'click-x3-fast', 'drag', 'auto-action', 'fail-once', 'recover'],
    );
    // bare Xvfb 仅窗口激活可降级：没有窗口管理器，不支持 _NET_ACTIVE_WINDOW。
    for (const step of steps) {
      const envLimited = !step.ok && step.step === 'activate' && String(step.detail).includes('_NET_ACTIVE_WINDOW');
      if (envLimited) continue;
      assert.equal(step.ok, true, `录制步骤失败：${JSON.stringify(step)}`);
    }
    const drag = steps.find((step) => step.step === 'drag');
    assert.ok(drag);
    assert.equal(drag.dragStart, true, `产品未进入拖动：${JSON.stringify(drag)}`);
    assert.equal(drag.dragEnd, true, `产品未结束拖动：${JSON.stringify(drag)}`);
    assert.ok(drag.before && drag.after, `缺少窗口几何回读：${JSON.stringify(drag)}`);
    assert.ok(
      drag.before.X !== drag.after.X || drag.before.Y !== drag.after.Y,
      `窗口没有真实移动：${JSON.stringify(drag)}`,
    );
    const auto = steps.find((step) => step.step === 'auto-action');
    assert.ok(auto);
    assert.match(auto.autoAfterDrag ?? '', /^auto-\d+$/, `drag-end 后没有新 auto：${JSON.stringify(auto)}`);
    assert.ok(summary.visuals.includes('idle'), `visuals=${JSON.stringify(summary.visuals)}`);
    assert.ok(summary.visuals.includes('reaction'), `visuals=${JSON.stringify(summary.visuals)}`);
    assert.ok(existsSync(logAbsolutePath(summary)), '日志没写盘');
    assert.ok(await waitWindowGone(10000), '收尾后 Electron 窗口应消失（无残留）');
  } finally {
    await cleanup(handle);
  }
});
