/**
 * M3-6 D：聊天/宠物反馈联动独立验收（不改 B/C 实现）。
 * 两臂：对照臂（不给 --experience，short,behavior 照开）与 companion 臂（--experience=companion）；
 * 两臂同 short 素材、同 fake 固定 1500ms 延迟、同输入脚本。
 * 只读 DOM 判定：chat-feedback[data-kind]、助手消息、documentElement.dataset.visual/request（回应）。
 * POST 次数：fake 模型 FAKE_MODEL_LOG 的 NDJSON 行数（不新增 POST 是硬门）。
 * 证据：tests/chat-evidence/feedback/<case>/（时间戳/NDJSON/截图），不落全量环境变量。
 * 运行：node --experimental-strip-types --test --test-concurrency=1 tests/feedback/companion.e2e.test.ts
 * 团队约定：独占 :94（verify 串行；Windows 未跑 → not-run，见 scripts/win-trial-recheck.mjs 同源复跑）。
 * @module pet-next/tests/feedback/companion.e2e
 */
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const evidenceRoot = path.join(petRoot, 'tests/chat-evidence/feedback');
const display = process.env.PET_NEXT_E2E_DISPLAY ?? ':94';
const displaySocket = `/tmp/.X11-unix/X${display.startsWith(':') ? display.slice(1) : display}`;
const sshBin = path.join(petRoot, 'tests/support/fake-ssh.mjs');
const FAKE_DELAY_MS = 1500;
/** 慢回复两臂验收：2.5s 明显超过等待提示 1.6s TTL。 */
const SLOW_DELAY_MS = 2500;
/** 两臂共用：short 素材 + behavior 行为，唯一差异是 PET_NEXT_EXPERIENCE。 */
const SHARED_PREVIEW = 'short,behavior';

let xvfb: ChildProcess | undefined;
let ownsXvfb = false;
let displayReady = false;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

