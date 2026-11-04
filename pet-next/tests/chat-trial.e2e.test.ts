/**
 * M3-5 D：正式试用入口 E2E（pnpm chat:trial --context=on|off，fake SSH 替身 + fake 模型，零真实推理）。
 * 只走正式入口（package.json 接线 pnpm build && node scripts/chat-trial.mjs），不改 A/B 业务实现；
 * 交互全部 CDP 真实鼠标/键盘，DOM 只读。Linux+替身不等于 Windows 通过；Windows 由
 * scripts/win-trial-recheck.mjs 生成 independent-trial-windows.check.ts 复跑，无 Windows 明确 not-run。
 * 证据：tests/chat-evidence/trial/（含请求 NDJSON 拷贝；不落全量环境变量）。
 * 运行：node --experimental-strip-types --test --test-concurrency=1 tests/chat-trial.e2e.test.ts
 * 团队约定：独占 :94（与 chat.e2e 同族，verify 串行）。
 * @module pet-next/tests/chat-trial.e2e
 */
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const evidenceRoot = path.join(petRoot, 'tests/chat-evidence/trial');
const display = process.env.PET_NEXT_E2E_DISPLAY ?? ':94';
const displaySocket = `/tmp/.X11-unix/X${display.startsWith(':') ? display.slice(1) : display}`;
// 直接指向 .mjs：chat-remote 对 .mjs/.js 替身自动改用 node 执行（见 chat-remote.mjs），
// Linux/Windows 同构，Windows 复跑无需 bash 包装或额外替换。
const sshBin = path.join(petRoot, 'tests/support/fake-ssh.mjs');
const ON_LOG = '[chat-trial] 上下文=on（连续对话，4 轮/2000 字符上界）';
const OFF_LOG = '[chat-trial] 上下文=off（单轮，与 M3-1 行为一致）';

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

/** node 24 自带 pnpm 同目录；Windows 生成版由 win-trial-recheck 替换为 cmd.exe。 */
function pnpmPath(): string {
  const beside = path.join(path.dirname(process.execPath), 'pnpm');
  return existsSync(beside) ? beside : 'pnpm';
}

