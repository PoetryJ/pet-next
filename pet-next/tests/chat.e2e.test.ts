/**
 * M3-0 聊天预览 E2E：真实 Electron（Xvfb :94）+ 本地 fake HTTP（tests/support/chat-fake-server.ts）。
 * 覆盖：面板挂载/发送回复显示（演示回复标注）、500 错误恢复、取消慢回复（旧迟到回复不显示）、
 * 在途关面板/关窗（连接撤销+进程无残留）、未开预览不挂面板（回归门）。
 * 运行：node --experimental-strip-types --test --test-reporter spec tests/chat.e2e.test.ts
 * 前提：pnpm build；data-testid 契约与原始记录见 tests/chat-evidence/RUN-NOTES.txt。
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pidIsAlive } from './support/process-table.ts';
import { startTrackedRun, type TrackedRun } from './support/tracked-run.ts';
import { startChatFakeServer } from './support/chat-fake-server.ts';

const petRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(path.join(petRoot, 'package.json'));
const electronPath = require('electron') as string;
const mainPath = path.join(petRoot, 'dist/electron/main.js');

// 独占 :94（团队约定；:99/:95 归他人）。已有 socket 则复用，只有自己拉起的才负责收掉。
const display = process.env.PET_NEXT_E2E_DISPLAY ?? ':94';
const displaySocket = `/tmp/.X11-unix/X${display.slice(1)}`;
const CHAT_ID_PATTERN = /^chat-[a-z0-9-]{1,48}$/;

let xvfb: ChildProcess | undefined;
let ownsXvfb = false;
let displayReady = false;

interface ChatPageState {
  hasPanel: boolean;
  /** 面板根的 data-state：closed/open/typing/pending/reply/error/cancelled。 */
  phase: string;
  isOpen: boolean;
  hasToggle: boolean;
  hasInput: boolean;
  inputValue: string | null;
  sendDisabled: boolean | null;
  hasCancel: boolean;
  cancelDisabled: boolean | null;
  hasClose: boolean;
  userMsgs: string[];
  assistantMsgs: string[];
  errorMsgs: string[];
  status: string;
  petQuit: boolean;
}

interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

