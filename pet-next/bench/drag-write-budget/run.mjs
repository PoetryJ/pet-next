#!/usr/bin/env node
/**
 * M3-11 A：活跃拖动的系统写入观测（只测基线，不接候选）。
 *
 *   node bench/drag-write-budget/run.mjs --arm=baseline --source=cdp|fixture \
 *     --hz=60|125|500 --stamp=<name> --display=:141 [--moves=480] [--seed=20261110] [--probe=0|1]
 *
 * 链路（产品原样，不改一行）：pointermove → core/interaction/gesture(相对 dx/dy)
 * → app/page → preload(ipcRenderer.send 'pet:move-by') → electron/main → adapters/window/controller
 * → advanceOrigin(夹边) → BrowserWindow.setPosition。
 *
 * 唯一写入真值来源：main 在 PET_NEXT_TEST=1 时自己打印的 {event:'bounds', bounds, requested, physical}。
 * bench 不另造写入计数器。侧信道只有两条，都只读：renderer 的 pointer 观察器（CDP 注入）
 * 与 /proc/<main pid>/stat 的 jiffies 差。
 *
 * 分层标签（不许互相冒充）：
 *   native      Windows 物理鼠标 → 本机没有，not-run
 *   cdp         Input.dispatchMouseEvent 驱动真实 Electron → 合成，不是物理鼠标
 *   pure-trace  固定 seed 的确定性序列（本文件的 --source=fixture 与 trace.test.ts 的回放）
 *
 * 零真实模型：只起 tests/support/fake-model-service.mjs + fake-ssh；
 * 显式删除会指向真实服务的环境变量，并校验 posts=0。
 *
 * 产物：bench/drag-write-budget/runs/<stamp>/{summary.json,bounds.ndjson,dispatch.ndjson,
 *       pointer.ndjson,probe-setposition.ndjson,product-stdout.log,exit.txt}
 * @module pet-next/bench/drag-write-budget/run
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, delay, freePort, waitForPageSocket } from '../idle-profile/lib/cdp.mjs';
import {
  analyzePointerEvents,
  analyzeWrites,
  collectWrites,
  cpuDelta,
  extractJson,
  inputToWriteLatency,
  mean,
  median,
  parseProcStat,
  projectBudget,
  round,
  summarize,
} from './lib/analysis.mjs';
import { DEFAULT_SEED, buildScreenPath, generateTrace, serializeTrace } from './lib/trace.mjs';

const petRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const benchDir = path.join(petRoot, 'bench/drag-write-budget');
const rawArgs = process.argv.slice(2);
const value = (name, fallback) => {
  const hit = rawArgs.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

if (process.platform !== 'linux') {
  console.error('bench/drag-write-budget/run.mjs 用 /proc 与 Xvfb 读数，需要 Linux。');
  process.exit(2);
}
if (process.env.NODE_OPTIONS !== undefined) {
  console.error('先清 NODE_OPTIONS：env -u NODE_OPTIONS node bench/drag-write-budget/run.mjs ...');
  process.exit(2);
}

const arm = value('arm', 'baseline');
if (arm === 'candidate') {
  console.error('本轮只跑 --arm=baseline：候选调度器在 B/C，此时产品入口没有接线，硬跑会得到假数据。');
  process.exit(2);
}
if (arm !== 'baseline') {
  console.error('--arm 只能是 baseline');
  process.exit(2);
}
const source = value('source', 'cdp');
if (source !== 'cdp' && source !== 'fixture') {
  console.error('--source 必须是 cdp 或 fixture');
  process.exit(2);
}
const hz = Number(value('hz', '125'));
if (![60, 125, 500].includes(hz)) {
  console.error('--hz 只接受 60 / 125 / 500（500 仅机制压力，不当物理鼠标）');
  process.exit(2);
}
const moves = Number(value('moves', '480'));
if (!Number.isInteger(moves) || moves <= 0) {
  console.error('--moves 必须是正整数');
  process.exit(2);
}
const seed = Number(value('seed', String(DEFAULT_SEED)));
const runProbe = value('probe', '1') !== '0';
const display = value('display', ':141');
const displayNumber = display.startsWith(':') ? display.slice(1) : display;
const displaySocket = `/tmp/.X11-unix/X${displayNumber}`;
const stamp = value('stamp', new Date().toISOString().replace(/[:.]/g, '-'));
const outDir = path.join(benchDir, 'runs', stamp);
const BUDGET_MS = 8;
const DRAG_THRESHOLD_PX = 5;
const failures = [];
const notRun = [];

/** 单调时钟，µs 分辨率（Date.now() 只有 ms）。 */
const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const sleep = delay;

