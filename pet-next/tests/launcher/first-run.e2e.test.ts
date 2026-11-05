/**
 * M3-7 R1 C：首次启动（launcher）E2E——双击入口全链，全自动 fake（不连真网、零真实 POST）。
 * 只由负责人串行运行（真实 Electron + Xvfb）：
 *   PET_NEXT_LAUNCHER_E2E=1 node --experimental-strip-types --test --test-concurrency=1 \
 *     --test-reporter spec tests/launcher/first-run.e2e.test.ts
 *
 * 门（R1 修复）：未显式置 PET_NEXT_LAUNCHER_E2E=1 / 未构建 dist/electron/main.js / 无显示环境时
 * gate 返回 false 并由用例立即 return——t.skip 本身不阻断执行；after() 另断言 disabled 期间
 * 零 spawn、零本地监听（POST 随之恒为 0）。
 *
 * 场景：
 * 1) 首次无配置→填配置→测试连接(GET only)→启动→app/page.html 桌宠（轮询等 #pet 挂载）→
 *    launcher 销毁→关窗退出 0；POST=0。
 * 2) 再开回填配置。
 * 3) 死端口探测失败→可读错误→改到 fixture 实际 fakePort→再次 probe 成功；旧隧道已退出、POST=0。
 * 4) models 探测进行中关窗→退出 0、无桌宠窗口、无隧道残留（归属 helper 断言先于 finally 清理）。
 * 5) 直接关 launcher→干净退出、无关哨兵存活。
 * 6) 选 companion→启动→发 1 条 fake 消息→回复上屏、reaction 恰 1 次、POST=1、退出 0。
 * 7) 同上但 FAKE_MODEL_DELAY_MS=2500 慢回复。
 * 基础设施参考 tests/feedback/companion.e2e.test.ts；归属快照用 tests/launcher/owned-processes.ts。
 * @module pet-next/tests/launcher/first-run
 */
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureOwnedProcesses, waitOwnedGone, type OwnedProcessSnapshot } from './owned-processes.ts';

const petRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const evidenceRoot = path.join(petRoot, 'tests/chat-evidence/launcher');
const mainBundle = path.join(petRoot, 'dist/electron/main.js');
const sshBin = path.join(petRoot, 'tests/support/fake-ssh.mjs');
const fakeModelService = path.join(petRoot, 'tests/support/fake-model-service.mjs');
const entry = path.join(petRoot, 'scripts/launch-trial.mjs');
const display = process.env.PET_NEXT_E2E_DISPLAY ?? ':94';
const displaySocket = `/tmp/.X11-unix/X${display.startsWith(':') ? display.slice(1) : display}`;
/** launcher 页与桌宠页的真实 URL 片段（file:// 下 dist/app/*.html）。 */
const LAUNCHER_URL_FRAGMENT = 'app/launcher.html';
const PET_URL_FRAGMENT = 'app/page.html';
/** 本轮默认不跑：负责人置 PET_NEXT_LAUNCHER_E2E=1 才真跑（不抢 Xvfb、不跑真 Electron）。 */
const enabled = process.env.PET_NEXT_LAUNCHER_E2E === '1';
const buildReady = existsSync(mainBundle);

/** disabled 自检计数：任何子进程 spawn / 本地监听都会 +1，after() 在 disabled 时断言为 0。 */
let spawnCalls = 0;
let listenCalls = 0;

let xvfb: ChildProcess | undefined;
let ownsXvfb = false;
let displayReady = false;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function freePort(): Promise<number> {
  listenCalls += 1;
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('no port'));
      const { port } = address as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

before(async () => {
  if (!enabled || !buildReady) return;
  if (process.platform === 'win32') {
    displayReady = true;
    return;
  }
  if (existsSync(displaySocket)) {
    displayReady = true;
    return;
  }
  spawnCalls += 1;
  xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  ownsXvfb = true;
  const deadline = Date.now() + 8000;
  while (!existsSync(displaySocket) && Date.now() < deadline) await delay(100);
  displayReady = existsSync(displaySocket);
});

