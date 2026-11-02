#!/usr/bin/env node
/**
 * M3-1 真实产品路径诊断（真 Electron + 真实 Qwen 服务 + chat:local 正式入口）。
 *
 * 为什么是脚本不是测试：它会产生真实模型调用与计费，绝不能进 CI 默认套件。
 * 默认 dry-run；`--run` 才执行；每次发送都先查全局预算（run-log.ndjson 累计 ≤30）。
 *
 * 三条路径（负责人指定，最少 3 次真实调用）：
 *   P1 正常回复       输入 → 发送 → 面板出现真实模型回复（无"演示回复"标注）
 *   P2 取消后重发     发送 → 在途取消 → 立刻重发 → 新回复上屏、旧迟到回复不上屏
 *   P3 关窗收尾       发送后在途关窗 → 退出码 0、无残留进程/端口
 *
 * 交互一律真实输入事件（CDP Input.dispatchMouseEvent / insertText / dispatchKeyEvent），
 * DOM 只读。观测口径：UI 层可见文本 + 发送点击到文本上屏的耗时；HTTP 状态/finish_reason/usage
 * 在 UI 层不可见，一律记 unknown（不编造）。
 *
 * 用法：
 *   node tests/chat-evidence/qwen/product-paths.mjs                 # dry-run
 *   node tests/chat-evidence/qwen/product-paths.mjs --run --path=reply
 *   node tests/chat-evidence/qwen/product-paths.mjs --run --all
 * 环境：DISPLAY 默认 :94（自起自收）；PATH 需含 node 24.14.0 与 pnpm。
 * @module pet-next/tests/chat-evidence/qwen/product-paths
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const petRoot = path.resolve(here, '../../..');
const runLogPath = path.join(here, 'run-log.ndjson');
const commandsPath = path.join(here, 'commands.txt');
const screenshotDir = path.join(here, 'screenshots');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const hit = argv.find((item) => item.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const run = flag('run');
const runAll = flag('all');
const only = opt('path', 'reply');
const display = opt('display', process.env.PET_NEXT_E2E_DISPLAY ?? ':94');
const budget = Number(opt('budget', '30'));
const BUDGET_MARGIN = 0; // 不预留：产品路径本身就是最后 9 次预算的用途。

const paths = runAll ? ['reply', 'cancel-resend', 'quit-inflight'] : [only];

/* ===== 预算：以 run-log.ndjson 为准，跨脚本累计 ===== */
function readRecords() {
  if (!existsSync(runLogPath)) return [];
  const rows = [];
  for (const line of readFileSync(runLogPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // 半行忽略。
    }
  }
  return rows;
}

