/**
 * 正式入口两臂的实验脚手架：真实 Electron + 真实 preload/main + 真实 X 指针（xdotool）。
 *
 * 分层（不许互相冒充，见 docs/M3-11-DRAG-WRITE-BUDGET.md 第 6 节）：
 * - `dragWithPointer`：xdotool 驱动真实 X11 指针 → 真实 Chromium 输入与真实窗口移动；
 * - `dragWithCdp`：`Input.dispatchMouseEvent` 视口合成 → 只用于 500Hz 压力/机制门，**不等于物理鼠标**；
 * - 写入条数来自主进程 `{event:'bounds'}` 日志（只在 PET_NEXT_TEST=1 时打印），
 *   它是 `setPosition` 已返回的软件提交，不代表物理帧。
 * @module pet-next/tests/drag-write-budget/support/app
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pidIsAlive, snapshotChildren } from '../../support/process-table.ts';
import { descendantPids } from '../../support/process-tree.ts';

export const PET_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const require = createRequire(path.join(PET_ROOT, 'package.json'));
export const ELECTRON_PATH = require('electron') as string;
export const MAIN_PATH = path.join(PET_ROOT, 'dist/electron/main.js');
export const MAIN_BUNDLE = path.join(PET_ROOT, 'dist/electron/main.js');

export type Arm = 'off' | 'on';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ReadyInfo {
  bounds: Bounds;
  workArea: Bounds;
  scaleFactor: number;
  displayCount: number;
  physical: Point;
  scaleSource: string;
  forcedDeviceScaleFactor: number | null;
}

export interface BoundsLine {
  readonly index: number;
  readonly requested: Point;
  readonly bounds: Bounds;
  /** 测试进程收到该行 stdout 的墙钟时间（Date.now()，与渲染层同源，但含管道与调度）。 */
  readonly recvAt: number;
}

export interface AppHandle {
  readonly arm: Arm;
  readonly label: string;
  readonly child: ChildProcess;
  readonly userData: string;
  readonly port: number;
  readonly ready: ReadyInfo;
  readonly env: NodeJS.ProcessEnv;
  readonly cdp: Cdp;
  stdout(): string;
  stderr(): string;
  boundsLines(): readonly BoundsLine[];
  /** 主进程写入次数（`event:'bounds'` 行数）。 */
  writeCount(): number;
  /** 当前子进程树快照（用于退出后残留判定）。 */
  trackedPids(): readonly number[];
}

export interface Cdp {
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
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

export function isBounds(value: unknown): value is Bounds {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<Bounds>;
  return [record.x, record.y, record.width, record.height].every((item) => typeof item === 'number');
}

export function isPoint(value: unknown): value is Point {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<Point>;
  return typeof record.x === 'number' && typeof record.y === 'number';
}

export function jsonLines(text: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (typeof value === 'object' && value !== null) found.push(value as Record<string, unknown>);
    } catch {
      // 非 JSON 行忽略。
    }
  }
  return found;
}