after(async () => {
  if (!enabled || !buildReady) {
    // disabled 自检：before 必须零 spawn，用例必须零监听——否则"skip 但仍起 GUI/替身"的缺陷会复现。
    console.log(
      JSON.stringify({
        event: 'launcher-e2e-gate',
        enabled,
        buildReady,
        displayReady,
        spawned: spawnCalls,
        listened: listenCalls,
        post: 0,
      }),
    );
    assert.equal(spawnCalls, 0, 'disabled 时必须零 spawn（Xvfb/fake 模型/Electron 都不起）');
    assert.equal(listenCalls, 0, 'disabled 时必须零本地监听（不分配调试/隧道端口）');
  }
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

/** 统一 skip 门槛：返回 false 时必须 `return`——t.skip 只标注不阻断（R1 修复点）。 */
function gate(t: TestContext): boolean {
  if (!enabled) {
    t.skip('not-run: 未显式开启 PET_NEXT_LAUNCHER_E2E=1（默认不启 GUI/替身/Xvfb）');
    return false;
  }
  if (!buildReady) {
    t.skip('not-run: 缺少 dist/electron/main.js（先 pnpm build）');
    return false;
  }
  if (!displayReady) {
    t.skip('not-run: 无显示环境（Xvfb / X11 socket 不可用）');
    return false;
  }
  return true;
}


/* ---------------------------------- CDP ---------------------------------- */

interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
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
  ws.addEventListener('close', () => {
    const error = new Error('cdp closed');
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
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
  const result = (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
    result?: { value?: T };
    exceptionDetails?: { exception?: { description?: string } };
  };
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result?.value as T;
}

interface Rect {
  found: boolean;
  visible: boolean;
  cx: number;
  cy: number;
  disabled: boolean | null;
}

async function clickRect(cdp: Cdp, rect: Rect): Promise<void> {
  const x = Math.round(rect.cx);
  const y = Math.round(rect.cy);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await delay(20);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

/** 清空并输入一个文本框（点击 → 全选 → insertText）。 */
async function fillField(cdp: Cdp, rect: Rect, text: string): Promise<void> {
  await clickRect(cdp, rect);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  await cdp.send('Input.insertText', { text });
}

/* --------- launcher 页面 DOM --------- */

const SEL = {
  page: '[data-testid="launcher"]',
  host: '[data-testid="launcher-field-host"]',
  port: '[data-testid="launcher-field-port"]',
  user: '[data-testid="launcher-field-user"]',
  identityFile: '[data-testid="launcher-field-identityFile"]',
  localPort: '[data-testid="launcher-field-localPort"]',
  remoteHost: '[data-testid="launcher-field-remoteHost"]',
  remotePort: '[data-testid="launcher-field-remotePort"]',
  probe: '[data-testid="launcher-probe"]',
  start: '[data-testid="launcher-start"]',
  status: '[data-testid="launcher-status"]',
  phase: '[data-testid="launcher-phase"]',
  experienceCompanion: '[data-testid="launcher-experience-companion"]',
  context: '[data-testid="launcher-context"]',
} as const;

type FieldName = 'host' | 'port' | 'user' | 'identityFile' | 'localPort' | 'remoteHost' | 'remotePort';

interface FieldState extends Rect {
  value: string;
}

interface LauncherDomState {
  hasForm: boolean;
  /** pageRoot.dataset.state：loading/load-error/editing/probing/starting/running。 */
  phase: string;
  /** 状态行文本（含探测成功/失败文案）。 */
  phaseText: string;
  statusText: string;
  /** pageRoot.dataset.experience：standard/companion。 */
  experience: string;
  chatContext: boolean | null;
  fields: Record<FieldName, FieldState>;
  probe: Rect;
  start: Rect;
  experienceCompanion: Rect;
}

const fieldRead = (selector: string): string => `read(${JSON.stringify(selector)})`;

const DOM_EXPRESSION = `(() => {
  const read = (selector) => {
    const el = document.querySelector(selector);
    if (el === null) return { found: false, visible: false, cx: 0, cy: 0, disabled: null, value: '' };
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const editable = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
    return {
      found: true,
      visible: !el.hidden && style.display !== 'none' && rect.width > 0 && rect.height > 0,
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      disabled: el instanceof HTMLButtonElement ? el.disabled : null,
      value: editable ? String(el.value) : '',
    };
  };
  const page = document.querySelector(${JSON.stringify(SEL.page)});
  const status = document.querySelector(${JSON.stringify(SEL.status)});
  const phaseEl = document.querySelector(${JSON.stringify(SEL.phase)});
  const context = document.querySelector(${JSON.stringify(SEL.context)});
  const phaseText = phaseEl === null ? '' : (phaseEl.textContent ?? '').trim();
  return {
    hasForm: page !== null && document.querySelector(${JSON.stringify(SEL.host)}) !== null,
    phase: page instanceof HTMLElement ? (page.dataset.state ?? '') : '',
    phaseText,
    statusText: status === null ? '' : (status.textContent ?? '').trim(),
    experience: page instanceof HTMLElement ? (page.dataset.experience ?? '') : '',
    chatContext: context instanceof HTMLInputElement ? context.checked : null,
    fields: {
      host: ${fieldRead(SEL.host)},
      port: ${fieldRead(SEL.port)},
      user: ${fieldRead(SEL.user)},
      identityFile: ${fieldRead(SEL.identityFile)},
      localPort: ${fieldRead(SEL.localPort)},
      remoteHost: ${fieldRead(SEL.remoteHost)},
      remotePort: ${fieldRead(SEL.remotePort)},
    },
    probe: ${fieldRead(SEL.probe)},
    start: ${fieldRead(SEL.start)},
    experienceCompanion: ${fieldRead(SEL.experienceCompanion)},
  };
})()`;

const readDom = (cdp: Cdp): Promise<LauncherDomState> => evaluate<LauncherDomState>(cdp, DOM_EXPRESSION);

async function waitDom(
  cdp: Cdp,
  label: string,
  ok: (state: LauncherDomState) => boolean,
  timeoutMs: number,
): Promise<{ state: LauncherDomState; atMs: number }> {
  const deadline = Date.now() + timeoutMs;
  let last: LauncherDomState | undefined;
  while (Date.now() < deadline) {
    try {
      last = await readDom(cdp);
      if (ok(last)) return { state: last, atMs: Date.now() };
    } catch {
      /* 页面导航/重绘瞬间，继续轮询 */
    }
    await delay(40);
  }
  throw new Error(`${label}（${timeoutMs}ms 超时）last=${JSON.stringify(last)}`);
}


/* --------- 桌宠页面 DOM（page.html） --------- */

interface PetDomState {
  pet: boolean;
  experience: string;
  visual: string;
  requestId: string;
  hasPanel: boolean;
  userMsgs: string[];
  assistantMsgs: string[];
  feedbackKind: string;
  feedbackText: string;
  inputValue: string | null;
  rects: { toggle: Rect; input: Rect; send: Rect; cancel: Rect };
}

const PET_DOM_EXPRESSION = `(() => {
  const read = (selector) => {
    const el = document.querySelector(selector);
    if (el === null) return { found: false, visible: false, cx: 0, cy: 0, disabled: null };
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      found: true,
      visible: !el.hidden && style.display !== 'none' && rect.width > 0 && rect.height > 0,
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      disabled: el instanceof HTMLButtonElement ? el.disabled : null,
    };
  };
  const texts = (selector) => Array.from(document.querySelectorAll(selector)).map((n) => (n.textContent ?? '').trim());
  const panel = document.querySelector('[data-testid="chat-panel"]');
  const inputEl = document.querySelector('[data-testid="chat-input"]');
  const fb = document.querySelector('[data-testid="chat-feedback"]');
  const ds = document.documentElement.dataset || {};
  return {
    pet: document.querySelector('#pet') !== null,
    experience: ds.experience ?? '',
    visual: ds.visual ?? '',
    requestId: ds.request ?? '',
    hasPanel: panel !== null,
    userMsgs: texts('[data-testid="chat-msg-user"]'),
    assistantMsgs: texts('[data-testid="chat-msg-assistant"]'),
    feedbackKind: fb === null ? 'absent' : (fb.hidden ? 'hidden' : (fb.dataset.kind || 'shown')),
    feedbackText: fb === null ? '' : (fb.textContent ?? '').trim(),
    inputValue: inputEl instanceof HTMLTextAreaElement ? inputEl.value : null,
    rects: {
      toggle: read('[data-testid="chat-toggle"]'),
      input: read('[data-testid="chat-input"]'),
      send: read('[data-testid="chat-send"]'),
      cancel: read('[data-testid="chat-cancel"]'),
    },
  };
})()`;

const readPetDom = (cdp: Cdp): Promise<PetDomState> => evaluate<PetDomState>(cdp, PET_DOM_EXPRESSION);

async function waitPetDom(
  cdp: Cdp,
  label: string,
  ok: (state: PetDomState) => boolean,
  timeoutMs: number,
): Promise<{ state: PetDomState; atMs: number }> {
  const deadline = Date.now() + timeoutMs;
  let last: PetDomState | undefined;
  while (Date.now() < deadline) {
    try {
      last = await readPetDom(cdp);
      if (ok(last)) return { state: last, atMs: Date.now() };
    } catch {
      /* 目标已销毁或重绘，继续轮询 */
    }
    await delay(40);
  }
  throw new Error(`${label}（${timeoutMs}ms 超时）last=${JSON.stringify(last)}`);
}

/** 轮询等 #pet 挂载（不用固定 sleep；about:blank 阶段 evaluate 会失败，直接重试）。 */
async function waitPetMounted(cdp: Cdp, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const mounted = await evaluate<boolean>(cdp, "document.querySelector('#pet') !== null");
      if (mounted === true) return;
    } catch {
      /* 还没导航到 page.html */
    }
    await delay(50);
  }
  throw new Error(`桌宠窗口 #pet 未挂载（${timeoutMs}ms）`);
}

async function openPetPanel(cdp: Cdp): Promise<PetDomState> {
  await waitPetDom(cdp, '聊天面板未挂载', (s) => s.hasPanel, 60000);
  const toggle = await waitPetDom(cdp, '聊天开关不可点', (s) => s.rects.toggle.visible, 15000);
  await clickRect(cdp, toggle.state.rects.toggle);
  const opened = await waitPetDom(cdp, '聊天面板未打开', (s) => s.rects.input.visible, 15000);
  return opened.state;
}

async function typeAndSend(cdp: Cdp, text: string): Promise<number> {
  const ready = await waitPetDom(cdp, '聊天输入框未就绪', (s) => s.rects.input.found && s.rects.input.visible, 15000);
  await clickRect(cdp, ready.state.rects.input);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  await cdp.send('Input.insertText', { text });
  const armed = await waitPetDom(
    cdp,
    '发送按钮未就绪',
    (s) => s.inputValue === text && s.rects.send.disabled === false,
    15000,
  );
  const at = Date.now();
  await clickRect(cdp, armed.state.rects.send);
  return at;
}

/** 采集 visual/request 变化序列：用于"reaction 恰一次"判定。 */
async function observeVisual(cdp: Cdp, ms: number): Promise<Array<{ visual: string; requestId: string; atMs: number }>> {
  const out: Array<{ visual: string; requestId: string; atMs: number }> = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const state = await readPetDom(cdp);
      const last = out.at(-1);
      if (last === undefined || last.requestId !== state.requestId || last.visual !== state.visual) {
        out.push({ visual: state.visual, requestId: state.requestId, atMs: Date.now() });
      }
    } catch {
      /* 页面销毁 */
    }
    await delay(30);
  }
  return out;
}

