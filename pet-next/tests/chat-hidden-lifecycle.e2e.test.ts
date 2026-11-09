/**
 * M3-9 R1 C：隐藏聊天故障闭环 E2E（正式入口 + 真实 BrowserWindow.hide/show + 真实会话/provider）。
 *
 * 入口：`scripts/chat-local.mjs`（= `pnpm chat:local` 去掉重复 build；本文件 before 里只 build 一次）。
 *   DISPLAY=<独占显示> PET_NEXT_QWEN_BASE_URL=<fake>/v1 PET_NEXT_QWEN_MODEL=qwen3.8-27b
 *   PET_NEXT_CHAT_DEBUG_PORT=<port> PET_NEXT_USER_DATA=<tmp> PET_NEXT_TEST=1
 *   [PET_NEXT_CHAT_CONTEXT=1] [PET_NEXT_EXPERIENCE=companion] [PET_NEXT_PREVIEW=short,behavior] [PET_NEXT_IDLE_PAUSE=1]
 * 模型只来自 B 的可控 fake（`tests/support/hidden-chat-fake-server.ts`）；不改产品默认值、
 * 不扩 max_tokens、不加生产 timeout、不重试、不访问 127.0.0.1:18872。
 *
 * 覆盖（六类）：
 *   ① 2s 延迟成功 + 长正文 2000/2001 字符（既有 2000 截断契约；finish_reason=length 只标记不报错）
 *   ② 隐藏 cancel → 立即重发 → 旧结果晚到（不占新槽 / 不出现旧消息 / 不触发新 reaction；取消不入史）
 *   ③ 隐藏期到真实 15s 总 deadline → 恢复 → 重发（恢复 0 POST、不补播反馈；失败不入史）
 *   ④ 隐藏 reset → 迟到 → 新请求（清展示 + 清历史 + 旧结果按 id 隔离）
 *   ⑤ 上游连接重置 → 可读错误 → 手动重发（无自动重试）
 *   ⑥ 在途隐藏关窗 → 自然退出（exit 0）、本次 PID 与调试端口消失
 *
 * 两臂：idle-pause 开 / 关，同素材同配置；主组合 context=on + companion，
 * 另留标准/context-off 成功对照。每臂实际 context/experience 由 `window.petChat.info()` 读取并记录。
 *
 * 就绪屏障：fake.waitForRequest / waitForCompletion / release、DOM 轮询、进程退出等待；
 * 固定 sleep 只用于“断言某件事不应发生”的观察窗口，不当作就绪条件。
 * 每个测试有总时限，只清理本次进程树与本次 display。
 *
 * 运行：
 *   node --experimental-strip-types --test --test-concurrency=1 --test-reporter spec tests/chat-hidden-lifecycle.e2e.test.ts
 * 团队约定：本文件独占显示 :131（自己起 Xvfb，已在跑则复用，不 kill 他人）。
 * @module pet-next/tests/chat-hidden-lifecycle.e2e
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { aliveTracked } from './platform/session.ts';
import { startTrackedRun, type TrackedRun } from './support/tracked-run.ts';

const petRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENTRY = path.join(petRoot, 'scripts/chat-local.mjs');
const LOG_ROOT = path.join(petRoot, 'logs/platform-runs');
/** 团队约定：本 E2E 独占 :131。 */
const DISPLAY = process.env.PET_NEXT_E2E_DISPLAY ?? ':131';
const DISPLAY_SUFFIX = DISPLAY.startsWith(':') ? DISPLAY.slice(1) : DISPLAY;
const DISPLAY_SOCKET = `/tmp/.X11-unix/X${DISPLAY_SUFFIX}`;
const MODEL = 'qwen3.8-27b';
/** 冻结契约值（contracts/chat.ts）：只读引用，测试不改。 */
const MAX_RESULT_CHARS = 2000;
const TOTAL_TIMEOUT_MS = 15_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ===== B 冻结模块的调用面（签名见 TASKS.txt B 段；实际实现由 agent/m39r1-b 提供） ===== */

type FakeMode = 'ok' | 'delay' | 'headers-sent' | 'body-hold' | 'reset' | 'long' | 'length' | 'late-ignore-abort';

/** 一次可控响应（B 的 plan 条目字段）：mode 决定行为，chars 决定 long 正文长度。 */
interface FakePlanEntry {
  mode: FakeMode;
  /** long 模式正文长度（'长' × chars）。 */
  chars?: number;
  /** delay / headers-sent 的自动放行时间；不给则由 release 控制。 */
  delayMs?: number;
  ignoreAbortMs?: number;
  responseId?: string;
}

type FakeStatus = 'pending' | 'completed' | 'completed-late' | 'aborted' | 'reset' | 'write-failed';

/** B 的 fake 账本条目（不含请求体原文，只有 sha256 与字节数）。 */
interface FakeRecord {
  index: number;
  mode: string;
  userText: string;
  bodySha256: string | null;
  requestBytes: number;
  finishReason: string | null;
  responseText: string | null;
  status: FakeStatus;
  clientAborted: boolean;
  downstreamClosedEarly: boolean;
}

interface FakeStats {
  total: number;
  parsed: number;
  pending: number;
  completed: number;
  completedLate: number;
  aborted: number;
  reset: number;
  writeFailed: number;
  clientAborted: number;
  byMode: Record<string, number>;
}

interface HiddenChatFake {
  readonly port: number;
  readonly url: string;
  readonly baseUrl: string;
  readonly requests: FakeRecord[];
  plan(entries: FakePlanEntry[]): number;
  waitForRequest(count: number, timeoutMs?: number): Promise<FakeRecord[]>;
  release(index?: number): number | boolean;
  waitForCompletion(index: number, timeoutMs?: number): Promise<FakeRecord>;
  stats(): FakeStats;
  close(): Promise<void>;
}

interface ProxyStats {
  postCount: number;
  total: number;
  forwarded: number;
  completed: number;
  downstreamClosedEarly: number;
  abortedUpstream: number;
  upstreamErrors: number;
  synthesizedErrors: number;
}

interface CountingProxy {
  readonly port: number;
  readonly url: string;
  readonly targetPort: number;
  readonly postCount: number;
  readonly requests: Array<{ forwardCount: number; abortedUpstream: boolean; downstreamClosedEarly: boolean }>;
  stats(): ProxyStats;
  waitForLedger(predicate: (rows: unknown[]) => boolean, timeoutMs?: number): Promise<unknown[]>;
  close(): Promise<void>;
}

