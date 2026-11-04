/**
 * M3-2 正式入口 E2E：pnpm chat:remote（fake SSH 替身 + fake 模型服务）下的真实 Electron 交互。
 * 明确测试层级：Linux + 替身，不等于 Windows 通过；Windows 由 verify-windows-chat-remote.ps1 复跑。
 * 交互全部走 CDP 真实鼠标/键盘；DOM 只读状态与矩形；不 el.click、不直接赋 value。
 * @module pet-next/tests/chat-remote.e2e
 */
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// 含空格/中文的路径必须走 fileURLToPath；URL.pathname 会给出百分号编码路径。
const petRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const display = process.env.PET_NEXT_E2E_DISPLAY ?? ':94';
const sshBin = path.join(petRoot, 'tests/support/fake-ssh-bin.sh');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tail(text: string, lines = 25): string {
  return text.split('\n').slice(-lines).join('\n');
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(120);
  }
  throw new Error(`等待超时：${label}`);
}

interface Running {
  child: ChildProcess;
  output: () => string;
  errors: () => string;
}

function launch(command: string, args: string[], options: { env: NodeJS.ProcessEnv }): Running {
  let out = '';
  let err = '';
  const child = spawn(command, args, { cwd: petRoot, env: options.env });
  child.stdout?.on('data', (chunk) => {
    out += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    err += String(chunk);
  });
  return { child, output: () => out, errors: () => err };
}

async function startFakeModel(modelId = 'qwen3.8-27b'): Promise<{ child: ChildProcess; port: number }> {
  let out = '';
  const child = spawn(process.execPath, [path.join(petRoot, 'tests/support/fake-model-service.mjs')], {
    cwd: petRoot,
    env: { ...process.env, FAKE_MODEL_DELAY_MS: '300', FAKE_MODEL_ID: modelId },
  });
  child.stdout?.on('data', (chunk) => {
    out += String(chunk);
  });
  await waitFor(() => Promise.resolve(out.includes('fake-model-ready')), 10000, 'fake 模型服务就绪');
  const line = out.split('\n').find((l) => l.includes('fake-model-ready')) ?? '{}';
  const record = JSON.parse(line.slice(line.indexOf('{'))) as { port: number };
  return { child, port: record.port };
}

/** 等入口退出：超时必须显式失败，不能返回 null 让 `code !== 0` 混过。 */
async function waitExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`入口 ${timeoutMs}ms 内未退出`)), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? null, signal: signal ?? null });
    });
  });
}

async function waitOutput(app: Running, needle: string, timeoutMs: number): Promise<void> {
  await waitFor(() => Promise.resolve(app.output().includes(needle)), timeoutMs, `stdout 出现 ${needle}`);
}

/** 从入口 NDJSON 输出里取最后一个指定事件；缺失时返回 null（调用方负责给出可读断言信息）。 */
function lastEvent(app: Running, name: string): Record<string, unknown> | null {
  const line = app
    .output()
    .split('\n')
    .filter((item) => item.includes(`"event":"${name}"`))
    .at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function findNodeEntryPid(rootPid: number): number | null {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const cmd = match[2] ?? '';
      if (cmd.includes('chat-remote.mjs') && !cmd.includes('&&') && !/^(sh|bash|dash)\b/.test(cmd.trim())) {
        // 只接受本次进程树里的 node（父链能回到 rootPid）。
        let cursor = pid;
        for (let depth = 0; depth < 6; depth += 1) {
          if (cursor === rootPid) return pid;
          try {
            const ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(cursor)], { encoding: 'utf8' }).trim());
            if (!Number.isInteger(ppid) || ppid <= 1) break;
            cursor = ppid;
          } catch {
            break;
          }
        }
      }
    }
  } catch {
    /* ps 不可用 */
  }
  return null;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ChatState {
  viewport: { w: number; h: number };
  hasPanel: boolean;
  mode: string;
  phase: string;
  isOpen: boolean;
  note: string | null;
  modeBadge: string | null;
  tag: string;
  status: string;
  bots: string[];
  errors: string[];
  rects: Record<string, Rect | null>;
}