function startFakeModel(logFile: string, delayMs: number): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    let out = '';
    const child = spawn(process.execPath, [path.join(petRoot, 'tests/support/fake-model-service.mjs')], {
      cwd: petRoot,
      env: { ...process.env, FAKE_MODEL_LOG: logFile, FAKE_MODEL_DELAY_MS: String(delayMs) },
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

interface Rect {
  found: boolean;
  visible: boolean;
  cx: number;
  cy: number;
  disabled: boolean | null;
}

interface DomState {
  hasPanel: boolean;
  context: string;
  phase: string;
  mode: string;
  userMsgs: string[];
  assistantMsgs: string[];
  statusMsgs: string[];
  inputValue: string | null;
  hasReset: boolean;
  note: string | null;
  rects: { toggle: Rect; input: Rect; send: Rect; reset: Rect; cancel: Rect };
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
  const inputEl = document.querySelector('[data-testid="chat-input"]');
  return {
    hasPanel: root !== null,
    context: root instanceof HTMLElement ? (root.dataset.context ?? '') : '',
    phase: root instanceof HTMLElement ? (root.dataset.state ?? '') : '',
    mode: root instanceof HTMLElement ? (root.dataset.mode ?? '') : '',
    userMsgs: texts('[data-testid="chat-msg-user"]'),
    assistantMsgs: texts('[data-testid="chat-msg-assistant"]'),
    statusMsgs: texts('[data-testid="chat-status"]'),
    inputValue: inputEl instanceof HTMLTextAreaElement ? inputEl.value : null,
    hasReset: document.querySelector('[data-testid="chat-reset"]') !== null,
    note: document.querySelector('.chat-note')?.textContent ?? null,
    rects: {
      toggle: read('[data-testid="chat-toggle"]'),
      input: read('[data-testid="chat-input"]'),
      send: read('[data-testid="chat-send"]'),
      reset: read('[data-testid="chat-reset"]'),
      cancel: read('[data-testid="chat-cancel"]'),
    },
  };
})()`;

async function readDom(cdp: Cdp): Promise<DomState> {
  return evaluate<DomState>(cdp, DOM_EXPRESSION);
}

async function waitDom(
  cdp: Cdp,
  label: string,
  ok: (state: DomState) => boolean,
  timeoutMs: number,
  note: string,
): Promise<DomState> {
  const deadline = Date.now() + timeoutMs;
  let last: DomState | undefined;
  while (Date.now() < deadline) {
    last = await readDom(cdp);
    if (ok(last)) return last;
    await delay(80);
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

function createEvidence(): Evidence {
  const lines: string[] = [];
  return {
    lines,
    log(line: string): void {
      lines.push(line);
      console.log(`[trial-evidence] ${line}`);
    },
  };
}

async function flushEvidence(evidence: Evidence, name: string, logFile?: string): Promise<void> {
  const dir = path.join(evidenceRoot, name);
  await mkdir(dir, { recursive: true });
  if (logFile !== undefined && existsSync(logFile)) {
    try {
      await copyFile(logFile, path.join(dir, 'requests.ndjson'));
    } catch {
      /* 证据拷贝失败不阻塞 */
    }
  }
  await writeFile(
    path.join(dir, 'log.txt'),
    `${[`# M3-5 D trial e2e ${name}`, `# ${new Date().toISOString()}`, '', ...evidence.lines].join('\n')}\n`,
  );
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

async function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

interface TrialHandle {
  cdp: Cdp;
  app: { child: ChildProcess; output: () => string; errors: () => string };
  logFile: string;
  sshLog: string;
  tunnelPort: number;
  fake: { child: ChildProcess; port: number };
  sentinel: ChildProcess | null;
  stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * 走正式入口启动一次试用：pnpm chat:trial <args>，fake SSH 替身 + 本用例自起 fake 模型。
 * inheritContext：父 env 里的 PET_NEXT_CHAT_CONTEXT 残留值（'1' 表示残留 on）；默认不设。
 */
async function launchTrial(options: {
  name: string;
  args: string[];
  evidence: Evidence;
  inheritContext?: string;
  fakeDelayMs?: number;
  userData?: string;
  withSentinel?: boolean;
}): Promise<TrialHandle> {
  const userData = options.userData ?? (await mkdtemp(path.join(tmpdir(), 'pet-next-trial-e2e-')));
  const keepDir = path.join(evidenceRoot, options.name);
  const logFile = path.join(userData, 'requests.ndjson');
  const sshLog = path.join(userData, 'ssh.ndjson');
  const fake = await startFakeModel(logFile, options.fakeDelayMs ?? 300);
  const tunnelPort = await freePort();
  const debugPort = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISPLAY: display,
    PET_NEXT_SSH_HOST: 'fake.example.invalid',
    PET_NEXT_SSH_PORT: '10977',
    PET_NEXT_SSH_USER: 'tester',
    PET_NEXT_SSH_BIN: sshBin,
    PET_NEXT_TUNNEL_LOCAL_PORT: String(tunnelPort),
    PET_NEXT_QWEN_MODEL: 'qwen3.8-27b',
    PET_NEXT_TEST: '1',
    PET_NEXT_CHAT_DEBUG_PORT: String(debugPort),
    PET_NEXT_USER_DATA: userData,
    FAKE_SSH_LOG: sshLog,
    FAKE_SSH_MODE: 'ok',
    FAKE_SSH_TARGET_PORT: String(fake.port),
  };
  delete env.PET_NEXT_CHAT_CONTEXT;
  if (options.inheritContext !== undefined) env.PET_NEXT_CHAT_CONTEXT = options.inheritContext;
  // 证据只记关键值，不全量落盘环境变量。
  options.evidence.log(
    `cmd: PET_NEXT_CHAT_CONTEXT=${options.inheritContext ?? '<unset>'} pnpm chat:trial ${options.args.join(' ') || '(no args)'}`,
  );
  options.evidence.log(`isolated: userData=${userData} tunnelPort=${tunnelPort} debugPort=${debugPort} fakeModel=${fake.port}`);
  let out = '';
  let err = '';
  const child = spawn(pnpmPath(), ['chat:trial', ...options.args], { cwd: petRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (chunk) => {
    out += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    err += String(chunk);
  });
  const sentinel = options.withSentinel === true ? spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']) : null;
  // 启动半途失败必须回收本次进程（入口/fake/sentinel），不得留孤儿拖累后续用例。
  const abortLaunch = async (reason: string): Promise<never> => {
    child.kill('SIGKILL');
    fake.child.kill('SIGTERM');
    sentinel?.kill('SIGKILL');
    await rm(userData, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`${reason}\nstdout:${out.slice(-3000)}\nstderr:${err.slice(-3000)}`);
  };
  // 等 CDP page 暴露（chat:trial 自带 pnpm build；空 dist 用例在此期间自动重建）。
  const deadline = Date.now() + 150000;
  let socket = '';
  while (Date.now() < deadline && socket === '') {
    if (child.exitCode !== null || child.signalCode !== null) {
      await abortLaunch(`入口提前退出 code=${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const list = (await response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
      socket = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? '';
    } catch {
      /* 未就绪 */
    }
    if (socket === '') await delay(200);
  }
  if (socket === '') await abortLaunch('CDP 未就绪');
  let cdp: Cdp | undefined;
  try {
    cdp = await connectCdp(socket);
  } catch (error) {
    const reason = `CDP 连接失败：${error instanceof Error ? error.message : String(error)}`;
    child.kill('SIGKILL');
    fake.child.kill('SIGTERM');
    sentinel?.kill('SIGKILL');
    await rm(userData, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`${reason}\nstdout:${out.slice(-3000)}\nstderr:${err.slice(-3000)}`, { cause: error });
  }
  const stop = async (): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
    cdp.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    fake.child.kill('SIGTERM');
    sentinel?.kill('SIGKILL');
    if (existsSync(sshLog)) {
      try {
        await mkdir(keepDir, { recursive: true });
        await copyFile(sshLog, path.join(keepDir, 'ssh.ndjson'));
      } catch {
        /* 证据拷贝失败不阻塞清理 */
      }
    }
    await rm(userData, { recursive: true, force: true }).catch(() => undefined);
    return { code: child.exitCode, signal: child.signalCode };
  };
  return {
    cdp,
    app: { child, output: () => out, errors: () => err },
    logFile,
    sshLog,
    tunnelPort,
    fake,
    sentinel,
    stop,
  };
}

