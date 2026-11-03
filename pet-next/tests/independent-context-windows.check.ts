/**
 * M3-3 上下文预览 E2E（正式入口 chat:local + fake 模型服务，零真实推理）：
 * 只走 `pnpm chat:local`，服务地址指向本用例自起的 fake-model-service（NDJSON 记录完整请求体）。
 *
 * 两臂对照：
 *   T1 PET_NEXT_CHAT_CONTEXT=1：两轮对话 → 第二个请求体必须携带第一轮 user/assistant（system 在最前）；
 *      点「新对话」（真实鼠标）→ 展示清空 → 第三轮请求体回到单轮形态（无任何旧轮次）。
 *   T2 缺省（不设变量）：两轮对话 → 两个请求体均为 [system,user] 单轮形态、无 assistant 消息；
 *      面板无「新对话」按钮、dataset.context=off（与 M3-1 行为一致的回归证明）。
 *
 * 交互一律真实输入事件（CDP Input.*）；DOM 只读。fake 回复格式 `隧道回复：<前24字>`，输入保持短文本。
 * 运行：node --experimental-strip-types --test --test-concurrency=1 --test-reporter spec tests/chat-context.e2e.test.ts
 * 团队约定：独占 :94（与 chat.e2e 同族，verify 串行）。证据：tests/chat-evidence/context/。
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const evidenceDir = path.join(petRoot, 'tests/chat-evidence/context-live/win');
const display = process.env.PET_NEXT_E2E_DISPLAY ?? ':94';
const displaySocket = `/tmp/.X11-unix/X${display.startsWith(':') ? display.slice(1) : display}`;

let xvfb: ChildProcess | undefined;
let ownsXvfb = false;
let displayReady = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort(): Promise<number> {
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

/** 与 chat.e2e 相同的定位方式：node 24 自带 pnpm 同目录。 */
function pnpmPath(): string {
  const beside = path.join(path.dirname(process.execPath), 'pnpm');
  return existsSync(beside) ? beside : 'pnpm';
}

function startFakeModel(logFile: string): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    let out = '';
    const child = spawn(process.execPath, [path.join(petRoot, 'tests/support/fake-model-service.mjs')], {
      cwd: petRoot,
      env: { ...process.env, FAKE_MODEL_LOG: logFile },
    });
    const timer = setTimeout(() => reject(new Error(`fake 模型服务未就绪：${out}`)), 10000);
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
      const line = out.split('\n').find((item) => item.includes('fake-model-ready'));
      if (line === undefined) return;
      clearTimeout(timer);
      try {
        const record = JSON.parse(line.slice(line.indexOf('{'))) as { port: number };
        resolve({ child, port: record.port });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.once('exit', () => clearTimeout(timer));
  });
}

before(async () => {
  if (process.platform === 'win32') {
    displayReady = true;
    return;
  }
  if (existsSync(displaySocket)) {
    displayReady = true;
    return;
  }
  xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  ownsXvfb = true;
  const deadline = Date.now() + 8000;
  while (!existsSync(displaySocket) && Date.now() < deadline) await delay(100);
  displayReady = existsSync(displaySocket);
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
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed');
  }
  return result.result?.value as T;
}

interface DomState {
  hasPanel: boolean;
  context: string;
  phase: string;
  userMsgs: string[];
  assistantMsgs: string[];
  statusMsgs: string[];
  inputValue: string | null;
  hasReset: boolean;
  rects: { toggle: Rect; input: Rect; send: Rect; reset: Rect };
}