function appendRecord(record) {
  const fd = openSync(runLogPath, 'a');
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function logCommand(command, exitCode, note) {
  const fd = openSync(commandsPath, 'a');
  try {
    writeSync(fd, `[${new Date().toISOString()}] exit=${exitCode} ${note ? `${note} :: ` : ''}${command}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const used = readRecords().length;

/* ===== 小工具 ===== */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tail = (text, max = 1800) => (text.length > max ? `…${text.slice(-max)}` : text);

function freePort() {
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

function portListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (value) => {
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

/* ===== Xvfb :94（自起自收） ===== */
let xvfb = null;
function startXvfb() {
  const suffix = display.startsWith(':') ? display.slice(1) : display;
  const socket = `/tmp/.X11-unix/X${suffix}`;
  if (existsSync(socket)) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const proc = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    xvfb = proc;
    const deadline = Date.now() + 8000;
    const poll = () => {
      if (existsSync(socket)) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline || proc.exitCode !== null) {
        reject(new Error(`Xvfb ${display} 起不来`));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

function stopXvfb() {
  if (xvfb === null) return;
  xvfb.kill('SIGTERM');
  xvfb = null;
}

/* ===== 启动 chat:local（正式入口，自己 build） ===== */
function pnpmPath() {
  const beside = path.join(path.dirname(process.execPath), 'pnpm');
  return existsSync(beside) ? beside : 'pnpm';
}

function startTracked(command, args, env, label) {
  const child = spawn(command, args, { cwd: petRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    label,
    stdout: () => stdout,
    stderr: () => stderr,
    stop() {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
    },
  };
}

async function waitForChildExit(child, timeoutMs) {
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

/* ===== CDP ===== */
async function connectCdp(url) {
  const ws = new WebSocket(url);
  let next = 0;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error(`cdp connect failed: ${url}`)));
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
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

async function waitForPageSocket(port, tracked, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no targets';
  while (Date.now() < deadline) {
    if (tracked.child.exitCode !== null || tracked.child.signalCode !== null) {
      throw new Error(`入口在暴露 CDP 前退出\nstdout:\n${tail(tracked.stdout())}\nstderr:\n${tail(tracked.stderr())}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page !== undefined) return page.webSocketDebuggerUrl;
      lastError = `targets=${JSON.stringify(list.map((item) => item.type))}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(80);
  }
  throw new Error(`CDP page 未就绪（${lastError}）\nstdout:\n${tail(tracked.stdout())}`);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed');
  }
  return result.result?.value;
}

/* ===== 面板只读快照（data-testid 优先，class 兜底；C 的面板用 class） ===== */
const DOM_EXPRESSION = `(() => {
  const pick = (testid, cls) => document.querySelector('[data-testid="' + testid + '"]') || document.querySelector(cls);
  const rect = (el) => {
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, disabled: el instanceof HTMLButtonElement ? el.disabled : null };
  };
  const root = pick('chat-panel', '.chat-panel-root');
  const input = pick('chat-input', '.chat-input');
  const texts = (sel) => Array.from(document.querySelectorAll(sel)).map((n) => (n.textContent ?? '').trim());
  const botEntries = Array.from(document.querySelectorAll('[data-testid="chat-msg-assistant"], .chat-entry-bot'));
  return {
    readyState: document.readyState,
    mounted: root !== null,
    mode: root instanceof HTMLElement ? (root.dataset.mode ?? '') : '',
    phase: root instanceof HTMLElement ? (root.dataset.state ?? '') : '',
    panelHidden: (() => { const p = pick('chat-panel-open', '.chat-panel-root .chat-body'); return p instanceof HTMLElement ? p.hidden : null; })(),
    toggle: rect(pick('chat-toggle', '.chat-toggle')),
    input: rect(input),
    send: rect(pick('chat-send', '.chat-send')),
    cancel: rect(pick('chat-cancel', '.chat-cancel')),
    close: rect(pick('chat-close', '.chat-close')),
    inputValue: input instanceof HTMLTextAreaElement ? input.value : null,
    userMsgs: texts('[data-testid="chat-msg-user"], .chat-entry-user'),
    botMsgs: botEntries.map((n) => (n.textContent ?? '').trim()),
    modelTagCount: document.querySelectorAll('.chat-model-tag').length,
    demoTagsBefore: 0,
    demoTagCount: document.querySelectorAll('.chat-demo-tag').length,
    statusMsgs: texts('[data-testid="chat-status"], .chat-entry-status'),
    errorMsgs: texts('[data-testid="chat-msg-error"], .chat-entry-error'),
    note: (() => { const n = document.querySelector('.chat-note'); return n === null ? null : (n.textContent ?? '').trim(); })(),
    info: document.title,
  };
})()`;

async function readDom(cdp) {
  return evaluate(cdp, DOM_EXPRESSION);
}

async function pollUntil(label, read, ok, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (ok(last)) return last;
    await delay(50);
  }
  throw new Error(`${label}（${timeoutMs}ms 超时）\nlast=${JSON.stringify(last)}`);
}

async function click(cdp, rect, label) {
  if (rect === null) throw new Error(`${label} 不存在`);
  const x = Math.round(rect.cx);
  const y = Math.round(rect.cy);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await delay(20);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function pressKey(cdp, key, code, vk) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function typeMessage(cdp, text) {
  const state = await readDom(cdp);
  await click(cdp, state.input, 'chat-input');
  const length = state.inputValue?.length ?? 0;
  if (length > 0) {
    await pressKey(cdp, 'End', 'End', 35);
    for (let i = 0; i < length; i += 1) await pressKey(cdp, 'Backspace', 'Backspace', 8);
  }
  await cdp.send('Input.insertText', { text });
  await pollUntil('输入回读不一致', () => readDom(cdp), (snapshot) => snapshot.inputValue === text, 8000);
}

async function screenshot(cdp, name) {
  mkdirSync(screenshotDir, { recursive: true });
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (typeof result.data !== 'string' || result.data.length === 0) throw new Error(`截图失败 ${name}`);
  writeFileSync(path.join(screenshotDir, name), Buffer.from(result.data, 'base64'));
  return `tests/chat-evidence/qwen/screenshots/${name}`;
}

/* ===== 进程/端口残留检查 ===== */
function readCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return '';
  }
}

function pidsWithArg(needle) {
  const found = [];
  let names;
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

async function launch(label) {
  const userData = await (async () => {
    const dir = path.join(tmpdir(), `pet-next-qwen-e2e-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  })();
  const debugPort = await freePort();
  const env = { ...process.env, DISPLAY: display, PET_NEXT_TEST: '1', PET_NEXT_CHAT_DEBUG_PORT: String(debugPort), PET_NEXT_USER_DATA: userData };
  delete env.PET_NEXT_CHAT_PREVIEW;
  delete env.PET_NEXT_CHAT_FAKE_URL;
  const tracked = startTracked(pnpmPath(), ['chat:local'], env, label);
  const socket = await waitForPageSocket(debugPort, tracked, 180000);
  const cdp = await connectCdp(socket);
  try {
    await cdp.send('Page.enable');
  } catch {
    // 截图失败会在后面显式报错。
  }
  return { tracked, cdp, debugPort, userData };
}