async function openPanel(cdp: Cdp, evidence: Evidence): Promise<DomState> {
  const mounted = await waitDom(cdp, '聊天面板未挂载', (s) => s.hasPanel, 60000, 'openPanel');
  evidence.log(`panel mounted: mode=${mounted.mode} context=${mounted.context} note=${String(mounted.note)}`);
  // 正式试用不得出现"演示回复"说明；on 臂的有界历史提示（"只记住当前会话内最近几轮…"）是合法文案。
  assert.equal(mounted.note !== null && mounted.note.includes('演示'), false, '不得出现"演示回复"说明');
  const toggle = await waitDom(cdp, '面板开关未就绪', (s) => s.rects.toggle.found && s.rects.toggle.visible, 10000, 'openPanel');
  await clickRect(cdp, toggle.rects.toggle);
  const opened = await waitDom(cdp, '点击开关后面板未打开', (s) => s.rects.input.found && s.rects.input.visible, 10000, 'openPanel');
  evidence.log(`panel open: context=${opened.context} hasReset=${String(opened.hasReset)}`);
  return opened;
}

async function waitReply(cdp: Cdp, needle: string): Promise<DomState> {
  return waitDom(cdp, `回复未显示：${needle}`, (s) => s.assistantMsgs.some((msg) => msg.includes(needle)), 30000, 'waitReply');
}