interface HiddenChatSupport {
  startHiddenChatFakeServer(options?: Record<string, unknown>): Promise<HiddenChatFake> | HiddenChatFake;
  startCountingProxy(options: { targetPort: number; allowedPorts: number[] }): Promise<CountingProxy> | CountingProxy;
}

/** B 的模块尚未合入时返回 null；由用例显式 skip，绝不伪造通过。 */
async function loadSupport(): Promise<HiddenChatSupport | null> {
  const fakeSpec = './support/hidden-chat-fake-server.mjs';
  const proxySpec = './support/counting-proxy.mjs';
  try {
    const fakeModule = (await import(fakeSpec)) as { startHiddenChatFakeServer?: HiddenChatSupport['startHiddenChatFakeServer'] };
    const proxyModule = (await import(proxySpec)) as { startCountingProxy?: HiddenChatSupport['startCountingProxy'] };
    if (typeof fakeModule.startHiddenChatFakeServer !== 'function') return null;
    if (typeof proxyModule.startCountingProxy !== 'function') return null;
    return {
      startHiddenChatFakeServer: fakeModule.startHiddenChatFakeServer,
      startCountingProxy: proxyModule.startCountingProxy,
    };
  } catch {
    return null;
  }
}

async function supportOrSkip(t: TestContext): Promise<HiddenChatSupport | null> {
  const support = await loadSupport();
  if (support === null) {
    t.skip('not-run: tests/support/hidden-chat-fake-server.ts / counting-proxy.ts 未合入（等 agent/m39r1-b）');
    return null;
  }
  return support;
}

/* ===== 正式入口 harness ===== */

interface Arm {
  readonly name: string;
  /** PET_NEXT_CHAT_CONTEXT（有界历史）。 */
  readonly context: boolean;
  /** PET_NEXT_EXPERIENCE + PET_NEXT_PREVIEW=short,behavior。 */
  readonly companion: boolean;
  /** PET_NEXT_IDLE_PAUSE。 */
  readonly idlePause: boolean;
  /** 经 B 的计数代理接 fake（需要独立 POST 计数 / 上游断开观测）。 */
  readonly viaProxy: boolean;
}

/** 主组合：idle-pause 开 + context=on + companion。 */
const ARM_MAIN: Arm = { name: 'main', context: true, companion: true, idlePause: true, viaProxy: false };
/** 同素材同配置，只把 idle-pause 关掉（两臂对照）。 */
const ARM_MAIN_NO_IDLE: Arm = { name: 'main-no-idle', context: true, companion: true, idlePause: false, viaProxy: false };
/** 标准体验 / context-off 成功对照。 */
const ARM_CONTROL: Arm = { name: 'control', context: false, companion: false, idlePause: true, viaProxy: false };
/** 需要独立计数与上游断开观测的组合。 */
const ARM_PROXIED: Arm = { name: 'main-proxy', context: true, companion: true, idlePause: true, viaProxy: true };

interface Rect {
  found: boolean;
  visible: boolean;
  cx: number;
  cy: number;
  disabled: boolean | null;
}

interface DomState {
  hasPanel: boolean;
  phase: string;
  experience: string;
  visual: string;
  request: string;
  userMsgs: string[];
  assistantMsgs: string[];
  /** 助手正文（不含“Qwen · model”标签）。截断/长度断言只看这里。 */
  assistantBodies: string[];
  statusMsgs: string[];
  errorMsgs: string[];
  feedbackKind: string;
  feedbackText: string;
  rects: { toggle: Rect; input: Rect; send: Rect; cancel: Rect; reset: Rect };
}

type RectKey = keyof DomState['rects'];

/** 只读 DOM：矩形 + 状态 + 文本；不调用 el.click()，不直接赋 value。 */
const DOM_EXPRESSION = `(() => {
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
  const texts = (selector) => Array.from(document.querySelectorAll(selector)).map((node) => (node.textContent === null ? '' : node.textContent.trim()));
  const root = document.querySelector('[data-testid="chat-panel"]');
  const feedback = document.querySelector('[data-testid="chat-feedback"]');
  const dataset = document.documentElement.dataset;
  return {
    hasPanel: root !== null,
    phase: root instanceof HTMLElement ? (root.dataset.state || '') : '',
    experience: dataset.experience || '',
    visual: dataset.visual || '',
    request: dataset.request || '',
    userMsgs: texts('[data-testid="chat-msg-user"]'),
    assistantMsgs: texts('[data-testid="chat-msg-assistant"]'),
    assistantBodies: texts('[data-testid="chat-msg-assistant"] .chat-entry-text'),
    statusMsgs: texts('[data-testid="chat-status"]'),
    errorMsgs: texts('[data-testid="chat-msg-error"]'),
    feedbackKind: feedback === null ? 'absent' : (feedback.hidden ? 'hidden' : (feedback.dataset.kind || 'shown')),
    feedbackText: feedback === null ? '' : (feedback.textContent === null ? '' : feedback.textContent.trim()),
    rects: {
      toggle: read('[data-testid="chat-toggle"]'),
      input: read('[data-testid="chat-input"]'),
      send: read('[data-testid="chat-send"]'),
      cancel: read('[data-testid="chat-cancel"]'),
      reset: read('[data-testid="chat-reset"]'),
    },
  };
})()`;

interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

interface Run {
  readonly arm: Arm;
  readonly cdp: Cdp;
  readonly entry: TrackedRun;
  readonly fake: HiddenChatFake;
  readonly proxy: CountingProxy | null;
  readonly userData: string;
  readonly debugPort: number;
  posts(): number;
  output(): string;
  log(line: string): void;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('无法取得空闲端口'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(800, () => finish(false));
  });
}

function buildOnce(): void {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync('pnpm', ['build'], { cwd: petRoot, env, encoding: 'utf8', timeout: 300_000 });
  if (result.status !== 0) {
    throw new Error(`pnpm build 失败（exit=${String(result.status)}）\nstdout:${result.stdout ?? ''}\nstderr:${result.stderr ?? ''}`);
  }
  assert.equal(existsSync(path.join(petRoot, 'dist/electron/main.js')), true, 'build 后必须存在 dist/electron/main.js');
}