async function openPanel(cdp) {
  await pollUntil('聊天面板未挂载（chat:local 未生效或接线缺失）', () => readDom(cdp), (s) => s.mounted, 30000);
  const state = await readDom(cdp);
  if (state.panelHidden === true) await click(cdp, state.toggle, 'chat-toggle');
  const opened = await pollUntil(
    '面板未打开',
    () => readDom(cdp),
    (s) => s.mounted && s.input !== null && (s.panelHidden === null ? s.phase !== 'closed' : s.panelHidden === false),
    15000,
  );
  return opened;
}

/* ===== 预算守卫 ===== */
function budgetLeft() {
  return budget - readRecords().length - BUDGET_MARGIN;
}

function recordProduct(entry) {
  const rows = readRecords();
  const seq = rows.length + 1;
  const record = {
    seq,
    ts: new Date().toISOString(),
    kind: 'product',
    keys: 'unknown',
    usage: 'unknown',
    note: 'UI 层观测：HTTP 状态 / finish_reason / usage 在页面不可见，记 unknown（不编造）',
    ...entry,
  };
  appendRecord(record);
  console.log(`[product #${seq}] ${record.key} → ${record.outcome} uiLatency=${record.uiLatencyMs ?? 'null'}ms reply=${record.replyChars ?? 'null'}字`);
  return record;
}

/* ===== 三条路径 ===== */

/**
 * 回复到达判定：新增一条助手消息（或出现错误），且不再有"发送中"状态。
 * 不能要求 statusMsgs 全空——"已取消"是历史状态条目，会一直留在面板上。
 */
function repliedSince(baselineCount) {
  return (state) =>
    (state.botMsgs.length > baselineCount || state.errorMsgs.length > 0) &&
    !state.statusMsgs.some((msg) => msg.includes('发送中'));
}

async function pathReply() {
  const session = await launch('qwen-product-reply');
  const screenshots = [];
  try {
    const opened = await openPanel(session.cdp);
    const prompt = '你好呀，今天过得怎么样？';
    await typeMessage(session.cdp, prompt);
    const before = await readDom(session.cdp);
    if (budgetLeft() <= 0) throw new Error(`预算不足：已用 ${readRecords().length}/${budget}，禁止发起真实调用`);
    const startedAt = Date.now();
    await click(session.cdp, before.send, 'chat-send');
    const replied = await pollUntil('真实模型回复未上屏', () => readDom(session.cdp), repliedSince(0), 40000);
    const uiLatencyMs = Date.now() - startedAt;
    screenshots.push(await screenshot(session.cdp, 'p1-reply.png'));
    const replyText = replied.botMsgs[replied.botMsgs.length - 1] ?? '';
    recordProduct({
      key: 'product/reply',
      prompt,
      replyText,
      replyChars: replyText.length,
      outcome: replied.errorMsgs.length > 0 ? 'ui-error' : 'ok',
      uiLatencyMs,
      finishReason: 'unknown',
      mode: replied.mode,
      modelTagCount: replied.modelTagCount,
      demoTagCount: replied.demoTagCount,
      panelNote: replied.note,
      screenshots,
      checks: {
        noDemoTag: replied.demoTagCount === 0,
        modeIsLocal: replied.mode === 'local',
        noError: replied.errorMsgs.length === 0,
      },
    });
    await evaluate(session.cdp, 'window.pet.quit()');
    const exit = await waitForChildExit(session.tracked.child, 40000);
    return { exit, screenshots, detail: { mode: replied.mode, modelTagCount: replied.modelTagCount, demoTagCount: replied.demoTagCount, note: replied.note, phase: replied.phase, opened: opened.phase } };
  } finally {
    session.cdp.close();
    session.tracked.stop();
  }
}