/** 关窗（Browser.close）→ 断言入口退出码 0、状态行、复用链就绪标记。 */
async function closeWindowAndAssertExit(handle: TrialHandle, evidence: Evidence, statusLine: string): Promise<void> {
  assert.ok(handle.app.output().includes(statusLine), `入口状态行必须包含 ${statusLine}；stdout=${handle.app.output().slice(-800)}`);
  assert.ok(handle.app.output().includes('chat-remote-ready'), '复用 chat-remote 链必须报就绪');
  void handle.cdp.send('Browser.close', {}).catch(() => undefined);
  const exit = await waitExit(handle.app.child, 60000);
  evidence.log(`entry exit: code=${String(exit.code)} signal=${String(exit.signal)}`);
  assert.equal(exit.code, 0, `关窗退出码必须为 0；stdout 尾部=${handle.app.output().slice(-1500)} stderr 尾部=${handle.app.errors().slice(-800)}`);
}

test('T1 chat:trial --context=on：状态行/历史注入请求体/新对话复位/窗口真实操作/关窗退出 0/本次进程清理', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip(`not-run: Xvfb ${display} 起不来（无显示环境）`);
  const evidence = createEvidence();
  let handle: TrialHandle | undefined;
  try {
    handle = await launchTrial({ name: 't1-context-on', args: ['--context=on'], evidence, withSentinel: true });
    const { cdp } = handle;
    const opened = await openPanel(cdp, evidence);
    assert.equal(opened.context, 'on', 'on 臂 dataset.context 必须为 on');
    assert.match(opened.note ?? '', /会话/, 'on 臂应显示有界历史提示（会话内/重启不保留）');
    assert.equal(opened.hasReset, true, 'on 臂必须渲染「新对话」按钮');

    await typeAndSend(cdp, '我叫小林', evidence.lines);
    await waitReply(cdp, '隧道回复：我叫小林');
    await typeAndSend(cdp, '我叫什么名字', evidence.lines);
    const second = await waitReply(cdp, '隧道回复：我叫什么名字');
    assert.ok(second.assistantMsgs.some((msg) => msg.includes('隧道回复：我叫小林')), '第一轮回复必须保持显示');

    const requests = readRequests(handle.logFile);
    assert.equal(requests.length, 2, `应恰好发出 2 个请求，实际 ${requests.length}`);
    const first = requests[0]?.body.messages ?? [];
    const msgs = requests[1]?.body.messages ?? [];
    assert.deepEqual(first.map((m) => m.role), ['system', 'user'], '第一问必须是 [system,user]');
    assert.deepEqual(
      msgs.map((m) => m.role),
      ['system', 'user', 'assistant', 'user'],
      '第二问必须携带第一轮 user/assistant（正式入口 on 语义）',
    );
    assert.equal(msgs[2]?.content, '隧道回复：我叫小林', '历史 assistant 必须是已交付界面的完整回复');
    evidence.log(`request bodies: roles=${JSON.stringify(msgs.map((m) => m.role))} bytes=${requests[0]?.bytes}->${requests[1]?.bytes}`);

    // 点「新对话」（真实鼠标）→ 展示清空 → 第三问回到单轮。
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
    evidence.log(`reset ok: status=${JSON.stringify(cleared.statusMsgs)}`);
    await typeAndSend(cdp, '新话题', evidence.lines);
    await waitReply(cdp, '隧道回复：新话题');
    const afterReset = readRequests(handle.logFile);
    assert.equal(afterReset.length, 3);
    const third = afterReset[2]?.body.messages ?? [];
    assert.deepEqual(third.map((m) => m.role), ['system', 'user'], '清空后第一问不得携带任何旧轮次');
    assert.ok(!JSON.stringify(third).includes('我叫小林'), '旧轮次内容不得残留');
    evidence.log('on-arm PASS: history injected then reset to single-turn');

    await closeWindowAndAssertExit(handle, evidence, ON_LOG);
    assert.equal(handle.sentinel?.exitCode, null, '无关进程必须存活（只清理本次进程）');
    const sshLogText = readFileSync(handle.sshLog, 'utf8');
    assert.match(sshLogText, /fake-ssh-listening/);
    assert.match(sshLogText, /fake-ssh-stopped/, '隧道应被本次收尾关闭');
    const still = await portListening(handle.tunnelPort);
    assert.equal(still, false, '退出后本地转发端口不得残留监听');
    evidence.log('PASS');
  } catch (error) {
    evidence.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop().catch(() => undefined);
    await flushEvidence(evidence, 't1-context-on', handle?.logFile);
  }
});