let xvfbOwned = false;
let buildInfo = { built: false, reason: 'pending' };
const cleanupHooks = [];
let cleaned = false;
function cleanupAll() {
  if (cleaned) return;
  cleaned = true;
  for (const hook of cleanupHooks.reverse()) {
    try {
      hook();
    } catch {
      /* 收尾失败不掩盖主结果 */
    }
  }
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    cleanupAll();
    process.exit(143);
  });
}

function recordFailure(message) {
  failures.push(message);
  console.error(`[drag-write-budget] 失败：${message}`);
}

function displayAlive() {
  return new Promise((resolve) => {
    const socket = net.connect({ path: displaySocket });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(300, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** 自有 Xvfb :141（1920x1080）：别人的显示号一概不碰。 */
async function ensureDisplay() {
  if (existsSync(displaySocket) && (await displayAlive())) return { owned: false };
  for (const stale of [displaySocket, `/tmp/.X${displayNumber}-lock`]) {
    if (!existsSync(stale)) continue;
    try {
      unlinkSync(stale);
    } catch {
      /* 已被他人清掉也无妨 */
    }
  }
  const child = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  cleanupHooks.push(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  });
  for (let i = 0; i < 60; i += 1) {
    if (existsSync(displaySocket)) return { owned: true };
    await sleep(100);
  }
  throw new Error(`Xvfb ${display} 10s 未就绪`);
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else if (/\.(ts|js|mjs|cjs|json|html|css)$/.test(entry.name)) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

function ensureBuild() {
  const mainJs = path.join(petRoot, 'dist/electron/main.js');
  if (existsSync(mainJs)) {
    let newest = statSync(path.join(petRoot, 'tsconfig.json')).mtimeMs;
    for (const dir of ['electron', 'app', 'core', 'adapters', 'contracts', 'scripts']) {
      newest = Math.max(newest, newestMtime(path.join(petRoot, dir)));
    }
    if (newest < statSync(mainJs).mtimeMs) return { built: false, reason: 'up-to-date' };
  }
  const started = Date.now();
  execFileSync(path.join(path.dirname(process.execPath), 'pnpm'), ['build'], {
    cwd: petRoot,
    env: { ...process.env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return { built: true, reason: 'stale-or-missing', ms: Date.now() - started };
}

function electronPreflight() {
  const binary = path.join(petRoot, 'node_modules/electron/dist/electron');
  const version = execFileSync(binary, ['--no-sandbox', '--version'], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000,
  })
    .toString()
    .trim();
  return { binary, version };
}

function gitOut(args) {
  try {
    return execFileSync('git', args, { cwd: petRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

function electronVersion() {
  try {
    return JSON.parse(readFileSync(path.join(petRoot, 'node_modules/electron/package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function xdo(args) {
  return execFileSync('xdotool', args, { env: { ...process.env, DISPLAY: display }, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

function findMainPid(tag) {
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let cmd;
    try {
      cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (cmd.includes('--type=') || !cmd.includes('electron/main.js')) continue;
    let environ = '';
    try {
      environ = readFileSync(`/proc/${entry}/environ`, 'utf8');
    } catch {
      /* 读不到 environ 的进程不认 */
    }
    if (cmd.includes(tag) || environ.includes(tag)) return Number(entry);
  }
  return null;
}

function findPetWindow(mainPid) {
  const selectors = [];
  if (mainPid !== null) selectors.push(['search', '--onlyvisible', '--pid', String(mainPid)]);
  selectors.push(['search', '--onlyvisible', '--name', 'pet-next']);
  for (const args of selectors) {
    try {
      const ids = xdo(args).split('\n').filter((item) => item.trim() !== '');
      if (ids.length > 0) return ids[ids.length - 1];
    } catch {
      /* 继续下一个选择器 */
    }
  }
  return null;
}

function windowGeometry(id) {
  try {
    const text = xdo(['getwindowgeometry', '--shell', id]);
    const map = Object.fromEntries(
      text
        .split('\n')
        .map((line) => line.split('='))
        .filter((pair) => pair.length === 2),
    );
    return { x: Number(map.X), y: Number(map.Y), width: Number(map.WIDTH), height: Number(map.HEIGHT) };
  } catch {
    return null;
  }
}

function acquireLock(lockPath) {
  if (existsSync(lockPath)) {
    const owner = Number(readFileSync(lockPath, 'utf8').trim().split('\n')[0]);
    if (Number.isFinite(owner) && owner > 0) {
      let alive = true;
      try {
        process.kill(owner, 0);
      } catch {
        alive = false;
      }
      if (alive) throw new Error(`另一个 bench 正在跑（pid ${owner}）；本机单核，必须串行。锁：${lockPath}`);
    }
  }
  writeFileSync(lockPath, `${process.pid}\n${outDir}\n`);
  cleanupHooks.push(() => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* 锁已被清理 */
    }
  });
}

function clkTick() {
  try {
    const text = execFileSync('getconf', ['CLK_TCK'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const parsed = Number(text);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
  } catch {
    return 100;
  }
}

function readStat(pid) {
  return parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
}

/** 屏幕点 → 视口内 CSS 像素（拖拽期间指针必须留在产品窗里）。 */
function clampPage(point) {
  const x = Math.min(300, Math.max(20, point.x));
  const y = Math.min(220, Math.max(20, point.y));
  return { x, y, clamped: x !== point.x || y !== point.y };
}

/** 生成待派发的位移步骤：cdp 用正弦屏幕轨迹，fixture 用固定 seed 序列。 */
function buildSteps() {
  if (source === 'fixture') {
    const trace = generateTrace({ seed, hz, moves });
    let elapsed = 0;
    const steps = trace.steps.map((step) => {
      elapsed += step.dtMs;
      return { i: step.i, tMs: elapsed, dx: step.dx, dy: step.dy };
    });
    return { steps, traceText: serializeTrace(trace), trace };
  }
  const steps = buildScreenPath({ hz, moves });
  return { steps, traceText: null, trace: null };
}

/**
 * 一次拖动：mousePressed → 按计划派发 mouseMoved → mouseReleased。
 * 屏幕目标点由“起点屏幕坐标 + 累计位移”给出，再减去当前窗口原点换成页面坐标，
 * 这样 Window 跟随指针移动不会形成正反馈（等价真实鼠标的 screen 坐标语义）。
 *
 * 派发**不逐条 await**：CDP 的 Input.dispatchMouseEvent 会等到 renderer/合成器处理完
 * 才回包，逐条 await 会把注入速率钉死在刷新率（本机实测 ~16.6ms/条）。这里按墙钟排队、
 * 只记录每条的回包延迟（dispatchAck），才能真实暴露“Chromium 是否把 pointermove 合帧”。
 * WebSocket 单连接保序，所以 mouseReleased 发在最后仍然正确。
 */
async function runDrag(cdp, steps, originRef) {
  const startScreen = { x: originRef.x + 160, y: originRef.y + 120 };
  const press = clampPage({ x: 160, y: 120 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: press.x, y: press.y, button: 'none', clickCount: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: press.x, y: press.y, button: 'left', clickCount: 1 });
  const t0 = nowMs();
  const dispatched = [];
  /** @type {number[]} */
  const ackMs = [];
  /** @type {Array<Promise<unknown>>} */
  const pending = [];
  let cumX = 0;
  let cumY = 0;
  let lastPage = press;
  let clamped = 0;
  for (const step of steps) {
    const wait = t0 + step.tMs - nowMs();
    if (wait > 0) await sleep(wait);
    cumX += step.dx;
    cumY += step.dy;
    const desired = { x: startScreen.x + cumX, y: startScreen.y + cumY };
    const page = clampPage({ x: desired.x - originRef.x, y: desired.y - originRef.y });
    if (page.clamped) clamped += 1;
    lastPage = { x: Math.round(page.x), y: Math.round(page.y) };
    const at = nowMs();
    pending.push(
      cdp
        .send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: lastPage.x,
          y: lastPage.y,
          button: 'left',
          buttons: 1,
        }, 30000)
        .then(() => {
          ackMs.push(nowMs() - at);
        })
        .catch(() => {
          /* 单条回包失败不打断整轮，最终由事件数差异暴露 */
        }),
    );
    dispatched.push({
      i: step.i,
      at: round(at - t0),
      page: lastPage,
      desired: { x: round(desired.x), y: round(desired.y) },
      origin: { x: originRef.x, y: originRef.y },
    });
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: lastPage.x,
    y: lastPage.y,
    button: 'left',
    clickCount: 1,
  }, 30000);
  await Promise.all(pending);
  return {
    dispatched,
    wallMs: nowMs() - t0,
    clampedDispatches: clamped,
    dispatchAckMs: ackMs,
  };
}

/** 直接从 src 的 pointer 观察器快照里挑出“drag-start 之后的非零位移 pointermove”。 */
function dragInputTimes(snapshot) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const moves = events.filter((event) => event.type === 'pointermove');
  const press = events.find((event) => event.type === 'pointerdown') ?? null;
  /** @type {number[]} */
  const times = [];
  let started = false;
  let prev = null;
  for (const move of moves) {
    if (!started) {
      if (press !== null && Math.hypot(move.screenX - press.screenX, move.screenY - press.screenY) >= DRAG_THRESHOLD_PX) {
        started = true;
        times.push(move.t);
        prev = move;
      } else {
        prev = move;
      }
      continue;
    }
    if (prev !== null && (move.screenX !== prev.screenX || move.screenY !== prev.screenY)) times.push(move.t);
    prev = move;
  }
  return times;
}

/** 注入只读观察器，直到页面里真的存在（loadFile 何时提交不确定，注入可能被导航清掉）。 */
async function ensureObserver(cdp) {
  const text = readFileSync(path.join(benchDir, 'inject-observe.js'), 'utf8');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const present = await cdp.evaluate('typeof window.__dragWriteObs === "object"');
      if (present === true) return true;
      await cdp.evaluate(text);
    } catch {
      /* 页面还在导航：下一轮再试 */
    }
    await sleep(200);
  }
  return false;
}

/** 独立 Electron 微基准：量 setPosition / getBounds 的单次软件耗时。 */
async function probeSetPosition() {
  const binary = path.join(petRoot, 'node_modules/electron/dist/electron');
  const entry = path.join(benchDir, 'probe-setposition-main.cjs');
  const child = spawn(binary, ['--no-sandbox', entry], {
    cwd: petRoot,
    env: { ...process.env, DISPLAY: display, PROBE_N: '300' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  /** @type {Record<string, number[]>} */
  const samples = {};
  let done = false;
  child.stdout?.on('data', (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.event === 'probe' && typeof row.us === 'number') (samples[row.mode] ??= []).push(row.us);
      if (row.event === 'probe-done') done = true;
    }
  });
  child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
  const deadline = Date.now() + 90000;
  while (!done && child.exitCode === null && Date.now() < deadline) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
  if (!done) recordFailure(`setPosition 微基准未跑完（exit=${String(child.exitCode)}）：${stderr.slice(0, 400)}`);
  const summary = {};
  for (const [mode, values] of Object.entries(samples)) {
    summary[mode] = {
      count: values.length,
      medianMs: round((median(values) ?? 0) / 1000, 4),
      minMs: round(Math.min(...values) / 1000, 4),
      maxMs: round(Math.max(...values) / 1000, 4),
      meanMs: round((mean(values) ?? 0) / 1000, 4),
    };
  }
  return { summary, raw: samples, stderr: stderr.slice(0, 2000), done };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  try {
    acquireLock(path.join(benchDir, 'runs/.lock'));
  } catch (error) {
    console.error(`[drag-write-budget] ${error.message}`);
    process.exit(3);
  }
  const xvfb = await ensureDisplay();
  xvfbOwned = xvfb.owned;
  buildInfo = ensureBuild();
  const preflight = electronPreflight();
  const cpuHz = clkTick();
  const prepared = buildSteps();
  await writeFile(path.join(outDir, 'input-plan.ndjson'), prepared.steps.map((step) => JSON.stringify(step)).join('\n') + '\n');
  if (prepared.traceText !== null) await writeFile(path.join(outDir, 'input-trace.ndjson'), prepared.traceText);

  const requestsFile = path.join(outDir, 'requests.ndjson');
  const fake = spawn(process.execPath, [path.join(petRoot, 'tests/support/fake-model-service.mjs')], {
    env: { ...process.env, FAKE_MODEL_LOG: requestsFile, FAKE_MODEL_DELAY_MS: '1500', FAKE_MODEL_MODE: 'ok' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let fakeOut = '';
  cleanupHooks.push(() => fake.kill('SIGKILL'));
  fake.stdout?.on('data', (chunk) => (fakeOut += String(chunk)));
  fake.stderr?.on('data', (chunk) => (fakeOut += String(chunk)));
  const fakePort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fake 模型未就绪：${fakeOut}`)), 15000);
    const check = () => {
      const line = fakeOut.split('\n').find((item) => item.includes('fake-model-ready'));
      if (line === undefined) return;
      clearTimeout(timer);
      resolve(JSON.parse(line.slice(line.indexOf('{'))).port);
    };
    fake.stdout?.on('data', check);
  });

  const tunnelPort = await freePort();
  const debugPort = await freePort();
  const userData = path.join(outDir, 'user-data');
  await mkdir(userData, { recursive: true });
  const env = {
    ...process.env,
    DISPLAY: display,
    PET_NEXT_SSH_HOST: 'fake.example.invalid',
    PET_NEXT_SSH_PORT: '10977',
    PET_NEXT_SSH_USER: 'tester',
    PET_NEXT_SSH_BIN: path.join(petRoot, 'tests/support/fake-ssh.mjs'),
    PET_NEXT_TUNNEL_LOCAL_PORT: String(tunnelPort),
    PET_NEXT_QWEN_MODEL: 'qwen3.8-27b',
    PET_NEXT_TEST: '1',
    PET_NEXT_CHAT_DEBUG_PORT: String(debugPort),
    PET_NEXT_USER_DATA: userData,
    FAKE_SSH_LOG: path.join(outDir, 'fake-ssh.ndjson'),
    FAKE_SSH_MODE: 'ok',
    FAKE_SSH_TARGET_PORT: String(fakePort),
  };
  // 基线臂必须没有候选开关；同时清掉会把请求带向真实服务的变量。
  for (const key of [
    'PET_NEXT_CHAT_CONTEXT',
    'PET_NEXT_EXPERIENCE',
    'PET_NEXT_PREVIEW',
    'PET_NEXT_DRAG_WRITE_BUDGET',
    'PET_NEXT_IDLE_PAUSE',
    'PET_NEXT_QWEN_BASE_URL',
    'PET_NEXT_CHAT_LOCAL',
  ]) {
    delete env[key];
  }

  let out = '';
  /** main 打印的 bounds 行：bench 侧读到的时刻（µs 分辨）与读到的块序号。 */
  const boundRecords = [];
  /** 窗口原点估计：只由 main 自己打印的 bounds 更新，不用 bench 的猜测。 */
  const originRef = { x: 0, y: 0 };
  let chunkSeq = 0;
  let stdoutBuf = '';
  let boundsLineCount = 0;
  let multiLineChunks = 0;

  const child = spawn(process.execPath, ['scripts/chat-trial.mjs'], {
    cwd: petRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  cleanupHooks.push(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    try {
      execFileSync('pkill', ['-f', outDir], { stdio: 'ignore' });
    } catch {
      /* 无匹配进程时 pkill 退 1 */
    }
  });
  const onData = (chunk) => {
    const at = nowMs();
    stdoutBuf += String(chunk);
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    const seq = chunkSeq++;
    let boundsInChunk = 0;
    for (const line of lines) {
      out += `${line}\n`;
      if (!line.includes('"event":"bounds"')) continue;
      boundsInChunk += 1;
      boundsLineCount += 1;
      boundRecords.push({ at, line, chunkSeq: seq });
      // 入口链会给子进程每一行加 `[electron] ` 前缀，所以从第一个 '{' 起解析。
      const payload = extractJson(line);
      if (payload?.bounds && Number.isFinite(payload.bounds.x) && Number.isFinite(payload.bounds.y)) {
        originRef.x = payload.bounds.x;
        originRef.y = payload.bounds.y;
      }
    }
    if (boundsInChunk > 1) multiLineChunks += 1;
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  let cdp = null;
  let mainPid = null;
  let windowId;
  let geometry;
  let snapshot;
  let drag;
  let cpu;
  let exitInfo;
  const startedAt = Date.now();

  try {
    const socket = await waitForPageSocket(debugPort, () => child.exitCode !== null, Date.now() + 150000, () => sleep(250));
    cdp = await connectCdp(socket);
    // 页面 target 出现 ≠ loadFile 已提交：注入可能落在 about:blank 上被导航清掉，所以按“存在性”重试。
    const observerOk = await ensureObserver(cdp);
    if (!observerOk) recordFailure('只读观察器注入失败（window.__dragWriteObs 不存在）');
    for (let i = 0; i < 40 && mainPid === null; i += 1) {
      await sleep(250);
      mainPid = findMainPid(outDir);
    }
    if (mainPid === null) recordFailure('找不到本轮 electron main pid');
    // 等 ready-to-show + 首帧：拖动必须在窗口已 map 后开始。
    await sleep(2500);
    windowId = findPetWindow(mainPid);
    geometry = windowId === null ? null : windowGeometry(windowId);
    if (geometry === null) {
      recordFailure('找不到产品窗几何（xdotool）');
      throw new Error('geometry-missing');
    }
    originRef.x = geometry.x;
    originRef.y = geometry.y;
    if (!(await ensureObserver(cdp))) recordFailure('拖动前观察器不在页面里');
    await cdp.evaluate('window.__dragWriteObs.reset()');

    const before = mainPid === null ? null : readStat(mainPid);
    const tDragStart = nowMs();
    drag = await runDrag(cdp, prepared.steps, originRef);
    await sleep(400);
    const tDragEnd = nowMs();
    const after = mainPid === null ? null : readStat(mainPid);

    snapshot = await cdp.evaluate('JSON.stringify(window.__dragWriteObs.snapshot())', 8000);
    const parsedSnapshot = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
    const c1 = nowMs();
    const p1 = await cdp.evaluate('window.__dragWriteObs.now()');
    const c2 = nowMs();
    const p2 = await cdp.evaluate('window.__dragWriteObs.now()');
    const offsets = [c1 - p1, c2 - p2].filter((value) => Number.isFinite(value));
    const clockOffsetMs = round(mean(offsets) ?? 0, 3);

    // 写入序列只取自 main 自己打印的 bounds 行（collectWrites 只认 event:'bounds' 且 requested 有限的那些）。
    const collected = collectWrites(boundRecords);
    const writeAnalysis = analyzeWrites(collected.writes, { windowMs: BUDGET_MS });
    const pointer = analyzePointerEvents(parsedSnapshot?.events ?? [], { windowMs: BUDGET_MS, thresholdPx: DRAG_THRESHOLD_PX });
    const inputTimes = dragInputTimes(parsedSnapshot).map((t) => t + clockOffsetMs);
    const writeTimes = boundRecords.map((record) => record.at);
    const latency = inputToWriteLatency(inputTimes, writeTimes);

    cpu = before !== null && after !== null
      ? cpuDelta(before, after, { hz: cpuHz, wallMs: tDragEnd - tDragStart, writes: collected.writes.length })
      : null;

    // 正常收尾：Escape 关窗，看产品自己退出。
    const closeStarted = Date.now();
    await Promise.race([cdp.escape().catch(() => undefined), delay(2000)]);
    const deadline = Date.now() + 15000;
    while (child.exitCode === null && Date.now() < deadline) await sleep(100);
    exitInfo = { code: child.exitCode, signal: child.signalCode, ms: Date.now() - closeStarted };
    if (child.exitCode !== 0) recordFailure(`关窗退出 code=${String(child.exitCode)}`);

    const probe = runProbe ? await probeSetPosition() : { summary: null, skipped: true };

    const posts = existsSync(requestsFile)
      ? readFileSync(requestsFile, 'utf8').split('\n').filter((line) => line.trim() !== '').length
      : 0;
    if (posts !== 0) recordFailure(`真实模型 POST 应为 0，实际 ${posts}`);

    const sameWindow = writeAnalysis.sameWindow;
    const gates = {
      multiWriteWithin8ms: {
        answer: sameWindow.pairCount > 0 ? 'yes' : 'no',
        pairCount: sameWindow.pairCount,
        ratioOfWrites: sameWindow.ratioOfWrites,
        windowMs: BUDGET_MS,
        basis: 'bench 读到 main bounds 行的相邻间隔 < 8ms（软件口径，含 IPC/stdout 跳）',
      },
      duplicateCoordinates: {
        answer: writeAnalysis.duplicateRequested.count > 0 ? 'yes' : 'no',
        count: writeAnalysis.duplicateRequested.count,
        ratio: writeAnalysis.duplicateRequested.ratio,
        distinctCoordinates: writeAnalysis.duplicateRequested.distinctCoordinates,
      },
      measurableCost: {
        answer: cpu === null ? 'not-run' : 'yes',
        mainCpuPercentOfWall: cpu?.cpuPercentOfWall ?? null,
        mainCpuSecondsPerWrite: cpu?.cpuSecondsPerWrite ?? null,
        setPositionMedianMs: probe.summary?.['setPosition']?.medianMs ?? null,
        getBoundsMedianMs: probe.summary?.['getBounds']?.medianMs ?? null,
        basis: '主进程 jiffies 差（CLK_TCK）+ 独立 Electron 微基准；两者都是软件口径，不是物理呈帧',
      },
    };

    notRun.push(
      'native：Windows 物理鼠标拖动未跑（本机无 Windows；见 README 单条复跑命令）。CDP/fixture 不能冒充物理鼠标输入率。',
      'main 内 setPosition 时间戳：产品 main 的 bounds 行不含时间，本轮的写入时刻是 bench 读取该行的时刻（上界）；单次成本另用独立微基准给出。',
    );

    const summary = {
      task: 'M3-11 A 拖动写入观测（基线，未接线候选）',
      arm,
      source,
      layer: source === 'cdp' ? 'cdp（Input.dispatchMouseEvent 合成）' : 'pure-trace（固定 seed 序列，经真实产品链派发）',
      hzRequested: hz,
      moves,
      seed: source === 'fixture' ? seed : null,
      budgetMs: BUDGET_MS,
      display,
      xvfbOwned,
      platform: `${process.platform} ${os.release()} ${os.arch()}`,
      host: os.hostname(),
      cores: os.cpus().length,
      node: process.version,
      electron: electronVersion(),
      electronPreflight: preflight.version,
      head: gitOut(['rev-parse', 'HEAD']),
      dirtyFiles: gitOut(['status', '--porcelain']).split('\n').filter(Boolean).length,
      build: buildInfo,
      productEntry: 'node scripts/chat-trial.mjs（产品正式入口；env 全部 fake，PET_NEXT_TEST=1）',
      drag: drag === undefined ? null : {
        wallMs: round(drag.wallMs),
        dispatched: drag.dispatched.length,
        clampedDispatches: drag.clampedDispatches,
        /** 注入侧实际节奏（不等回包）与每条 CDP 回包延迟：合帧发生在哪一层一眼能看出来。 */
        injectRateHz: drag.wallMs > 0 ? round(drag.dispatched.length / (drag.wallMs / 1000), 2) : null,
        dispatchAckMs: summarize(drag.dispatchAckMs ?? []),
      },
      dispatchArrival: summarize(
        drag === undefined ? [] : drag.dispatched.slice(1).map((row, index) => round((row.at ?? 0) - (drag.dispatched[index]?.at ?? 0))),
      ),
      pointer,
      writes: { ...writeAnalysis, projection8ms: projectBudget(writeTimes, BUDGET_MS) },
      boundsLineCount,
      chunksWithMultipleBoundsLines: multiLineChunks,
      stdoutChunks: chunkSeq,
      latencyInputToWrite: latency,
      clockOffsetMs,
      cpu,
      probeSetPosition: probe.summary,
      posts,
      postsGate: posts === 0 ? 'pass' : 'fail',
      gates,
      productExit: exitInfo,
      failures,
      notRun,
      command: `node bench/drag-write-budget/run.mjs --arm=${arm} --source=${source} --hz=${hz} --moves=${moves} --stamp=${stamp} --display=${display}`,
      generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
    };

    await writeFile(
      path.join(outDir, 'bounds.ndjson'),
      boundRecords
        .map((record) => JSON.stringify({ at: round(record.at), chunkSeq: record.chunkSeq, ...safeParse(record.line) }))
        .join('\n') + (boundRecords.length > 0 ? '\n' : ''),
    );
    await writeFile(
      path.join(outDir, 'dispatch.ndjson'),
      (drag?.dispatched ?? []).map((row) => JSON.stringify(row)).join('\n') + (drag ? '\n' : ''),
    );
    await writeFile(
      path.join(outDir, 'pointer.ndjson'),
      (parsedSnapshot?.events ?? []).map((event) => JSON.stringify(event)).join('\n') + '\n',
    );
    if (probe.summary !== null) {
      const rows = [];
      for (const [mode, values] of Object.entries(probe.raw ?? {})) {
        for (const us of values) rows.push(JSON.stringify({ mode, us }));
      }
      await writeFile(path.join(outDir, 'probe-setposition.ndjson'), rows.join('\n') + '\n');
    }
    await writeFile(path.join(outDir, 'product-stdout.log'), out);
    await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    if (!existsSync(requestsFile)) await writeFile(requestsFile, '');
    const exitOk = failures.length === 0 && posts === 0;
    await writeFile(
      path.join(outDir, 'exit.txt'),
      [
        `harness_exit=${exitOk ? 0 : 1}`,
        `arm=${arm} source=${source} hz=${hz} moves=${moves} display=${display}`,
        `product_exit=${String(exitInfo.code)}`,
        `posts=${posts}`,
        `writes=${writeAnalysis.count} pointermove=${pointer.pointermove}`,
        `failures=${failures.length === 0 ? 'none' : failures.join(' | ')}`,
        `not_run=${notRun.length === 0 ? 'none' : notRun.join(' | ')}`,
        '',
      ].join('\n'),
    );
    console.log(path.join(outDir, 'summary.json'));
    console.log(
      JSON.stringify({
        source,
        hz,
        pointermove: pointer.pointermove,
        writes: writeAnalysis.count,
        sameWindow8ms: sameWindow.pairCount,
        duplicateRequested: writeAnalysis.duplicateRequested.count,
        mainCpuPercentOfWall: cpu?.cpuPercentOfWall ?? null,
        setPositionMedianMs: probe.summary?.['setPosition']?.medianMs ?? null,
        posts,
        failures,
      }),
    );
    if (!exitOk) process.exitCode = 1;
  } catch (error) {
    recordFailure(String(error?.message ?? error));
    await writeFile(path.join(outDir, 'product-stdout.log'), out);
    await writeFile(
      path.join(outDir, 'exit.txt'),
      [`harness_exit=1`, `failures=${failures.join(' | ')}`, ''].join('\n'),
    );
    process.exitCode = 1;
  } finally {
    cdp?.close();
    cleanupAll();
  }
}

function safeParse(line) {
  const payload = extractJson(line);
  return payload === null ? { raw: line } : payload;
}

await main();