/** 产物里是否已出现候选/开关接线；缺失就是"等负责人接线"，不是用例失败。 */
export function wiringPresent(): { present: boolean; reason: string } {
  let bundle: string;
  try {
    bundle = readFileSync(MAIN_BUNDLE, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { present: false, reason: `dist/electron/main.js 缺失或不可读（先 pnpm build）：${message}` };
  }
  const hasSwitch = bundle.includes('PET_NEXT_DRAG_WRITE_BUDGET') || bundle.includes('dragBudget');
  const hasAdapter = bundle.includes('drag-write-budget');
  if (!hasSwitch && !hasAdapter) {
    return {
      present: false,
      reason: '公共接线未落地：dist/electron/main.js 里没有 PET_NEXT_DRAG_WRITE_BUDGET / dragBudget / drag-write-budget（等待负责人 + C）',
    };
  }
  return { present: true, reason: '' };
}

export async function connectCdp(url: string): Promise<Cdp> {
  const ws = new WebSocket(url);
  let next = 0;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cdp connect timeout: ${url}`)), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`cdp connect failed: ${url}`));
    });
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? 'cdp error'));
    else waiter.resolve(message.result ?? {});
  });
  const closed = new Promise<void>((resolve) => {
    ws.addEventListener('close', () => resolve());
  });
  const send: Cdp['send'] = (method, params, timeoutMs = 10000) => {
    const id = next + 1;
    next = id;
    return Promise.race([
      new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      }),
      delay(timeoutMs).then(() => {
        pending.delete(id);
        throw new Error(`cdp ${method} timeout ${timeoutMs}ms`);
      }),
    ]);
  };
  return {
    send,
    async evaluate<T>(expression: string, timeoutMs = 8000): Promise<T> {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
      if (result['exceptionDetails'] !== undefined) {
        throw new Error(`cdp evaluate exception: ${JSON.stringify(result['exceptionDetails'])}`);
      }
      return ((result['result'] as { value?: T } | undefined)?.value) as T;
    },
    async close() {
      try {
        ws.close();
      } catch {
        // 已关闭。
      }
      await closed;
    },
  };
}

async function waitForPageSocket(port: number): Promise<string> {
  const deadline = Date.now() + 20000;
  let lastError = 'no targets';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = (await response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl;
      lastError = JSON.stringify(list.map((item) => item.type));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(50);
  }
  throw new Error(`cdp page missing: ${lastError}`);
}

export interface LaunchOptions {
  readonly arm: Arm;
  readonly label: string;
  readonly extraEnv?: NodeJS.ProcessEnv;
  readonly args?: readonly string[];
}

export async function launchApp(options: LaunchOptions): Promise<AppHandle> {
  const userData = await mkdtemp(path.join(tmpdir(), `pet-next-dwb-${options.label}-`));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PET_NEXT_TEST: '1',
    PET_NEXT_USER_DATA: userData,
  };
  delete env['PET_NEXT_DRAG_WRITE_BUDGET'];
  if (options.arm === 'on') env['PET_NEXT_DRAG_WRITE_BUDGET'] = '1';
  Object.assign(env, options.extraEnv ?? {});

  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${port}`,
    ...(options.args ?? []),
    MAIN_PATH,
  ];
  const child = spawn(ELECTRON_PATH, args, {
    cwd: PET_ROOT,
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const lines: BoundsLine[] = [];
  let pendingText = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    pendingText += chunk;
    const parts = pendingText.split('\n');
    pendingText = parts.pop() ?? '';
    for (const part of parts) ingestLine(part, lines);
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const ready = await waitForReady(() => stdout, () => child.exitCode, () => stderr);
  const cdp = await connectCdp(await waitForPageSocket(port));
  const tracked = new Set<number>();
  if (child.pid !== undefined) tracked.add(child.pid);

  return {
    arm: options.arm,
    label: options.label,
    child,
    userData,
    port,
    ready,
    env,
    cdp,
    stdout: () => stdout,
    stderr: () => stderr,
    boundsLines: () => {
      // 未换行收尾的行也要计入（quit 前最后一条可能没有换行）。
      const tail = pendingText;
      if (tail.trim().startsWith('{')) ingestLine(tail, lines);
      pendingText = '';
      return [...lines];
    },
    writeCount: () => lines.length,
    trackedPids: () => [...tracked],
  };
}

function ingestLine(raw: string, into: BoundsLine[]): void {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  const record = parsed as Record<string, unknown>;
  if (record['event'] !== 'bounds') return;
  if (!isBounds(record['bounds']) || !isPoint(record['requested'])) return;
  into.push({
    index: into.length,
    requested: record['requested'],
    bounds: record['bounds'],
    recvAt: Date.now(),
  });
}

async function waitForReady(
  stdout: () => string,
  exitCode: () => number | null,
  stderr: () => string,
): Promise<ReadyInfo> {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const found = jsonLines(stdout()).find((item) => item.event === 'ready');
    if (
      found !== undefined &&
      isBounds(found['bounds']) &&
      isBounds(found['workArea']) &&
      typeof found['scaleFactor'] === 'number' &&
      typeof found['displayCount'] === 'number' &&
      isPoint(found['physical'])
    ) {
      return {
        bounds: found['bounds'],
        workArea: found['workArea'],
        scaleFactor: found['scaleFactor'],
        displayCount: found['displayCount'],
        physical: found['physical'],
        scaleSource: String(found['scaleSource'] ?? ''),
        forcedDeviceScaleFactor:
          typeof found['forcedDeviceScaleFactor'] === 'number' ? found['forcedDeviceScaleFactor'] : null,
      };
    }
    const code = exitCode();
    if (code !== null) throw new Error(`electron 提前退出 ${code}\nstdout:\n${stdout()}\nstderr:\n${stderr()}`);
    await delay(30);
  }
  throw new Error(`ready 超时\nstdout:\n${stdout()}\nstderr:\n${stderr()}`);
}

export interface StopOptions {
  /** 用真实 Escape 键退出（产品自身的退出路径），而不是直接杀进程。 */
  readonly graceful?: boolean;
  readonly timeoutMs?: number;
}

export interface StopResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly portClosed: boolean;
  readonly alivePids: readonly number[];
  readonly writesAtQuit: number;
  readonly writesAfterQuit: number;
  /** 该 pid 的窗口是否已消失（起下一臂前必须为真，否则会拖到旧窗口上）。 */
  readonly windowGone: boolean;
}