const reactionsIn = (seq: Array<{ requestId: string }>): string[] =>
  seq.map((item) => item.requestId).filter((id) => id.startsWith('reaction-'));

/* --------- 窗口/目标探测 --------- */

interface Target {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

async function listTargets(debugPort: number): Promise<Target[]> {
  try {
    const list = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as Target[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function waitForTarget(debugPort: number, ok: (targets: Target[]) => boolean, timeoutMs: number): Promise<Target[]> {
  const deadline = Date.now() + timeoutMs;
  let last: Target[] = [];
  while (Date.now() < deadline) {
    last = await listTargets(debugPort);
    if (ok(last)) return last;
    await delay(150);
  }
  throw new Error(`目标窗口未就绪（${timeoutMs}ms 超时）targets=${JSON.stringify(last.map((t) => t.url))}`);
}

const targetUrl = (target: Target): string => String(target.url ?? '');
/** 只认真正加载 launcher 页的 page target（排除 about:blank 与 devtools）。 */
const isLauncherPage = (target: Target): boolean =>
  target.type === 'page' && targetUrl(target).includes(LAUNCHER_URL_FRAGMENT);
/** 只认真正加载 app/page.html 的 page target；about:blank 一律拒绝。 */
const isPetPage = (target: Target): boolean =>
  target.type === 'page' && targetUrl(target).includes(PET_URL_FRAGMENT) && !targetUrl(target).startsWith('about:');

/** 等到桌宠 target 并校验 URL/调试入口；等待期间出现的 about:blank 不算。 */
async function waitPetTarget(debugPort: number, timeoutMs: number): Promise<Target> {
  const targets = await waitForTarget(debugPort, (list) => list.some(isPetPage), timeoutMs);
  const target = targets.find(isPetPage);
  if (target === undefined) throw new Error(`未找到 ${PET_URL_FRAGMENT} 桌宠 target`);
  const url = targetUrl(target);
  assert.ok(url.includes(PET_URL_FRAGMENT), `桌宠 target 必须加载 ${PET_URL_FRAGMENT}，实际 ${url}`);
  assert.ok(!url.startsWith('about:'), `about:blank 不得当桌宠 target：${url}`);
  assert.ok((target.webSocketDebuggerUrl ?? '') !== '', '桌宠窗口必须有 CDP 入口');
  return target;
}

async function waitPortOpen(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await delay(100);
  }
  return false;
}


/* --------- POST 观测 / 隧道日志 / 残留 / 哨兵 --------- */

/** fake 模型只记录 POST /chat/completions；GET /models 不落盘 → 行数即 POST 数。 */
function countPosts(logFile: string): number {
  if (!existsSync(logFile)) return 0;
  return readFileSync(logFile, 'utf8').split('\n').filter((line) => line.includes('"event":"chat-request"')).length;
}

interface LoggedRequest {
  messages: Array<{ role: string; content: string }>;
}

function readRequests(logFile: string): LoggedRequest[] {
  if (!existsSync(logFile)) return [];
  const rows: LoggedRequest[] = [];
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line) as { body?: { messages: Array<{ role: string; content: string }> } };
      if (value.body && Array.isArray(value.body.messages)) rows.push(value.body);
    } catch {
      /* 半行忽略 */
    }
  }
  return rows;
}

interface SshLogRow {
  event?: string;
  port?: number;
  targetPort?: number;
  pid?: number;
  args?: string[];
}

function readSshLog(file: string): SshLogRow[] {
  if (!existsSync(file)) return [];
  const rows: SshLogRow[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line) as SshLogRow);
    } catch {
      /* 半行忽略 */
    }
  }
  return rows;
}

async function waitSshLog(
  file: string,
  label: string,
  ok: (rows: SshLogRow[]) => boolean,
  timeoutMs: number,
): Promise<SshLogRow[]> {
  const deadline = Date.now() + timeoutMs;
  let last: SshLogRow[] = [];
  while (Date.now() < deadline) {
    last = readSshLog(file);
    if (ok(last)) return last;
    await delay(100);
  }
  throw new Error(`${label}（${timeoutMs}ms 超时）ssh=${JSON.stringify(last)}`);
}

/** fake-ssh 的 -L 规格：127.0.0.1:<localPort>:<remoteHost>:<remotePort>。 */
function sshForwardSpec(row: SshLogRow): { localPort: number; remotePort: number } | null {
  const args = row.args ?? [];
  const index = args.indexOf('-L');
  const spec = index >= 0 ? args[index + 1] : undefined;
  if (typeof spec !== 'string') return null;
  const parts = spec.split(':');
  const localPort = Number(parts[1]);
  const remotePort = Number(parts[3]);
  if (!Number.isInteger(localPort) || !Number.isInteger(remotePort)) return null;
  return { localPort, remotePort };
}

const stoppedFor = (rows: SshLogRow[], port: number): SshLogRow[] =>
  rows.filter((row) => row.event === 'fake-ssh-stopped' && row.port === port);