async function pathCancelResend() {
  const session = await launch('qwen-product-cancel');
  const screenshots = [];
  try {
    await openPanel(session.cdp);
    const prompt = '慢慢说说你最喜欢的一个季节，多说几句。';
    await typeMessage(session.cdp, prompt);
    const before = await readDom(session.cdp);
    if (budgetLeft() <= 0) throw new Error(`预算不足：已用 ${readRecords().length}/${budget}`);
    const sentAt = Date.now();
    await click(session.cdp, before.send, 'chat-send');
    const pending = await pollUntil('未进入在途态', () => readDom(session.cdp), (s) => s.phase === 'pending' || s.statusMsgs.some((m) => m.includes('发送中')), 15000);
    screenshots.push(await screenshot(session.cdp, 'p2-01-pending.png'));
    await click(session.cdp, pending.cancel, 'chat-cancel');
    const cancelled = await pollUntil('取消后未显示已取消', () => readDom(session.cdp), (s) => s.phase === 'cancelled' || s.statusMsgs.some((m) => m.includes('已取消')), 10000);
    screenshots.push(await screenshot(session.cdp, 'p2-02-cancelled.png'));
    const prompt2 = '刚才那句不用了，现在说一句简短的问候。';
    await typeMessage(session.cdp, prompt2);
    const before2 = await readDom(session.cdp);
    if (budgetLeft() <= 0) throw new Error(`预算不足：已用 ${readRecords().length}/${budget}`);
    const resendAt = Date.now();
    await click(session.cdp, before2.send, 'chat-send');
    const replied = await pollUntil(
      '取消后重发未得到回复',
      () => readDom(session.cdp),
      repliedSince(before2.botMsgs.length),
      40000,
    );
    screenshots.push(await screenshot(session.cdp, 'p2-03-resend.png'));
    await delay(2500); // 留出旧请求迟到响应窗口
    const after = await readDom(session.cdp);
    // 迟到泄漏判定：重发后助手消息只应比取消前多 1 条（那条是新回复）。
    const lateLeak = after.botMsgs.length > before.botMsgs.length + 1;
    // 两次发送都是真实调用，必须各记一条（预算是按调用计，不是按路径计）。
    recordProduct({
      key: 'product/cancel',
      prompt,
      replyText: null,
      replyChars: null,
      outcome: 'cancelled',
      uiLatencyMs: null,
      finishReason: 'unknown',
      mode: cancelled.mode,
      cancelLatencyMs: Date.now() - sentAt,
      screenshots,
      checks: {
        cancelledShown: cancelled.statusMsgs.some((m) => m.includes('已取消')) || cancelled.phase === 'cancelled',
        cancelButtonDisabledAfter: cancelled.cancel?.disabled === true,
      },
    });
    recordProduct({
      key: 'product/resend-after-cancel',
      prompt: prompt2,
      replyText: replied.botMsgs[replied.botMsgs.length - 1] ?? '',
      replyChars: (replied.botMsgs[replied.botMsgs.length - 1] ?? '').length,
      outcome: replied.errorMsgs.length > 0 ? 'ui-error' : 'ok',
      uiLatencyMs: Date.now() - resendAt,
      finishReason: 'unknown',
      mode: replied.mode,
      originalPrompt: prompt,
      screenshots,
      checks: {
        noLateLeak: !lateLeak,
        noError: after.errorMsgs.length === 0,
        assistantMsgCount: after.botMsgs.length,
      },
    });
    await evaluate(session.cdp, 'window.pet.quit()');
    const exit = await waitForChildExit(session.tracked.child, 40000);
    return { exit, screenshots, detail: { mode: replied.mode, demoTagCount: replied.demoTagCount, modelTagCount: replied.modelTagCount, botMsgs: after.botMsgs, statusMsgs: after.statusMsgs } };
  } finally {
    session.cdp.close();
    session.tracked.stop();
  }
}

