/**
 * 拉起一次真实 Electron，并用 CDP 发送指针。
 * 页面里的 `dispatchEvent` 不算这次的输入。
 * @module pet-next/tests/platform/session
 */
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pidIsAlive } from '../support/process-table.ts';
import { startTrackedRun, type TrackedRun } from '../support/tracked-run.ts';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReadyInfo {
  alwaysOnTop: boolean;
  transparent: boolean;
  requestedBackground: string;
  background: string;
  bounds: Bounds;
  workArea: Bounds;
  scaleFactor: number;
  forcedDeviceScaleFactor: number | null;
  scaleSource: string;
  displayCount: number;
  /** `screen.dipToScreenPoint` 的窗口原点，给系统光标用。 */
  physical: { x: number; y: number };
}

export interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export interface PetSession {
  tracked: TrackedRun;
  userData: string;
  cdp: Cdp;
  ready: ReadyInfo;
  stdout(): string;
  stderr(): string;
}

export interface ScaleLaunch {
  label: string;
  /** null 表示不传 `--force-device-scale-factor`。 */
  forced: number | null;
}

const require = createRequire(path.join(petRoot(), 'package.json'));

export function petRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

export async function openPet(launch: ScaleLaunch): Promise<PetSession> {
  const root = petRoot();
  const electronPath = require('electron') as string;
  const userData = await mkdtemp(path.join(tmpdir(), 'pet-next-platform-'));
  const port = await freePort();
  const args = ['--no-sandbox', '--disable-dev-shm-usage', '--remote-allow-origins=*', `--remote-debugging-port=${port}`];
  if (launch.forced !== null) args.push(`--force-device-scale-factor=${launch.forced}`);
  args.push(path.join(root, 'dist/electron/main.js'));
  const tracked = startTrackedRun({
    executable: electronPath,
    args,
    cwd: root,
    env: { ...process.env, PET_NEXT_TEST: '1', PET_NEXT_USER_DATA: userData },
    label: launch.label,
    logRoot: path.join(root, 'logs', 'platform-runs'),
  });
  try {
    const ready = await waitUntilReady(tracked);
    const cdp = await connectCdp(await waitForPageSocket(port));
    return { tracked, userData, cdp, ready, stdout: () => tracked.stdout(), stderr: () => tracked.stderr() };
  } catch (error) {
    await tracked.stop();
    const recordDir = await tracked.writeRecord().catch(() => '');
    await rm(userData, { recursive: true, force: true });
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.message = `${failure.message}\nrecord=${recordDir}`;
    throw failure;
  }
}

export async function closePet(session: PetSession | undefined): Promise<string | null> {
  if (!session) return null;
  try {
    session.cdp.close();
  } catch {
    // 退出时调试连接会先断开。
  }
  await session.tracked.stop();
  const recordDir = await session.tracked.writeRecord();
  await rm(session.userData, { recursive: true, force: true });
  return recordDir;
}

export async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
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

/** CDP 鼠标。`buttons` 为 1 表示左键仍按着。 */
export async function mouse(cdp: Cdp, type: 'mousePressed' | 'mouseReleased' | 'mouseMoved', x: number, y: number, buttons: number): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons,
    clickCount: type === 'mousePressed' ? 1 : 0,
    pointerType: 'mouse',
  });
}

export async function readTrace(session: PetSession): Promise<string> {
  return evaluate<string>(session.cdp, 'document.documentElement.dataset.trace ?? ""');
}

export async function waitForTrace(session: PetSession, label: string, ok: (trace: string) => boolean): Promise<string> {
  const deadline = Date.now() + 20000;
  let last = '';
  while (Date.now() < deadline) {
    const trace = await readTrace(session);
    if (ok(trace)) return trace;
    last = trace;
    await delay(40);
  }
  throw new Error(`${label} trace=${last}\nstdout=${session.stdout()}\nstderr=${session.stderr()}`);
}

export function jsonObjects(text: string): Array<Record<string, unknown>> {
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

export async function waitForBounds(session: PetSession, ok: (bounds: Bounds) => boolean): Promise<Bounds> {
  const deadline = Date.now() + 5000;
  let last = '';
  while (Date.now() < deadline) {
    const bounds = latestBounds(session.stdout());
    if (bounds && ok(bounds)) return bounds;
    last = JSON.stringify(bounds);
    await delay(30);
  }
  throw new Error(`bounds ${last}\nstdout=${session.stdout()}`);
}

export async function aliveTracked(tracked: TrackedRun): Promise<number[]> {
  const deadline = Date.now() + 2000;
  let alive = tracked.trackedPids().filter((pid) => pidIsAlive(pid));
  while (alive.length > 0 && Date.now() < deadline) {
    await delay(30);
    alive = tracked.trackedPids().filter((pid) => pidIsAlive(pid));
  }
  return alive;
}

export function relativeToPet(absPath: string): string {
  return path.relative(petRoot(), absPath).split(path.sep).join('/');
}

function latestBounds(text: string): Bounds | null {
  let bounds: Bounds | null = null;
  for (const item of jsonObjects(text)) {
    if (isBounds(item.bounds)) bounds = item.bounds;
  }
  return bounds;
}

async function waitUntilReady(tracked: TrackedRun): Promise<ReadyInfo> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const found = jsonObjects(tracked.stdout()).find((item) => item.event === 'ready');
    const ready = found ? asReady(found) : null;
    if (ready) return ready;
    if (tracked.child.exitCode !== null) {
      throw new Error(`electron exited ${tracked.child.exitCode}\n${tracked.stdout()}\n${tracked.stderr()}`);
    }
    await delay(30);
  }
  throw new Error(`ready timeout\n${tracked.stdout()}\n${tracked.stderr()}`);
}

function asReady(found: Record<string, unknown>): ReadyInfo | null {
  if (
    typeof found.alwaysOnTop !== 'boolean' ||
    found.transparent !== true ||
    typeof found.requestedBackground !== 'string' ||
    typeof found.background !== 'string' ||
    !isBounds(found.bounds) ||
    !isBounds(found.workArea) ||
    typeof found.scaleFactor !== 'number' ||
    typeof found.scaleSource !== 'string' ||
    !isPoint(found.physical) ||
    (found.forcedDeviceScaleFactor !== null && typeof found.forcedDeviceScaleFactor !== 'number')
  ) {
    return null;
  }
  return {
    alwaysOnTop: found.alwaysOnTop,
    transparent: true,
    requestedBackground: found.requestedBackground,
    background: found.background,
    bounds: found.bounds,
    workArea: found.workArea,
    scaleFactor: found.scaleFactor,
    forcedDeviceScaleFactor: typeof found.forcedDeviceScaleFactor === 'number' ? found.forcedDeviceScaleFactor : null,
    scaleSource: found.scaleSource,
    displayCount: typeof found.displayCount === 'number' ? found.displayCount : 0,
    physical: found.physical,
  };
}

function isPoint(value: unknown): value is { x: number; y: number } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { x?: unknown; y?: unknown };
  return typeof record.x === 'number' && typeof record.y === 'number';
}

function isBounds(value: unknown): value is Bounds {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<Bounds>;
  return [record.x, record.y, record.width, record.height].every((item) => typeof item === 'number');
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
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