function entryEnv(arm: Arm, baseUrl: string, userData: string, debugPort: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISPLAY,
    PET_NEXT_QWEN_BASE_URL: baseUrl,
    PET_NEXT_QWEN_MODEL: MODEL,
    PET_NEXT_CHAT_DEBUG_PORT: String(debugPort),
    PET_NEXT_USER_DATA: userData,
    PET_NEXT_TEST: '1',
  };
  // 两臂唯一差异由 Arm 决定：父 shell / 上一次用例的残留开关必须先清掉。
  delete env.PET_NEXT_CHAT_LOCAL;
  delete env.PET_NEXT_CHAT_PREVIEW;
  delete env.PET_NEXT_CHAT_CONTEXT;
  delete env.PET_NEXT_EXPERIENCE;
  delete env.PET_NEXT_PREVIEW;
  delete env.PET_NEXT_IDLE_PAUSE;
  delete env.NODE_OPTIONS;
  if (arm.context) env.PET_NEXT_CHAT_CONTEXT = '1';
  if (arm.companion) {
    env.PET_NEXT_EXPERIENCE = 'companion';
    env.PET_NEXT_PREVIEW = 'short,behavior';
  }
  if (arm.idlePause) env.PET_NEXT_IDLE_PAUSE = '1';
  return env;
}

async function connectCdp(url: string): Promise<Cdp> {
  const socket = new WebSocket(url);
  let next = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error(`CDP 连接失败：${url}`)));
  });
  socket.addEventListener('message', (event) => {
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
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function openRun(support: HiddenChatSupport, arm: Arm, label: string): Promise<Run> {
  const userData = await mkdtemp(path.join(tmpdir(), `pet-hidden-${label}-`));
  const fake = await support.startHiddenChatFakeServer({ label });
  let proxy: CountingProxy | null = null;
  if (arm.viaProxy) {
    proxy = await support.startCountingProxy({ targetPort: fake.port, allowedPorts: [fake.port] });
  }
  const baseHost = proxy === null ? fake.url : proxy.url;
  const debugPort = await freePort();
  const entry = startTrackedRun({
    executable: process.execPath,
    args: [ENTRY],
    cwd: petRoot,
    env: entryEnv(arm, `${baseHost}/v1`, userData, debugPort),
    label: `hidden-${label}`,
    logRoot: LOG_ROOT,
  });

  let socket = '';
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && socket === '') {
    if (entry.child.exitCode !== null) {
      await entry.stop().catch(() => undefined);
      await fake.close().catch(() => undefined);
      await proxy?.close().catch(() => undefined);
      await rm(userData, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(`入口提前退出 code=${String(entry.child.exitCode)}\n${entry.stdout().slice(-3000)}\n${entry.stderr().slice(-2000)}`);
    }
    try {
      const list = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as Array<{
        type?: string;
        webSocketDebuggerUrl?: string;
      }>;
      socket = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? '';
    } catch {
      // 未就绪
    }
    if (socket === '') await delay(150);
  }
  if (socket === '') {
    await entry.stop().catch(() => undefined);
    await fake.close().catch(() => undefined);
    await proxy?.close().catch(() => undefined);
    await rm(userData, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`CDP 未就绪（60s）\n${entry.stdout().slice(-3000)}\n${entry.stderr().slice(-2000)}`);
  }

  const cdp = await connectCdp(socket);
  let closed = false;
  return {
    arm,
    cdp,
    entry,
    fake,
    proxy,
    userData,
    debugPort,
    posts: () => fake.requests.length,
    output: () => `${entry.stdout()}\n${entry.stderr()}`,
    log: (line: string) => console.log(`[hidden-e2e] ${label} ${line}`),
    async stop() {
      if (closed) return;
      closed = true;
      try {
        cdp.close();
      } catch {
        // 已退出。
      }
      await entry.stop().catch(() => undefined);
      await entry.writeRecord().catch(() => undefined);
      if (proxy !== null) await proxy.close().catch(() => undefined);
      await fake.close().catch(() => undefined);
      await rm(userData, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/* ===== DOM / CDP 操作 ===== */

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
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate 失败');
  }
  return result.result?.value as T;
}

function readDom(cdp: Cdp): Promise<DomState> {
  return evaluate<DomState>(cdp, DOM_EXPRESSION);
}

async function waitDom(run: Run, label: string, ok: (state: DomState) => boolean, timeoutMs: number): Promise<DomState> {
  const deadline = Date.now() + timeoutMs;
  let last: DomState | undefined;
  while (Date.now() < deadline) {
    try {
      last = await readDom(run.cdp);
      if (ok(last)) return last;
    } catch {
      // 页面重绘/导航瞬间，继续轮询。
    }
    await delay(40);
  }
  throw new Error(`${label}（${timeoutMs}ms 超时）last=${JSON.stringify(last)}\n${run.output().slice(-2000)}`);
}

async function clickRect(cdp: Cdp, rect: Rect): Promise<void> {
  const x = Math.round(rect.cx);
  const y = Math.round(rect.cy);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await delay(20);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function clickTestId(run: Run, key: RectKey): Promise<void> {
  const state = await waitDom(run, `${key} 可点击`, (dom) => dom.rects[key].visible && dom.rects[key].disabled !== true, 10_000);
  await clickRect(run.cdp, state.rects[key]);
}

async function openPanel(run: Run): Promise<DomState> {
  await waitDom(run, '面板未挂载', (state) => state.hasPanel && state.rects.toggle.visible, 30_000);
  await clickTestId(run, 'toggle');
  return waitDom(run, '面板未打开', (state) => state.rects.input.visible, 10_000);
}

async function typeAndSend(run: Run, text: string): Promise<void> {
  const ready = await waitDom(run, '输入框未就绪', (state) => state.rects.input.visible, 10_000);
  await clickRect(run.cdp, ready.rects.input);
  // 全选覆盖上一次草稿（真实按键，不直接赋 value）。
  await run.cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
  });
  await run.cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
  });
  await run.cdp.send('Input.insertText', { text });
  const armed = await waitDom(run, '发送按钮未就绪', (state) => state.rects.send.disabled === false, 10_000);
  await clickRect(run.cdp, armed.rects.send);
}

/** 真实 BrowserWindow.hide()/show()（主进程只在 PET_NEXT_TEST=1 注册该通道）。 */
async function actWindow(run: Run, action: 'hide' | 'show'): Promise<{ visible: boolean; minimized: boolean }> {
  return evaluate<{ visible: boolean; minimized: boolean }>(run.cdp, `window.petTestWindow.act(${JSON.stringify(action)})`);
}

interface IdleSnapshot {
  hidden: boolean;
  pauseCount: number;
  resumeCount: number;
  phase: string;
  clip: string;
}

function idleSnapshot(cdp: Cdp): Promise<IdleSnapshot | null> {
  return evaluate<IdleSnapshot | null>(
    cdp,
    'window.__petIdleSuspension ? { hidden: window.__petIdleSuspension.hidden, pauseCount: window.__petIdleSuspension.pauseCount, resumeCount: window.__petIdleSuspension.resumeCount, phase: window.__petIdleSuspension.phase, clip: window.__petIdleSuspension.clip } : null',
  );
}

interface ChatInfo {
  mode?: string;
  model?: string;
  transport?: string;
  context?: boolean;
  experience?: string;
}

async function hideUntilPaused(run: Run): Promise<IdleSnapshot> {
  const info = await actWindow(run, 'hide');
  assert.equal(info.visible, false, '真实 hide 后窗口必须不可见');
  if (!run.arm.idlePause) return { hidden: true, pauseCount: 0, resumeCount: 0, phase: '', clip: '' };
  const deadline = Date.now() + 15_000;
  let last: IdleSnapshot | null = null;
  while (Date.now() < deadline) {
    last = await idleSnapshot(run.cdp);
    if (last !== null && last.hidden && last.pauseCount >= 1) return last;
    await delay(40);
  }
  throw new Error(`hide 后未观察到 idle 暂停：${JSON.stringify(last)}`);
}

/**
 * 只要求“真实显示 + 观测面回到 hidden=false”。
 * 隐藏期的成功回应会接管 idle 播放并作废暂停归属，此时 resumeCount 不增（D 的 idle 用例覆盖 resume 归属）；
 * 这里不把两种合法收敛混为一谈。
 */
async function showUntilVisible(run: Run): Promise<IdleSnapshot | null> {
  const info = await actWindow(run, 'show');
  assert.equal(info.visible, true, '真实 show 后窗口必须可见');
  if (!run.arm.idlePause) return null;
  const deadline = Date.now() + 10_000;
  let last: IdleSnapshot | null = null;
  while (Date.now() < deadline) {
    last = await idleSnapshot(run.cdp);
    if (last !== null && last.hidden === false) return last;
    await delay(40);
  }
  throw new Error(`show 后未观察到 hidden=false：${JSON.stringify(last)}`);
}

async function showUntilResumed(run: Run, pauseCount: number): Promise<void> {
  const info = await actWindow(run, 'show');
  assert.equal(info.visible, true, '真实 show 后窗口必须可见');
  if (!run.arm.idlePause) return;
  const deadline = Date.now() + 15_000;
  let last: IdleSnapshot | null = null;
  while (Date.now() < deadline) {
    last = await idleSnapshot(run.cdp);
    if (last !== null && last.hidden === false && last.resumeCount >= 1 && last.pauseCount === pauseCount) return;
    await delay(40);
  }
  throw new Error(`show 后未观察到 idle 恢复：${JSON.stringify(last)}`);
}

/**
 * 采样回应动作：只认 reaction/auto 两种播放（idle/placeholder 是常驻待机，不是回应），
 * 用于证明旧结果没触发新 reaction、标准体验不排回应。
 */
async function observeReactions(cdp: Cdp, windowMs: number): Promise<string[]> {
  const seen = new Set<string>();
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const state = await readDom(cdp);
    if (state.visual === 'reaction' || state.visual === 'auto') seen.add(`${state.request}|${state.visual}`);
    await delay(60);
  }
  return [...seen];
}