export async function stopApp(app: AppHandle, options: StopOptions = {}): Promise<StopResult> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const pid = app.child.pid;
  // 退出前先把子进程树抓下来：父进程退出后子进程会被 init 收养，届时无法再按父子关系判定残留。
  const tracked = new Set<number>(app.trackedPids());
  try {
    const snapshot = await snapshotChildren(process.platform);
    for (const child of descendantPids(pid ?? 0, snapshot)) tracked.add(child);
  } catch {
    // 进程表查询失败时保留已知 PID；残留判定退化为只看主进程。
  }

  // 先把管道里已经在飞的 bounds 行读完，再记"退出前写入数"；否则会把退出前的正常写入
  // 误判成"退出过程中又写了宿主"。
  await delay(60);
  app.boundsLines();
  const writesAtQuit = app.writeCount();
  if (options.graceful !== false) {
    try {
      await app.cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
      await app.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
    } catch {
      // 页面已崩/已退出：继续走等待与清理。
    }
  }

  const exited = await waitExit(app.child, timeoutMs);
  await app.cdp.close();
  if (!exited) killGroup(pid);
  // 父进程退出后子进程可能被收养：这里再补一次组信号，避免把 144 显示号占住。
  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // 已经没了。
    }
  }
  await delay(120);
  // 下一臂启动前必须确认这一臂的窗口真的没了，否则名字搜索会拿到旧窗口 id。
  const windowGone = pid === undefined ? false : await waitWindowsGone(requireDisplay(), pid, 2000);
  const alivePids = [...tracked].filter((item) => pidIsAlive(item));
  const portClosed = await portIsFree(app.port);
  const writesAfterQuit = app.writeCount();
  await rm(app.userData, { recursive: true, force: true });
  return {
    exitCode: app.child.exitCode,
    signal: app.child.signalCode,
    timedOut: !exited,
    portClosed,
    alivePids,
    writesAtQuit,
    writesAfterQuit,
    windowGone,
  };
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
    return;
  } catch {
    // 无进程组：退回单进程。
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 已经退出。
  }
}