function processAlive(pid: number): boolean {
  if (pid <= 0) return false;
  if (process.platform === 'win32') {
    try {
      return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).includes(String(pid));
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
}

interface Sentinel {
  pid: number;
  alive(): boolean;
  kill(): void;
}

function startSentinel(): Sentinel {
  spawnCalls += 1;
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  return {
    pid: child.pid ?? -1,
    alive: () => child.exitCode === null && processAlive(child.pid ?? -1),
    kill: () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    },
  };
}

/** 只接受连接、永不回 HTTP：让 /models 探测停在等待中（不引入固定 sleep）。 */
interface Blackhole {
  port: number;
  close(): Promise<void>;
}

async function startBlackhole(): Promise<Blackhole> {
  listenCalls += 1;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('blackhole 未取得端口');
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await delay(40);
  }
  throw new Error(`文件未生成：${file}`);
}

async function writeCaseEvidence(caseName: string, name: string, text: string): Promise<void> {
  const dir = path.join(evidenceRoot, caseName);
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  await writeFile(path.join(dir, name), text).catch(() => undefined);
}


/* --------- 一次启动（共用） --------- */

interface LaunchCase {
  caseName: string;
  /** 预写配置（null = 首次启动，无配置文件）。 */
  config: Record<string, unknown> | null;
  /** true 时设 FAKE_SSH_TARGET_PORT：表单任意 remotePort 都转发到 fake 模型。
   *  false 时 fake ssh 转发到表单 remotePort——用于"连错端口→改对重试"/"探测中取消"。 */
  pinFakeTarget: boolean;
  /** 只作用于 fake 模型：0 = 即时回复；2500 = 慢回复验收。 */
  fakeDelayMs?: number;
  /** 只作用于 fake ssh 替身。 */
  fakeSshMode?: 'ok' | 'no-listen' | 'drop-after-ready' | 'auth-fail' | 'port-conflict';
}

interface Handle {
  cdp: Cdp;
  child: ChildProcess;
  logFile: string;
  sshLog: string;
  configPath: string;
  userData: string;
  instanceTag: string;
  debugPort: number;
  /** fake 模型实际监听端口（失败重试用例的目标端口）。 */
  fakePort: number;
  fakePid: number;
  caseName: string;
  output: () => string;
  /** 退出前 capture 本次入口进程归属（D 的 helper；断言先于 finally 清理）。 */
  captureOwned(): OwnedProcessSnapshot;
  stop(): Promise<void>;
}