interface Rect {
  found: boolean;
  visible: boolean;
  cx: number;
  cy: number;
  disabled: boolean | null;
}

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
  const texts = (selector) => Array.from(document.querySelectorAll(selector)).map((n) => (n.textContent ?? '').trim());
  const root = document.querySelector('[data-testid="chat-panel"]');
  const panel = document.querySelector('[data-testid="chat-panel-open"]');
  const input = document.querySelector('[data-testid="chat-input"]');
  return {
    hasPanel: root !== null,
    context: root instanceof HTMLElement ? (root.dataset.context ?? '') : '',
    phase: root instanceof HTMLElement ? (root.dataset.state ?? '') : '',
    panelHidden: panel instanceof HTMLElement ? panel.hidden : null,
    userMsgs: texts('[data-testid="chat-msg-user"]'),
    assistantMsgs: texts('[data-testid="chat-msg-assistant"]'),
    statusMsgs: texts('[data-testid="chat-status"]'),
    inputValue: input instanceof HTMLTextAreaElement ? input.value : null,
    hasReset: document.querySelector('[data-testid="chat-reset"]') !== null,
    rects: {
      toggle: read('[data-testid="chat-toggle"]'),
      input: read('[data-testid="chat-input"]'),
      send: read('[data-testid="chat-send"]'),
      reset: read('[data-testid="chat-reset"]'),
    },
  };
})()`;

async function readDom(cdp: Cdp): Promise<DomState> {
  return evaluate<DomState>(cdp, DOM_EXPRESSION);
}

async function waitDom(cdp: Cdp, label: string, ok: (state: DomState) => boolean, timeoutMs: number, note: string): Promise<DomState> {
  const deadline = Date.now() + timeoutMs;
  let last: DomState | undefined;
  while (Date.now() < deadline) {
    last = await readDom(cdp);
    if (ok(last)) return last;
    await delay(60);
  }
  throw new Error(`${label}（${timeoutMs}ms 超时）${note}\nlast=${JSON.stringify(last)}`);
}

async function clickRect(cdp: Cdp, rect: Rect): Promise<void> {
  const x = Math.round(rect.cx);
  const y = Math.round(rect.cy);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await delay(20);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function typeAndSend(cdp: Cdp, text: string, evidence: string[]): Promise<void> {
  const ready = await waitDom(cdp, '输入框未就绪', (s) => s.rects.input.found && s.rects.input.visible, 8000, `send ${text}`);
  await clickRect(cdp, ready.rects.input);
  // 面板发送后草稿保留（既有行为）：先全选再插入，保证替换而非追加。
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  await cdp.send('Input.insertText', { text });
  // 空输入时发送按钮本就禁用：插入文本后才应变为可用。
  await waitDom(cdp, '输入回读/发送按钮未就绪', (s) => s.inputValue === text && s.rects.send.disabled === false, 8000, `send ${text}`);
  await clickRect(cdp, ready.rects.send);
  evidence.push(`send: ${text}`);
}

interface FakeRequest {
  bytes: number;
  body: { messages: Array<{ role: string; content: string }> };
}

function readRequests(logFile: string): FakeRequest[] {
  if (!existsSync(logFile)) return [];
  const rows: FakeRequest[] = [];
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line) as { body?: FakeRequest['body']; bytes?: number };
      if (value.body && Array.isArray(value.body.messages)) rows.push({ bytes: value.bytes ?? 0, body: value.body });
    } catch {
      /* 半行忽略 */
    }
  }
  return rows;
}

interface Evidence {
  lines: string[];
  log(line: string): void;
}

function createEvidence(_name: string): Evidence {
  const lines: string[] = [];
  return {
    lines,
    log(line: string): void {
      lines.push(line);
      console.log(`[evidence] ${line}`);
    },
  };
}

async function flushEvidence(evidence: Evidence, name: string): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, `${name}.txt`), `${[`# M3-3 E2E ${name}`, `# ${new Date().toISOString()}`, '', ...evidence.lines].join('\n')}\n`);
}

/** 启动 chat:local（指向 fake），接管 CDP；返回句柄与退出等待。 */
async function launchLocal(options: { context: boolean; label: string; evidence: Evidence }): Promise<{
  cdp: Cdp;
  fake: { child: ChildProcess; port: number };
  entry: ChildProcess;
  logFile: string;
  userData: string;
  stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}> {
  const userData = await mkdtemp(path.join(tmpdir(), 'pet-next-ctx-e2e-'));
  const logFile = path.join(userData, 'requests.ndjson');
  const fake = await startFakeModel(logFile);
  const debugPort = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: display };
  delete env.PET_NEXT_CHAT_LOCAL;
  delete env.PET_NEXT_CHAT_PREVIEW;
  delete env.PET_NEXT_CHAT_CONTEXT;
  if (options.context) env.PET_NEXT_CHAT_CONTEXT = '1';
  env.PET_NEXT_QWEN_BASE_URL = `http://127.0.0.1:${fake.port}/v1`;
  env.PET_NEXT_QWEN_MODEL = 'qwen3.8-27b';
  env.PET_NEXT_CHAT_DEBUG_PORT = String(debugPort);
  env.PET_NEXT_USER_DATA = userData;
  options.evidence.log(
    `cmd: DISPLAY=${display} PET_NEXT_QWEN_BASE_URL=${env.PET_NEXT_QWEN_BASE_URL} PET_NEXT_CHAT_CONTEXT=${options.context ? '1' : '<unset>'} pnpm chat:local`,
  );
  const entry = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/c', 'pnpm chat:local'], { cwd: petRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(pnpmPath(), ['chat:local'], { cwd: petRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  entry.stdout?.on('data', (chunk) => {
    out += String(chunk);
  });
  entry.stderr?.on('data', (chunk) => {
    err += String(chunk);
  });
  // 等 CDP page 暴露
  const deadline = Date.now() + 150000;
  let socket: string | null = null;
  while (Date.now() < deadline && socket === null) {
    if (entry.exitCode !== null || entry.signalCode !== null) {
      throw new Error(`入口提前退出 code=${entry.exitCode}\nstdout:${out}\nstderr:${err}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const list = (await response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
      socket = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? null;
    } catch {
      /* 未就绪 */
    }
    if (socket === null) await delay(150);
  }
  if (socket === null) throw new Error(`CDP 未就绪\nstdout:${out}\nstderr:${err}`);
  const cdp = await connectCdp(socket);
  const stop = async (): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
    cdp.close();
    if (process.platform === 'win32' && entry.exitCode === null && entry.signalCode === null && entry.pid !== undefined) {
      try {
        execFileSync('taskkill', ['/PID', String(entry.pid), '/T', '/F'], { windowsHide: true });
      } catch {
        /* 已退出则忽略 */
      }
    }
    if (entry.exitCode === null) {
      entry.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        entry.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (entry.exitCode === null) entry.kill('SIGKILL');
    }
    fake.child.kill('SIGTERM');
    // 原始请求 NDJSON 是对照证据：清理临时 userData 前先落到持久证据目录（M3-4 要求）。
    if (existsSync(logFile)) {
      try {
        const keepDir = path.join(petRoot, 'tests/chat-evidence/context-live', options.label);
        await mkdir(keepDir, { recursive: true });
        await copyFile(logFile, path.join(keepDir, 'requests.ndjson'));
        await writeFile(
          path.join(keepDir, 'meta.txt'),
          `label=${options.label}\ncontext=${options.context ? 'on' : 'off'}\ncopiedAt=${new Date().toISOString()}\nsource=${logFile}\n`,
        );
      } catch (error) {
        console.error(`[context-live] 证据落盘失败（不阻塞清理）：${String(error)}`);
      }
    }
    await rm(userData, { recursive: true, force: true }).catch(() => undefined);
    return { code: entry.exitCode, signal: entry.signalCode };
  };
  return { cdp, fake, entry, logFile, userData, stop };
}

async function quitByApi(cdp: Cdp): Promise<void> {
  try {
    const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, `before-quit-${Date.now()}.png`), Buffer.from(shot.data, 'base64'));
  } catch {
    /* 截图失败不阻塞退出 */
  }
  await evaluate(cdp, 'window.pet.quit()');
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`入口 ${timeoutMs}ms 内未退出`)), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? null, signal: signal ?? null });
    });
  });
}

async function openPanel(cdp: Cdp, evidence: Evidence): Promise<DomState> {
  const mounted = await waitDom(cdp, '聊天面板未挂载（local 模式未接通）', (s) => s.hasPanel, 60000, 'openPanel');
  evidence.log(`panel mounted: phase=${mounted.phase} context=${mounted.context}`);
  const toggle = await waitDom(cdp, '面板开关未就绪', (s) => s.rects.toggle.found && s.rects.toggle.visible, 10000, 'openPanel');
  await clickRect(cdp, toggle.rects.toggle);
  const opened = await waitDom(cdp, '点击开关后面板未打开', (s) => s.rects.input.found && s.rects.input.visible, 10000, 'openPanel');
  evidence.log(`panel open: context=${opened.context} hasReset=${String(opened.hasReset)}`);
  return opened;
}

async function waitReply(cdp: Cdp, needle: string): Promise<DomState> {
  return waitDom(cdp, `回复未显示：${needle}`, (s) => s.assistantMsgs.some((msg) => msg.includes(needle)), 30000, 'waitReply');
}

test('T1 PET_NEXT_CHAT_CONTEXT=1：第二问携带第一轮，新对话后回到单轮（退出码 0）', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip(`not-run: Xvfb ${display} 起不来（无显示环境）`);
  const evidence = createEvidence('t1-context-on');
  let handle: Awaited<ReturnType<typeof launchLocal>> | undefined;
  try {
    handle = await launchLocal({ context: true, label: 'ctx-on', evidence });
    const { cdp } = handle;
    await openPanel(cdp, evidence);
    assert.equal((await readDom(cdp)).context, 'on', 'dataset.context 必须为 on');
    assert.equal((await readDom(cdp)).hasReset, true, 'context=on 必须渲染「新对话」按钮');

    await typeAndSend(cdp, '我叫小林', evidence.lines);
    await waitReply(cdp, '隧道回复：我叫小林');
    await typeAndSend(cdp, '我叫什么名字', evidence.lines);
    const second = await waitReply(cdp, '隧道回复：我叫什么名字');
    assert.ok(second.assistantMsgs.some((msg) => msg.includes('隧道回复：我叫小林')), '第一轮回复必须保持显示');

    const requests = readRequests(handle.logFile);
    assert.equal(requests.length, 2, `应恰好发出 2 个请求，实际 ${requests.length}`);
    evidence.log(`request[0].bytes=${requests[0]?.bytes} request[1].bytes=${requests[1]?.bytes}`);
    const first = requests[0]?.body.messages ?? [];
    const msgs = requests[1]?.body.messages ?? [];
    assert.equal(first.length, 2, '第一问必须是 [system,user]');
    assert.equal(first[0]?.role, 'system');
    assert.equal(first[1]?.content, '我叫小林');
    assert.deepEqual(
      msgs.map((m) => m.role),
      ['system', 'user', 'assistant', 'user'],
      '第二问消息序列必须为 system → 历史 user/assistant → 当前 user',
    );
    assert.equal(msgs[1]?.content, '我叫小林');
    assert.equal(msgs[2]?.content, '隧道回复：我叫小林', '历史 assistant 必须是已交付界面的完整回复');
    assert.equal(msgs[3]?.content, '我叫什么名字');
    assert.ok((requests[1]?.bytes ?? 0) > (requests[0]?.bytes ?? 0), '请求体字节必须增长');
    evidence.log(`history injected: ${JSON.stringify(msgs.slice(1, 3))}`);

    // 点「新对话」（真实鼠标）→ 展示清空 → 第三问回到单轮
    const resettable = await waitDom(cdp, '新对话按钮未就绪', (s) => s.rects.reset.found && s.rects.reset.visible, 8000, 'reset');
    await clickRect(cdp, resettable.rects.reset);
    const cleared = await waitDom(
      cdp,
      '点新对话后未清空',
      (s) => s.userMsgs.length === 0 && s.statusMsgs.some((msg) => msg.includes('已开启新对话')),
      8000,
      'reset',
    );
    assert.equal(cleared.assistantMsgs.length, 0, '历史展示必须被清空');
    evidence.log(`reset ok: phase=${cleared.phase} status=${JSON.stringify(cleared.statusMsgs)}`);

    await typeAndSend(cdp, '新话题', evidence.lines);
    await waitReply(cdp, '隧道回复：新话题');
    const afterReset = readRequests(handle.logFile);
    assert.equal(afterReset.length, 3);
    const third = afterReset[2]?.body.messages ?? [];
    assert.deepEqual(
      third.map((m) => m.role),
      ['system', 'user'],
      '清空后第一问不得携带任何旧轮次',
    );
    assert.equal(third[1]?.content, '新话题');
    assert.ok(!JSON.stringify(third).includes('我叫小林'), '旧轮次内容不得残留');
    evidence.log(`after reset: bytes=${afterReset[2]?.bytes} messages=${JSON.stringify(third.map((m) => m.role))}`);

    await quitByApi(cdp);
    const exit = await waitExit(handle.entry, 60000);
    evidence.log(`entry exit: code=${String(exit.code)} signal=${String(exit.signal)}`);
    assert.equal(exit.code, 0, '关窗退出码必须为 0');
    await handle.stop();
    evidence.log('PASS');
  } catch (error) {
    evidence.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop().catch(() => undefined);
    await flushEvidence(evidence, 't1-context-on');
  }
});

test('T2 缺省关闭：两问均为单轮形态、无「新对话」（与 M3-1 一致）', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip(`not-run: Xvfb ${display} 起不来（无显示环境）`);
  const evidence = createEvidence('t2-context-off');
  let handle: Awaited<ReturnType<typeof launchLocal>> | undefined;
  try {
    handle = await launchLocal({ context: false, label: 'ctx-off', evidence });
    const { cdp } = handle;
    const opened = await openPanel(cdp, evidence);
    assert.equal(opened.context, 'off', '缺省时 dataset.context 必须为 off');
    assert.equal(opened.hasReset, false, '缺省时不得渲染「新对话」按钮');

    await typeAndSend(cdp, '第一句话', evidence.lines);
    await waitReply(cdp, '隧道回复：第一句话');
    await typeAndSend(cdp, '第二句话', evidence.lines);
    await waitReply(cdp, '隧道回复：第二句话');

    const requests = readRequests(handle.logFile);
    assert.equal(requests.length, 2, `应恰好发出 2 个请求，实际 ${requests.length}`);
    evidence.log(`request[0].bytes=${requests[0]?.bytes} request[1].bytes=${requests[1]?.bytes}`);
    for (const [index, request] of requests.entries()) {
      const roles = request.body.messages.map((m) => m.role);
      assert.deepEqual(roles, ['system', 'user'], `第 ${index + 1} 问必须是单轮 [system,user]（缺省不注入历史）`);
      assert.equal(request.body.messages.some((m) => m.role === 'assistant'), false, '缺省请求不得携带 assistant 消息');
    }
    assert.equal(requests[0]?.bytes, requests[1]?.bytes, '缺省时同输入长度的请求体字节应一致（未注入历史）');
    assert.notEqual(requests[0]?.body.messages[1]?.content, requests[1]?.body.messages[1]?.content);
    evidence.log('no history injected: both [system,user]');

    await quitByApi(cdp);
    const exit = await waitExit(handle.entry, 60000);
    evidence.log(`entry exit: code=${String(exit.code)} signal=${String(exit.signal)}`);
    assert.equal(exit.code, 0, '关窗退出码必须为 0');
    await handle.stop();
    evidence.log('PASS');
  } catch (error) {
    evidence.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop().catch(() => undefined);
    await flushEvidence(evidence, 't2-context-off');
  }
});

test('T3 连续在途清空→立即重发×3：旧内容不上屏、后续请求无旧历史（Windows 复验）', { timeout: 120000 }, async (t) => {
  if (!displayReady) return t.skip('not-run: 无显示环境');
  const evidence = createEvidence('t3-pending-reset');
  process.env.FAKE_MODEL_DELAY_MS = '1200';
  let handle: Awaited<ReturnType<typeof launchLocal>> | undefined;
  try {
    handle = await launchLocal({ context: true, label: 'ctx-pending', evidence });
    const { cdp } = handle;
    await openPanel(cdp, evidence);
    for (let i = 0; i < 3; i++) {
      await typeAndSend(cdp, `待取消${i}`, evidence.lines);
      const pending = await waitDom(cdp, 'pending', (st) => st.phase === 'pending', 5000, 'old request');
      await clickRect(cdp, pending.rects.reset);
      await typeAndSend(cdp, `新请求${i}`, evidence.lines);
      await waitReply(cdp, `隧道回复：新请求${i}`);
      await delay(1400);
      const state = await readDom(cdp);
      assert.equal(state.assistantMsgs.length, 1, '旧内容不得上屏');
      assert.ok(state.assistantMsgs[0]?.includes(`新请求${i}`));
      assert.ok(!JSON.stringify(state.assistantMsgs).includes('待取消'), '被取消轮不得出现在展示区');
      const request: FakeRequest | undefined = readRequests(handle.logFile).at(-1);
      assert.ok(request !== undefined, 'missing request');
      assert.deepEqual(request.body.messages.map((m: { role: string }) => m.role), ['system', 'user'], '清空后请求必须回单轮形态');
      assert.equal(request.body.messages[1]?.content, `新请求${i}`);
      evidence.log(`reset-resend ${i} PASS`);
      await clickRect(cdp, state.rects.reset);
    }
    await quitByApi(cdp);
    const exit = await waitExit(handle.entry, 10000);
    assert.equal(exit.code, 0);
    evidence.log('PASS exit0');
  } finally {
    delete process.env.FAKE_MODEL_DELAY_MS;
    if (handle) await handle.stop().catch(() => undefined);
    await flushEvidence(evidence, 't3-pending-reset');
  }
});