test('T2 父 env 残留 PET_NEXT_CHAT_CONTEXT=1 但显式 --context=off：继承值必须被清除', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip(`not-run: Xvfb ${display} 起不来（无显示环境）`);
  const evidence = createEvidence();
  let handle: TrialHandle | undefined;
  try {
    handle = await launchTrial({ name: 't2-explicit-off', args: ['--context=off'], evidence, inheritContext: '1' });
    const { cdp } = handle;
    const opened = await openPanel(cdp, evidence);
    assert.equal(opened.context, 'off', '显式 off 必须清除父 env 残留值（不得变 on）');
    assert.equal(opened.hasReset, false, 'off 臂不得渲染「新对话」按钮');

    await typeAndSend(cdp, '第一句话', evidence.lines);
    await waitReply(cdp, '隧道回复：第一句话');
    await typeAndSend(cdp, '第二句话', evidence.lines);
    await waitReply(cdp, '隧道回复：第二句话');
    const requests = readRequests(handle.logFile);
    assert.equal(requests.length, 2, `应恰好发出 2 个请求，实际 ${requests.length}`);
    for (const [index, request] of requests.entries()) {
      assert.deepEqual(
        request.body.messages.map((m) => m.role),
        ['system', 'user'],
        `第 ${index + 1} 问必须是单轮 [system,user]（残留 on 被清除）`,
      );
      assert.equal(request.body.messages.some((m) => m.role === 'assistant'), false, 'off 请求不得携带 assistant 消息');
    }
    evidence.log(`explicit-off PASS: both [system,user] bytes=${requests[0]?.bytes}/${requests[1]?.bytes}`);
    await closeWindowAndAssertExit(handle, evidence, OFF_LOG);
    evidence.log('PASS');
  } catch (error) {
    evidence.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop().catch(() => undefined);
    await flushEvidence(evidence, 't2-explicit-off', handle?.logFile);
  }
});

test('T3 chat:trial --context=on 在途「新对话」重发：迟到响应不上屏、新请求单轮', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip(`not-run: Xvfb ${display} 起不来（无显示环境）`);
  const evidence = createEvidence();
  let handle: TrialHandle | undefined;
  try {
    handle = await launchTrial({ name: 't3-pending-reset', args: ['--context=on'], evidence, fakeDelayMs: 1500 });
    const { cdp } = handle;
    await openPanel(cdp, evidence);
    await typeAndSend(cdp, '迟到甲', evidence.lines);
    const pending = await waitDom(cdp, '未进入发送中', (s) => s.phase === 'pending', 5000, 'old request');
    assert.equal(pending.rects.cancel.visible, true, '发送中取消按钮应可见（窗口可操作）');
    await clickRect(cdp, pending.rects.reset);
    await typeAndSend(cdp, '重发乙', evidence.lines);
    await waitReply(cdp, '隧道回复：重发乙');
    // 等待足够久，确保被清空轮的迟到响应已经送达——它不得上屏。
    await delay(2200);
    const state = await readDom(cdp);
    assert.equal(state.assistantMsgs.length, 1, '迟到响应不得上屏');
    assert.ok(state.assistantMsgs[0]?.includes('重发乙'));
    assert.ok(!JSON.stringify(state.assistantMsgs).includes('迟到甲'), '被清空轮的响应不得出现在展示区');
    const requests = readRequests(handle.logFile);
    assert.equal(requests.length, 2, `应恰好 2 个请求（旧+新），实际 ${requests.length}`);
    const last = requests.at(-1)?.body.messages ?? [];
    assert.deepEqual(last.map((m) => m.role), ['system', 'user'], '清空后重发必须回单轮形态');
    assert.equal(last[1]?.content, '重发乙');
    evidence.log('pending-reset PASS: late reply dropped, resend single-turn');
    await closeWindowAndAssertExit(handle, evidence, ON_LOG);
    evidence.log('PASS');
  } catch (error) {
    evidence.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop().catch(() => undefined);
    await flushEvidence(evidence, 't3-pending-reset', handle?.logFile);
  }
});

