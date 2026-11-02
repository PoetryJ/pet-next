/**
 * M3-0 聊天预览 E2E（正式入口版）：只走 `pnpm chat:preview`，不另造启动链。
 *
 * 唯一启动方式（冻结参数）：
 *   DISPLAY=:94 PET_NEXT_CHAT_DEBUG_PORT=<port> PET_NEXT_USER_DATA=<tmp> pnpm chat:preview
 *   （pnpm chat:preview = pnpm build && node scripts/chat-demo.mjs；入口自起 fake HTTP + Electron，
 *     关窗或 Ctrl-C 结束，失败必须非零退出。）
 *
 * 交互一律真实输入事件：CDP Input.dispatchMouseEvent 点击（坐标取矩形中心）、
 * Input.insertText / Input.dispatchKeyEvent 输入与 Enter 发送。DOM 只读（矩形、状态、文本），
 * 不调用 el.click()，不直接赋 value。
 *
 * 覆盖：
 *   T1 打开面板→输入→发送→回复（含"演示回复"标注）→关面板→关窗，退出码 0、无残留
 *   T2 fake 的 [error] 标记→面板报错→恢复后再发成功
 *   T3 [slow] 在途取消→已取消→立即重发成功→旧迟到回复不显示→关面板→在途关窗，
 *      并用 /proc 连接表证明取消时 Electron→fake 的 TCP 连接被撤销
 *   T4 正式入口失败路径：fake 端口被占用 → 入口非零退出、无 Electron 残留
 *
 * 运行（团队约定：独占 :94，PATH 需含 node 24.14.0）：
 *   node --experimental-strip-types --test --test-concurrency=1 --test-reporter spec tests/chat.e2e.test.ts
 * 证据：tests/chat-evidence/formal-entry/（每用例一份 .txt + 关键截图 .png），汇总见 RUN-NOTES.txt。
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pidIsAlive } from './support/process-table.ts';
import { startTrackedRun, type TrackedRun } from './support/tracked-run.ts';

const petRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const evidenceDir = path.join(petRoot, 'tests/chat-evidence/formal-entry');

// 团队约定：本 E2E 独占 :94（:99/:95 归他人）。已在跑则复用，只有自己拉起才负责收掉。
const display = process.env.PET_NEXT_E2E_DISPLAY ?? ':94';
const displaySuffix = display.startsWith(':') ? display.slice(1) : display;
const displaySocket = `/tmp/.X11-unix/X${displaySuffix}`;
const SLOW_MS = 3000;

let xvfb: ChildProcess | undefined;
let ownsXvfb = false;
let displayReady = false;

/** 面板控件矩形读取结果（全部字段都返回，缺元素时 found=false）。 */
interface RectInfo {
  found: boolean;
  visible: boolean;
  inViewport: boolean;
  hit: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
  disabled: boolean | null;
  text: string;
}

type RectKey = 'toggle' | 'title' | 'close' | 'input' | 'send' | 'cancel';

const RECT_SELECTORS: Record<RectKey, string> = {
  toggle: '[data-testid="chat-toggle"]',
  title: '.chat-title',
  close: '[data-testid="chat-close"]',
  input: '[data-testid="chat-input"]',
  send: '[data-testid="chat-send"]',
  cancel: '[data-testid="chat-cancel"]',
};

/** 页面只读快照：状态、消息文本、输入值、焦点与六个控件矩形。 */
interface DomState {
  readyState: string;
  viewport: { width: number; height: number; dpr: number };
  hasPanel: boolean;
  phase: string;
  panelHidden: boolean | null;
  userMsgs: string[];
  assistantMsgs: string[];
  errorMsgs: string[];
  statusMsgs: string[];
  demoTagCount: number;
  inputValue: string | null;
  focusTestId: string | null;
  rects: Record<RectKey, RectInfo>;
}

interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

interface Evidence {
  readonly name: string;
  readonly lines: string[];
  log(line: string): void;
}

interface EntryRun {
  readonly tracked: TrackedRun;
  readonly cdp: Cdp;
  readonly debugPort: number;
  readonly userData: string;
  readonly fakePort: number | null;
  readonly observabilityFile: string;
  readonly evidence: Evidence;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(text: string, max = 2000): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function createEvidence(name: string): Evidence {
  return {
    name,
    lines: [],
    log(line: string): void {
      this.lines.push(line);
      console.log(`[evidence] ${line}`);
    },
  };
}

async function flushEvidence(evidence: Evidence, title: string): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  const body = [`# ${title}`, `# 记录时间: ${new Date().toISOString()}`, `# 用例: ${evidence.name}`, '', ...evidence.lines].join('\n');
  await writeFile(path.join(evidenceDir, `${evidence.name}.txt`), `${body}\n`);
}