async function launchCase(launch: LaunchCase): Promise<Handle> {
  const userData = await mkdtemp(path.join(tmpdir(), `pet-launcher-${launch.caseName}-`));
  const instanceTag = path.basename(userData);
  const logFile = path.join(userData, 'requests.ndjson');
  const sshLog = path.join(userData, 'ssh.ndjson');
  const configPath = path.join(userData, 'qwen-remote.json');
  if (launch.config !== null) await writeFile(configPath, `${JSON.stringify(launch.config, null, 2)}\n`, 'utf8');
  let fakeOut = '';
  spawnCalls += 1;
  const fake = spawn(process.execPath, [fakeModelService], {
    env: {
      ...process.env,
      FAKE_MODEL_LOG: logFile,
      FAKE_MODEL_MODE: 'ok',
      FAKE_MODEL_DELAY_MS: String(launch.fakeDelayMs ?? 0),
    },
  });
  const fakePort = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fake 模型未就绪：${fakeOut}`)), 10000);
    fake.stdout?.on('data', (chunk) => {
      fakeOut += String(chunk);
      const line = fakeOut.split('\n').find((item) => item.includes('fake-model-ready'));
      if (line === undefined) return;
      clearTimeout(timer);
      resolve((JSON.parse(line.slice(line.indexOf('{'))) as { port: number }).port);
    });
  });
  const debugPort = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PET_NEXT_TEST: '1',
    PET_NEXT_USER_DATA: userData,
    PET_NEXT_REMOTE_CONFIG: configPath,
    PET_NEXT_SSH_BIN: sshBin,
    PET_NEXT_CHAT_DEBUG_PORT: String(debugPort),
    FAKE_SSH_LOG: sshLog,
    FAKE_SSH_MODE: launch.fakeSshMode ?? 'ok',
    ...(launch.pinFakeTarget ? { FAKE_SSH_TARGET_PORT: String(fakePort) } : {}),
  };
  if (process.platform !== 'win32') env.DISPLAY = display;
  // 父环境残留不得污染本次选择：体验/预览/连接都由测试显式给。
  delete env.PET_NEXT_LAUNCHER; // launcher 开关必须由入口自己设置，测试不得代设
  delete env.PET_NEXT_EXPERIENCE;
  delete env.PET_NEXT_PREVIEW;
  delete env.PET_NEXT_CHAT_PREVIEW;
  delete env.PET_NEXT_CHAT_LOCAL;
  delete env.PET_NEXT_CHAT_CONTEXT;
  delete env.NODE_OPTIONS;
  let out = '';
  // 双击入口等价命令：启动.cmd -> node scripts/launch-trial.mjs（真入口、真 Electron）。
  // detached：失败清理时按进程组杀，才能连 Electron 孙进程一起收掉（chmod 只作用于 Linux）。
  spawnCalls += 1;
  const child = spawn(process.execPath, [entry], {
    cwd: petRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stdout?.on('data', (chunk) => (out += String(chunk)));
  child.stderr?.on('data', (chunk) => (out += String(chunk)));

  const cleanupOnFailure = async (): Promise<void> => {
    if (process.platform !== 'win32' && typeof child.pid === 'number') {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* 组已退出 */
      }
    }
    if (child.exitCode === null) child.kill('SIGKILL');
    fake.kill('SIGTERM');
    await rm(userData, { recursive: true, force: true }).catch(() => undefined);
  };

  let socket: string;
  try {
    const launcher = await waitForTarget(debugPort, (targets) => targets.some(isLauncherPage), 60000);
    const found = launcher.find(isLauncherPage)?.webSocketDebuggerUrl ?? '';
    if (found === '') throw new Error(`${LAUNCHER_URL_FRAGMENT} 窗口缺少 CDP 入口；输出：${out.slice(-2000)}`);
    socket = found;
  } catch (error) {
    await cleanupOnFailure();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n入口输出：${out.slice(-2000)}`, {
      cause: error,
    });
  }
  const cdp = await connectCdp(socket);
  const dir = path.join(evidenceRoot, launch.caseName);
  let stopped = false;
  return {
    cdp,
    child,
    logFile,
    sshLog,
    configPath,
    userData,
    instanceTag,
    debugPort,
    fakePort,
    fakePid: fake.pid ?? -1,
    caseName: launch.caseName,
    output: () => out,
    captureOwned: () => captureOwnedProcesses(child.pid ?? 0),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      cdp.close();
      // 只清理本次实例：进程组（launch-trial 派生的 Electron/ssh 都在组内）+ 自身。
      // 不做全局 pkill，树外进程（哨兵等）不得受影响。
      if (process.platform !== 'win32' && typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* 组已退出 */
        }
      }
      if (child.exitCode === null) child.kill('SIGKILL');
      fake.kill('SIGTERM');
      await mkdir(dir, { recursive: true }).catch(() => undefined);
      if (existsSync(logFile)) await copyFile(logFile, path.join(dir, 'requests.ndjson')).catch(() => undefined);
      if (existsSync(sshLog)) await copyFile(sshLog, path.join(dir, 'ssh.ndjson')).catch(() => undefined);
      await rm(userData, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

interface FormValues {
  host: string;
  port: string;
  user: string;
  identityFile: string;
  localPort: string;
  remoteHost: string;
  remotePort: string;
}

/** 填一遍连接表单（字段名与 contracts/launcher.ts LauncherConfig 对齐）。 */
async function fillForm(handle: Handle, values: FormValues): Promise<LauncherDomState> {
  const ready = await waitDom(handle.cdp, 'launcher 表单未挂载', (s) => s.hasForm, 30000);
  const fields = ready.state.fields;
  await fillField(handle.cdp, fields.host, values.host);
  await fillField(handle.cdp, fields.port, values.port);
  await fillField(handle.cdp, fields.user, values.user);
  await fillField(handle.cdp, fields.identityFile, values.identityFile);
  await fillField(handle.cdp, fields.localPort, values.localPort);
  await fillField(handle.cdp, fields.remoteHost, values.remoteHost);
  await fillField(handle.cdp, fields.remotePort, values.remotePort);
  const filled = await readDom(handle.cdp);
  for (const name of Object.keys(values) as Array<keyof FormValues>) {
    assert.equal(filled.fields[name].value, values[name], `字段 ${name} 应回填输入值`);
  }
  return filled;
}

/** 启动成功后 capture 归属（入口 + Electron 子树），断言先于任何清理。 */
function captureAfterStart(handle: Handle): OwnedProcessSnapshot {
  const snapshot = handle.captureOwned();
  assert.ok(snapshot.rootPid > 0, '启动成功后必须能识别入口 PID');
  assert.ok(snapshot.pids.includes(snapshot.rootPid), `归属快照必须包含入口 PID：${snapshot.pids.join(',')}`);
  if (process.platform === 'linux') {
    assert.ok(snapshot.pids.length >= 2, `启动后应捕获入口 + Electron 子树，实际 ${snapshot.pids.join(',')}`);
  }
  return snapshot;
}

interface CleanExitOptions {
  expectCode?: number;
  cdp?: Cdp;
  /** true：本次必须从未创建桌宠窗口（探测中取消）。 */
  expectNoPetWindow?: boolean;
}

/**
 * 正式收尾：退出前 capture 归属 → Browser.close → 退出码 → 归属 PID 全消失 → 调试端口关闭。
 * 断言全部在 finally 清理之前；stop() 的组杀只作兜底，不能把失败变成通过。
 * 启动成功后 launcher 窗口已销毁，必须向桌宠窗口（或探测中的 launcher 窗口）的 CDP 发 Browser.close。
 */
async function closeAndAssertClean(handle: Handle, options: CleanExitOptions = {}): Promise<number | null> {
  const cdp = options.cdp ?? handle.cdp;
  const expectCode = options.expectCode ?? 0;
  // 退出前 capture：此刻仍应看到本次进程树，否则归属断言无意义。
  const owned = handle.captureOwned();
  assert.ok(owned.rootPid > 0, '退出前必须捕获本次入口 PID');
  assert.ok(owned.pids.includes(owned.rootPid), `退出前归属快照必须含入口 PID：${owned.pids.join(',')}`);
  const aliveBefore = owned.pids.filter(processAlive);
  assert.ok(aliveBefore.length > 0, `退出前本次进程应仍在跑：${owned.pids.join(',')}`);
  if (options.expectNoPetWindow === true) {
    const targets = await listTargets(handle.debugPort);
    assert.equal(
      targets.filter(isPetPage).length,
      0,
      `探测中取消不得创建桌宠窗口：${JSON.stringify(targets.map((t) => t.url))}`,
    );
  }

  void cdp.send('Browser.close', {}).catch(() => undefined);
  const code = await waitExit(handle.child, 90000);
  const gone = await waitOwnedGone(owned, { timeoutMs: 20000 });
  const open = await portOpen(handle.debugPort);

  await writeCaseEvidence(
    handle.caseName,
    'exit.txt',
    [
      `code=${String(code)}`,
      `root_pid=${owned.rootPid}`,
      `owned_pids_before=${owned.pids.join(',')}`,
      `owned_pids_alive_after=${gone.alive.join(',')}`,
      `debug_port=${handle.debugPort} open_after=${String(open)}`,
      `output_tail=${handle.output().slice(-600)}`,
      '',
    ].join('\n'),
  );

  assert.equal(code, expectCode, `关窗退出码必须 ${expectCode}；stdout=${handle.output().slice(-800)}`);
  assert.deepEqual(gone.alive, [], `退出后不得残留本次进程：${gone.alive.join(',')}`);
  assert.equal(open, false, `退出后调试端口 ${handle.debugPort} 必须关闭`);
  return code;
}


/* ---------------------------------- 用例 ---------------------------------- */

test('首次启动 · 无配置→填表→测试连接(GET only)→启动→app/page.html 桌宠(#pet 挂载)→launcher 销毁→退出 0', { timeout: 300000 }, async (t) => {
  if (!gate(t)) return;
  const startedAt = Date.now();
  let handle: Handle | undefined;
  let petCdp: Cdp | undefined;
  try {
    handle = await launchCase({ caseName: 'first-run-success', config: null, pinFakeTarget: true });
    // 页面由渲染进程动态挂载：CDP 连上时可能仍在 loading，先等表单出现。
    const first = await waitDom(handle.cdp, '首次启动必须出现 launcher 表单', (s) => s.hasForm, 30000);
    for (const name of ['host', 'user', 'remotePort'] as const) {
      assert.equal(first.state.fields[name].value, '', `首次无配置时 ${name} 必须为空`);
    }
    const tunnelPort = await freePort();
    await fillForm(handle, {
      host: 'fake.example.invalid',
      port: '10977',
      user: 'tester',
      identityFile: path.join(handle.userData, 'id_ed25519'),
      localPort: String(tunnelPort),
      remoteHost: '127.0.0.1',
      remotePort: '18872',
    });
    // 测试连接：起隧道 → GET /v1/models → 收隧道；页面给成功提示与模型列表。
    // 页面没有独立保存按钮（启动时先 saveConfig 再 start），故先探测，启动后再验落盘。
    await clickRect(handle.cdp, (await readDom(handle.cdp)).probe);
    await waitDom(handle.cdp, '测试连接无成功提示', (s) => s.phaseText.includes('连接成功'), 40000);
    assert.equal(countPosts(handle.logFile), 0, '测试连接只允许 GET');
    // 预览选项：缺省 standard + context off（与现有 trial 入口一致），显式确认后启动。
    const beforeStart = await readDom(handle.cdp);
    assert.equal(beforeStart.experience, 'standard', '缺省体验应为 standard');
    await clickRect(handle.cdp, beforeStart.start);
    await waitDom(handle.cdp, '启动未进入保存/启动阶段', (s) => s.phase === 'starting' || s.phase === 'running', 15000);
    // 启动前会先落盘：轮询等配置文件真实出现（不用固定 sleep）。
    await waitForFile(handle.configPath, 15000);
    const saved = JSON.parse(readFileSync(handle.configPath, 'utf8')) as Record<string, unknown>;
    assert.equal(saved.host, 'fake.example.invalid');
    assert.equal(saved.user, 'tester');
    assert.equal(saved.remotePort, 18872);
    // 桌宠窗口 = 真正加载 app/page.html 的 target；等待期间出现的 about:blank 不算。
    const pet = await waitPetTarget(handle.debugPort, 60000);
    petCdp = await connectCdp(pet.webSocketDebuggerUrl ?? '');
    await waitPetMounted(petCdp, 30000);
    const petState = await waitPetDom(petCdp, '桌宠页面未就绪', (s) => s.pet && s.hasPanel, 30000);
    assert.equal(petState.state.experience, '', 'standard 启动不得写 companion 体验标记');
    // launcher 窗口必须销毁（只剩 page.html）。
    await waitForTarget(
      handle.debugPort,
      (targets) => !targets.some(isLauncherPage) && targets.some(isPetPage),
      30000,
    );
    // 硬门：全链只允许 GET，POST 计数必须为 0。
    assert.equal(countPosts(handle.logFile), 0, 'launcher 全链不得发出任何模型 POST');
    // 启动成功后 capture 归属（入口 + Electron 子树），退出前 closeAndAssertClean 再 capture 一次。
    captureAfterStart(handle);
    const code = await closeAndAssertClean(handle, { cdp: petCdp });
    assert.equal(code, 0, `关窗退出码必须 0；stdout=${handle.output().slice(-800)}`);
    assert.equal(countPosts(handle.logFile), 0, '退出后 POST 仍必须为 0');
    console.log(`[launcher-e2e] PASS first-run-success ms=${Date.now() - startedAt} POST=0 tunnel_port=${tunnelPort}`);
  } finally {
    petCdp?.close();
    if (handle) await handle.stop();
  }
});

test('再次启动 · 保存过的配置回填表单', { timeout: 300000 }, async (t) => {
  if (!gate(t)) return;
  const startedAt = Date.now();
  let handle: Handle | undefined;
  try {
    // 预写一份配置（等价于上一轮保存的 qwen-remote.json），验证 loadConfig → 回填。
    handle = await launchCase({
      caseName: 'reopen-refill',
      config: {
        host: 'refill.example.invalid',
        port: 10977,
        user: 'refiller',
        identityFile: '/tmp/refill-key',
        localPort: 18874,
        remoteHost: '127.0.0.1',
        remotePort: 18872,
      },
      pinFakeTarget: true,
    });
    const filled = await waitDom(handle.cdp, 'launcher 表单未挂载', (s) => s.hasForm && s.fields.host.value !== '', 30000);
    assert.equal(filled.state.fields.host.value, 'refill.example.invalid');
    assert.equal(filled.state.fields.user.value, 'refiller');
    assert.equal(filled.state.fields.identityFile.value, '/tmp/refill-key');
    assert.equal(filled.state.fields.remotePort.value, '18872');
    assert.equal(countPosts(handle.logFile), 0, '回填本身零 POST');
    await closeAndAssertClean(handle);
    console.log(`[launcher-e2e] PASS reopen-refill ms=${Date.now() - startedAt}`);
  } finally {
    if (handle) await handle.stop();
  }
});


test('连接失败 · 可读错误、改到实际 fakePort 再次 probe 成功、旧隧道已退出、POST=0', { timeout: 300000 }, async (t) => {
  if (!gate(t)) return;
  const startedAt = Date.now();
  let handle: Handle | undefined;
  try {
    // pinFakeTarget=false：fake ssh 按表单 remotePort 转发——先填死端口，探测必失败。
    handle = await launchCase({ caseName: 'probe-fail-retry', config: null, pinFakeTarget: false });
    const tunnelPort = await freePort();
    const deadPort = await freePort(); // 无监听端口：转发目标不可达
    await fillForm(handle, {
      host: 'fake.example.invalid',
      port: '10977',
      user: 'tester',
      identityFile: path.join(handle.userData, 'id_ed25519'),
      localPort: String(tunnelPort),
      remoteHost: '127.0.0.1',
      remotePort: String(deadPort),
    });
    await clickRect(handle.cdp, (await readDom(handle.cdp)).probe);
    const failed = await waitDom(
      handle.cdp,
      '探测失败无提示',
      (s) => s.phase === 'editing' && s.phaseText.includes('失败'),
      40000,
    );
    assert.ok(failed.state.phaseText.length > 0, '失败提示必须有可读文案');
    assert.ok(!failed.state.phaseText.includes('连接成功'), '失败不得显示成功');
    // 失败路径必须已经收掉本次隧道：ssh 替身记录 fake-ssh-stopped（同一本地端口）。
    const firstRows = await waitSshLog(
      handle.sshLog,
      '失败探测后旧隧道未结束（无 fake-ssh-stopped）',
      (rows) => stoppedFor(rows, tunnelPort).length >= 1,
      20000,
    );
    const argsRows = firstRows.filter((row) => row.event === 'fake-ssh-args');
    assert.equal(argsRows.length, 1, `失败探测应只起 1 条隧道，实际 ${argsRows.length}`);
    assert.deepEqual(
      sshForwardSpec(argsRows[0] ?? {}),
      { localPort: tunnelPort, remotePort: deadPort },
      '第一次隧道应转发到死端口',
    );
    const stopped = stoppedFor(firstRows, tunnelPort)[0];
    assert.ok(stopped !== undefined && typeof stopped.pid === 'number', 'fake-ssh-stopped 必须带隧道 pid');
    assert.equal(processAlive(stopped.pid ?? -1), false, `旧隧道进程 ${String(stopped.pid)} 必须已退出`);
    // 改配置重试：remotePort 改成 fake 模型实际端口（fake ssh 转发即通），再次点击 probe。
    const retry = await readDom(handle.cdp);
    assert.equal(retry.probe.disabled, false, '失败后必须允许改配置重试');
    assert.equal(retry.fields.remotePort.value, String(deadPort), '失败后字段应保留用户输入');
    await fillField(handle.cdp, retry.fields.remotePort, String(handle.fakePort));
    assert.equal((await readDom(handle.cdp)).fields.remotePort.value, String(handle.fakePort), '字段必须可修改');
    await clickRect(handle.cdp, (await readDom(handle.cdp)).probe);
    await waitDom(handle.cdp, '改到 fakePort 后再次 probe 未成功', (s) => s.phaseText.includes('连接成功'), 40000);
    // 成功探测同样收隧道：两条隧道都必须有 stopped 记录。
    const allRows = await waitSshLog(
      handle.sshLog,
      '成功探测后隧道未全部结束',
      (rows) => stoppedFor(rows, tunnelPort).length >= 2,
      20000,
    );
    const allArgs = allRows.filter((row) => row.event === 'fake-ssh-args');
    assert.equal(allArgs.length, 2, `重试应起第 2 条隧道，实际 ${allArgs.length}`);
    assert.deepEqual(
      sshForwardSpec(allArgs[1] ?? {}),
      { localPort: tunnelPort, remotePort: handle.fakePort },
      '第二次隧道应转发到 fake 模型端口',
    );
    for (const row of stoppedFor(allRows, tunnelPort)) {
      assert.equal(processAlive(row.pid ?? -1), false, `隧道进程 ${String(row.pid)} 必须已退出`);
    }
    assert.equal(countPosts(handle.logFile), 0, '失败重试全程零 POST');
    await writeCaseEvidence(
      handle.caseName,
      'retry.txt',
      [
        `dead_port=${deadPort}`,
        `fake_port=${handle.fakePort}`,
        `tunnel_port=${tunnelPort}`,
        `failure_text=${failed.state.phaseText}`,
        'post=0',
        '',
      ].join('\n'),
    );
    await closeAndAssertClean(handle);
    console.log(`[launcher-e2e] PASS probe-fail-retry ms=${Date.now() - startedAt} POST=0 tunnels=2`);
  } finally {
    if (handle) await handle.stop();
  }
});

test('探测中关窗 · /models 等待中取消：退出 0、无桌宠窗口、隧道已收、归属进程全消失', { timeout: 300000 }, async (t) => {
  if (!gate(t)) return;
  const startedAt = Date.now();
  let handle: Handle | undefined;
  let blackhole: Blackhole | undefined;
  try {
    // 只接受连接不回包的本地黑洞：隧道真实建立，但 GET /v1/models 一直等待 → 稳定停在 probing。
    blackhole = await startBlackhole();
    handle = await launchCase({ caseName: 'probe-cancel-exit', config: null, pinFakeTarget: false });
    const tunnelPort = await freePort();
    await fillForm(handle, {
      host: 'fake.example.invalid',
      port: '10977',
      user: 'tester',
      identityFile: path.join(handle.userData, 'id_ed25519'),
      localPort: String(tunnelPort),
      remoteHost: '127.0.0.1',
      remotePort: String(blackhole.port),
    });
    await clickRect(handle.cdp, (await readDom(handle.cdp)).probe);
    await waitDom(handle.cdp, '点击探测后未进入 probing', (s) => s.phase === 'probing', 15000);
    // 隧道已真实建立（fake-ssh-listening），此时探测仍在等待 → 关窗即"探测中取消"。
    const rows = await waitSshLog(
      handle.sshLog,
      '隧道未建立，无法验证探测中取消',
      (list) => list.some((row) => row.event === 'fake-ssh-listening' && row.port === tunnelPort),
      15000,
    );
    assert.ok(
      rows.some((row) => row.event === 'fake-ssh-listening' && row.port === tunnelPort),
      'fake-ssh 必须已监听本次隧道端口',
    );
    assert.equal((await readDom(handle.cdp)).phase, 'probing', '关窗时必须仍处于探测中');
    // 无桌宠窗口：关窗前不得出现 app/page.html。
    assert.equal((await listTargets(handle.debugPort)).filter(isPetPage).length, 0, '探测阶段不得创建桌宠窗口');
    // 立即关窗：断言（退出码/归属/端口）在 finally 之前。
    const code = await closeAndAssertClean(handle, { expectNoPetWindow: true });
    assert.equal(code, 0, `探测中关窗退出码必须 0；stdout=${handle.output().slice(-800)}`);
    // 隧道收尾：ssh 替身记录 fake-ssh-stopped，且 pid 已退出、本地端口不再监听。
    const after = await waitSshLog(
      handle.sshLog,
      '探测中关窗后隧道未收（无 fake-ssh-stopped）',
      (list) => stoppedFor(list, tunnelPort).length >= 1,
      20000,
    );
    for (const row of stoppedFor(after, tunnelPort)) {
      assert.equal(processAlive(row.pid ?? -1), false, `隧道进程 ${String(row.pid)} 必须已退出`);
    }
    assert.equal(await portOpen(tunnelPort), false, `隧道本地端口 ${tunnelPort} 不得残留监听`);
    // 未进入启动链：main 不得打印 launcher-started，也不得留下 page.html target。
    assert.ok(!handle.output().includes('"event":"launcher-started"'), '探测中取消不得进入启动链');
    assert.equal((await listTargets(handle.debugPort)).filter(isPetPage).length, 0, '取消后不得有桌宠窗口');
    console.log(`[launcher-e2e] PASS probe-cancel-exit ms=${Date.now() - startedAt} tunnel_port=${tunnelPort} POST=0`);
  } finally {
    if (handle) await handle.stop();
    if (blackhole) await blackhole.close().catch(() => undefined);
  }
});


test('直接关 launcher 窗口 · 干净退出、无残留进程/端口、无关哨兵存活、零 POST', { timeout: 300000 }, async (t) => {
  if (!gate(t)) return;
  const startedAt = Date.now();
  let handle: Handle | undefined;
  let sentinel: Sentinel | undefined;
  try {
    handle = await launchCase({ caseName: 'cancel-clean-exit', config: null, pinFakeTarget: true });
    await waitDom(handle.cdp, 'launcher 表单未挂载', (s) => s.hasForm, 30000);
    sentinel = startSentinel();
    assert.equal(sentinel.alive(), true, '哨兵进程应先在跑');
    await closeAndAssertClean(handle);
    assert.equal(sentinel.alive(), true, '退出清理不得误杀无关哨兵进程');
    assert.equal(countPosts(handle.logFile), 0, '取消路径零 POST');
    console.log(`[launcher-e2e] PASS cancel-clean-exit ms=${Date.now() - startedAt} sentinel=${sentinel.pid} alive`);
  } finally {
    sentinel?.kill();
    if (handle) await handle.stop();
  }
});

test('选 companion · 发 1 条 fake 消息：回复上屏、reaction 恰 1 次、POST=1、退出 0', { timeout: 300000 }, async (t) => {
  if (!gate(t)) return;
  const startedAt = Date.now();
  let handle: Handle | undefined;
  let petCdp: Cdp | undefined;
  try {
    handle = await launchCase({ caseName: 'companion-chat', config: null, pinFakeTarget: true });
    const tunnelPort = await freePort();
    const filled = await fillForm(handle, {
      host: 'fake.example.invalid',
      port: '10977',
      user: 'tester',
      identityFile: path.join(handle.userData, 'id_ed25519'),
      localPort: String(tunnelPort),
      remoteHost: '127.0.0.1',
      remotePort: '18872',
    });
    // 用户显式选择 companion（原生 radio；click 触发 change → page.dataset.experience）。
    await clickRect(handle.cdp, filled.experienceCompanion);
    const chosen = await waitDom(handle.cdp, 'companion 单选未生效', (s) => s.experience === 'companion', 15000);
    assert.equal(chosen.state.experience, 'companion');
    await clickRect(handle.cdp, chosen.state.start);
    const pet = await waitPetTarget(handle.debugPort, 90000);
    petCdp = await connectCdp(pet.webSocketDebuggerUrl ?? '');
    await waitPetMounted(petCdp, 30000);
    const ready = await waitPetDom(petCdp, '桌宠页面未就绪', (s) => s.pet && s.hasPanel && s.experience === 'companion', 30000);
    assert.equal(ready.state.experience, 'companion', '选择的 companion 必须生效到页面');
    // 启动成功后隧道保持（聊天经隧道）；归属快照断言在退出前。
    assert.equal(await waitPortOpen(tunnelPort, 15000), true, `启动成功后隧道 ${tunnelPort} 应保持监听`);
    captureAfterStart(handle);

    await openPetPanel(petCdp);
    const submittedAt = await typeAndSend(petCdp, '伙伴一句');
    const reply = await waitPetDom(
      petCdp,
      '回复未上屏',
      (s) => s.assistantMsgs.some((m) => m.includes('隧道回复：伙伴一句')),
      40000,
    );
    const seq = await observeVisual(petCdp, 2500);
    const reactions = reactionsIn(seq);
    assert.equal(reactions.length, 1, `成功回复必须恰好一次 reaction；seq=${JSON.stringify(seq)}`);
    assert.ok(seq.some((item) => item.visual === 'auto'), `reaction 期间 visual 应为 auto；seq=${JSON.stringify(seq)}`);
    const requests = readRequests(handle.logFile);
    assert.equal(requests.length, 1, `发送 1 条必须恰好 1 次 POST，实际 ${requests.length}`);
    assert.equal(countPosts(handle.logFile), 1, 'POST 计数必须为 1');
    await writeCaseEvidence(
      handle.caseName,
      'chat.txt',
      [
        `submit_at=${submittedAt}`,
        `reply_ms=${reply.atMs - submittedAt}`,
        `visual_seq=${JSON.stringify(seq)}`,
        `reactions=${JSON.stringify(reactions)}`,
        `post=${requests.length}`,
        `model_turns=${String(requests[0]?.messages.length ?? 0)}`,
        '',
      ].join('\n'),
    );
    const code = await closeAndAssertClean(handle, { cdp: petCdp });
    assert.equal(code, 0, `关窗退出码必须 0；stdout=${handle.output().slice(-800)}`);
    assert.equal(countPosts(handle.logFile), 1, '退出后 POST 仍必须为 1（不得补发）');
    console.log(
      `[launcher-e2e] PASS companion-chat ms=${Date.now() - startedAt} reply_ms=${reply.atMs - submittedAt} reactions=1 POST=1`,
    );
  } finally {
    petCdp?.close();
    if (handle) await handle.stop();
  }
});

test('选 companion · 慢回复 2500ms：等待提示先到期、回复上屏、reaction 恰 1 次、POST=1、退出 0', { timeout: 300000 }, async (t) => {
  if (!gate(t)) return;
  const startedAt = Date.now();
  let handle: Handle | undefined;
  let petCdp: Cdp | undefined;
  try {
    handle = await launchCase({ caseName: 'companion-chat-slow', config: null, pinFakeTarget: true, fakeDelayMs: 2500 });
    const tunnelPort = await freePort();
    const filled = await fillForm(handle, {
      host: 'fake.example.invalid',
      port: '10977',
      user: 'tester',
      identityFile: path.join(handle.userData, 'id_ed25519'),
      localPort: String(tunnelPort),
      remoteHost: '127.0.0.1',
      remotePort: '18872',
    });
    await clickRect(handle.cdp, filled.experienceCompanion);
    const chosen = await waitDom(handle.cdp, 'companion 单选未生效', (s) => s.experience === 'companion', 15000);
    await clickRect(handle.cdp, chosen.state.start);
    const pet = await waitPetTarget(handle.debugPort, 90000);
    petCdp = await connectCdp(pet.webSocketDebuggerUrl ?? '');
    await waitPetMounted(petCdp, 30000);
    await waitPetDom(petCdp, '桌宠页面未就绪', (s) => s.pet && s.hasPanel && s.experience === 'companion', 30000);
    assert.equal(await waitPortOpen(tunnelPort, 15000), true, `启动成功后隧道 ${tunnelPort} 应保持监听`);
    captureAfterStart(handle);

    await openPetPanel(petCdp);
    const submittedAt = await typeAndSend(petCdp, '慢回复一句');
    const waiting = await waitPetDom(petCdp, '等待反馈未出现', (s) => s.feedbackKind === 'waiting', 15000);
    const hidden = await waitPetDom(petCdp, '等待提示未按期隐藏', (s) => s.feedbackKind === 'hidden', 15000);
    assert.ok(waiting.atMs <= hidden.atMs, '等待提示必须先可见再到期隐藏');
    assert.ok(hidden.atMs - submittedAt < 2500, '等待提示必须在慢回复到达前到期隐藏');
    const reply = await waitPetDom(
      petCdp,
      '慢回复未上屏',
      (s) => s.assistantMsgs.some((m) => m.includes('隧道回复：慢回复一句')),
      40000,
    );
    const seq = await observeVisual(petCdp, 2500);
    const reactions = reactionsIn(seq);
    assert.equal(reactions.length, 1, `慢回复成功也必须恰好一次 reaction；seq=${JSON.stringify(seq)}`);
    assert.equal(countPosts(handle.logFile), 1, '慢回复只允许 1 次 POST');
    await writeCaseEvidence(
      handle.caseName,
      'chat.txt',
      [
        `submit_at=${submittedAt}`,
        `waiting_hidden_ms=${hidden.atMs - submittedAt}`,
        `reply_ms=${reply.atMs - submittedAt}`,
        `visual_seq=${JSON.stringify(seq)}`,
        `reactions=${JSON.stringify(reactions)}`,
        'post=1',
        '',
      ].join('\n'),
    );
    const code = await closeAndAssertClean(handle, { cdp: petCdp });
    assert.equal(code, 0, `关窗退出码必须 0；stdout=${handle.output().slice(-800)}`);
    assert.equal(countPosts(handle.logFile), 1, '退出后 POST 仍必须为 1');
    console.log(
      `[launcher-e2e] PASS companion-chat-slow ms=${Date.now() - startedAt} reply_ms=${reply.atMs - submittedAt} reactions=1 POST=1`,
    );
  } finally {
    petCdp?.close();
    if (handle) await handle.stop();
  }
});

