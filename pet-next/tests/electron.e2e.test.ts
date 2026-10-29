/**
 * 真实 Electron：启动、点击回待机、连续点击、拖动、缺素材降级、退出。
 * 断言窗口位置和进程退出；页面状态用调试端口读取，不扩大 preload。
 */
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(path.join(petRoot, 'package.json'));
const electronPath = require('electron') as string;
const mainPath = path.join(petRoot, 'dist/electron/main.js');

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ReadyInfo {
  alwaysOnTop: boolean;
  transparent: boolean;
  requestedBackground: string;
  background: string;
  bounds: Bounds;
  workArea: Bounds;
}

interface PageState {
  visual: string;
  request: string;
  trace: string;
  paused: boolean;
  hidden: boolean;
  currentTime: number;
  placeholderHidden: boolean;
  bodyBackground: string;
  hasPet: boolean;
  exposedKeys: string[];
  nodeIntegration: boolean;
}

interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

interface RunningApp {
  child: ChildProcess;
  userData: string;
  stdout: () => string;
  stderr: () => string;
  cdp: Cdp;
  ready: ReadyInfo;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function electronPids(): Set<number> {
  const out = execFileSync('ps', ['-eo', 'pid,comm'], { encoding: 'utf8' });
  const ids = new Set<number>();
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)/.exec(line);
    const command = match?.[2];
    if (match?.[1] && command && /electron/i.test(command)) ids.add(Number(match[1]));
  }
  return ids;
}

function jsonObjects(text: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (typeof value === 'object' && value !== null) found.push(value as Record<string, unknown>);
    } catch {
      // 非 JSON 日志行忽略。
    }
  }
  return found;
}

function isBounds(value: unknown): value is Bounds {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<Bounds>;
  return [record.x, record.y, record.width, record.height].every((item) => typeof item === 'number');
}

function latestBounds(text: string): Bounds | null {
  let bounds: Bounds | null = null;
  for (const item of jsonObjects(text)) {
    if (isBounds(item.bounds)) bounds = item.bounds;
  }
  return bounds;
}

async function connectCdp(url: string): Promise<Cdp> {
  const ws = new WebSocket(url);
  let next = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error(`cdp connect failed: ${url}`)));
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? 'cdp error'));
    else waiter.resolve(message.result);
  });
  return {
    send(method, params) {
      const id = next + 1;
      next = id;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}

async function waitForPageSocket(port: number): Promise<string> {
  const deadline = Date.now() + 15000;
  let lastError = 'no targets';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = (await response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      lastError = JSON.stringify(list.map((item) => item.type));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(50);
  }
  throw new Error(`cdp page missing: ${lastError}`);
}

async function launch(extraEnv: Record<string, string>): Promise<RunningApp> {
  const userData = await mkdtemp(path.join(tmpdir(), 'pet-next-e2e-'));
  const port = await freePort();
  let stdout = '';
  let stderr = '';
  const child = spawn(
    electronPath,
    [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--force-device-scale-factor=1',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${port}`,
      mainPath,
    ],
    {
      cwd: petRoot,
      detached: true,
      env: {
        ...process.env,
        PET_NEXT_TEST: '1',
        PET_NEXT_USER_DATA: userData,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const ready = await new Promise<ReadyInfo>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`ready timeout\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 20000);
    const poll = () => {
      const found = jsonObjects(stdout).find((item) => item.event === 'ready');
      if (
        found &&
        typeof found.alwaysOnTop === 'boolean' &&
        found.transparent === true &&
        typeof found.requestedBackground === 'string' &&
        typeof found.background === 'string' &&
        isBounds(found.bounds) &&
        isBounds(found.workArea)
      ) {
        clearTimeout(timer);
        resolve({
          alwaysOnTop: found.alwaysOnTop,
          transparent: true,
          requestedBackground: found.requestedBackground,
          background: found.background,
          bounds: found.bounds,
          workArea: found.workArea,
        });
        return;
      }
      if (child.exitCode !== null) {
        clearTimeout(timer);
        reject(new Error(`electron exited ${child.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      setTimeout(poll, 30);
    };
    poll();
  });

  const socket = await waitForPageSocket(port);
  const cdp = await connectCdp(socket);
  return {
    child,
    userData,
    stdout: () => stdout,
    stderr: () => stderr,
    cdp,
    ready,
  };
}

async function shutdown(app: RunningApp | undefined, before: Set<number>): Promise<void> {
  if (app) {
    app.cdp.close();
    const pid = app.child.pid;
    if (app.child.exitCode === null && pid !== undefined) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          app.child.kill('SIGKILL');
        } catch {
          // 进程已经退出。
        }
      }
    }
    await rm(app.userData, { recursive: true, force: true });
  }
  const leftover = [...electronPids()].filter((pid) => !before.has(pid));
  for (const pid of leftover) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已经退出。
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const result = (await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as {
    result?: { value?: T };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed');
  }
  return result.result?.value as T;
}