/**
 * 请求体指纹：B 的账本只给 bodySha256（不落原文），而 qwen-provider 的请求体里没有请求 id，
 * 因此「同一 user 文本 + 同一历史」必然得到同一哈希。
 * 这是在不读请求体原文的前提下，证明“某轮是否入史”的可核对判据。
 */
function bodyHash(fake: HiddenChatFake, index: number): string {
  const record = fake.requests[index];
  assert.ok(record !== undefined, `缺少第 ${index} 个请求记录`);
  assert.equal(typeof record.bodySha256, 'string', `第 ${index} 个请求缺少 bodySha256`);
  return String(record.bodySha256);
}

/** 上游被客户端断开/取消的观测次数（fake 侧）。 */
function abortedCount(fake: HiddenChatFake): number {
  return fake.stats().aborted;
}

/** 每臂口径记录：实际 context/experience、idle 开关、POST 数。 */
async function recordArm(run: Run): Promise<{ info: ChatInfo; idle: IdleSnapshot | null }> {
  const info = await evaluate<ChatInfo>(run.cdp, 'window.petChat.info()');
  const idle = await idleSnapshot(run.cdp);
  run.log(
    `arm=${run.arm.name} context=${String(info.context)} experience=${String(info.experience ?? '')} idlePause=${run.arm.idlePause ? 'on' : 'off'} idleSurface=${idle === null ? 'absent' : 'present'} posts=${run.posts()} proxyPosts=${run.proxy === null ? 'n/a' : String(run.proxy.postCount)}`,
  );
  return { info, idle };
}

/* ===== 独占显示 ===== */

let xvfb: ChildProcess | undefined;
let ownsXvfb = false;

async function ensureDisplay(): Promise<void> {
  if (existsSync(DISPLAY_SOCKET)) return;
  xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  ownsXvfb = true;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(DISPLAY_SOCKET)) return;
    await delay(80);
  }
  throw new Error(`Xvfb ${DISPLAY} 未就绪`);
}

before(async () => {
  await ensureDisplay();
  buildOnce();
});

after(async () => {
  if (ownsXvfb && xvfb !== undefined) {
    try {
      xvfb.kill('SIGTERM');
    } catch {
      // 已退出。
    }
  }
});

/* ===== ① 2s 延迟成功 + 长正文（2000/2001） ===== */