interface Cdp {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  evaluate: <T>(expression: string) => Promise<T>;
  click: (rect: Rect) => Promise<void>;
  close: () => void;
}

const stateExpression = `(() => {
  const by = (id, cls) => document.querySelector('[data-testid="' + id + '"]') ?? document.querySelector(cls);
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const root = by('chat-panel', '.chat-panel-root');
  const body = by('chat-panel-open', '.chat-panel');
  return {
    viewport: { w: innerWidth, h: innerHeight },
    hasPanel: root instanceof HTMLElement,
    mode: root?.dataset.mode ?? '',
    phase: root?.dataset.state ?? '',
    isOpen: body instanceof HTMLElement ? !body.hidden : false,
    note: document.querySelector('.chat-note')?.textContent ?? null,
    modeBadge: document.querySelector('.chat-mode-badge')?.textContent ?? null,
    tag: document.querySelector('.chat-model-tag')?.textContent ?? document.querySelector('.chat-demo-tag')?.textContent ?? '',
    status: (document.querySelector('[data-testid="chat-status"]')?.textContent ?? '').trim(),
    bots: Array.from(document.querySelectorAll('[data-testid="chat-msg-assistant"]')).map((el) => el.textContent ?? ''),
    errors: Array.from(document.querySelectorAll('[data-testid="chat-msg-error"]')).map((el) => el.textContent ?? ''),
    rects: {
      toggle: rect(by('chat-toggle', '.chat-toggle')),
      title: rect(document.querySelector('.chat-title')),
      close: rect(by('chat-close', '.chat-close')),
      input: rect(by('chat-input', '.chat-input')),
      send: rect(by('chat-send', '.chat-send')),
      cancel: rect(by('chat-cancel', '.chat-cancel')),
    },
  };
})()`;

function inViewport(rect: Rect | null, viewport: { w: number; h: number }): boolean {
  return (
    rect !== null &&
    rect.x >= -0.5 &&
    rect.y >= -0.5 &&
    rect.x + rect.w <= viewport.w + 0.5 &&
    rect.y + rect.h <= viewport.h + 0.5
  );
}