test('T4 空 dist + 缺省（不带参数默认 off）：一条命令自带 build 就绪', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip(`not-run: Xvfb ${display} 起不来（无显示环境）`);
  const mainJs = path.join(petRoot, 'dist/electron/main.js');
  const evidence = createEvidence();
  let handle: TrialHandle | undefined;
  try {
    await rm(mainJs, { force: true });
    assert.equal(existsSync(mainJs), false, '前置：构建产物已删除');
    evidence.log('dist/electron/main.js removed before launch');
    handle = await launchTrial({ name: 't4-empty-dist', args: [], evidence });
    const { cdp } = handle;
    const opened = await openPanel(cdp, evidence);
    assert.equal(opened.context, 'off', '缺省（无参数）必须是 off');
    assert.equal(opened.hasReset, false, '缺省不得渲染「新对话」按钮');
    assert.equal(existsSync(mainJs), true, 'chat:trial 接线应自动 pnpm build 出产物');
    await typeAndSend(cdp, '空目录首启', evidence.lines);
    await waitReply(cdp, '隧道回复：空目录首启');
    evidence.log('empty-dist PASS: rebuilt then single-turn off');
    await closeWindowAndAssertExit(handle, evidence, OFF_LOG);
    evidence.log('PASS');
  } catch (error) {
    evidence.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop().catch(() => undefined);
    // 本用例删过构建产物：无论成败都恢复，避免拖累后续用例。
    if (!existsSync(mainJs)) execFileSync('pnpm', ['build'], { cwd: petRoot, stdio: 'ignore' });
    await flushEvidence(evidence, 't4-empty-dist', handle?.logFile);
  }
});

test('T5 PET_NEXT_USER_DATA 带空格路径：正式入口全链可用（on 一轮）', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip(`not-run: Xvfb ${display} 起不来（无显示环境）`);
  const evidence = createEvidence();
  let handle: TrialHandle | undefined;
  try {
    const spaced = path.join(tmpdir(), `pet next trial ${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    await mkdir(spaced, { recursive: true });
    evidence.log(`spaced userData: ${spaced}`);
    handle = await launchTrial({ name: 't5-spaced-path', args: ['--context=on'], evidence, userData: spaced });
    const { cdp } = handle;
    const opened = await openPanel(cdp, evidence);
    assert.equal(opened.context, 'on', '带空格路径不影响 on 语义');
    await typeAndSend(cdp, '路径带空格', evidence.lines);
    await waitReply(cdp, '隧道回复：路径带空格');
    const requests = readRequests(handle.logFile);
    assert.equal(requests.length, 1, `带空格路径应正常发出 1 个请求，实际 ${requests.length}`);
    evidence.log('spaced-path PASS');
    await closeWindowAndAssertExit(handle, evidence, ON_LOG);
    evidence.log('PASS');
  } catch (error) {
    evidence.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop().catch(() => undefined);
    await flushEvidence(evidence, 't5-spaced-path', handle?.logFile);
  }
});