async function pathQuitInflight() {
  const session = await launch('qwen-product-quit');
  const screenshots = [];
  try {
    await openPanel(session.cdp);
    const prompt = '给我讲一个稍微长一点的故事开头。';
    await typeMessage(session.cdp, prompt);
    const before = await readDom(session.cdp);
    if (budgetLeft() <= 0) throw new Error(`预算不足：已用 ${readRecords().length}/${budget}`);
    const sentAt = Date.now();
    await click(session.cdp, before.send, 'chat-send');
    await pollUntil('未进入在途态（无法测试在途关窗）', () => readDom(session.cdp), (s) => s.phase === 'pending' || s.statusMsgs.some((m) => m.includes('发送中')), 15000);
    screenshots.push(await screenshot(session.cdp, 'p3-01-pending-before-quit.png'));
    await evaluate(session.cdp, 'window.pet.quit()');
    const exit = await waitForChildExit(session.tracked.child, 40000);
    // 残留检查：调试端口关闭 + 无带本端口的游离进程。
    const deadline = Date.now() + 8000;
    let listening = await portListening(session.debugPort);
    while (listening && Date.now() < deadline) {
      await delay(150);
      listening = await portListening(session.debugPort);
    }
    const stray = pidsWithArg(`--remote-debugging-port=${session.debugPort}`);
    recordProduct({
      key: 'product/quit-inflight',
      prompt,
      replyText: null,
      replyChars: null,
      outcome: exit.code === 0 && !listening && stray.length === 0 ? 'ok' : 'failed',
      uiLatencyMs: null,
      finishReason: 'unknown',
      sentToQuitMs: Date.now() - sentAt,
      screenshots,
      checks: { exitCode: exit.code, exitSignal: exit.signal, debugPortStillListening: listening, strayPids: stray },
    });
    return { exit, screenshots, detail: { debugPortStillListening: listening, strayPids: stray } };
  } finally {
    session.cdp.close();
    session.tracked.stop();
  }
}

async function main() {
  const planned = paths.length;
  console.log('M3-1 真实产品路径诊断（chat:local + 真 Electron + 真实 Qwen）');
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`DISPLAY: ${display}   入口: pnpm chat:local`);
  console.log(`预算: 已用 ${used}/${budget}，本次计划 ${planned} 条路径（每条最多 2 次真实调用）`);
  if (!run) {
    console.log('路径:');
    for (const name of paths) console.log(`  - ${name}`);
    console.log('');
    console.log('DRY RUN：未启动 Electron、未发起任何真实调用。加 --run 执行。');
    logCommand(`node tests/chat-evidence/qwen/product-paths.mjs ${argv.join(' ')}`, 0, 'dry-run（零真实调用）');
    return 0;
  }
  if (budgetLeft() <= 0) {
    console.error(`预算不足：已用 ${used}/${budget}，拒绝执行`);
    return 2;
  }

  await startXvfb();
  const results = [];
  try {
    for (const name of paths) {
      console.log(`\n=== ${name}`);
      let result;
      if (name === 'reply') result = await pathReply();
      else if (name === 'cancel-resend') result = await pathCancelResend();
      else if (name === 'quit-inflight') result = await pathQuitInflight();
      else throw new Error(`未知路径 ${name}`);
      results.push({ name, ...result });
      console.log(`=== ${name} exit=${String(result.exit.code)}/${String(result.exit.signal)} ${JSON.stringify(result.detail)}`);
      await delay(800);
    }
    console.log('\n汇总:');
    for (const item of results) console.log(`  ${item.name}: exit=${String(item.exit.code)} ${JSON.stringify(item.detail?.checks ?? {})}`);
    logCommand(`node tests/chat-evidence/qwen/product-paths.mjs ${argv.join(' ')}`, 0, `产品路径 ${paths.join(',')}`);
    return 0;
  } finally {
    stopXvfb();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    logCommand(`node tests/chat-evidence/qwen/product-paths.mjs ${argv.join(' ')}`, 1, `失败：${error instanceof Error ? error.message : String(error)}`);
    stopXvfb();
    process.exit(1);
  },
);