test('① 隐藏期 2s 延迟成功 + 2000/2001 字符正文（截断契约与 length 元信息）', { timeout: 180_000 }, async (t) => {
  const support = await supportOrSkip(t);
  if (!support) return;
  const run = await openRun(support, ARM_MAIN, 'long-body');
  try {
    await run.fake.plan([
      { mode: 'delay', delayMs: 2000 }, // #0 2s 延迟：隐藏期成功
      { mode: 'long', chars: 2000 }, // #1 2000 字符：原样交付
      { mode: 'long', chars: 2001 }, // #2 2001 字符：按契约截断到 2000
      { mode: 'ok' }, // #3 与 #0 同文本：指纹证明超预算轮次被淘汰
      { mode: 'length' }, // #4 finish_reason=length：只标记、不报错
    ]);

    const opened = await openPanel(run);
    const { info, idle } = await recordArm(run);
    assert.equal(opened.experience, 'companion', '主组合必须记录到 experience=companion');
    assert.equal(info.context, true, '主组合必须是 context=on');
    assert.equal(info.mode, 'local');
    assert.notEqual(idle, null, 'idle-pause 开启时必须有观测面');

    // #0：2s 延迟，在途时真实隐藏；回复仍要在隐藏期结算到 DOM。
    await typeAndSend(run, '长文甲');
    await run.fake.waitForRequest(1, 15_000);
    const paused = await hideUntilPaused(run);
    const first = await waitDom(run, '2s 延迟回复未显示', (state) => state.assistantBodies.length === 1, 30_000);
    assert.equal(first.assistantBodies[0], '隧道回复：长文甲');
    assert.equal(first.phase, 'reply');
    assert.equal(first.feedbackKind === 'success' || first.feedbackKind === 'hidden', true, `companion 成功口径异常：${first.feedbackKind}`);
    const anchor = bodyHash(run.fake, 0);

    // 恢复：0 次新 POST、不补播等待反馈。
    const postsBeforeShow = run.posts();
    const afterShow = await showUntilVisible(run);
    assert.equal(afterShow?.hidden, false, '恢复后窗口不得仍处于隐藏态');
    assert.equal(run.posts(), postsBeforeShow, '恢复窗口本身不得产生任何新 POST');
    const resumedKinds: string[] = [];
    const resumeWindow = Date.now() + 800;
    while (Date.now() < resumeWindow) {
      resumedKinds.push((await readDom(run.cdp)).feedbackKind);
      await delay(80);
    }
    assert.equal(resumedKinds.includes('waiting'), false, `恢复后不得补播等待反馈：${resumedKinds.join(',')}`);

    // #1：2000 字符（未超上限）→ 原样 2000。
    await typeAndSend(run, '长文乙');
    const two = await waitDom(run, '2000 字符回复未显示', (state) => state.assistantBodies.length === 2, 30_000);
    assert.equal(two.assistantBodies[1]?.length, MAX_RESULT_CHARS, '2000 字符必须原样交付');
    assert.equal(two.assistantBodies[1], '长'.repeat(MAX_RESULT_CHARS));
    assert.equal(run.fake.requests[1]?.responseText?.length, MAX_RESULT_CHARS, '服务端确实给了 2000 字符');
    assert.equal(two.phase, 'reply');

    // #2：2001 字符 → 界面必须截断到 2000，且是前缀。
    await typeAndSend(run, '长文丙');
    const three = await waitDom(run, '2001 字符回复未显示', (state) => state.assistantBodies.length === 3, 30_000);
    assert.equal(three.assistantBodies[2]?.length, MAX_RESULT_CHARS, '超上限必须截断到 2000 字符');
    assert.equal(three.assistantBodies[2], '长'.repeat(MAX_RESULT_CHARS), '截断必须是前缀，不是改写');
    assert.equal(run.fake.requests[2]?.responseText?.length, MAX_RESULT_CHARS + 1, '服务端确实给了 2001 字符');
    assert.equal(three.errorMsgs.length, 0, '截断不是错误');

    // #3：与 #0 完全同一句。历史若还留着 2000/2001 两轮，请求体指纹必然变化。
    await typeAndSend(run, '长文甲');
    const four = await waitDom(run, '第四句回复未显示', (state) => state.assistantBodies.length === 4, 30_000);
    assert.equal(four.assistantBodies[3], '隧道回复：长文甲');
    assert.equal(
      bodyHash(run.fake, 3),
      anchor,
      '超预算轮次必须整轮淘汰（同一文本、历史为空 ⇒ 请求体指纹必须与首轮相同）',
    );

    // #4：finish_reason=length 只标记截断，正文照常交付。
    await typeAndSend(run, '长文丁');
    const five = await waitDom(run, 'length 回复未显示', (state) => state.assistantBodies.length === 5, 30_000);
    assert.equal(five.assistantBodies[4], '截断回复：长文丁');
    assert.equal(run.fake.requests[4]?.finishReason, 'length', 'length 元信息必须由服务端声明并被接受');
    assert.equal(five.errorMsgs.length, 0, 'finish_reason=length 不得报错');
    assert.equal(five.phase, 'reply');

    assert.equal(run.posts(), 5, '五次业务发送必须恰 5 次 POST（无自动重试）');
    await recordArm(run);
    run.log(`ok bodies=2000/2000 posts=${run.posts()} paused=${paused.pauseCount}`);
  } finally {
    await run.stop();
  }
});

/* ===== ①′ 对照臂：同素材同配置，仅 idle-pause 关闭 ===== */

test('①′ 同样素材与配置、仅 idle-pause 关闭：隐藏不影响 2s 延迟与长正文链路', { timeout: 180_000 }, async (t) => {
  const support = await supportOrSkip(t);
  if (!support) return;
  const run = await openRun(support, ARM_MAIN_NO_IDLE, 'idle-off');
  try {
    await run.fake.plan([{ mode: 'delay', delayMs: 2000 }, { mode: 'long', chars: 2000 }]);
    await openPanel(run);
    const { info } = await recordArm(run);
    assert.equal(info.context, true, '两臂对照必须同 context');
    assert.equal(info.experience, 'companion', '两臂对照必须同 experience');
    assert.equal(await evaluate<string>(run.cdp, 'typeof window.__petIdleSuspension'), 'undefined', '关闭时不得创建观测面');

    await typeAndSend(run, '关闭臂一句');
    await run.fake.waitForRequest(1, 15_000);
    await actWindow(run, 'hide');
    const first = await waitDom(run, '关闭臂 2s 回复未显示', (state) => state.assistantBodies.length === 1, 30_000);
    assert.equal(first.assistantBodies[0], '隧道回复：关闭臂一句');
    assert.equal(first.phase, 'reply');

    const postsBefore = run.posts();
    await actWindow(run, 'show');
    await delay(300);
    assert.equal(run.posts(), postsBefore, '关闭臂恢复同样不得产生 POST');

    await typeAndSend(run, '关闭臂长文');
    const long = await waitDom(run, '关闭臂长文未显示', (state) => state.assistantBodies.length === 2, 30_000);
    assert.equal(long.assistantBodies[1]?.length, MAX_RESULT_CHARS);
    assert.equal(run.posts(), 2);
    await recordArm(run);
    run.log('ok idle-off posts=2');
  } finally {
    await run.stop();
  }
});