function pnpmPath(): string {
  const beside = path.join(path.dirname(process.execPath), 'pnpm');
  return existsSync(beside) ? beside : 'pnpm';
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
  // 关窗/页面销毁时连接先断：reject pending，避免 evaluate 永久悬挂。
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
    exceptionDetails?: { exception?: { description?: string }; text?: string };
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

interface DomState {
  hasPanel: boolean;
  experience: string;
  phase: string;
  userMsgs: string[];
  assistantMsgs: string[];
  statusMsgs: string[];
  inputValue: string | null;
  /** 反馈提示：无节点（对照臂）→ kind='absent'；节点隐藏 → kind='hidden'。 */
  feedbackKind: string;
  feedbackText: string;
  /** 回应可见性：visual 由 behavior 播放时写入（idle/reaction/auto/placeholder）。 */
  visual: string;
  requestId: string;
  bodyDragging: boolean;
  rects: { toggle: Rect; input: Rect; send: Rect; reset: Rect; cancel: Rect; pet: Rect };
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
  const fb = document.querySelector('[data-testid="chat-feedback"]');
  const doc = document.documentElement;
  const ds = (doc && doc.dataset) || {};
  return {
    hasPanel: root !== null,
    experience: ds.experience ?? '',
    phase: root instanceof HTMLElement ? (root.dataset.state ?? '') : '',
    userMsgs: texts('[data-testid="chat-msg-user"]'),
    assistantMsgs: texts('[data-testid="chat-msg-assistant"]'),
    statusMsgs: texts('[data-testid="chat-status"]'),
    inputValue: inputEl instanceof HTMLTextAreaElement ? inputEl.value : null,
    feedbackKind: fb === null ? 'absent' : (fb.hidden ? 'hidden' : (fb.dataset.kind || 'shown')),
    feedbackText: fb === null ? '' : (fb.textContent ?? '').trim(),
    visual: ds.visual ?? '',
    requestId: ds.request ?? '',
    bodyDragging: document.body.classList.contains('dragging'),
    rects: {
      toggle: read('[data-testid="chat-toggle"]'),
      input: read('[data-testid="chat-input"]'),
      send: read('[data-testid="chat-send"]'),
      reset: read('[data-testid="chat-reset"]'),
      cancel: read('[data-testid="chat-cancel"]'),
      pet: read('#pet'),
    },
  };
})()`;

const readDom = (cdp: Cdp): Promise<DomState> => evaluate<DomState>(cdp, DOM_EXPRESSION);

async function waitDom(
  cdp: Cdp,
  label: string,
  ok: (state: DomState) => boolean,
  timeoutMs: number,
  note: string,
): Promise<{ state: DomState; atMs: number }> {
  const deadline = Date.now() + timeoutMs;
  let last: DomState | undefined;
  while (Date.now() < deadline) {
    try {
      last = await readDom(cdp);
      if (ok(last)) return { state: last, atMs: Date.now() };
    } catch {
      /* 页面导航/重绘瞬间，继续轮询 */
    }
    await delay(40);
  }
  throw new Error(`${label}（${timeoutMs}ms 超时）${note}\nlast=${JSON.stringify(last)}`);
}

async function clickRect(cdp: Cdp, rect: Rect): Promise<number> {
  const x = Math.round(rect.cx);
  const y = Math.round(rect.cy);
  const at = Date.now();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await delay(20);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  return at;
}

async function typeAndSend(cdp: Cdp, text: string): Promise<number> {
  const ready = await waitDom(cdp, '输入框未就绪', (s) => s.rects.input.found && s.rects.input.visible, 8000, `send ${text}`);
  await clickRect(cdp, ready.state.rects.input);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  await cdp.send('Input.insertText', { text });
  const armed = await waitDom(cdp, '发送按钮未就绪', (s) => s.inputValue === text && s.rects.send.disabled === false, 8000, `send ${text}`);
  return clickRect(cdp, armed.state.rects.send);
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

async function screenshot(cdp: Cdp, dir: string, name: string): Promise<string> {
  try {
    const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    await writeFile(file, Buffer.from(shot.data, 'base64'));
    return file;
  } catch {
    return '';
  }
}

interface Arm {
  name: 'control' | 'companion';
  args: string[];
  env?: Record<string, string>;
  /** 只作用于 fake 模型服务，不传给入口。 */
  fakeMode?: 'ok' | 'error';
  /** 只作用于 fake 模型服务：慢回复验收用 2.5s。 */
  fakeDelayMs?: number;
}

interface Handle {
  cdp: Cdp;
  logFile: string;
  /** userData 目录名片段：用于兜底清理本实例的 Electron 孙进程。 */
  instanceTag: string;
  /** 本实例 CDP 调试端口：退出后必须关闭。 */
  debugPort: number;
  caseName: string;
  /** fake 模型服务 PID：其日志路径含实例标签，但属于测试装置，不参与入口残留断言。 */
  fakePid: number;
  child: ChildProcess;
  output: () => string;
  stop(): Promise<void>;
}

/** 启动一次试用入口（两臂共用；仅 args/env 不同）。 */
async function launch(arm: Arm, caseName: string): Promise<Handle> {
  const userData = await mkdtemp(path.join(tmpdir(), `pet-fb-${caseName}-`));
  const instanceTag = path.basename(userData);
  const logFile = path.join(userData, 'requests.ndjson');
  const sshLog = path.join(userData, 'ssh.ndjson');
  let fakeOut = '';
  const fake = spawn(process.execPath, [path.join(petRoot, 'tests/support/fake-model-service.mjs')], {
    env: {
      ...process.env,
      FAKE_MODEL_LOG: logFile,
      FAKE_MODEL_DELAY_MS: String(arm.fakeDelayMs ?? FAKE_DELAY_MS),
      FAKE_MODEL_MODE: arm.fakeMode ?? 'ok',
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
    FAKE_SSH_TARGET_PORT: String(fakePort),
    // 对照臂也必须同 short,behavior；两臂唯一差异是 companion 参数注入的 PET_NEXT_EXPERIENCE。
    PET_NEXT_PREVIEW: SHARED_PREVIEW,
    ...(arm.env ?? {}),
  };
  delete env.PET_NEXT_CHAT_CONTEXT;
  delete env.PET_NEXT_EXPERIENCE;
  if (arm.name === 'companion') env.PET_NEXT_EXPERIENCE = 'companion';
  let out = '';
  const child = spawn(pnpmPath(), ['chat:trial', ...arm.args], { cwd: petRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (chunk) => (out += String(chunk)));
  child.stderr?.on('data', (chunk) => (out += String(chunk)));
  const deadline = Date.now() + 150000;
  let socket = '';
  while (Date.now() < deadline && socket === '') {
    if (child.exitCode !== null) throw new Error(`入口提前退出 code=${child.exitCode}\n${out.slice(-3000)}`);
    try {
      const list = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as Array<{
        type?: string;
        webSocketDebuggerUrl?: string;
      }>;
      socket = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? '';
    } catch {
      /* 未就绪 */
    }
    if (socket === '') await delay(150);
  }
  if (socket === '') throw new Error(`CDP 未就绪\n${out.slice(-3000)}`);
  const cdp = await connectCdp(socket);
  const dir = path.join(evidenceRoot, caseName);
  return {
    cdp,
    logFile,
    instanceTag,
    debugPort,
    caseName,
    fakePid: fake.pid ?? -1,
    child,
    output: () => out,
    stop: async () => {
      cdp.close();
      if (child.exitCode === null) child.kill('SIGKILL');
      fake.kill('SIGTERM');
      // 实测缺陷：Browser.close 后 pnpm 链退出 0，但 Electron 孙进程可能残留——
      // 其窗口会盖住后续用例的新窗口，吞掉 xdotool 屏幕事件。按本次 userData 精确兜底清理。
      try {
        execFileSync('pkill', ['-f', `pet-fb-${caseName}`], { stdio: 'ignore' });
      } catch {
        /* 无匹配进程 = 正常退出，忽略 */
      }
      await mkdir(dir, { recursive: true }).catch(() => undefined);
      if (existsSync(logFile)) await copyFile(logFile, path.join(dir, 'requests.ndjson')).catch(() => undefined);
      if (existsSync(sshLog)) await copyFile(sshLog, path.join(dir, 'ssh.ndjson')).catch(() => undefined);
      await rm(userData, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function openPanel(handle: Handle): Promise<DomState> {
  await waitDom(handle.cdp, '面板未挂载', (s) => s.hasPanel, 60000, 'openPanel');
  const toggle = await waitDom(handle.cdp, '开关未就绪', (s) => s.rects.toggle.visible, 10000, 'openPanel');
  await clickRect(handle.cdp, toggle.state.rects.toggle);
  const opened = await waitDom(handle.cdp, '面板未打开', (s) => s.rects.input.visible, 10000, 'openPanel');
  return opened.state;
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

/** 本次入口进程树的后代（Linux /proc；Windows 经 CIM）。只用于断言残留，不用于杀进程。 */
function descendants(rootPid: number): number[] {
  if (rootPid <= 0) return [];
  if (process.platform === 'win32') {
    try {
      const script =
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress';
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
      });
      const rows = JSON.parse(out) as Array<{ ProcessId: number; ParentProcessId: number }>;
      const list = Array.isArray(rows) ? rows : [rows];
      const pids: number[] = [];
      for (const row of list) {
        let cursor = row.ProcessId;
        for (let guard = 0; guard < 16; guard += 1) {
          const parent = list.find((item) => item.ProcessId === cursor)?.ParentProcessId;
          if (parent === undefined) break;
          if (parent === rootPid) {
            pids.push(row.ProcessId);
            break;
          }
          cursor = parent;
        }
      }
      return pids;
    } catch {
      return [];
    }
  }
  const pids: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return pids;
  }
  const parent = new Map<number, number>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const text = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const close = text.lastIndexOf(')');
      parent.set(Number(entry), Number(text.slice(close + 2).split(' ')[1]));
    } catch {
      /* 进程已消失 */
    }
  }
  for (const pid of parent.keys()) {
    let cursor = pid;
    for (let guard = 0; guard < 16; guard += 1) {
      const up = parent.get(cursor);
      if (up === undefined) break;
      if (up === rootPid) {
        pids.push(pid);
        break;
      }
      cursor = up;
    }
  }
  return pids;
}

/** 按实例标签找进程：Linux 读 /proc/<pid>/environ（孙进程重挂父后仍可识别）；Windows 用 CommandLine 过滤。 */
function pidsByEnvTag(tag: string): number[] {
  if (process.platform === 'win32') {
    try {
      const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${tag}*' } | Select-Object -ExpandProperty ProcessId`;
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
      });
      return out
        .split(/\s+/)
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch {
      return [];
    }
  }
  const pids: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return pids;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/environ`, 'utf8').includes(tag)) pids.push(Number(entry));
    } catch {
      /* 无权限或已退出 */
    }
  }
  return pids;
}

function processAlive(pid: number): boolean {
  if (pid <= 0) return false;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' });
      return out.includes(String(pid));
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

interface Residue {
  pids: number[];
  portOpen: boolean;
  waitedMs: number;
}

async function waitResidueGone(handle: Handle, pids: number[], timeoutMs: number): Promise<Residue> {
  const started = Date.now();
  let alive = pids;
  let open = true;
  while (Date.now() - started < timeoutMs) {
    alive = pids.filter(processAlive);
    open = await portOpen(handle.debugPort);
    if (alive.length === 0 && !open) break;
    await delay(200);
  }
  return { pids: alive, portOpen: open, waitedMs: Date.now() - started };
}

/**
 * 正式退出：Browser.close → 等待入口结束 → 断言本次 PID 树与调试端口消失。
 * 断言先于 finally 清理；兜底清理只发生在 finally，不能把失败变成通过。
 * pnpm 退出 0 不代表 Electron 孙进程已死（实测会残留并遮挡后续 xdotool 事件）。
 */
async function closeWindow(handle: Handle): Promise<number | null> {
  const before = [
    ...new Set([
      handle.child.pid ?? 0,
      ...descendants(handle.child.pid ?? 0),
      ...pidsByEnvTag(handle.instanceTag),
    ]),
  ].filter((pid) => pid > 0 && pid !== handle.fakePid);
  void handle.cdp.send('Browser.close', {}).catch(() => undefined);
  const code = await waitExit(handle.child, 90000);
  const after = await waitResidueGone(handle, before, 20000);
  const dir = path.join(evidenceRoot, handle.caseName);
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  await writeFile(
    path.join(dir, 'exit.txt'),
    [
      `code=${String(code)}`,
      `pids_before=${before.join(',')}`,
      `pids_alive_after=${after.pids.join(',')}`,
      `debug_port=${handle.debugPort} open_after=${String(after.portOpen)}`,
      `wait_ms=${after.waitedMs}`,
      `output_tail=${handle.output().slice(-600)}`,
      '',
    ].join('\n'),
  ).catch(() => undefined);
  assert.equal(code, 0, `关窗退出码必须 0；stdout=${handle.output().slice(-800)}`);
  assert.deepEqual(after.pids, [], `正式退出后不得残留本次进程：${after.pids.join(',')}`);
  assert.equal(after.portOpen, false, `正式退出后调试端口 ${handle.debugPort} 必须关闭`);
  return code;
}

interface Log {
  lines: string[];
  log(line: string): void;
}

function createLog(): Log {
  const lines: string[] = [];
  return {
    lines,
    log(line: string): void {
      lines.push(line);
      console.log(`[feedback-evidence] ${line}`);
    },
  };
}

async function flushLog(log: Log, caseName: string): Promise<void> {
  const dir = path.join(evidenceRoot, caseName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'log.txt'), `${log.lines.join('\n')}\n`);
}

const CONTROL: Arm = { name: 'control', args: [] };
const COMPANION: Arm = { name: 'companion', args: ['--experience=companion'] };

/** 与本次验收无关的哨兵进程：退出清理不得误杀树外进程。 */
interface Sentinel {
  pid: number;
  alive(): boolean;
  kill(): void;
}

function startSentinel(): Sentinel {
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

/** 采集 visual/requestId 变化序列：用于"回应至多一次"与"拖动/点击优先"的可判定证据。 */
async function observe(cdp: Cdp, ms: number): Promise<Array<{ visual: string; requestId: string; atMs: number }>> {
  const out: Array<{ visual: string; requestId: string; atMs: number }> = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const state = await readDom(cdp);
    const last = out.at(-1);
    if (last === undefined || last.requestId !== state.requestId || last.visual !== state.visual) {
      out.push({ visual: state.visual, requestId: state.requestId, atMs: Date.now() });
    }
    await delay(30);
  }
  return out;
}

const reactionsIn = (seq: Array<{ requestId: string }>): string[] =>
  seq.map((item) => item.requestId).filter((id) => id.startsWith('reaction-'));

test('对照臂 · 关闭：无反馈节点、成功不触发回应、POST=1、关窗退出 0', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip('not-run: 无显示环境');
  const log = createLog();
  let handle: Handle | undefined;
  try {
    handle = await launch(CONTROL, 'control-off');
    const opened = await openPanel(handle);
    assert.equal(opened.experience, '', '对照臂 dataset.experience 必须为空');
    assert.equal(opened.feedbackKind, 'absent', '关闭时不得存在反馈节点');
    const submittedAt = await typeAndSend(handle.cdp, '对照一句');
    const reply = await waitDom(handle.cdp, '回复未显示', (s) => s.assistantMsgs.some((m) => m.includes('隧道回复：对照一句')), 30000, 'control');
    const seq = await observe(handle.cdp, 2200);
    assert.deepEqual(reactionsIn(seq), [], '关闭时成功不得触发回应');
    assert.equal(readRequests(handle.logFile).length, 1, 'POST 必须恰好 1 次');
    log.log(`submit=${submittedAt} reply=${reply.atMs} reactions=${reactionsIn(seq).length}`);
    const code = await closeWindow(handle);
    assert.equal(code, 0, `关窗退出码必须 0；stdout=${handle.output().slice(-800)}`);
    log.log('PASS control-off');
  } catch (error) {
    log.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop();
    await flushLog(log, 'control-off');
  }
});

test('companion · 成功：等待反馈先于回复可见、成功提示、回应恰一次、POST=1、截图', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip('not-run: 无显示环境');
  const log = createLog();
  let handle: Handle | undefined;
  try {
    handle = await launch(COMPANION, 'companion-success');
    const opened = await openPanel(handle);
    assert.equal(opened.experience, 'companion');
    const submittedAt = await typeAndSend(handle.cdp, '成功一句');
    const waiting = await waitDom(handle.cdp, '等待反馈未出现', (s) => s.feedbackKind === 'waiting', 8000, 'success');
    assert.equal(waiting.state.feedbackText.length > 0, true, '等待提示必须有可读文案');
    const reply = await waitDom(handle.cdp, '回复未显示', (s) => s.assistantMsgs.some((m) => m.includes('隧道回复：成功一句')), 30000, 'success');
    assert.ok(waiting.atMs <= reply.atMs, '等待反馈必须在回复之前真实可见');
    const success = await waitDom(handle.cdp, '成功提示未出现', (s) => s.feedbackKind === 'success', 8000, 'success');
    const react = await waitDom(handle.cdp, '回应动作未出现', (s) => s.visual === 'auto', 8000, 'success');
    const seq = await observe(handle.cdp, 2500);
    const reactions = reactionsIn(seq);
    assert.equal(reactions.length, 1, `每成功 token 回应至多一次；seq=${JSON.stringify(seq)}`);
    assert.equal(readRequests(handle.logFile).length, 1, 'POST 不得增加');
    log.log(
      `submit=${submittedAt} waiting_ms=${waiting.atMs - submittedAt} reply_ms=${reply.atMs - submittedAt} success_ms=${success.atMs - submittedAt} react_ms=${react.atMs - submittedAt} reaction=${reactions[0]}`,
    );
    const shot = await screenshot(handle.cdp, path.join(evidenceRoot, 'companion-success'), 'react');
    log.log(`screenshot=${shot}`);
    const shotHint = await waitDom(handle.cdp, '成功提示消失', (s) => s.feedbackKind === 'hidden', 8000, 'success');
    log.log(`hint_hidden_ms=${shotHint.atMs - submittedAt}`);
    const code = await closeWindow(handle);
    assert.equal(code, 0, `关窗退出码必须 0；stdout=${handle.output().slice(-800)}`);
    log.log('PASS companion-success');
  } catch (error) {
    log.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop();
    await flushLog(log, 'companion-success');
  }
});

test('companion · 错误：error 提示可辨认、不假成功、零回应、POST=1', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip('not-run: 无显示环境');
  const log = createLog();
  let handle: Handle | undefined;
  try {
    handle = await launch({ ...COMPANION, fakeMode: 'error' }, 'companion-error');
    await openPanel(handle);
    const submittedAt = await typeAndSend(handle.cdp, '错误一句');
    await waitDom(handle.cdp, '等待反馈未出现', (s) => s.feedbackKind === 'waiting', 8000, 'error');
    const errorHint = await waitDom(handle.cdp, '错误提示未出现', (s) => s.feedbackKind === 'error', 30000, 'error');
    const seq = await observe(handle.cdp, 2500);
    assert.deepEqual(reactionsIn(seq), [], '错误不得触发回应');
    assert.equal(readRequests(handle.logFile).length, 1);
    log.log(`submit=${submittedAt} error_ms=${errorHint.atMs - submittedAt} text=${errorHint.state.feedbackText}`);
    assert.equal(await closeWindow(handle), 0);
    log.log('PASS companion-error');
  } catch (error) {
    log.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop();
    await flushLog(log, 'companion-error');
  }
});

test('companion · 取消后立即重发：cancelled 可辨认、新请求成功且回应一次', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip('not-run: 无显示环境');
  const log = createLog();
  let handle: Handle | undefined;
  try {
    handle = await launch(COMPANION, 'companion-cancel-resend');
    await openPanel(handle);
    await typeAndSend(handle.cdp, '要被取消的');
    const pending = await waitDom(handle.cdp, '未进入发送中', (s) => s.phase === 'pending' && s.rects.cancel.visible, 8000, 'cancel');
    await clickRect(handle.cdp, pending.state.rects.cancel);
    const cancelled = await waitDom(handle.cdp, '取消提示未出现', (s) => s.feedbackKind === 'cancelled', 8000, 'cancel');
    const submittedAt = await typeAndSend(handle.cdp, '取消后重发');
    const reply = await waitDom(handle.cdp, '重发回复未显示', (s) => s.assistantMsgs.some((m) => m.includes('隧道回复：取消后重发')), 30000, 'cancel');
    const seq = await observe(handle.cdp, 2500);
    assert.equal(reactionsIn(seq).length, 1, `只有成功的新 token 回应一次；seq=${JSON.stringify(seq)}`);
    const requests = readRequests(handle.logFile);
    assert.equal(requests.length, 2, `取消发出 1 + 重发 1，实际 ${requests.length}`);
    log.log(`cancel_hint_ms=${cancelled.atMs - submittedAt} resend_reply_ms=${reply.atMs - submittedAt} POST=${requests.length}`);
    assert.equal(await closeWindow(handle), 0);
    log.log('PASS companion-cancel-resend');
  } catch (error) {
    log.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop();
    await flushLog(log, 'companion-cancel-resend');
  }
});

test('companion · reset 后迟到：旧回复不上屏、零回应、重发单轮', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip('not-run: 无显示环境');
  const log = createLog();
  let handle: Handle | undefined;
  try {
    handle = await launch({ ...COMPANION, args: ['--experience=companion', '--context=on'] }, 'companion-reset-late');
    await openPanel(handle);
    await typeAndSend(handle.cdp, '迟到甲');
    const resettable = await waitDom(handle.cdp, '新对话按钮未就绪', (s) => s.rects.reset.visible, 8000, 'reset');
    await delay(200);
    const resetAt = await clickRect(handle.cdp, resettable.state.rects.reset);
    const cleared = await waitDom(handle.cdp, 'reset 未清空展示', (s) => s.userMsgs.length === 0, 8000, 'reset');
    assert.ok(cleared.state.feedbackKind !== 'waiting', 'reset 立即清等待反馈');
    await delay(2000);
    const late = await readDom(handle.cdp);
    assert.equal(late.assistantMsgs.length, 0, '迟到回复不得上屏');
    assert.ok(!late.assistantMsgs.join('').includes('迟到甲'));
    const seq = await observe(handle.cdp, 1200);
    assert.deepEqual(reactionsIn(seq), [], '迟到 token 不得触发回应');
    const submittedAt = await typeAndSend(handle.cdp, '新题');
    await waitDom(handle.cdp, '新题回复未显示', (s) => s.assistantMsgs.some((m) => m.includes('隧道回复：新题')), 30000, 'reset');
    const seq2 = await observe(handle.cdp, 2500);
    assert.equal(reactionsIn(seq2).length, 1, '新 token 回应恰一次');
    const requests = readRequests(handle.logFile);
    assert.equal(requests.length, 2, `迟到 1 + 新题 1，实际 ${requests.length}`);
    assert.deepEqual(requests[1]?.messages.map((m) => m.role), ['system', 'user'], 'reset 后重发必须单轮');
    assert.ok(!JSON.stringify(requests[1]).includes('迟到甲'));
    log.log(`reset_at=${resetAt} resend_at=${submittedAt} POST=${requests.length} late_dropped=true`);
    assert.equal(await closeWindow(handle), 0);
    log.log('PASS companion-reset-late');
  } catch (error) {
    log.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop();
    await flushLog(log, 'companion-reset-late');
  }
});

test('companion · 拖动中完成：结果提示保留、回应动作丢弃', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip('not-run: 无显示环境');
  if (process.platform === 'win32') return t.skip('not-run: 拖动依赖 xdotool（Linux 验收通道，同 drag-scale.e2e）');
  const log = createLog();
  let handle: Handle | undefined;
  try {
    handle = await launch(COMPANION, 'companion-drag');
    await openPanel(handle);
    const submittedAt = await typeAndSend(handle.cdp, '拖动中完成');
    await waitDom(handle.cdp, '未进入发送中', (s) => s.phase === 'pending', 8000, 'drag');
    // 真实拖动复刻 scripts/demo.mjs 的验收通道：xdotool 按窗口几何取屏幕坐标，
    // 步进 80ms（CDP 视口事件不走 Electron 窗口拖动路径，合成事件产品未接）。
    const xdoEnv = { ...process.env, DISPLAY: display };
    const xdo = (args: string[]): void => {
      execFileSync('xdotool', args, { stdio: 'ignore', env: xdoEnv });
    };
    const winId = execFileSync('xdotool', ['search', '--name', 'pet-next'], {
      encoding: 'utf8',
      env: xdoEnv,
    })
      .split('\n')
      .filter(Boolean)
      .at(-1);
    assert.ok(winId, '未找到 pet-next 窗口（xdotool search）');
    const shell = execFileSync('xdotool', ['getwindowgeometry', '--shell', winId], {
      encoding: 'utf8',
      env: xdoEnv,
    });
    const geo = { X: 0, Y: 0, WIDTH: 0, HEIGHT: 0 };
    for (const line of shell.split('\n')) {
      const [key, value] = line.split('=');
      if (key === 'X' || key === 'Y' || key === 'WIDTH' || key === 'HEIGHT') geo[key] = Number(value);
    }
    // 面板 fixed 右下（264 宽 + gutter）盖住窗口大部：从左上面板覆盖区外起拖
    //（#pet 铺满全窗，drag-start 后窗口接管移动，越入面板区不受影响）。
    const cx = geo.X + 12;
    const cy = geo.Y + 12;
    log.log(`window=${winId} geo=${JSON.stringify(geo)} center=(${cx},${cy})`);
    try {
      xdo(['windowactivate', '--sync', winId]);
    } catch {
      /* bare Xvfb 无 WM：激活降级（与 demo.mjs 的 envLimited 同语义） */
    }
    xdo(['mousemove', String(cx), String(cy)]);
    xdo(['mousedown', '1']);
    for (let i = 1; i <= 6; i += 1) {
      xdo(['mousemove', String(cx + i * 10), String(cy + i * 5)]);
      await delay(80);
    }
    // 拖动必须真实生效（body.dragging 由 drag-start 接线写入），否则后续断言无意义。
    const draggingState = await waitDom(handle.cdp, '拖动未生效（body.dragging 未出现）', (s) => s.bodyDragging, 5000, 'drag');
    log.log(`drag_started visual=${draggingState.state.visual}`);
    // 按住不松：回复与结果提示都应在拖动中到达。
    const reply = await waitDom(handle.cdp, '拖动中回复未显示', (s) => s.assistantMsgs.some((m) => m.includes('隧道回复：拖动中完成')), 30000, 'drag');
    const success = await waitDom(handle.cdp, '拖动中完成未给结果提示', (s) => s.feedbackKind === 'success', 8000, 'drag');
    const duringDrag = await readDom(handle.cdp);
    assert.equal(duringDrag.bodyDragging, true, '结果提示到达时仍应处于拖动中');
    xdo(['mouseup', '1']);
    const seq = await observe(handle.cdp, 2500);
    assert.deepEqual(reactionsIn(seq), [], `拖中完成不得排回应（也不补发）；seq=${JSON.stringify(seq)}`);
    log.log(`submit=${submittedAt} reply_ms=${reply.atMs - submittedAt} success_ms=${success.atMs - submittedAt} reactions=0`);
    assert.equal(await closeWindow(handle), 0);
    log.log('PASS companion-drag');
  } catch (error) {
    log.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop();
    await flushLog(log, 'companion-drag');
  }
});

test('companion · 连点发送：busy 期间不产生第二个 POST', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip('not-run: 无显示环境');
  const log = createLog();
  let handle: Handle | undefined;
  try {
    handle = await launch(COMPANION, 'companion-double-click');
    await openPanel(handle);
    await typeAndSend(handle.cdp, '连点一句');
    const pending = await waitDom(handle.cdp, '未进入发送中', (s) => s.phase === 'pending', 8000, 'double');
    const second = await clickRect(handle.cdp, pending.state.rects.send);
    await waitDom(handle.cdp, '回复未显示', (s) => s.assistantMsgs.some((m) => m.includes('隧道回复：连点一句')), 30000, 'double');
    await delay(800);
    const requests = readRequests(handle.logFile);
    assert.equal(requests.length, 1, `连点不得发出第二个 POST，实际 ${requests.length}`);
    log.log(`second_click_at=${second} POST=${requests.length}`);
    assert.equal(await closeWindow(handle), 0);
    log.log('PASS companion-double-click');
  } catch (error) {
    log.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop();
    await flushLog(log, 'companion-double-click');
  }
});

test('companion · 素材失败：回应走既有占位、不崩溃、POST=1', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip('not-run: 无显示环境');
  const log = createLog();
  let handle: Handle | undefined;
  try {
    handle = await launch(
      { ...COMPANION, env: { PET_NEXT_REACTION_URL: 'file:///tmp/pet-next-feedback-missing-reaction.webm' } },
      'companion-missing-media',
    );
    await openPanel(handle);
    const submittedAt = await typeAndSend(handle.cdp, '素材失败一句');
    await waitDom(handle.cdp, '回复未显示', (s) => s.assistantMsgs.some((m) => m.includes('隧道回复：素材失败一句')), 30000, 'missing');
    const seq = await observe(handle.cdp, 3000);
    const visuals = [...new Set(seq.map((item) => item.visual))];
    // 缺失素材的回应属调度器内失败：播完即回 idle（不走非调度器 id 的 placeholder 分支）。
    // 用 trace 证明回应确实被提议并尝试播放（auto:reaction-N 条目）。
    const trace = await evaluate<string>(handle.cdp, "document.documentElement.dataset.trace || ''");
    assert.ok(/auto:reaction-\d+/.test(trace), `回应必须尝试播放；trace=${trace}`);
    assert.equal(readRequests(handle.logFile).length, 1);
    const alive = await readDom(handle.cdp);
    assert.equal(alive.hasPanel, true, '素材失败不得导致页面崩溃');
    log.log(`submit=${submittedAt} visuals=${JSON.stringify(visuals)} trace=${trace.slice(-120)} POST=1`);
    assert.equal(await closeWindow(handle), 0);
    log.log('PASS companion-missing-media');
  } catch (error) {
    log.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop();
    await flushLog(log, 'companion-missing-media');
  }
});

test('对照臂 · 慢回复 2.5s：无提示无回应、POST=1、自然退出零残留', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip('not-run: 无显示环境');
  const log = createLog();
  let handle: Handle | undefined;
  try {
    handle = await launch({ ...CONTROL, fakeDelayMs: SLOW_DELAY_MS }, 'control-slow');
    const opened = await openPanel(handle);
    assert.equal(opened.feedbackKind, 'absent', '对照臂不得出现反馈节点');
    const submittedAt = await typeAndSend(handle.cdp, '慢回复对照');
    const reply = await waitDom(
      handle.cdp,
      '慢回复未显示',
      (s) => s.assistantMsgs.some((m) => m.includes('隧道回复：慢回复对照')),
      40000,
      'control-slow',
    );
    const seq = await observe(handle.cdp, 2200);
    assert.deepEqual(reactionsIn(seq), [], '对照臂慢回复也不得触发回应');
    assert.equal(readRequests(handle.logFile).length, 1, '两臂各 1 POST');
    log.log(`submit=${submittedAt} reply_ms=${reply.atMs - submittedAt} POST=1 reactions=0`);
    await closeWindow(handle);
    log.log('PASS control-slow');
  } catch (error) {
    log.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop();
    await flushLog(log, 'control-slow');
  }
});

test('companion · 慢回复 2.5s：等待提示到期后成功仍提示并回应恰一次', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip('not-run: 无显示环境');
  const log = createLog();
  let handle: Handle | undefined;
  try {
    handle = await launch({ ...COMPANION, fakeDelayMs: SLOW_DELAY_MS }, 'companion-slow');
    await openPanel(handle);
    const submittedAt = await typeAndSend(handle.cdp, '慢回复一句');
    const waiting = await waitDom(handle.cdp, '等待反馈未出现', (s) => s.feedbackKind === 'waiting', 8000, 'slow');
    // 等待提示 1.6s 到期先隐藏，而请求仍在途（2.5s 后才成功）。
    const hidden = await waitDom(handle.cdp, '等待提示未按期隐藏', (s) => s.feedbackKind === 'hidden', 8000, 'slow');
    assert.ok(waiting.atMs <= hidden.atMs, '等待提示必须先可见再到期隐藏');
    assert.ok(hidden.atMs - submittedAt < SLOW_DELAY_MS, '等待提示必须在慢回复到达前到期隐藏');
    const reply = await waitDom(
      handle.cdp,
      '慢回复未显示',
      (s) => s.assistantMsgs.some((m) => m.includes('隧道回复：慢回复一句')),
      40000,
      'slow',
    );
    const success = await waitDom(handle.cdp, '慢回复成功后无提示（旧缺陷）', (s) => s.feedbackKind === 'success', 8000, 'slow');
    const react = await waitDom(handle.cdp, '慢回复成功后无回应（旧缺陷）', (s) => s.visual === 'auto', 8000, 'slow');
    const seq = await observe(handle.cdp, 2500);
    const reactions = reactionsIn(seq);
    assert.equal(reactions.length, 1, `慢回复成功必须恰好一次回应；seq=${JSON.stringify(seq)}`);
    assert.equal(readRequests(handle.logFile).length, 1, '慢回复不得增加 POST');
    log.log(
      `submit=${submittedAt} waiting_hidden_ms=${hidden.atMs - submittedAt} reply_ms=${reply.atMs - submittedAt} success_ms=${success.atMs - submittedAt} react_ms=${react.atMs - submittedAt} reaction=${reactions[0]} POST=1`,
    );
    await closeWindow(handle);
    log.log('PASS companion-slow');
  } catch (error) {
    log.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop();
    await flushLog(log, 'companion-slow');
  }
});

test('companion · 取消/重置后迟到：零回应、POST=2', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip('not-run: 无显示环境');
  const log = createLog();
  let handle: Handle | undefined;
  try {
    // 新对话按钮只在 --context=on 时存在（历史在主进程）。
    handle = await launch(
      { ...COMPANION, fakeDelayMs: SLOW_DELAY_MS, args: ['--experience=companion', '--context=on'] },
      'companion-late-drop',
    );
    await openPanel(handle);
    // 取消：慢请求被取消后，迟到结果不得触发回应或上屏。
    await typeAndSend(handle.cdp, '迟到甲');
    const pending = await waitDom(handle.cdp, '未进入发送中', (s) => s.phase === 'pending' && s.rects.cancel.visible, 8000, 'late');
    await clickRect(handle.cdp, pending.state.rects.cancel);
    await waitDom(handle.cdp, '取消提示未出现', (s) => s.feedbackKind === 'cancelled', 8000, 'late');
    await delay(3200);
    const afterCancel = await readDom(handle.cdp);
    assert.ok(!afterCancel.assistantMsgs.join('').includes('迟到甲'), '取消后的迟到回复不得上屏');
    const seqAfterCancel = await observe(handle.cdp, 1200);
    assert.deepEqual(reactionsIn(seqAfterCancel), [], '取消后的迟到结果不得触发回应');

    // 重置：等待中 reset 让在途 token 失效，迟到成功同样零回应。
    await typeAndSend(handle.cdp, '迟到乙');
    const resettable = await waitDom(handle.cdp, '新对话按钮未就绪', (s) => s.rects.reset.visible, 8000, 'late');
    const resetAt = await clickRect(handle.cdp, resettable.state.rects.reset);
    await waitDom(handle.cdp, 'reset 未清空展示', (s) => s.userMsgs.length === 0, 8000, 'late');
    await delay(3200);
    const afterReset = await readDom(handle.cdp);
    assert.equal(afterReset.assistantMsgs.length, 0, 'reset 后的迟到回复不得上屏');
    const seqAfterReset = await observe(handle.cdp, 1200);
    assert.deepEqual(reactionsIn(seqAfterReset), [], 'reset 后的迟到结果不得触发回应');
    const requests = readRequests(handle.logFile);
    assert.equal(requests.length, 2, `取消 1 + 重置 1，实际 ${requests.length}`);
    log.log(`reset_at=${resetAt} POST=${requests.length} late_cancel_reactions=0 late_reset_reactions=0`);
    await closeWindow(handle);
    log.log('PASS companion-late-drop');
  } catch (error) {
    log.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.stop();
    await flushLog(log, 'companion-late-drop');
  }
});

test('入口冒烟（Linux/Windows 同源）：正式退出零残留、无关哨兵存活', { timeout: 300000 }, async (t) => {
  if (!displayReady) return t.skip('not-run: 无显示环境');
  const log = createLog();
  let handle: Handle | undefined;
  let sentinel: Sentinel | undefined;
  try {
    handle = await launch(COMPANION, 'companion-exit-smoke');
    await openPanel(handle);
    sentinel = startSentinel();
    assert.equal(sentinel.alive(), true, '哨兵进程应先在跑');
    // closeWindow 内部断言：退出码 0、本次 PID 树全部消失、调试端口关闭；失败在 finally 清理前抛出。
    await closeWindow(handle);
    assert.equal(sentinel.alive(), true, '退出清理不得误杀无关哨兵进程');
    log.log(`exit natural ok; debug_port=${handle.debugPort} closed; sentinel_pid=${sentinel.pid} alive`);
    log.log('PASS companion-exit-smoke');
  } catch (error) {
    log.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  } finally {
    sentinel?.kill();
    if (handle) await handle.stop();
    await flushLog(log, 'companion-exit-smoke');
  }
});