function freePort(): Promise<number> {
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

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function pnpmPath(): string {
  const beside = path.join(path.dirname(process.execPath), 'pnpm');
  if (existsSync(beside)) return beside;
  return 'pnpm';
}

function startXvfb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    xvfb = proc;
    ownsXvfb = true;
    let spawnError: Error | undefined;
    proc.once('error', (error) => {
      spawnError = error;
    });
    const deadline = Date.now() + 8000;
    const poll = (): void => {
      if (existsSync(displaySocket)) {
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
        reject(new Error(`Xvfb socket missing: ${displaySocket}`));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

before(async () => {
  if (existsSync(displaySocket)) {
    displayReady = true;
    return;
  }
  try {
    await startXvfb();
    displayReady = true;
  } catch {
    displayReady = false;
  }
});

after(async () => {
  if (xvfb === undefined || !ownsXvfb) return;
  xvfb.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000);
    xvfb?.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
});

function ensureDisplay(t: { skip(message?: string): unknown }): boolean {
  if (!displayReady) {
    t.skip(`not-run: Xvfb ${display} 起不来（无显示环境）`);
    return false;
  }
  return true;
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

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const result = (await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed');
  }
  return result.result?.value as T;
}

/** 命名的 JSON 打点（入口会转发 electron stdout，行首可能带 "[electron] " 前缀）。 */
function findEvent(tracked: TrackedRun, event: string): Record<string, unknown> | null {
  for (const line of tracked.stdout().split('\n')) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    try {
      const value = JSON.parse(line.slice(start)) as unknown;
      if (typeof value === 'object' && value !== null && (value as { event?: unknown }).event === event) {
        return value as Record<string, unknown>;
      }
    } catch {
      // 非 JSON 行忽略。
    }
  }
  return null;
}

async function waitForPageSocket(port: number, tracked: TrackedRun, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no targets';
  while (Date.now() < deadline) {
    if (tracked.child.exitCode !== null || tracked.child.signalCode !== null) {
      throw new Error(
        `入口在暴露 CDP 前退出（code=${tracked.child.exitCode} signal=${tracked.child.signalCode}）\nstdout:\n${tail(tracked.stdout())}\nstderr:\n${tail(tracked.stderr())}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = (await response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      lastError = `targets=${JSON.stringify(list.map((item) => item.type))}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(80);
  }
  throw new Error(`CDP page 未就绪（${lastError}）\nstdout:\n${tail(tracked.stdout())}\nstderr:\n${tail(tracked.stderr())}`);
}
function entryEnv(input: {
  debugPort: number;
  userData: string;
  delayMs: number;
  slowMs: number;
  observabilityFile: string;
  extra?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // 正式入口自己设置这两个开关；避免外部残留污染。
  delete env.PET_NEXT_CHAT_PREVIEW;
  delete env.PET_NEXT_CHAT_FAKE_URL;
  delete env.PET_NEXT_FAKE_CHAT_PORT;
  delete env.PET_NEXT_CHAT_DEBUG_PORT;
  delete env.PET_NEXT_USER_DATA;
  env.DISPLAY = display;
  env.PET_NEXT_TEST = '1';
  env.PET_NEXT_CHAT_DEBUG_PORT = String(input.debugPort);
  env.PET_NEXT_USER_DATA = input.userData;
  env.PET_NEXT_FAKE_CHAT_DELAY_MS = String(input.delayMs);
  env.PET_NEXT_FAKE_CHAT_SLOW_MS = String(input.slowMs);
  // 可选观测口子：入口 fake 若实现，会把请求/断开/响应写成 NDJSON；不实现则退回 /proc 连接观测。
  env.PET_NEXT_CHAT_FAKE_OBSERVABILITY = input.observabilityFile;
  for (const [key, value] of Object.entries(input.extra ?? {})) env[key] = value;
  return env;
}

/** 启动正式入口并接管 CDP。失败时清理本次进程与临时 userData。 */
async function launchEntry(options: {
  label: string;
  evidence: Evidence;
  delayMs?: number;
  slowMs?: number;
}): Promise<EntryRun> {
  const userData = await mkdtemp(path.join(tmpdir(), 'pet-next-formal-e2e-'));
  const observabilityFile = path.join(userData, 'fake-observability.ndjson');
  const debugPort = await freePort();
  const env = entryEnv({
    debugPort,
    userData,
    delayMs: options.delayMs ?? 0,
    slowMs: options.slowMs ?? SLOW_MS,
    observabilityFile,
  });
  options.evidence.log(`cmd: DISPLAY=${display} PET_NEXT_CHAT_DEBUG_PORT=${debugPort} PET_NEXT_USER_DATA=${userData} pnpm chat:preview`);
  options.evidence.log(
    `env: PET_NEXT_TEST=1 PET_NEXT_FAKE_CHAT_DELAY_MS=${String(env.PET_NEXT_FAKE_CHAT_DELAY_MS)} PET_NEXT_FAKE_CHAT_SLOW_MS=${String(env.PET_NEXT_FAKE_CHAT_SLOW_MS)}`,
  );
  const tracked = startTrackedRun({
    executable: pnpmPath(),
    args: ['chat:preview'],
    cwd: petRoot,
    env,
    label: options.label,
    logRoot: path.join(petRoot, 'logs/platform-runs'),
  });
  try {
    const socket = await waitForPageSocket(debugPort, tracked, 120000);
    options.evidence.log(`cdp page: ${socket}`);
    const cdp = await connectCdp(socket);
    try {
      await cdp.send('Page.enable');
    } catch {
      // Page 域不可用时截图会在后面报错，不影响交互断言。
    }
    const fakePort = await waitForFakePort(tracked, 15000);
    options.evidence.log(`fake chat server port: ${fakePort === null ? 'unknown' : String(fakePort)}`);
    options.evidence.log(`entry electron config: ${JSON.stringify(findEvent(tracked, 'chat-demo-electron-config'))}`);
    return { tracked, cdp, debugPort, userData, fakePort, observabilityFile, evidence: options.evidence };
  } catch (error) {
    await tracked.stop().catch(() => undefined);
    await tracked.writeRecord().catch(() => undefined);
    await rm(userData, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function waitForFakePort(tracked: TrackedRun, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = findEvent(tracked, 'fake-chat-server-ready');
    if (record !== null) {
      const port = record.port;
      return typeof port === 'number' ? port : null;
    }
    await delay(50);
  }
  return null;
}

function domExpression(): string {
  return `(() => {
  const SELECTORS = ${JSON.stringify(RECT_SELECTORS)};
  const read = (selector) => {
    const el = document.querySelector(selector);
    if (el === null) {
      return { found: false, visible: false, inViewport: false, hit: false, x: 0, y: 0, width: 0, height: 0, cx: 0, cy: 0, disabled: null, text: '' };
    }
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = !el.hidden && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const inViewport = rect.left >= -0.5 && rect.top >= -0.5 && rect.right <= innerWidth + 0.5 && rect.bottom <= innerHeight + 0.5;
    const at = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight ? document.elementFromPoint(cx, cy) : null;
    const hit = at !== null && (at === el || el.contains(at));
    return {
      found: true,
      visible,
      inViewport,
      hit,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      cx,
      cy,
      disabled: el instanceof HTMLButtonElement ? el.disabled : null,
      text: (el.textContent ?? '').trim().slice(0, 40),
    };
  };
  const rects = {};
  for (const key of Object.keys(SELECTORS)) rects[key] = read(SELECTORS[key]);
  const texts = (selector) => Array.from(document.querySelectorAll(selector)).map((node) => (node.textContent ?? '').trim());
  const root = document.querySelector('[data-testid="chat-panel"]');
  const panel = document.querySelector('[data-testid="chat-panel-open"]');
  const input = document.querySelector('[data-testid="chat-input"]');
  const active = document.activeElement;
  return {
    readyState: document.readyState,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    hasPanel: root !== null,
    phase: root instanceof HTMLElement ? (root.dataset.state ?? '') : '',
    panelHidden: panel instanceof HTMLElement ? panel.hidden : null,
    userMsgs: texts('[data-testid="chat-msg-user"]'),
    assistantMsgs: texts('[data-testid="chat-msg-assistant"]'),
    errorMsgs: texts('[data-testid="chat-msg-error"]'),
    statusMsgs: texts('[data-testid="chat-status"]'),
    demoTagCount: document.querySelectorAll('[data-testid="chat-msg-assistant"] .chat-demo-tag').length,
    inputValue: input instanceof HTMLTextAreaElement ? input.value : null,
    focusTestId: active instanceof HTMLElement ? (active.dataset.testid ?? active.tagName) : null,
    rects,
  };
})()`;
}

async function readDom(run: EntryRun): Promise<DomState> {
  return evaluate<DomState>(run.cdp, domExpression());
}

async function pollUntil<T>(
  label: string,
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs: number,
  describe?: (value: T) => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (ok(last)) return last;
    await delay(50);
  }
  const detail = last === undefined ? '无采样' : describe ? describe(last) : JSON.stringify(last);
  throw new Error(`${label}（${timeoutMs}ms 超时）\nlast=${detail}`);
}

async function waitDom(
  run: EntryRun,
  label: string,
  ok: (state: DomState) => boolean,
  timeoutMs = 20000,
): Promise<DomState> {
  try {
    return await pollUntil(label, () => readDom(run), ok, timeoutMs);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nstdout:\n${tail(run.tracked.stdout())}\nstderr:\n${tail(run.tracked.stderr())}`,
      { cause: error },
    );
  }
}

/** 断言控件：存在、可见、矩形完全在视口 0..宽高内、中心点可命中（未被遮挡）。 */
async function rectReady(run: EntryRun, key: RectKey, label: string, timeoutMs = 12000): Promise<RectInfo> {
  const state = await pollUntil(
    `${label} 未就绪（存在/可见/在视口内/可命中）`,
    () => readDom(run),
    (snapshot) => {
      const rect = snapshot.rects[key];
      return rect.found && rect.visible && rect.inViewport && rect.hit;
    },
    timeoutMs,
    (snapshot) => JSON.stringify({ viewport: snapshot.viewport, rect: snapshot.rects[key] }),
  );
  const rect = state.rects[key];
  const { width, height } = state.viewport;
  assert.equal(rect.found, true, `${label} 不存在`);
  assert.equal(rect.visible, true, `${label} 不可见：${JSON.stringify(rect)}`);
  assert.ok(rect.width > 0 && rect.height > 0, `${label} 尺寸为 0：${JSON.stringify(rect)}`);
  assert.ok(
    rect.x >= -0.5 && rect.y >= -0.5 && rect.x + rect.width <= width + 0.5 && rect.y + rect.height <= height + 0.5,
    `${label} 矩形越出视口 ${width}x${height}：x=${rect.x} y=${rect.y} w=${rect.width} h=${rect.height}`,
  );
  assert.equal(rect.hit, true, `${label} 中心点被遮挡/不可命中：${JSON.stringify(rect)}`);
  run.evidence.log(
    `rect ${key}: x=${rect.x.toFixed(1)} y=${rect.y.toFixed(1)} ${rect.width.toFixed(1)}x${rect.height.toFixed(1)} 视口=${width}x${height} disabled=${String(rect.disabled)}`,
  );
  return rect;
}

/** 打开面板前/后的完整视口断言：toggle、标题、关闭、输入、发送、取消。 */
async function assertControlsInViewport(run: EntryRun): Promise<void> {
  const keys: RectKey[] = ['toggle', 'title', 'close', 'input', 'send', 'cancel'];
  for (const key of keys) await rectReady(run, key, key);
}

async function clickRect(run: EntryRun, rect: RectInfo, label: string): Promise<void> {
  const x = Math.round(rect.cx);
  const y = Math.round(rect.cy);
  await run.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await run.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await delay(20);
  await run.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  run.evidence.log(`mouse click ${label} @ (${x},${y})`);
}

/** Ctrl+A：真实键盘事件（modifiers=2 表示 Ctrl），随后 insertText 覆盖整段旧文本。 */
async function pressKey(run: EntryRun, key: string, code: string, virtualKeyCode: number): Promise<void> {
  const base = { key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode };
  await run.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await run.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** 用真实键盘清空输入框：End 移到末尾，再按 value.length 次 Backspace。 */
async function clearInput(run: EntryRun): Promise<void> {
  const before = await readDom(run);
  const length = before.inputValue?.length ?? 0;
  if (length === 0) return;
  await pressKey(run, 'End', 'End', 35);
  for (let index = 0; index < length; index += 1) await pressKey(run, 'Backspace', 'Backspace', 8);
  await waitDom(run, '输入框未清空', (state) => state.inputValue === '', 6000);
  run.evidence.log(`keyboard clear: ${length} 次 Backspace`);
}

/** 鼠标点入输入框 → 键盘清空 → Input.insertText；随后回读 DOM 确认值。 */
async function typeMessage(run: EntryRun, text: string): Promise<void> {
  const input = await rectReady(run, 'input', '输入框');
  await clickRect(run, input, 'chat-input');
  await pollUntil('输入框未获得焦点', () => readDom(run), (state) => state.focusTestId === 'chat-input', 6000);
  await clearInput(run);
  await run.cdp.send('Input.insertText', { text });
  const state = await waitDom(run, `输入回读不一致（期望 ${text}）`, (snapshot) => snapshot.inputValue === text, 8000);
  assert.equal(state.inputValue, text, `输入回读不一致：${JSON.stringify(state.inputValue)}`);
  run.evidence.log(`keyboard input: ${text}`);
}

async function pressEnter(run: EntryRun): Promise<void> {
  await run.cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await run.cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  run.evidence.log('keyboard: Enter（rawKeyDown/keyUp）');
}

async function clickSend(run: EntryRun): Promise<void> {
  const send = await rectReady(run, 'send', '发送按钮');
  const state = await waitDom(run, '发送按钮应可用', (snapshot) => snapshot.rects.send.disabled === false, 6000);
  assert.equal(state.rects.send.disabled, false, '发送按钮应可用');
  await clickRect(run, send, 'chat-send');
}

async function clickCancel(run: EntryRun): Promise<void> {
  const cancel = await rectReady(run, 'cancel', '取消按钮');
  const state = await waitDom(run, '取消按钮应可用', (snapshot) => snapshot.rects.cancel.disabled === false, 6000);
  assert.equal(state.rects.cancel.disabled, false, '取消按钮应可用');
  await clickRect(run, cancel, 'chat-cancel');
}

async function openPanel(run: EntryRun): Promise<DomState> {
  await waitDom(run, '聊天面板未挂载（正式入口未开启 chat 预览或接线缺失）', (state) => state.hasPanel, 30000);
  const before = await waitDom(run, '面板初始应为收起态', (state) => state.panelHidden === true, 8000);
  run.evidence.log(`panel mounted: phase=${before.phase} hidden=${String(before.panelHidden)}`);
  const toggle = await rectReady(run, 'toggle', '面板开关');
  await clickRect(run, toggle, 'chat-toggle');
  const opened = await waitDom(
    run,
    '点击开关后面板未打开',
    (state) => state.panelHidden === false && state.phase !== 'closed' && state.rects.input.found,
    10000,
  );
  run.evidence.log(`panel open: phase=${opened.phase}`);
  return opened;
}

async function closePanelByMouse(run: EntryRun): Promise<void> {
  const close = await rectReady(run, 'close', '面板关闭按钮');
  await clickRect(run, close, 'chat-close');
}

async function screenshot(run: EntryRun, name: string): Promise<void> {
  const result = (await run.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })) as {
    data?: string;
  };
  const data = result.data;
  assert.ok(typeof data === 'string' && data.length > 0, `截图失败：${name}`);
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, name), Buffer.from(data as string, 'base64'));
  run.evidence.log(`截图: tests/chat-evidence/formal-entry/${name}`);
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => reject(new Error(`入口未在 ${timeoutMs}ms 内退出`)), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function quitByApi(run: EntryRun, note: string): Promise<void> {
  run.evidence.log(`关窗: ${note}（Runtime.evaluate window.pet.quit()）`);
  await evaluate(run.cdp, 'window.pet.quit()');
}
function readCmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return '';
  }
}

function pidsWithArg(needle: string): number[] {
  const found: number[] = [];
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return found;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (readCmdline(pid).includes(needle)) found.push(pid);
  }
  return found;
}

/** 本次入口的 Electron 主进程 PID（命令行带 dist/electron/main.js）。 */
function electronPids(run: EntryRun): number[] {
  return run.tracked.trackedPids().filter((pid) => readCmdline(pid).includes('dist/electron/main.js'));
}

interface SocketRow {
  inode: string;
  localPort: number;
  remotePort: number;
}

function parsePort(hexAddress: string): number {
  const index = hexAddress.lastIndexOf(':');
  return index < 0 ? 0 : Number.parseInt(hexAddress.slice(index + 1), 16);
}

/** 读取某 PID 已建立的 TCP 连接（/proc/<pid>/fd 的 socket inode + /proc/net/tcp 状态）。 */
function establishedSockets(pid: number, remotePort: number): SocketRow[] {
  const inodes = new Set<string>();
  let fds: string[];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return [];
  }
  for (const fd of fds) {
    try {
      const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
      const inode = match?.[1];
      if (inode !== undefined) inodes.add(inode);
    } catch {
      // fd 在枚举期间关闭。
    }
  }
  if (inodes.size === 0) return [];
  const rows: SocketRow[] = [];
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = readFileSync(table, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      const state = fields[3];
      const inode = fields[9];
      if (state !== '01' || inode === undefined || !inodes.has(inode)) continue; // 01 = ESTABLISHED
      rows.push({
        inode,
        localPort: parsePort(fields[1] ?? ''),
        remotePort: parsePort(fields[2] ?? ''),
      });
    }
  }
  return rows.filter((row) => row.remotePort === remotePort);
}

/** 本入口所有 Electron 进程到 fake 端口的已建立连接（取消前应有、取消后应无）。 */
function fakeConnections(run: EntryRun): Array<SocketRow & { pid: number }> {
  const port = run.fakePort;
  if (port === null) return [];
  const rows: Array<SocketRow & { pid: number }> = [];
  for (const pid of electronPids(run)) {
    for (const row of establishedSockets(pid, port)) rows.push({ ...row, pid });
  }
  return rows;
}

interface FakeObservation {
  event?: string;
  id?: string;
  text?: string;
  receivedAt?: number;
  closedAt?: number;
  respondedAt?: number;
  delivered?: boolean;
}

/** 入口 fake 的可选 NDJSON 观测（实现了才有；没有就返回空数组）。 */
function readObservations(run: EntryRun): FakeObservation[] {
  if (!existsSync(run.observabilityFile)) return [];
  const rows: FakeObservation[] = [];
  for (const line of readFileSync(run.observabilityFile, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === 'object' && value !== null) rows.push(value as FakeObservation);
    } catch {
      // 半行（未 flush 完）忽略。
    }
  }
  return rows;
}

/** 退出后核对：入口进程树全灭、调试/fake 端口关闭、无带本次调试端口的游离进程。 */
async function assertNoLeftovers(run: EntryRun): Promise<void> {
  const deadline = Date.now() + 8000;
  let alive = run.tracked.trackedPids().filter((pid) => pidIsAlive(pid));
  while (alive.length > 0 && Date.now() < deadline) {
    await delay(100);
    alive = run.tracked.trackedPids().filter((pid) => pidIsAlive(pid));
  }
  run.evidence.log(`残留进程（本次进程树）: ${JSON.stringify(alive)}`);
  assert.deepEqual(alive, [], `入口退出后仍有残留进程：${JSON.stringify(alive)}`);
  assert.equal(await portListening(run.debugPort), false, `调试端口 ${run.debugPort} 仍在监听`);
  const stray = pidsWithArg(`--remote-debugging-port=${run.debugPort}`);
  run.evidence.log(`残留进程（--remote-debugging-port=${run.debugPort}）: ${JSON.stringify(stray)}`);
  assert.deepEqual(stray, [], `调试端口被游离进程占用：${JSON.stringify(stray)}`);
  const fakePort = run.fakePort;
  if (fakePort !== null) {
    await pollUntil(
      `fake 端口 ${fakePort} 未随入口退出关闭`,
      () => portListening(fakePort),
      (listening) => listening === false,
      8000,
    );
  }
}

async function teardown(run: EntryRun | undefined): Promise<void> {
  if (run === undefined) return;
  try {
    run.cdp.close();
  } catch {
    // 退出时连接已断。
  }
  try {
    await run.tracked.stop();
    await run.tracked.writeRecord();
  } catch {
    // 记录失败不影响断言结论。
  }
  await rm(run.userData, { recursive: true, force: true }).catch(() => undefined);
}

function entryExitLine(evidence: Evidence, exit: { code: number | null; signal: NodeJS.Signals | null }): void {
  evidence.log(`entry exit: code=${String(exit.code)} signal=${String(exit.signal)}`);
}
test('T1 正式入口：打开面板→输入→发送→演示回复→关面板→关窗（退出码 0）', { timeout: 240000 }, async (t) => {
  const evidence = createEvidence('t1-open-send-reply');
  let run: EntryRun | undefined;
  try {
    if (!ensureDisplay(t)) return;
    run = await launchEntry({ label: 'formal-chat-happy', evidence, delayMs: 0 });
    await openPanel(run);
    await assertControlsInViewport(run);
    await screenshot(run, 't1-01-panel-open.png');

    await typeMessage(run, '你好桌面宠物');
    await clickSend(run);

    const replied = await waitDom(
      run,
      '演示回复未显示',
      (state) => state.assistantMsgs.some((msg) => msg.includes('【演示回复】已收到：你好桌面宠物')) && state.demoTagCount >= 1,
      25000,
    );
    assert.ok(replied.userMsgs.some((msg) => msg.includes('你好桌面宠物')), '用户消息未上屏');
    assert.equal(replied.phase, 'reply', `回复后面板状态应为 reply，实际 ${replied.phase}`);
    assert.equal(replied.statusMsgs.length, 0, '回复后不应残留“发送中…”状态');
    evidence.log(
      `reply: phase=${replied.phase} demoTagCount=${replied.demoTagCount} assistantMsgs=${JSON.stringify(replied.assistantMsgs)}`,
    );
    await screenshot(run, 't1-02-reply.png');

    await closePanelByMouse(run);
    const closed = await waitDom(
      run,
      '关面板后应回到收起态',
      (state) => state.panelHidden === true && state.phase === 'closed',
      8000,
    );
    evidence.log(`closed: phase=${closed.phase} hidden=${String(closed.panelHidden)}`);
    await screenshot(run, 't1-03-closed.png');

    await quitByApi(run, '正常关窗');
    const exit = await waitForChildExit(run.tracked.child, 30000);
    entryExitLine(evidence, exit);
    evidence.log(`stdout tail:\n${tail(run.tracked.stdout())}`);
    assert.equal(exit.code, 0, `关窗后入口退出码应为 0\nstdout:\n${tail(run.tracked.stdout())}\nstderr:\n${tail(run.tracked.stderr())}`);
    await assertNoLeftovers(run);
    evidence.log('PASS');
  } catch (error) {
    evidence.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    await teardown(run);
    await flushEvidence(evidence, 'T1 正式入口：打开→输入→发送→演示回复→关面板→关窗');
  }
});

test('T2 正式入口：fake 的 [error] → 面板报错 → 恢复后再发成功', { timeout: 240000 }, async (t) => {
  const evidence = createEvidence('t2-error-recovery');
  let run: EntryRun | undefined;
  try {
    if (!ensureDisplay(t)) return;
    run = await launchEntry({ label: 'formal-chat-error', evidence, delayMs: 0 });
    await openPanel(run);
    await assertControlsInViewport(run);

    await typeMessage(run, '[error] 这句会失败');
    await clickSend(run);
    const errored = await waitDom(
      run,
      '500 后面板应显示错误',
      (state) => state.errorMsgs.some((msg) => /发送失败/.test(msg)) && state.phase === 'error',
      25000,
    );
    assert.equal(errored.rects.cancel.disabled, true, '错误后不应仍处于在途态（取消应禁用）');
    assert.equal(errored.statusMsgs.length, 0, '错误后不应残留“发送中…”状态');
    evidence.log(`error: phase=${errored.phase} errorMsgs=${JSON.stringify(errored.errorMsgs)}`);
    await screenshot(run, 't2-01-error.png');

    await typeMessage(run, '恢复后的这句');
    await clickSend(run);
    const recovered = await waitDom(
      run,
      '恢复后新回复未显示',
      (state) =>
        state.assistantMsgs.some((msg) => msg.includes('【演示回复】已收到：恢复后的这句')) && state.demoTagCount >= 1,
      25000,
    );
    assert.equal(recovered.phase, 'reply');
    evidence.log(`recovered: phase=${recovered.phase} assistantMsgs=${JSON.stringify(recovered.assistantMsgs)}`);
    await screenshot(run, 't2-02-recovered.png');

    await quitByApi(run, '正常关窗');
    const exit = await waitForChildExit(run.tracked.child, 30000);
    entryExitLine(evidence, exit);
    evidence.log(`stdout tail:\n${tail(run.tracked.stdout())}`);
    assert.equal(exit.code, 0, `退出码应为 0\nstderr:\n${tail(run.tracked.stderr())}`);
    await assertNoLeftovers(run);
    evidence.log('PASS');
  } catch (error) {
    evidence.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    await teardown(run);
    await flushEvidence(evidence, 'T2 正式入口：[error] 报错 → 恢复后再发成功');
  }
});
test('T3 正式入口：[slow] 取消→已取消→立即重发→旧迟到回复不显示→关面板→在途关窗', { timeout: 300000 }, async (t) => {
  const evidence = createEvidence('t3-cancel-resend');
  let run: EntryRun | undefined;
  try {
    if (!ensureDisplay(t)) return;
    run = await launchEntry({ label: 'formal-chat-cancel', evidence, delayMs: 0, slowMs: SLOW_MS });
    await openPanel(run);
    await assertControlsInViewport(run);

    // 1) 慢请求在途
    await typeMessage(run, '慢速第一句 [slow]');
    const sentAt = Date.now();
    await clickSend(run);
    const pending = await waitDom(
      run,
      '慢请求应进入 pending 且在途态可取消',
      (state) =>
        state.phase === 'pending' && state.rects.cancel.disabled === false && state.statusMsgs.some((msg) => msg.includes('发送中')),
      15000,
    );
    evidence.log(`pending: phase=${pending.phase} status=${JSON.stringify(pending.statusMsgs)}`);
    await screenshot(run, 't3-01-pending.png');

    // 取消前先证明 Electron→fake 的连接确实存在，否则“断开”断言没有意义。
    const opened = await pollUntil(
      '未观察到 Electron→fake 的已建立 TCP 连接',
      () => Promise.resolve(fakeConnections(run as EntryRun)),
      (rows) => rows.length > 0,
      8000,
      (rows) => JSON.stringify(rows),
    );
    evidence.log(`tcp open at +${Date.now() - sentAt}ms: ${JSON.stringify(opened)}`);

    // 2) 取消（真实鼠标点击）
    await clickCancel(run);
    const cancelAt = Date.now();
    const cancelled = await waitDom(
      run,
      '取消后面板应显示已取消',
      (state) =>
        state.phase === 'cancelled' && state.statusMsgs.some((msg) => msg.includes('已取消')) && state.rects.cancel.disabled === true,
      10000,
    );
    evidence.log(`cancelled: phase=${cancelled.phase} status=${JSON.stringify(cancelled.statusMsgs)} at +${cancelAt - sentAt}ms`);
    await screenshot(run, 't3-02-cancelled.png');

    // 3) 取消必须真的撤销连接（signal → fetch abort → socket 关闭）
    await pollUntil(
      '取消后 Electron→fake 的 TCP 连接仍未断开',
      () => Promise.resolve(fakeConnections(run as EntryRun)),
      (rows) => rows.length === 0,
      10000,
      (rows) => JSON.stringify(rows),
    );
    evidence.log(`tcp closed at +${Date.now() - cancelAt}ms after cancel（距发送 +${Date.now() - sentAt}ms）`);

    // 可选观测口子：入口 fake 若实现观测文件，追加 respondedAt/closedAt 证据。
    const observations = readObservations(run);
    if (observations.length === 0) {
      evidence.log('fake 观测文件不存在（入口 fake 未暴露观测口子），改用 /proc TCP 连接观测');
    } else {
      evidence.log(`fake 观测记录: ${JSON.stringify(observations)}`);
      const slow = observations.filter((row) => row.event === 'chat-request' && (row.text ?? '').includes('慢速第一句'));
      assert.ok(slow.length > 0, '观测文件应记录到旧慢请求');
      for (const record of slow) {
        const closed = observations.find((row) => row.event === 'chat-request-closed' && row.id === record.id);
        assert.ok(closed?.closedAt !== undefined, `fake 未记录旧请求被客户端断开：${record.id}`);
        const responded = observations.find((row) => row.event === 'chat-responded' && row.id === record.id);
        if (responded?.respondedAt !== undefined && closed?.closedAt !== undefined) {
          evidence.log(`old ${record.id}: closedAt=${closed.closedAt} respondedAt=${responded.respondedAt}`);
          assert.ok(responded.respondedAt >= closed.closedAt, '旧响应的 respondedAt 不应早于 closedAt');
        }
      }
    }

    // 4) 立即重发（键盘 Enter 发送），新回复必须显示
    await typeMessage(run, '第二句立刻回');
    await pressEnter(run);
    const resent = await waitDom(
      run,
      '取消后立即重发的新回复未显示',
      (state) => state.assistantMsgs.some((msg) => msg.includes('【演示回复】已收到：第二句立刻回')),
      25000,
    );
    evidence.log(`resend reply at +${Date.now() - sentAt}ms: ${JSON.stringify(resent.assistantMsgs)}`);
    await screenshot(run, 't3-03-resend.png');

    // 5) 等过旧慢请求的到期点，旧回复仍不得上屏
    const slack = sentAt + SLOW_MS + 1500 - Date.now();
    if (slack > 0) await delay(slack);
    const afterDeadline = await readDom(run);
    assert.equal(
      afterDeadline.assistantMsgs.some((msg) => msg.includes('慢速第一句')),
      false,
      `旧迟到回复泄漏上屏：${JSON.stringify(afterDeadline.assistantMsgs)}`,
    );
    assert.ok(afterDeadline.assistantMsgs.some((msg) => msg.includes('第二句立刻回')), '新回复应保持显示');
    assert.equal(afterDeadline.errorMsgs.length, 0, `不应出现错误条目：${JSON.stringify(afterDeadline.errorMsgs)}`);
    evidence.log(`after slow deadline (+${Date.now() - sentAt}ms): assistantMsgs=${JSON.stringify(afterDeadline.assistantMsgs)}`);

    // 6) 关面板（在途撤销的入口）
    await closePanelByMouse(run);
    await waitDom(run, '关面板后应收起', (state) => state.panelHidden === true && state.phase === 'closed', 8000);
    evidence.log('panel closed by mouse on chat-close');

    // 7) 重新打开 → 在途关窗 → 退出码 0 且连接断开、无残留
    await openPanel(run);
    await typeMessage(run, '关窗前在途 [slow]');
    await clickSend(run);
    await waitDom(run, '关窗前应重新进入 pending', (state) => state.phase === 'pending', 15000);
    const inFlight = await pollUntil(
      '关窗前未观察到 Electron→fake 的已建立连接',
      () => Promise.resolve(fakeConnections(run as EntryRun)),
      (rows) => rows.length > 0,
      8000,
      (rows) => JSON.stringify(rows),
    );
    evidence.log(`tcp open before quit: ${JSON.stringify(inFlight)}`);
    await screenshot(run, 't3-04-pending-before-quit.png');

    await quitByApi(run, '在途关窗');
    const exit = await waitForChildExit(run.tracked.child, 30000);
    entryExitLine(evidence, exit);
    evidence.log(`stdout tail:\n${tail(run.tracked.stdout())}`);
    assert.equal(exit.code, 0, `在途关窗退出码应为 0\nstderr:\n${tail(run.tracked.stderr())}`);
    await assertNoLeftovers(run);
    evidence.log('PASS');
  } catch (error) {
    evidence.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    await teardown(run);
    await flushEvidence(evidence, 'T3 正式入口：取消慢回复→立即重发→旧回复不显示→关面板→在途关窗');
  }
});

test('T4 正式入口失败路径：fake 端口被占用 → 入口非零退出、无 Electron 残留', { timeout: 240000 }, async (t) => {
  const evidence = createEvidence('t4-entry-failure');
  let tracked: TrackedRun | undefined;
  let userData = '';
  const blocker = net.createServer();
  try {
    if (!ensureDisplay(t)) return;
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => resolve());
    });
    const address = blocker.address();
    assert.ok(address !== null && typeof address !== 'string', '占用端口失败');
    const occupied = (address as net.AddressInfo).port;

    userData = await mkdtemp(path.join(tmpdir(), 'pet-next-formal-e2e-'));
    const debugPort = await freePort();
    const env = entryEnv({
      debugPort,
      userData,
      delayMs: 0,
      slowMs: SLOW_MS,
      observabilityFile: path.join(userData, 'fake-observability.ndjson'),
      extra: { PET_NEXT_FAKE_CHAT_PORT: String(occupied) },
    });
    evidence.log(`cmd: DISPLAY=${display} PET_NEXT_CHAT_DEBUG_PORT=${debugPort} PET_NEXT_FAKE_CHAT_PORT=${occupied} pnpm chat:preview`);
    tracked = startTrackedRun({
      executable: pnpmPath(),
      args: ['chat:preview'],
      cwd: petRoot,
      env,
      label: 'formal-chat-failure',
      logRoot: path.join(petRoot, 'logs/platform-runs'),
    });

    const exit = await waitForChildExit(tracked.child, 180000);
    entryExitLine(evidence, exit);
    evidence.log(`stdout tail:\n${tail(tracked.stdout())}`);
    evidence.log(`stderr tail:\n${tail(tracked.stderr())}`);
    assert.notEqual(exit.code, 0, `fake 端口被占用时入口必须非零退出，实际 code=${String(exit.code)}`);
    assert.equal(findEvent(tracked, 'fake-chat-server-ready'), null, 'fake 不应在端口被占用时报告就绪');
    assert.equal(await portListening(debugPort), false, '失败路径不应留下调试端口');
    assert.deepEqual(pidsWithArg(`--remote-debugging-port=${debugPort}`), [], '失败路径不应留下 Electron');
    await delay(300);
    const alive = tracked.trackedPids().filter((pid) => pidIsAlive(pid));
    evidence.log(`失败后本次进程树存活 pid: ${JSON.stringify(alive)}`);
    assert.deepEqual(alive, [], `失败后仍有残留进程：${JSON.stringify(alive)}`);
    assert.equal(await portListening(occupied), true, '占用端口应仍归本用例所有（fake 未抢占）');
    evidence.log('PASS');
  } catch (error) {
    evidence.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    await tracked?.stop().catch(() => undefined);
    await tracked?.writeRecord().catch(() => undefined);
    if (userData !== '') await rm(userData, { recursive: true, force: true }).catch(() => undefined);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await flushEvidence(evidence, 'T4 正式入口失败路径：fake 端口被占用 → 非零退出');
  }
});