/* ===== ② 隐藏 cancel → 立即重发 → 旧结果晚到 ===== */

test('② 隐藏取消 → 立即重发 → 旧结果晚到：不占新槽、不出现旧消息、不触发新 reaction', { timeout: 180_000 }, async (t) => {
  const support = await supportOrSkip(t);
  if (!support) return;
  const run = await openRun(support, ARM_PROXIED, 'cancel-late');
  try {
    await run.fake.plan([
      { mode: 'headers-sent' }, // #0 在途被取消（挂正文）
      { mode: 'ok' }, // #1 立即重发（同一句）
      { mode: 'ok' }, // #2 新一句：证明成功轮入史
    ]);
    const proxy = run.proxy;
    assert.notEqual(proxy, null, '本用例必须经计数代理观测上游断开');

    await openPanel(run);
    await recordArm(run);

    await typeAndSend(run, '甲方问题');
    await run.fake.waitForRequest(1, 15_000);
    await hideUntilPaused(run);
    assert.equal(run.posts(), 1);

    // 隐藏中取消：会话立刻结算、槽位立即释放。
    await clickTestId(run, 'cancel');
    const cancelled = await waitDom(run, '取消未结算', (state) => state.phase === 'cancelled' && state.statusMsgs.includes('已取消'), 10_000);
    assert.equal(cancelled.assistantBodies.length, 0, '取消不得产生助手消息');
    if (proxy !== null) assert.equal(proxy.postCount, 1, '取消本身不得产生新 POST');

    // 立即重发同一句：恰 1 POST；请求体指纹与首轮相同 ⇒ 取消那轮未入史。
    await typeAndSend(run, '甲方问题');
    const replied = await waitDom(run, '重发未成功', (state) => state.assistantBodies.includes('隧道回复：甲方问题'), 30_000);
    assert.equal(replied.phase, 'reply');
    assert.equal(replied.assistantBodies.length, 1, '旧结果不得占新槽');
    assert.equal(run.posts(), 2, '取消 + 重发必须恰 2 次 POST');
    assert.equal(bodyHash(run.fake, 1), bodyHash(run.fake, 0), '取消轮不得入史（同一文本必须同一请求体指纹）');
    if (proxy !== null) assert.equal(proxy.postCount, 2, '代理侧也只应看到 2 次 POST');

    // 基线：重发的成功回应动作。
    const reactionsBeforeLate = await observeReactions(run.cdp, 1200);

    // 旧结果晚到：释放被挂住的响应，等它进入终态。
    run.fake.release(0);
    const late = await run.fake.waitForCompletion(0, 15_000);
    assert.equal(late.clientAborted, true, '取消必须让 fake 观测到客户端在响应完成前断开');
    assert.equal(late.status === 'aborted' || late.status === 'completed-late' || late.status === 'write-failed', true, `迟到响应终态异常：${late.status}`);

    const afterLate = await readDom(run.cdp);
    assert.equal(afterLate.assistantBodies.length, 1, '旧结果晚到后仍只能有 1 条助手消息');
    assert.equal(afterLate.assistantBodies[0], '隧道回复：甲方问题', '旧结果不得覆盖或追加到新槽');
    assert.equal(afterLate.phase, 'reply');
    assert.notEqual(afterLate.feedbackKind, 'waiting', '旧结果晚到不得触发新的等待反馈');

    const reactionsAfterLate = await observeReactions(run.cdp, 1200);
    const newReactions = reactionsAfterLate.filter((item) => !reactionsBeforeLate.includes(item));
    assert.deepEqual(newReactions, [], `旧结果晚到不得触发新 reaction：${JSON.stringify({ reactionsBeforeLate, reactionsAfterLate })}`);

    // 新一句：成功轮必须入史 ⇒ 指纹与首轮不同。
    await typeAndSend(run, '乙方问题');
    await waitDom(run, '乙方回复未显示', (state) => state.assistantBodies.includes('隧道回复：乙方问题'), 30_000);
    assert.notEqual(bodyHash(run.fake, 2), bodyHash(run.fake, 0), '成功轮必须入史（请求体应带上历史）');
    assert.equal(run.posts(), 3, '三次业务发送恰 3 POST');

    // 上游断开：取消要贯穿网络（fake + 代理两侧都要有观测）。
    const fakeStats = run.fake.stats();
    assert.ok(fakeStats.aborted >= 1, `取消必须让 fake 观测到断开：${JSON.stringify(fakeStats)}`);
    if (proxy !== null) {
      const proxyStats = proxy.stats();
      assert.ok(proxyStats.abortedUpstream >= 1, `代理必须 abort 上游：${JSON.stringify(proxyStats)}`);
      assert.equal(proxyStats.postCount, 3, '代理侧无重试：恰 3 次 POST');
    }
    await recordArm(run);
    run.log(`ok fakestats=${JSON.stringify(fakeStats)} proxystats=${JSON.stringify(proxy?.stats() ?? null)}`);
  } finally {
    await run.stop();
  }
});

/* ===== ③ 隐藏期到 15s 总 deadline → 恢复 → 重发 ===== */