async function portIsFree(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// 真实 X 指针（xdotool）
// ---------------------------------------------------------------------------

export function requireDisplay(): string {
  const display = process.env['DISPLAY'];
  if (display === undefined || display === '') throw new Error('DISPLAY 未设置（需要 Xvfb，例如 :144）');
  return display;
}

export function xdotool(display: string, args: readonly string[]): string {
  return execFileSync('xdotool', [...args], {
    encoding: 'utf8',
    env: { ...process.env, DISPLAY: display },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * 列出某 pid 名下的窗口 id。
 * 两臂在同一个测试进程里串行跑，**不能**用"名字匹配的第一个/最后一个窗口"定位：
 * 上一臂残留的窗口会让拖动打在不收事件的窗口上（实测症状是 0 次写入但退出码 0）。
 */
export function windowIdsForPid(display: string, pid: number): string[] {
  // xdotool search 匹配不到窗口时是**非零退出**，不是查询失败；这里必须区分二者，
  // 否则"窗口已经消失"会被误判成"查不到"。
  let out: string;
  try {
    out = execFileSync('xdotool', ['search', '--onlyvisible', '--pid', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, DISPLAY: display },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error('xdotool 未安装或不在 PATH', { cause: error });
    // 其余（含 exit 1 = 没有匹配窗口）按空结果处理。
    out = String((error as { stdout?: string }).stdout ?? '');
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 取**本会话子进程**的窗口。优先按 `_NET_WM_PID` 绑定；绑定不到时退回按名字匹配，
 * 但要求名字匹配唯一（多于一个直接失败，不再"取最后一个"猜）。
 */
export function petWindowId(display: string, pid?: number): string {
  if (pid !== undefined) {
    const byPid = windowIdsForPid(display, pid).filter((id) => id.length > 0);
    const named = byPid.filter((id) => windowName(display, id).includes('pet-next'));
    const chosen = named.at(-1) ?? byPid.at(-1);
    if (chosen !== undefined) return chosen;
  }
  const found = xdotool(display, ['search', '--onlyvisible', '--name', 'pet-next'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (found.length === 0) throw new Error('未找到 pet-next 窗口（xdotool search --name pet-next）');
  if (found.length > 1) {
    throw new Error(
      `按名字找到 ${found.length} 个 pet-next 窗口（${found.join(',')}），无法确定本会话窗口；` +
        '按 pid 绑定也失败，拒绝继续以免拖到别的窗口上',
    );
  }
  return found[0] as string;
}

/** 窗口的 `_NET_WM_PID`：用来确认拿到的是**本会话子进程**的窗口（X 会复用窗口 id，不能靠 id 唯一性判断）。 */
export function windowPid(display: string, id: string): number {
  const text = xdotool(display, ['getwindowpid', id]).trim();
  const pid = Number(text);
  if (!Number.isFinite(pid) || pid <= 0) throw new Error(`xdotool getwindowpid ${id} 返回 "${text}"`);
  return pid;
}

function windowName(display: string, id: string): string {
  try {
    return xdotool(display, ['getwindowname', id]).trim();
  } catch {
    return '';
  }
}

/** 有界等待：某 pid 的窗口全部消失（进程退出后窗口应当一起销毁）。 */
export async function waitWindowsGone(display: string, pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let remaining: string[];
    try {
      remaining = windowIdsForPid(display, pid);
    } catch {
      // xdotool 本身失败（比如 X 连接抖动）不当成"窗口还在"，交给调用方的残留断言。
      return false;
    }
    if (remaining.length === 0) return true;
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
}

export function windowGeometry(display: string, winId: string): Bounds {
  const text = xdotool(display, ['getwindowgeometry', '--shell', winId]);
  const values: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const [key, value] = line.split('=');
    if (key === undefined || value === undefined) continue;
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) values[key.trim()] = parsed;
  }
  return {
    x: values['X'] ?? 0,
    y: values['Y'] ?? 0,
    width: values['WIDTH'] ?? 0,
    height: values['HEIGHT'] ?? 0,
  };
}

export interface PointerDragOptions {
  readonly from: Point;
  /** 每步位移（真实 X 指针，一步一次 mousemove）。 */
  readonly steps: readonly Point[];
  readonly stepDelayMs: number;
  /** 松手前的驻留时间。 */
  readonly settleMs?: number;
}

/**
 * 真实 X11 指针拖动。一次 xdotool 调用里串起 mousemove/sleep/mousedown/mouseup：
 * 每次重新 spawn 的开销会让 60/125Hz 根本达不到，串在一条命令里才接近目标速率。
 *
 * 必须**异步**：同步 exec 会把本进程事件循环整段挂住，主进程 stdout 的 `bounds` 行
 * 只能在拖动结束后才被读走，测出来的"输入→提交时延"会变成整段拖动时长（伪影）。
 */
export function dragWithPointer(display: string, options: PointerDragOptions): Promise<{ x: number; y: number }> {
  const args: string[] = ['mousemove', String(options.from.x), String(options.from.y), 'mousedown', '1'];
  let x = options.from.x;
  let y = options.from.y;
  for (const step of options.steps) {
    x += step.x;
    y += step.y;
    args.push('mousemove', String(x), String(y), 'sleep', String(options.stepDelayMs / 1000));
  }
  if ((options.settleMs ?? 0) > 0) args.push('sleep', String((options.settleMs ?? 0) / 1000));
  args.push('mouseup', '1');
  return new Promise((resolve, reject) => {
    const child = spawn('xdotool', args, {
      env: { ...process.env, DISPLAY: display },
      stdio: 'ignore',
    });
    child.once('error', (error) => reject(error));
    child.once('exit', (code) => {
      if (code === 0) resolve({ x, y });
      else reject(new Error(`xdotool 退出码 ${String(code)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// 500Hz 压力臂（合成指针，只用于机制门）
// ---------------------------------------------------------------------------

/**
 * 页面内合成指针脉冲：由 CDP `Runtime.evaluate` 注入，在 `#pet` 上按固定节拍 dispatch
 * `PointerEvent`，`screenX` 由测试给定（每一步 +1 DIP）。
 *
 * **不等同于物理鼠标，也不等同于 CDP `Input.dispatchMouseEvent`。** 为什么不用后者：
 * 1. 每条 `Input.dispatchMouseEvent` 都要一次 CDP 往返，实测 400 条耗 6667ms
 *    （≈60Hz），根本到不了 500Hz，机制门会变成"60Hz 下没有可合并写入"的假阴性；
 * 2. 它的 `screenX` 由**正在被产品移动的**窗口原点推出，形成正反馈：
 *    同一段 400 条输入会把窗口一路推到工作区右边缘（实测 80 → 1600 DIP），
 *    位移口径已失真。
 *
 * 这里保留产品真实链路（`#pet` 监听 → 手势归约 → `window.pet.moveBy` → 主进程控制器 →
 * `setPosition`），只替换"指针从哪来"，因此可以稳定给出 500Hz 与可控的 screenX。
 */
export async function dispatchPointerBurst(
  cdp: Cdp,
  options: {
    readonly events: number;
    readonly intervalMs: number;
    readonly screenStartX: number;
    readonly screenY: number;
    readonly clientX: number;
    readonly clientY: number;
  },
): Promise<{ dispatched: number; elapsedMs: number; effectiveHz: number }> {
  const result = await cdp.evaluate<{ dispatched: number; elapsedMs: number }>(`(async () => {
    const el = document.querySelector('#pet');
    if (!(el instanceof HTMLElement)) throw new Error('missing pet');
    const send = (type, screenX, buttons) => {
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 7,
        pointerType: 'mouse',
        isPrimary: true,
        button: type === 'pointermove' ? -1 : 0,
        buttons,
        clientX: ${options.clientX},
        clientY: ${options.clientY},
        screenX,
        screenY: ${options.screenY},
      }));
    };
    // 2ms 级节拍不能用 setTimeout：Chromium 的嵌套定时器实际会被夹到 ~4ms（实测 247Hz）。
    // 这里用 performance.now() 自旋保证间距；自旋发生在渲染层，主进程 CPU 口径不受影响。
    const pace = (ms) => {
      const end = performance.now() + ms;
      while (performance.now() < end) { /* spin */ }
    };
    const startedAt = performance.now();
    send('pointerdown', ${options.screenStartX}, 1);
    for (let index = 1; index <= ${options.events}; index += 1) {
      send('pointermove', ${options.screenStartX} + index, 1);
      pace(${options.intervalMs});
    }
    send('pointerup', ${options.screenStartX} + ${options.events}, 0);
    return { dispatched: ${options.events}, elapsedMs: performance.now() - startedAt };
  })()`, 60000);
  const elapsedMs = Math.max(1, result.elapsedMs);
  return {
    dispatched: result.dispatched,
    elapsedMs,
    effectiveHz: Math.round((result.dispatched / elapsedMs) * 1000),
  };
}

/**
 * 页面侧采样器。`at` 用 `performance.timeOrigin + event.timeStamp`：
 * - timeStamp 是事件**产生**时刻（硬件/合成输入到达浏览器的时间），不是本监听器被调度的时刻；
 * - timeOrigin 把 performance 时基换回 Date.now 时基，与主进程 stdout 的接收时间同一台墙钟。
 *
 * 若改用 `Date.now()`（监听器被调度时刻），由于指针投递按帧对齐，实测会整体偏移约一帧（-16ms），
 * 把真实时延压成负数——那是伪影，不是收益。
 */
export async function installPointerSampler(cdp: Cdp): Promise<void> {
  await cdp.evaluate(`(() => {
    window.__dwbSamples = [];
    const el = document.querySelector('#pet');
    if (!(el instanceof HTMLElement)) throw new Error('missing pet');
    const record = (event) => {
      window.__dwbSamples.push({
        t: event.type,
        at: Math.round(performance.timeOrigin + event.timeStamp),
        dispatchAt: Date.now(),
        sx: event.screenX,
        sy: event.screenY,
        cx: event.clientX,
        cy: event.clientY,
        buttons: event.buttons,
      });
    };
    el.addEventListener('pointerdown', record, true);
    el.addEventListener('pointermove', record, true);
    el.addEventListener('pointerup', record, true);
    return true;
  })()`);
}

export interface PointerSample {
  readonly t: string;
  readonly at: number;
  readonly sx: number;
  readonly sy: number;
  readonly cx: number;
  readonly cy: number;
  readonly buttons: number;
}

export async function readPointerSamples(cdp: Cdp): Promise<PointerSample[]> {
  return cdp.evaluate<PointerSample[]>('window.__dwbSamples ?? []');
}

export async function clearPointerSamples(cdp: Cdp): Promise<void> {
  await cdp.evaluate('window.__dwbSamples = []');
}

export async function readTrace(cdp: Cdp): Promise<string> {
  return cdp.evaluate<string>('document.documentElement.dataset.trace ?? ""');
}

export async function readVisual(cdp: Cdp): Promise<{ visual: string; request: string; dragging: boolean }> {
  return cdp.evaluate<{ visual: string; request: string; dragging: boolean }>(`(() => ({
    visual: document.documentElement.dataset.visual ?? '',
    request: document.documentElement.dataset.request ?? '',
    dragging: document.body.classList.contains('dragging'),
  }))()`);
}

export async function waitFor<T>(
  label: string,
  probe: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs: number,
  extra: () => string = () => '',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await probe();
    if (ok(last)) return last;
    await delay(40);
  }
  throw new Error(`${label} 超时；最后观测 ${JSON.stringify(last)} ${extra()}`);
}

/** 拖动结束后静置一段时间，确认没有迟到的 timer 继续写宿主。 */
export async function waitQuietWrites(app: AppHandle, quietMs: number): Promise<{ before: number; after: number }> {
  const before = app.writeCount();
  await delay(quietMs);
  return { before, after: app.writeCount() };
}

export interface Session {
  readonly app: AppHandle;
  readonly windowId: string;
  readonly geometry: Bounds;
}

/** 起一个真实窗口并激活（裸 Xvfb 无 WM 时激活降级，指针仍按坐标命中）。 */
export async function openSession(options: LaunchOptions & { readonly preview?: string }): Promise<Session> {
  const env: NodeJS.ProcessEnv = { ...(options.extraEnv ?? {}) };
  if (options.preview !== undefined && options.preview !== '') env['PET_NEXT_PREVIEW'] = options.preview;
  const app = await launchApp({ ...options, extraEnv: env });
  const display = requireDisplay();
  // 按本会话子进程 pid 绑定窗口：两臂串行时不能靠名字猜。
  // 窗口刚映射时 geometry 可能还是 0×0，拖动会打在窗口外（症状：0 次写入但退出码 0）。
  let windowId = petWindowId(display, app.child.pid);
  let geometry = windowGeometry(display, windowId);
  for (let attempt = 0; attempt < 20 && (geometry.width <= 0 || geometry.height <= 0); attempt += 1) {
    await delay(50);
    windowId = petWindowId(display, app.child.pid);
    geometry = windowGeometry(display, windowId);
  }
  if (geometry.width <= 0 || geometry.height <= 0) {
    throw new Error(`窗口 ${windowId} 未映射出可见尺寸（geometry=${JSON.stringify(geometry)}）`);
  }
  try {
    xdotool(display, ['windowactivate', '--sync', windowId]);
  } catch {
    // 裸 Xvfb 没有窗口管理器。
  }
  // 主进程 ready-to-show 只代表窗口可显示，**早于** page.ts 绑定 #pet 监听。
  // 不等这一步就按下拖动，事件会打空（症状：0 次写入、退出码 0、页面 trace 正常）——
  // 这是本轮实际踩到的竞态，必须在这里统一等，而不是让每个用例各自记得等。
  await waitFor('页面就绪', () => readVisual(app.cdp), (state) => state.visual === 'idle', 20000);
  return { app, windowId, geometry };
}

export interface DragResult {
  readonly base: Point;
  readonly expectedFinal: Point;
  readonly lines: readonly BoundsLine[];
  readonly samples: readonly PointerSample[];
}

/** 真实指针拖动 + 等待主进程写到位；返回**本次**拖动产生的写入切片。 */
export async function realPointerDrag(
  session: Session,
  input: { readonly steps: readonly Point[]; readonly stepDelayMs: number; readonly settleMs?: number },
): Promise<DragResult> {
  const app = session.app;
  const base = app.boundsLines().at(-1)?.requested ?? { x: app.ready.bounds.x, y: app.ready.bounds.y };
  await clearPointerSamples(app.cdp);
  const before = app.boundsLines().length;
  const scale = app.ready.scaleFactor > 0 ? app.ready.scaleFactor : 1;
  // 起点按**当前**窗口原点算（上一次拖动已经把它挪走了），否则连续手势会点到窗口外。
  const originPx = { x: Math.round(base.x * scale), y: Math.round(base.y * scale) };
  const from = { x: originPx.x + 60, y: originPx.y + 60 };
  const landed = await dragWithPointer(requireDisplay(), {
    from,
    steps: input.steps,
    stepDelayMs: input.stepDelayMs,
    settleMs: input.settleMs ?? 0,
  });
  const expectedFinal = {
    x: Math.round(base.x + (landed.x - from.x) / scale),
    y: Math.round(base.y + (landed.y - from.y) / scale),
  };
  await waitFor(
    '拖动后主进程写到位',
    async () => app.boundsLines().slice(before),
    (lines) => {
      const last = lines.at(-1);
      return last !== undefined && last.requested.x === expectedFinal.x && last.requested.y === expectedFinal.y;
    },
    8000,
    () => `writes=${app.writeCount()} stdout=${app.stdout().slice(-400)}`,
  );
  await delay(120);
  return {
    base,
    expectedFinal,
    lines: app.boundsLines().slice(before),
    samples: await readPointerSamples(app.cdp),
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

export interface GestureLatency {
  /** 首个 pointermove（越阈值那一下）→ 首条 bounds 的时延。 */
  readonly first: number;
  /** 最后一个 pointermove → 末条 bounds 的时延（候选臂这里是 flush 落地的时刻）。 */
  readonly last: number;
  readonly moves: number;
  readonly writes: number;
}

/**
 * 按"手势两端"取时延，不做逐条位置配对。
 *
 * 为什么不做位置配对：真实指针拖动里窗口本身在动，渲染层的 `screenX` 由（可能落后一帧的）
 * 窗口原点推出，位置序列与 `screenX` 序列不是 1:1 对齐的；按位置反解会把提交配到更晚的
 * 输入上，测出整帧的负时延伪影。首/末两端各只有一个候选事件，配对是明确的。
 */
export function latencyEdges(lines: readonly BoundsLine[], samples: readonly PointerSample[]): GestureLatency {
  const moves = samples.filter((sample) => sample.t === 'pointermove' && sample.buttons === 1);
  const firstMove = moves[0];
  const lastMove = moves.at(-1);
  const firstLine = lines[0];
  const lastLine = lines.at(-1);
  return {
    first: firstMove === undefined || firstLine === undefined ? Number.NaN : firstLine.recvAt - firstMove.at,
    last: lastMove === undefined || lastLine === undefined ? Number.NaN : lastLine.recvAt - lastMove.at,
    moves: moves.length,
    writes: lines.length,
  };
}

/** 主进程 CPU：/proc/<pid>/stat 的 utime+stime（USER_HZ=100）。非 Linux 返回 null。 */
export function readCpuJiffies(pid: number): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = text.lastIndexOf(')');
    if (close < 0) return null;
    const fields = text.slice(close + 2).split(' ');
    // stat 的第 14/15 个字段是 utime/stime；去掉 pid/comm 之后从 state 起算。
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    return utime + stime;
  } catch {
    return null;
  }
}