async function connectCdp(socket: string): Promise<Cdp> {
  const ws = new WebSocket(socket);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
  });
  let seq = 0;
  const pending = new Map<number, (msg: unknown) => void>();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String((event as MessageEvent).data)) as { id?: number };
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      seq += 1;
      const id = seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} 超时（无响应）`));
      }, 10000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async <T>(expression: string): Promise<T> => {
    const res = (await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { result?: { value?: T }; exceptionDetails?: { text?: string } } };
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text ?? 'evaluate failed');
    return res.result?.result?.value as T;
  };
  const click = async (rect: Rect): Promise<void> => {
    const x = Math.round(rect.x + rect.w / 2);
    const y = Math.round(rect.y + rect.h / 2);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  return { send, evaluate, click, close: () => ws.close() };
}

async function waitForState(
  cdp: Cdp,
  label: string,
  ok: (state: ChatState) => boolean,
  timeoutMs = 20000,
): Promise<ChatState> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const state = await cdp.evaluate<ChatState>(stateExpression);
    if (ok(state)) return state;
    last = JSON.stringify({ phase: state.phase, open: state.isOpen, bots: state.bots.length });
    await sleep(150);
  }
  throw new Error(`等待超时：${label}（last=${last}）`);
}

async function resolvePageSocket(port: number): Promise<string> {
  let socket = '';
  await waitFor(
    async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = (await res.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
        const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) {
          socket = page.webSocketDebuggerUrl;
          return true;
        }
      } catch {
        /* 未就绪 */
      }
      return false;
    },
    90000,
    'CDP 页面就绪',
  );
  return socket;
}

function remoteEnv(port: number, sshLog: string, overrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DISPLAY: display,
    PET_NEXT_SSH_HOST: 'fake.example.invalid',
    PET_NEXT_SSH_PORT: '10977',
    PET_NEXT_SSH_USER: 'tester',
    PET_NEXT_SSH_BIN: sshBin,
    PET_NEXT_TUNNEL_LOCAL_PORT: String(port),
    PET_NEXT_QWEN_MODEL: 'qwen3.8-27b',
    PET_NEXT_TEST: '1',
    FAKE_SSH_LOG: sshLog,
    ...overrides,
  };
}

describe('chat:remote 正式入口（fake SSH 替身 + fake 模型）', () => {
  let fakeModel: { child: ChildProcess; port: number };
  let userData: string;
  let xvfb: ChildProcess | null = null;
  before(async () => {
    if (!existsSync(path.join(petRoot, 'dist/electron/main.js'))) {
      throw new Error('缺少 dist/electron/main.js：先 pnpm build');
    }
    execFileSync('chmod', ['+x', sshBin], { cwd: petRoot });
    xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x800x24'], { stdio: 'ignore' });
    xvfb.on('error', () => {
      xvfb = null;
    });
    await sleep(1200);
    userData = await mkdtemp(path.join(os.tmpdir(), 'pet-next-remote-e2e-'));
    fakeModel = await startFakeModel();
  });
  after(async () => {
    fakeModel.child.kill('SIGTERM');
    xvfb?.kill('SIGTERM');
    await rm(userData, { recursive: true, force: true });
  });

  test('T1 隧道 + 真实鼠标键盘：打开→输入→回复→取消→重发→关闭（退出码 0）', { timeout: 180000 }, async () => {
    const tunnelPort = await freePort();
    const debugPort = await freePort();
    const sshLog = path.join(userData, 'ssh.ndjson');
    // 无关进程哨兵：整个入口生命周期内必须存活（只清理本次进程）。
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    const app = launch('pnpm', ['chat:remote'], {
      env: remoteEnv(tunnelPort, sshLog, {
        PET_NEXT_CHAT_DEBUG_PORT: String(debugPort),
        PET_NEXT_USER_DATA: userData,
        FAKE_SSH_MODE: 'ok',
        FAKE_SSH_TARGET_PORT: String(fakeModel.port),
      }),
    });
    const cdp = await connectCdp(await resolvePageSocket(debugPort));
    try {
      let state = await waitForState(cdp, '面板挂载', (s) => s.hasPanel, 30000);
      assert.equal(state.mode, 'local');
      assert.equal(state.note, null, '真实模式不得出现"演示回复"说明');
      assert.equal(inViewport(state.rects.toggle ?? null, state.viewport), true);

      await cdp.click(state.rects.toggle as Rect);
      state = await waitForState(cdp, '面板打开', (s) => s.isOpen, 5000);
      assert.match(state.modeBadge ?? '', /隧道/, `标题徽标应标明隧道；badge=${state.modeBadge}`);
      for (const key of ['toggle', 'title', 'close', 'input', 'send']) {
        assert.equal(inViewport(state.rects[key] ?? null, state.viewport), true, `${key} 应完整在视口内`);
      }

      await cdp.click(state.rects.input as Rect);
      await cdp.send('Input.insertText', { text: '你好，测试隧道' });
      await sleep(250);
      state = await cdp.evaluate<ChatState>(stateExpression);
      await cdp.click(state.rects.send as Rect);
      state = await waitForState(cdp, '收到回复', (s) => s.bots.length > 0, 20000);
      assert.match(state.bots[0] ?? '', /隧道回复/);

      await cdp.click(state.rects.input as Rect);
      await cdp.send('Input.insertText', { text: '这句取消' });
      await sleep(250);
      state = await cdp.evaluate<ChatState>(stateExpression);
      await cdp.click(state.rects.send as Rect);
      state = await waitForState(cdp, '进入发送中', (s) => s.phase === 'pending', 5000);
      assert.equal(inViewport(state.rects.cancel ?? null, state.viewport), true);
      await cdp.click(state.rects.cancel as Rect);
      await waitForState(cdp, '显示已取消', (s) => s.status.includes('已取消') || s.phase === 'cancelled', 5000);

      state = await cdp.evaluate<ChatState>(stateExpression);
      await cdp.click(state.rects.input as Rect);
      await cdp.send('Input.insertText', { text: '取消后重发' });
      await sleep(250);
      state = await cdp.evaluate<ChatState>(stateExpression);
      await cdp.click(state.rects.send as Rect);
      state = await waitForState(cdp, '重发成功', (s) => s.bots.length >= 2, 20000);
      assert.equal(state.bots.length, 2, '旧取消请求的迟到结果不得上屏');

      // Browser.close 会断开 CDP 连接，收不到响应；不等待其返回。
      void cdp.send('Browser.close', {}).catch(() => undefined);
      const exit = await waitExit(app.child, 60000);
      assert.equal(exit.code, 0, `入口退出码应为数字 0；got code=${exit.code} signal=${exit.signal} stdout=${tail(app.output())} stderr=${tail(app.errors())}`);
      assert.match(app.output(), /chat-remote-ready/);
      assert.equal(sentinel.exitCode, null, '无关进程必须存活（只清理本次进程）');
      const sshLogText = await readFile(sshLog, 'utf8');
      assert.match(sshLogText, /fake-ssh-listening/);
      assert.match(sshLogText, /fake-ssh-stopped/, '隧道应被本次收尾关闭');
    } finally {
      cdp.close();
      if (app.child.exitCode === null) app.child.kill('SIGKILL');
      sentinel.kill('SIGKILL');
    }
  });

  test('T2 认证失败：入口非零退出、不起 Electron、不残留隧道', { timeout: 90000 }, async () => {
    const tunnelPort = await freePort();
    const debugPort = await freePort();
    const app = launch('pnpm', ['chat:remote'], {
      env: remoteEnv(tunnelPort, path.join(userData, 'ssh-fail.ndjson'), {
        PET_NEXT_CHAT_DEBUG_PORT: String(debugPort),
        PET_NEXT_USER_DATA: `${userData}-fail`,
        FAKE_SSH_MODE: 'auth-fail',
        FAKE_SSH_TARGET_PORT: String(fakeModel.port),
      }),
    });
    const exit = await waitExit(app.child, 60000);
    assert.equal(exit.code, 1, `认证失败必须退出码 1（不是 null）；got code=${exit.code} signal=${exit.signal}`);
    assert.match(app.errors(), /认证失败|auth-failed/);
    assert.ok(!app.output().includes('chat-remote-ready'), '失败时不得报就绪');
    const failedEvent = lastEvent(app, 'chat-remote-failed');
    assert.ok(failedEvent !== null, `缺少 chat-remote-failed 事件；stdout=${tail(app.output())}`);
    assert.equal(failedEvent.reason, 'auth-failed');
    // 认证失败发生在隧道句柄建立之前：没有 done 事件是正确的（否则说明句柄泄漏）。
    assert.equal(lastEvent(app, 'chat-remote-done'), null, '无隧道句柄时不应出现 done 事件');
    const listening = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: tunnelPort });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    assert.equal(listening, false, '失败后本地转发端口不应残留监听');
  });

  test('T3 空 dist 首次启动：chat:remote 自带 build，一条命令即可就绪（退出码 0）', { timeout: 180000 }, async () => {
    const mainJs = path.join(petRoot, 'dist/electron/main.js');
    await rm(mainJs, { force: true });
    assert.equal(existsSync(mainJs), false, '前置：构建产物已删除');
    const tunnelPort = await freePort();
    const debugPort = await freePort();
    const sshLog = path.join(userData, 'ssh-build.ndjson');
    const app = launch('pnpm', ['chat:remote'], {
      env: remoteEnv(tunnelPort, sshLog, {
        PET_NEXT_CHAT_DEBUG_PORT: String(debugPort),
        PET_NEXT_USER_DATA: `${userData}-build`,
        FAKE_SSH_MODE: 'ok',
        FAKE_SSH_TARGET_PORT: String(fakeModel.port),
      }),
    });
    const cdp = await connectCdp(await resolvePageSocket(debugPort));
    try {
      await waitForState(cdp, '面板挂载', (s) => s.hasPanel, 60000);
      assert.equal(existsSync(mainJs), true, 'chat:remote 应自动 pnpm build 出产物');
      void cdp.send('Browser.close', {}).catch(() => undefined);
      const exit = await waitExit(app.child, 60000);
      assert.equal(exit.code, 0, `空 dist 首次启动应成功退出；code=${exit.code}`);
    } finally {
      cdp.close();
      if (app.child.exitCode === null) app.child.kill('SIGKILL');
      // 本用例删过构建产物：无论成败都恢复，避免拖累后续用例。
      if (!existsSync(mainJs)) execFileSync('pnpm', ['build'], { cwd: petRoot, stdio: 'ignore' });
    }
  });

  test('T4 隧道启动中 Ctrl-C：退出码 130、不起 Electron、不残留端口', { timeout: 120000, skip: process.platform === 'win32' }, async () => {
    const tunnelPort = await freePort();
    const debugPort = await freePort();
    const sshLog = path.join(userData, 'ssh-cancel.ndjson');
    const app = launch('pnpm', ['chat:remote'], {
      env: remoteEnv(tunnelPort, sshLog, {
        PET_NEXT_CHAT_DEBUG_PORT: String(debugPort),
        PET_NEXT_USER_DATA: `${userData}-cancel`,
        FAKE_SSH_MODE: 'no-listen', // 隧道一直不就绪，取消必然发生在启动阶段
        FAKE_SSH_TARGET_PORT: String(fakeModel.port),
      }),
    });
    try {
      await waitOutput(app, '"event":"chat-remote-config"', 90000);
      await sleep(400);
      const nodePid = findNodeEntryPid(app.child.pid as number);
      assert.ok(nodePid !== null, '应能定位 chat-remote 进程');
      process.kill(nodePid as number, 'SIGINT');
      const exit = await waitExit(app.child, 60000);
      assert.equal(exit.code, 130, `取消应返回数字 130；got code=${exit.code} signal=${exit.signal}`);
      assert.ok(app.output().includes('"event":"chat-remote-cancelled"'), '应记录取消事件');
      assert.ok(!app.output().includes('chat-remote-ready'), '取消后不得报就绪');
      const listening = await new Promise<boolean>((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: tunnelPort });
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
      });
      assert.equal(listening, false, '取消后不得残留本地转发端口');
    } finally {
      if (app.child.exitCode === null) app.child.kill('SIGKILL');
    }
  });

  test('T5 转发的模型服务缺目标模型：退出码 1、done 退出码一致、不起 Electron', { timeout: 120000 }, async () => {
    const otherModel = await startFakeModel('other-9b');
    const tunnelPort = await freePort();
    const debugPort = await freePort();
    const sshLog = path.join(userData, 'ssh-nomodel.ndjson');
    const app = launch('pnpm', ['chat:remote'], {
      env: remoteEnv(tunnelPort, sshLog, {
        PET_NEXT_CHAT_DEBUG_PORT: String(debugPort),
        PET_NEXT_USER_DATA: `${userData}-nomodel`,
        FAKE_SSH_MODE: 'ok',
        FAKE_SSH_TARGET_PORT: String(otherModel.port),
      }),
    });
    try {
      const exit = await waitExit(app.child, 90000);
      assert.equal(exit.code, 1, `缺模型应退出码 1；got code=${exit.code}`);
      const failedEvent = lastEvent(app, 'chat-remote-failed');
      assert.ok(failedEvent !== null, `缺少 chat-remote-failed 事件；stdout=${tail(app.output())}`);
      assert.equal(failedEvent.reason, 'probe-failed');
      const doneEvent = lastEvent(app, 'chat-remote-done');
      assert.ok(doneEvent !== null, `缺少 chat-remote-done 事件；stdout=${tail(app.output())}`);
      assert.equal(doneEvent.exit, 1, 'done 退出码必须为 1');
      const listening = await new Promise<boolean>((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: tunnelPort });
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
      });
      assert.equal(listening, false, '失败后不得残留本地转发端口');
    } finally {
      otherModel.child.kill('SIGTERM');
      if (app.child.exitCode === null) app.child.kill('SIGKILL');
    }
  });
});