test('③ 隐藏期到真实 15s 总 deadline → 恢复 → 重发（恢复 0 POST、不补播反馈、失败不入史）', { timeout: 180_000 }, async (t) => {
  const support = await supportOrSkip(t);
  if (!support) return;
  const run = await openRun(support, ARM_MAIN, 'deadline');
  try {
    await run.fake.plan([{ mode: 'headers-sent' }, { mode: 'ok' }]);
    await openPanel(run);
    await recordArm(run);

    const sentAt = Date.now();
    await typeAndSend(run, '超时问题');
    await run.fake.waitForRequest(1, 15_000);
    const paused = await hideUntilPaused(run);

    // 唯一的真实 15s 期限（产品冻结值，不新增 timeout）：隐藏期间照样到点结算。
    const errored = await waitDom(
      run,
      '15s 总 deadline 未结算',
      (state) => state.phase === 'error' || state.errorMsgs.length > 0,
      TOTAL_TIMEOUT_MS + 10_000,
    );
    const elapsed = Date.now() - sentAt;
    assert.ok(elapsed >= TOTAL_TIMEOUT_MS - 1_000, `必须真等到 15s 期限，实测 ${elapsed}ms`);
    assert.ok(elapsed <= TOTAL_TIMEOUT_MS + 8_000, `超时结算明显晚于期限：${elapsed}ms`);
    assert.equal(errored.errorMsgs.some((text) => text.includes('发送失败（timeout）')), true, `错误必须可读且含 timeout：${errored.errorMsgs.join('|')}`);
    assert.equal(errored.errorMsgs.some((text) => text.includes('响应超时')), true, '错误必须带可行动中文提示');
    assert.equal(errored.assistantBodies.length, 0);

    // 恢复：0 次新 POST、不补播等待反馈。
    const postsBeforeShow = run.posts();
    await showUntilResumed(run, paused.pauseCount);
    assert.equal(run.posts(), postsBeforeShow, '恢复窗口本身不得产生 POST');
    const kinds: string[] = [];
    const windowEnd = Date.now() + 900;
    while (Date.now() < windowEnd) {
      kinds.push((await readDom(run.cdp)).feedbackKind);
      await delay(80);
    }
    assert.equal(kinds.includes('waiting'), false, `恢复后不得补播等待反馈：${kinds.join(',')}`);

    // 手动重发同一句：恰 1 POST；指纹与首轮相同 ⇒ 超时轮未入史。
    await typeAndSend(run, '超时问题');
    const replied = await waitDom(run, '超时后重发未成功', (state) => state.assistantBodies.includes('隧道回复：超时问题'), 30_000);
    assert.equal(replied.phase, 'reply');
    assert.equal(bodyHash(run.fake, 1), bodyHash(run.fake, 0), '超时轮不得入史（同一文本必须同一请求体指纹）');
    assert.equal(run.posts(), 2, '超时 + 手动重发恰 2 POST（无自动重试）');
    assert.ok(run.fake.stats().aborted >= 1, `15s 到期必须 abort 上游：${JSON.stringify(run.fake.stats())}`);
    await recordArm(run);
    run.log(`ok elapsed=${elapsed}ms posts=${run.posts()}`);
  } finally {
    await run.stop();
  }
});

/* ===== ④ 隐藏 reset → 迟到 → 新请求 ===== */

test('④ 隐藏 reset → 旧结果迟到 → 新请求：清展示、清历史、旧结果按 id 隔离', { timeout: 180_000 }, async (t) => {
  const support = await supportOrSkip(t);
  if (!support) return;
  const run = await openRun(support, ARM_MAIN, 'reset-late');
  try {
    await run.fake.plan([
      { mode: 'ok' }, // #0 探针（首轮必然无历史）
      { mode: 'headers-sent' }, // #1 在途时被 reset 取消
      { mode: 'ok' }, // #2 与 #0 同文本：证明 reset 清了历史
    ]);
    await openPanel(run);
    const { info } = await recordArm(run);
    assert.equal(info.context, true, 'reset 面需要 context=on');

    await typeAndSend(run, '探针问题');
    const first = await waitDom(run, '探针回复未显示', (state) => state.assistantBodies.includes('隧道回复：探针问题'), 30_000);
    assert.equal(first.assistantBodies.length, 1);
    const anchor = bodyHash(run.fake, 0);

    // 第二轮：历史确实生效（否则 #1 的指纹不会变）。
    await typeAndSend(run, '中途问题');
    await run.fake.waitForRequest(2, 15_000);
    assert.notEqual(bodyHash(run.fake, 1), anchor, '成功轮必须入史：第二轮请求体应比首轮更大（带历史）');
    const paused = await hideUntilPaused(run);

    // 隐藏中“新对话”：主进程取消在途 + 清空历史，页面清空展示。
    await clickTestId(run, 'reset');
    const cleared = await waitDom(run, 'reset 未清空展示', (state) => state.userMsgs.length === 0 && state.assistantBodies.length === 0, 10_000);
    assert.deepEqual(cleared.statusMsgs, ['已开启新对话（此前内容不再带入）']);

    // 旧结果迟到：释放被挂住的响应，等它进入终态后仍不得出现在 DOM。
    run.fake.release(1);
    const late = await run.fake.waitForCompletion(1, 15_000);
    assert.equal(late.clientAborted, true, 'reset 必须让 fake 观测到客户端在响应完成前断开');
    const lateDom = await readDom(run.cdp);
    assert.equal(lateDom.assistantBodies.length, 0, 'reset 后旧结果不得出现');
    assert.equal(lateDom.userMsgs.length, 0, 'reset 后旧问题不得回来');
    assert.notEqual(lateDom.phase, 'cancelled', '旧结果不得把状态带回取消态');

    await showUntilResumed(run, paused.pauseCount);

    // 新请求与首轮同文本：指纹相同 ⇒ 历史已清空，且被取消的 #1 未入史。
    await typeAndSend(run, '探针问题');
    const replied = await waitDom(run, 'reset 后新请求未成功', (state) => state.assistantBodies.includes('隧道回复：探针问题'), 30_000);
    assert.equal(replied.assistantBodies.length, 1);
    assert.equal(bodyHash(run.fake, 2), anchor, 'reset 必须清空历史（同一文本必须回到首轮请求体指纹）');
    assert.equal(run.posts(), 3, '三次业务发送恰 3 POST');
    await recordArm(run);
    run.log(`ok posts=${run.posts()}`);
  } finally {
    await run.stop();
  }
});

/* ===== ⑤ 上游连接重置 → 可读错误 → 手动重发 ===== */