const pageStateExpression = `(() => {
  const video = document.querySelector('#clip');
  const placeholder = document.querySelector('#placeholder');
  return {
    visual: document.documentElement.dataset.visual ?? '',
    request: document.documentElement.dataset.request ?? '',
    trace: document.documentElement.dataset.trace ?? '',
    paused: !(video instanceof HTMLVideoElement) || video.paused,
    hidden: !(video instanceof HTMLVideoElement) || video.hidden,
    currentTime: video instanceof HTMLVideoElement ? video.currentTime : 0,
    placeholderHidden: !(placeholder instanceof HTMLImageElement) || placeholder.hidden,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    hasPet: typeof window.pet?.moveBy === 'function' && typeof window.pet?.quit === 'function',
    exposedKeys: window.pet ? Object.keys(window.pet) : [],
    nodeIntegration: typeof require !== 'undefined',
  };
})()`;

function pointerScript(steps: Array<[string, number, number]>): string {
  const body = steps
    .map(([type, x, y]) => `fire(${JSON.stringify(type)}, ${x}, ${y});`)
    .join('\n');
  return `(() => {
    const el = document.querySelector('#pet');
    if (!(el instanceof HTMLElement)) throw new Error('missing pet');
    const fire = (type, x, y) => {
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
      }));
    };
    ${body}
    return document.documentElement.dataset.trace ?? '';
  })()`;
}

async function readState(app: RunningApp): Promise<PageState> {
  return evaluate<PageState>(app.cdp, pageStateExpression);
}

async function waitForState(app: RunningApp, label: string, ok: (state: PageState) => boolean): Promise<PageState> {
  const deadline = Date.now() + 20000;
  let last = '';
  while (Date.now() < deadline) {
    const state = await readState(app);
    if (ok(state)) return state;
    last = JSON.stringify(state);
    await delay(40);
  }
  throw new Error(`${label}\nstate=${last}\nstdout=${app.stdout()}\nstderr=${app.stderr()}`);
}

async function waitForBounds(app: RunningApp, ok: (bounds: Bounds) => boolean): Promise<Bounds> {
  const deadline = Date.now() + 5000;
  let last = '';
  while (Date.now() < deadline) {
    const bounds = latestBounds(app.stdout());
    if (bounds && ok(bounds)) return bounds;
    last = JSON.stringify(bounds);
    await delay(30);
  }
  throw new Error(`bounds\nlast=${last}\nstdout=${app.stdout()}`);
}