interface ChatApp {
  child: ChildProcess;
  tracked: TrackedRun;
  userData: string;
  stdout(): string;
  stderr(): string;
  cdp: Cdp;
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

function tail(text: string, max = 1500): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
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
    const poll = () => {
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
  if (!existsSync(mainPath)) return; // 由 ensure() 统一按 not-run 跳过
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

function ensure(t: { skip(message?: string): unknown }): boolean {
  if (!existsSync(mainPath)) {
    t.skip('not-run: dist/electron/main.js 不存在，先 pnpm build');
    return false;
  }
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

function waitForReady(tracked: TrackedRun): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`ready timeout\nstdout:\n${tail(tracked.stdout())}\nstderr:\n${tail(tracked.stderr())}`));
    }, 20000);
    const poll = () => {
      if (jsonObjects(tracked.stdout()).some((item) => item.event === 'ready')) {
        clearTimeout(timer);
        resolve();
        return;
      }
      if (tracked.child.exitCode !== null) {
        clearTimeout(timer);
        reject(new Error(`electron exited ${tracked.child.exitCode}\nstdout:\n${tail(tracked.stdout())}\nstderr:\n${tail(tracked.stderr())}`));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

async function launchChat(options: { label: string; fakeUrl?: string; chatPreview?: boolean }): Promise<ChatApp> {
  const userData = await mkdtemp(path.join(tmpdir(), 'pet-next-chat-e2e-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: display, PET_NEXT_TEST: '1', PET_NEXT_USER_DATA: userData };
  if ((options.chatPreview ?? true) && options.fakeUrl !== undefined) {
    env.PET_NEXT_CHAT_PREVIEW = '1';
    env.PET_NEXT_CHAT_FAKE_URL = options.fakeUrl;
  }
  const tracked = startTrackedRun({
    executable: electronPath,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--force-device-scale-factor=1',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${port}`,
      mainPath,
    ],
    cwd: petRoot,
    env,
    label: options.label,
    logRoot: path.join(petRoot, 'logs', 'platform-runs'),
  });
  try {
    await waitForReady(tracked);
    const socket = await waitForPageSocket(port);
    const cdp = await connectCdp(socket);
    return { child: tracked.child, tracked, userData, stdout: () => tracked.stdout(), stderr: () => tracked.stderr(), cdp };
  } catch (error) {
    try {
      await tracked.stop();
      await tracked.writeRecord();
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
    throw error;
  }
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

/** 页面侧读取面板状态：data-testid 优先，class 兜底（与 C 的 m3c-panel class 命名一致）。 */
function chatStateExpression(): string {
  return `(() => {
  const by = (id, cls) => document.querySelector('[data-testid="' + id + '"]') ?? document.querySelector(cls);
  const texts = (sel) => Array.from(document.querySelectorAll(sel)).map((el) => el.textContent ?? '');
  const root = by('chat-panel', '.chat-panel-root');
  const panelBody = by('chat-panel-open', '.chat-panel');
  const input = by('chat-input', '.chat-input');
  const send = by('chat-send', '.chat-send');
  const cancel = by('chat-cancel', '.chat-cancel');
  return {
    hasPanel: root instanceof HTMLElement,
    phase: root instanceof HTMLElement ? (root.dataset.state ?? '') : '',
    isOpen: panelBody instanceof HTMLElement ? !panelBody.hidden : false,
    hasToggle: by('chat-toggle', '.chat-toggle') instanceof HTMLElement,
    hasInput: input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement,
    inputValue: input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement ? input.value : null,
    sendDisabled: send instanceof HTMLButtonElement ? send.disabled === true : null,
    hasCancel: cancel instanceof HTMLElement,
    cancelDisabled: cancel instanceof HTMLButtonElement ? cancel.disabled === true : null,
    hasClose: by('chat-close', '.chat-close') instanceof HTMLElement,
    userMsgs: texts('[data-testid="chat-msg-user"], .chat-entry-user'),
    assistantMsgs: texts('[data-testid="chat-msg-assistant"], .chat-entry-bot'),
    errorMsgs: texts('[data-testid="chat-msg-error"], .chat-entry-error'),
    status: texts('[data-testid="chat-status"], .chat-entry-status').join(' | ').trim(),
    petQuit: typeof window.pet?.quit === 'function',
  };
})()`;
}

function chatTypeExpression(text: string): string {
  return `(() => {
  const el = document.querySelector('[data-testid="chat-input"]');
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return { ok: false, reason: 'no-input' };
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) return { ok: false, reason: 'no-setter' };
  setter.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return { ok: true, value: el.value };
})()`;
}

function chatClickExpression(testId: string): string {
  return `(() => {
  const el = document.querySelector('[data-testid="${testId}"]') ?? document.querySelector('.${testId}');
  if (el instanceof HTMLElement) {
    el.click();
    return 'clicked';
  }
  if ('${testId}' === 'chat-send') {
    const input = document.querySelector('[data-testid="chat-input"]') ?? document.querySelector('.chat-input');
    const form = input instanceof HTMLElement ? input.form : null;
    if (form instanceof HTMLFormElement) {
      form.requestSubmit();
      return 'form-submit';
    }
  }
  return 'missing';
})()`;
}

/** 面板初始为收起态：先等挂载，再点 chat-toggle 打开。 */
async function openChatPanel(app: ChatApp): Promise<ChatPageState> {
  await waitForChat(app, 'chat=preview 面板未挂载（接线未合入或 PET_NEXT_CHAT_PREVIEW 未生效）', (state) => state.hasPanel);
  const before = await readChat(app);
  if (!before.isOpen) {
    const clicked = await evaluate<string>(app.cdp, chatClickExpression('chat-toggle'));
    assert.equal(clicked, 'clicked', `面板开关按钮不可用：${clicked}`);
  }
  return waitForChat(app, '面板打开失败', (state) => state.isOpen && state.phase !== 'closed' && state.hasInput);
}

async function readChat(app: ChatApp): Promise<ChatPageState> {
  return evaluate<ChatPageState>(app.cdp, chatStateExpression());
}

async function waitForChat(
  app: ChatApp,
  label: string,
  ok: (state: ChatPageState) => boolean,
  timeoutMs = 20000,
): Promise<ChatPageState> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const state = await readChat(app);
    if (ok(state)) return state;
    last = JSON.stringify(state);
    await delay(60);
  }
  throw new Error(`${label}\nstate=${last}\nstdout=${tail(app.stdout())}\nstderr=${tail(app.stderr())}`);
}

async function typeAndSend(app: ChatApp, text: string): Promise<void> {
  const typed = await evaluate<{ ok: boolean; reason?: string; value?: string }>(app.cdp, chatTypeExpression(text));
  assert.equal(typed.ok, true, `输入框不可写：${JSON.stringify(typed)}`);
  assert.equal(typed.value, text, `输入回读不一致：${JSON.stringify(typed)}`);
  await waitForChat(app, '合法输入后发送按钮应可用', (state) => state.sendDisabled === false, 5000);
  const clicked = await evaluate<string>(app.cdp, chatClickExpression('chat-send'));
  assert.ok(clicked === 'clicked' || clicked === 'form-submit', `发送按钮不可用：${clicked}`);
}

function isErrorShown(state: ChatPageState): boolean {
  return state.errorMsgs.length > 0 || /错误|失败|error/i.test(state.status);
}

function isCancelledShown(state: ChatPageState): boolean {
  return /取消|cancel/i.test(state.status) || state.errorMsgs.some((msg) => /取消|cancel/i.test(msg));
}

async function waitUntilTrackedGone(tracked: TrackedRun, timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = tracked.trackedPids().filter((pid) => pidIsAlive(pid));
  while (alive.length > 0 && Date.now() < deadline) {
    await delay(30);
    alive = tracked.trackedPids().filter((pid) => pidIsAlive(pid));
  }
  return alive;
}

async function shutdownApp(app: ChatApp | undefined): Promise<void> {
  if (!app) return;
  try {
    app.cdp.close();
  } catch {
    // 调试连接可能已经随退出关掉。
  }
  try {
    await app.tracked.stop();
    await app.tracked.writeRecord();
  } finally {
    await rm(app.userData, { recursive: true, force: true });
  }
}

async function quitApp(app: ChatApp): Promise<void> {
  try {
    await evaluate(app.cdp, 'window.pet.quit()');
  } catch {
    try {
      await app.cdp.send('Browser.close');
    } catch {
      // 两条路都不通时由 tracked.stop 兜底，退出码断言会如实失败。
    }
  }
}

test('聊天预览：打开面板→输入→发送→fake 回复显示（含演示回复标注）', { timeout: 120000 }, async (t) => {
  if (!ensure(t)) return;
  const fake = await startChatFakeServer({ mode: 'ok', delayMs: 0 });
  let app: ChatApp | undefined;
  try {
    app = await launchChat({ label: 'chat-e2e-open', fakeUrl: fake.url });
    await openChatPanel(app);

    await typeAndSend(app, '你好桌面宠物');
    const replied = await waitForChat(app, '回复未显示', (state) =>
      state.assistantMsgs.some((msg) => msg.includes('演示回复') && msg.includes('你好桌面宠物')),
    );
    assert.ok(replied.userMsgs.some((msg) => msg.includes('你好桌面宠物')), '用户消息未上屏');

    const fakeState = fake.state();
    assert.equal(fakeState.requests.length, 1, `fake 应收到 1 条请求：${JSON.stringify(fakeState.requests)}`);
    const request = fakeState.requests[0];
    assert.match(request?.id ?? '', CHAT_ID_PATTERN, '请求 id 不符合冻结协议形状');
    assert.equal(request?.text, '你好桌面宠物');
    assert.ok(request?.respondedAt !== null && request.respondedAt !== undefined, 'fake 应已产出响应');
  } finally {
    await shutdownApp(app);
    await fake.stop();
  }
});

test('聊天预览：fake 返回 500→面板报错→恢复后再发成功', { timeout: 120000 }, async (t) => {
  if (!ensure(t)) return;
  const fake = await startChatFakeServer({ mode: 'error', status: 500, delayMs: 0 });
  let app: ChatApp | undefined;
  try {
    app = await launchChat({ label: 'chat-e2e-error', fakeUrl: fake.url });
    await openChatPanel(app);

    await typeAndSend(app, '这句会失败');
    await waitForChat(app, '500 后面板应显示错误', isErrorShown);
    let fakeState = fake.state();
    assert.equal(fakeState.requests.length, 1);
    assert.equal(fakeState.requests[0]?.mode, 'error');

    fake.config({ mode: 'ok', delayMs: 0 });
    await typeAndSend(app, '恢复后的这句');
    await waitForChat(app, '恢复后新回复未显示', (state) =>
      state.assistantMsgs.some((msg) => msg.includes('演示回复') && msg.includes('恢复后的这句')),
    );
    fakeState = fake.state();
    assert.equal(fakeState.requests.length, 2, 'fake 应收到两条请求');
    assert.equal(fakeState.requests[1]?.mode, 'ok');
  } finally {
    await shutdownApp(app);
    await fake.stop();
  }
});

test('聊天预览：取消慢回复→显示已取消→立即再发成功且旧迟到回复不显示（核心断言）', { timeout: 180000 }, async (t) => {
  if (!ensure(t)) return;
  const fake = await startChatFakeServer({ mode: 'ok', delayMs: 3000 });
  let app: ChatApp | undefined;
  try {
    app = await launchChat({ label: 'chat-e2e-cancel', fakeUrl: fake.url });
    await openChatPanel(app);

    // 旧请求：3s 慢回复。
    await typeAndSend(app, '慢速第一句');
    const firstId = (await fake.waitFor((state) => state.requests.length >= 1, 8000, 'fake 未收到第一句')).requests[0]?.id ?? '';
    assert.match(firstId, CHAT_ID_PATTERN);
    await waitForChat(app, '在途时取消按钮应可用', (state) => state.phase === 'pending' && state.cancelDisabled === false);

    const cancelled = await evaluate<string>(app.cdp, chatClickExpression('chat-cancel'));
    assert.equal(cancelled, 'clicked', `取消按钮不可用：${cancelled}`);
    await waitForChat(app, '取消后面板应显示已取消', isCancelledShown);
    // 契约：signal 触发后 Provider 必须停止——fake 侧应观察到连接断开。
    await fake.waitFor(
      (state) => state.requests.some((item) => item.id === firstId && item.clientClosed),
      8000,
      '取消未撤销 fake 侧连接',
    );

    // 立即再发新请求（fake 切回快回复；旧请求参数在收到时已快照，不受影响）。
    fake.config({ mode: 'ok', delayMs: 0 });
    await typeAndSend(app, '第二句立刻回');
    await waitForChat(app, '取消后立即再发的新回复未显示', (state) =>
      state.assistantMsgs.some((msg) => msg.includes('演示回复') && msg.includes('第二句立刻回')),
    );
    const fakeState = fake.state();
    assert.equal(fakeState.requests.length, 2);
    assert.notEqual(fakeState.requests[1]?.id, firstId, '两次请求的 id 应不同');
    assert.ok(fakeState.requests[1]?.respondedAt != null, '新请求应已回复');

    // 核心：等旧请求的迟到响应在 fake 侧产出（3s 到点），再留缓冲，旧回复仍不得上屏。
    await fake.waitFor(
      (state) => state.requests.some((item) => item.id === firstId && item.respondedAt !== null),
      6000,
      '旧请求的迟到响应未在 fake 侧产出',
    );
    await delay(1000);
    const finalState = await readChat(app);
    assert.equal(
      finalState.assistantMsgs.some((msg) => msg.includes('慢速第一句')),
      false,
      `旧迟到回复泄漏上屏：${JSON.stringify(finalState.assistantMsgs)}`,
    );
    assert.ok(
      finalState.assistantMsgs.some((msg) => msg.includes('第二句立刻回')),
      '新回复应保持显示',
    );
  } finally {
    await shutdownApp(app);
    await fake.stop();
  }
});

test('聊天预览：在途时关面板/关窗→fake 观察连接断开，Electron 退出无残留', { timeout: 180000 }, async (t) => {
  if (!ensure(t)) return;
  const fake = await startChatFakeServer({ mode: 'ok', delayMs: 5000 });
  let app: ChatApp | undefined;
  try {
    app = await launchChat({ label: 'chat-e2e-close', fakeUrl: fake.url });
    await openChatPanel(app);

    await typeAndSend(app, '关窗前在途这句');
    const firstId = (await fake.waitFor((state) => state.requests.length >= 1, 8000, 'fake 未收到在途请求')).requests[0]?.id ?? '';

    // 有面板关闭按钮则先关面板（App 仍存活），请求应被撤销——fake 观察到连接断开。
    const state = await readChat(app);
    if (state.hasClose) {
      const clicked = await evaluate<string>(app.cdp, chatClickExpression('chat-close'));
      assert.equal(clicked, 'clicked', `面板关闭按钮不可用：${clicked}`);
      await waitForChat(app, '关面板后应进入已收起态', (page) => !page.isOpen, 5000);
      await fake.waitFor(
        (snapshot) => snapshot.requests.some((item) => item.id === firstId && item.clientClosed),
        8000,
        '关面板后请求未被撤销（fake 未观察到连接断开）',
      );
    }

    await quitApp(app);
    const exitCode = await new Promise<number | null>((resolve) => {
      if (app && app.child.exitCode !== null) {
        resolve(app.child.exitCode);
        return;
      }
      app?.child.once('exit', (code) => resolve(code));
    });
    assert.equal(exitCode, 0, `关窗后退出码应为 0\nstdout=${tail(app?.stdout() ?? '')}\nstderr=${tail(app?.stderr() ?? '')}`);
    const leftovers = await waitUntilTrackedGone(app.tracked, 5000);
    assert.deepEqual(leftovers, [], `有残留进程：${JSON.stringify(leftovers)}`);
    assert.equal(pidIsAlive(app.child.pid ?? -1), false);
    // 关窗路径同样必须撤下在途请求：进程死亡断开 socket，fake 应观察到。
    await fake.waitFor(
      (snapshot) => snapshot.requests.some((item) => item.id === firstId && item.clientClosed),
      8000,
      '关窗后 fake 未观察到连接断开',
    );
  } finally {
    await shutdownApp(app);
    await fake.stop();
  }
});

test('回归门：未设 PET_NEXT_CHAT_PREVIEW 时不挂聊天面板，pet 仍可退出', { timeout: 90000 }, async (t) => {
  if (!ensure(t)) return;
  let app: ChatApp | undefined;
  try {
    app = await launchChat({ label: 'chat-e2e-gate', chatPreview: false });
    const state = await waitForChat(app, '页面未就绪', (page) => page.petQuit === true);
    assert.equal(state.hasPanel, false, '未开预览时不应挂载聊天面板');
    assert.equal(state.hasInput, false);
    await quitApp(app);
    const exitCode = await new Promise<number | null>((resolve) => {
      if (app && app.child.exitCode !== null) {
        resolve(app.child.exitCode);
        return;
      }
      app?.child.once('exit', (code) => resolve(code));
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(await waitUntilTrackedGone(app.tracked, 5000), []);
  } finally {
    await shutdownApp(app);
  }
});