test('⑤ 上游连接重置 → 可读错误 → 手动重发成功（无自动重试）', { timeout: 180_000 }, async (t) => {
  const support = await supportOrSkip(t);
  if (!support) return;
  const run = await openRun(support, ARM_MAIN, 'upstream-reset');
  try {
    await run.fake.plan([{ mode: 'reset' }, { mode: 'ok' }]);
    await openPanel(run);
    await recordArm(run);

    await typeAndSend(run, '断连问题');
    await run.fake.waitForRequest(1, 15_000);
    const paused = await hideUntilPaused(run);
    const failed = await waitDom(run, '连接重置未映射为可读错误', (state) => state.errorMsgs.length > 0, 20_000);
    assert.equal(failed.errorMsgs.some((text) => text.includes('发送失败（provider-error）')), true, `错误必须是可读中文 + 原始 code：${failed.errorMsgs.join('|')}`);
    assert.equal(failed.errorMsgs.some((text) => text.includes('服务不可用或连接已断开')), true);
    assert.equal(failed.assistantBodies.length, 0);
    assert.equal(run.posts(), 1, '失败本身不得触发自动重试');
    assert.equal(run.fake.requests[0]?.status, 'reset', 'fake 侧应记录到连接被重置');

    await showUntilResumed(run, paused.pauseCount);

    // 手动重发同一句：恰 1 POST；指纹与首轮相同 ⇒ 失败轮未入史。
    await typeAndSend(run, '断连问题');
    const replied = await waitDom(run, '手动重发未成功', (state) => state.assistantBodies.includes('隧道回复：断连问题'), 30_000);
    assert.equal(replied.phase, 'reply');
    assert.equal(bodyHash(run.fake, 1), bodyHash(run.fake, 0), '失败轮不得入史（同一文本必须同一请求体指纹）');
    assert.equal(run.posts(), 2, '失败 + 手动重发恰 2 POST');
    await recordArm(run);
    run.log(`ok posts=${run.posts()}`);
  } finally {
    await run.stop();
  }
});

/* ===== ⑥ 在途隐藏关窗 → 自然退出 ===== */

test('⑥ 在途隐藏关窗 → 自然退出（exit 0）、本次 PID 与调试端口消失、上游断开', { timeout: 180_000 }, async (t) => {
  const support = await supportOrSkip(t);
  if (!support) return;
  const run = await openRun(support, ARM_PROXIED, 'in-flight-quit');
  try {
    await run.fake.plan([{ mode: 'headers-sent' }]);
    await openPanel(run);
    await recordArm(run);

    await typeAndSend(run, '关窗时的问题');
    await run.fake.waitForRequest(1, 15_000);
    await hideUntilPaused(run);
    assert.equal(run.posts(), 1);

    await evaluate(run.cdp, 'window.pet.quit()');
    const exit = await run.entry.untilExit(20_000);
    assert.equal(exit.timedOut, false, '在途关窗必须自然退出，不得超时强杀');
    assert.equal(exit.exitCode, 0, `关窗退出码必须 0，实际 ${String(exit.exitCode)}；${run.output().slice(-1500)}`);

    const alive = await aliveTracked(run.entry);
    assert.deepEqual(alive, [], `本次进程树必须无残留：${JSON.stringify(alive)}`);
    assert.equal(await portListening(run.debugPort), false, '关窗后调试端口必须关闭');
    if (run.proxy !== null) assert.equal(run.proxy.postCount, 1, '关窗路径不得补发请求');

    // 上游：客户端在途断开，fake 与代理两侧都必须有观测。
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && abortedCount(run.fake) < 1) await delay(100);
    assert.ok(abortedCount(run.fake) >= 1, `在途关窗必须让 fake 观测到断开：${JSON.stringify(run.fake.stats())}`);
    if (run.proxy !== null) {
      const proxyStats = run.proxy.stats();
      assert.ok(proxyStats.abortedUpstream >= 1, `代理必须 abort 上游：${JSON.stringify(proxyStats)}`);
    }
    run.log(`ok exit=0 posts=${run.posts()} aborted=${abortedCount(run.fake)}`);
  } finally {
    await run.stop();
  }
});

/* ===== 标准 / context-off 成功对照 ===== */

test('对照 · context=off + 标准体验：成功链路不注入历史、无反馈节点、无回应动作', { timeout: 180_000 }, async (t) => {
  const support = await supportOrSkip(t);
  if (!support) return;
  const run = await openRun(support, ARM_CONTROL, 'control-off');
  try {
    await run.fake.plan([{ mode: 'delay', delayMs: 2000 }, { mode: 'ok' }]);
    const opened = await openPanel(run);
    const { info } = await recordArm(run);
    assert.equal(opened.experience, '', '标准体验不得写 dataset.experience');
    assert.equal(info.context, false, '对照臂必须是 context=off');
    assert.equal(opened.rects.reset.found, false, 'context=off 不得渲染“新对话”');
    assert.equal(opened.feedbackKind, 'absent', '标准体验不得有反馈节点');

    await typeAndSend(run, '对照一句话');
    await run.fake.waitForRequest(1, 15_000);
    const paused = await hideUntilPaused(run);
    const replied = await waitDom(run, '对照回复未显示', (state) => state.assistantBodies.includes('隧道回复：对照一句话'), 30_000);
    assert.equal(replied.phase, 'reply');
    assert.equal(replied.feedbackKind, 'absent');

    const reactions = await observeReactions(run.cdp, 1500);
    assert.deepEqual(reactions, [], `标准体验不得触发回应动作：${JSON.stringify(reactions)}`);

    const postsBeforeShow = run.posts();
    await showUntilResumed(run, paused.pauseCount);
    assert.equal(run.posts(), postsBeforeShow, '对照臂恢复不得产生 POST');

    // context=off：同一句再发一次，请求体必须逐字节相同（指纹相等）⇒ 没有历史注入。
    await typeAndSend(run, '对照一句话');
    await waitDom(run, '对照第二句未显示', (state) => state.assistantBodies.length === 2, 30_000);
    assert.equal(bodyHash(run.fake, 1), bodyHash(run.fake, 0), '关闭上下文时不得注入历史');
    assert.equal(run.posts(), 2, '两次业务发送恰 2 POST');
    await recordArm(run);
    run.log(`ok control posts=${run.posts()}`);
  } finally {
    await run.stop();
  }
});