test('electron pet idles, reacts, drags inside the work area, and exits', { timeout: 90000 }, async () => {
  const before = electronPids();
  let app: RunningApp | undefined;
  try {
    app = await launch({});
    assert.equal(app.ready.alwaysOnTop, true);
    assert.equal(app.ready.transparent, true);
    assert.equal(app.ready.requestedBackground.toLowerCase(), '#00000000');

    const idle = await waitForState(app, 'idle playback', (state) => {
      return state.visual === 'idle' && state.trace === 'idle:1' && !state.paused && !state.hidden && state.currentTime > 0;
    });
    assert.equal(idle.bodyBackground, 'rgba(0, 0, 0, 0)');
    assert.equal(idle.hasPet, true);
    assert.deepEqual(idle.exposedKeys.sort(), ['moveBy', 'quit']);
    assert.equal(idle.nodeIntegration, false);

    await evaluate(app.cdp, pointerScript([['pointerdown', 0, 0], ['pointerup', 2, 1]]));
    const afterClick = await waitForState(app, 'reaction returns to idle', (state) => {
      return state.trace === 'idle:1,reaction:2,idle:3' && state.visual === 'idle' && !state.paused && state.currentTime > 0;
    });
    assert.equal(afterClick.request, '3');

    await evaluate(
      app.cdp,
      pointerScript([
        ['pointerdown', 0, 0],
        ['pointerup', 1, 1],
        ['pointerdown', 0, 0],
        ['pointerup', 1, 0],
        ['pointerdown', 0, 0],
        ['pointerup', 2, 0],
      ]),
    );
    const afterBurst = await waitForState(app, 'latest click wins', (state) => {
      return (
        state.trace === 'idle:1,reaction:2,idle:3,reaction:4,reaction:5,reaction:6,idle:7' &&
        state.visual === 'idle' &&
        !state.paused
      );
    });
    assert.equal(afterBurst.request, '7');

    const beforeDrag = latestBounds(app.stdout());
    assert.ok(beforeDrag);
    await evaluate(app.cdp, pointerScript([['pointerdown', 0, 0], ['pointermove', 40, 16], ['pointerup', 40, 16]]));
    const dragged = await waitForBounds(app, (bounds) => bounds.x !== beforeDrag.x || bounds.y !== beforeDrag.y);
    assert.equal(dragged.x, beforeDrag.x + 40);
    assert.equal(dragged.y, beforeDrag.y + 16);
    const afterDrag = await readState(app);
    assert.equal(afterDrag.trace, afterBurst.trace);
    assert.equal(afterDrag.visual, 'idle');

    await evaluate(
      app.cdp,
      pointerScript([
        ['pointerdown', 0, 0],
        ['pointermove', -8000, -8000],
        ['pointerup', -8000, -8000],
      ]),
    );
    const clamped = await waitForBounds(app, (bounds) => bounds.x === app?.ready.workArea.x && bounds.y === app.ready.workArea.y);
    assert.ok(clamped.x + clamped.width <= app.ready.workArea.x + app.ready.workArea.width);
    assert.ok(clamped.y + clamped.height <= app.ready.workArea.y + app.ready.workArea.height);
    const afterClamp = await readState(app);
    assert.equal(afterClamp.trace, afterBurst.trace);

    const pid = app.child.pid;
    assert.ok(pid);
    try {
      await evaluate(app.cdp, 'window.pet.quit()');
    } catch {
      // 退出会关掉调试连接。
    }
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`exit timeout\n${app?.stderr()}`)), 10000);
      if (app?.child.exitCode !== null && app) {
        clearTimeout(timer);
        resolve(app.child.exitCode);
        return;
      }
      app?.child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0);
    assert.equal(alive(pid), false);
    assert.deepEqual([...electronPids()].filter((id) => !before.has(id)), []);
  } finally {
    await shutdown(app, before);
  }
});

test('missing media falls back to the placeholder and can still be dragged', { timeout: 60000 }, async () => {
  const before = electronPids();
  let app: RunningApp | undefined;
  try {
    app = await launch({
      PET_NEXT_IDLE_URL: 'file:///tmp/pet-next-missing-idle.webm',
      PET_NEXT_REACTION_URL: 'file:///tmp/pet-next-missing-reaction.webm',
    });
    const fallen = await waitForState(app, 'placeholder after idle failure', (state) => {
      return state.trace === 'idle:1,placeholder' && state.visual === 'placeholder' && state.placeholderHidden === false;
    });
    assert.equal(fallen.hidden, true);

    await evaluate(app.cdp, pointerScript([['pointerdown', 4, 4], ['pointerup', 5, 4]]));
    const afterClick = await waitForState(app, 'reaction failure stays on placeholder', (state) => {
      return state.trace === 'idle:1,placeholder,reaction:2,idle:3,placeholder' && state.visual === 'placeholder';
    });
    const stableTrace = afterClick.trace;
    await delay(200);
    const still = await readState(app);
    assert.equal(still.trace, stableTrace);
    assert.equal(still.placeholderHidden, false);

    const beforeDrag = latestBounds(app.stdout());
    assert.ok(beforeDrag);
    await evaluate(app.cdp, pointerScript([['pointerdown', 0, 0], ['pointermove', 24, 10], ['pointerup', 24, 10]]));
    const dragged = await waitForBounds(app, (bounds) => bounds.x === (beforeDrag?.x ?? 0) + 24 && bounds.y === (beforeDrag?.y ?? 0) + 10);
    assert.ok(dragged.x >= app.ready.workArea.x);
    assert.ok(dragged.y >= app.ready.workArea.y);
    assert.equal((await readState(app)).trace, stableTrace);

    const pid = app.child.pid;
    assert.ok(pid);
    try {
      await evaluate(app.cdp, 'window.pet.quit()');
    } catch {
      // 退出会关掉调试连接。
    }
    const exitCode = await new Promise<number | null>((resolve) => {
      if (app?.child.exitCode !== null && app) {
        resolve(app.child.exitCode);
        return;
      }
      app?.child.once('exit', (code) => resolve(code));
    });
    assert.equal(exitCode, 0);
    assert.equal(alive(pid), false);
    assert.deepEqual([...electronPids()].filter((id) => !before.has(id)), []);
  } finally {
    await shutdown(app, before);
  }
});
