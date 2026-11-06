#!/usr/bin/env node
/**
 * M3-8 C：桌宠待机资源画像 + 单一候选（隐藏态暂停播放器）对照。
 *
 *   node bench/idle-profile/run.mjs --arm=baseline|candidate --seconds=60 --warmup=8 --display=:97
 *   可选：--state=visible|hidden  --probe=click,recovery,drag,close  --stamp=<目录名>  --preview=<令牌>
 *
 * 一支臂 = 一次产品入口（node scripts/chat-trial.mjs，构建由本脚本预先做一次）+
 * fake 模型 + fake ssh，零真实推理。进程按角色分账（main/renderer/gpu/utility/
 * zygote/cli/fake-*），RSS 明确为**进程 RSS 求和**，CPU 为 /proc jiffies 差。
 *
 * 候选只在 --arm=candidate 时由 CDP 注入 experiments/idle-profile/hidden-pause.js；
 * baseline 只注入只读观察器。默认关闭，不改产品开关。
 *
 * 产物：bench/idle-profile/runs/<stamp>/<arm>/{samples.json,summary.json,requests.ndjson,exit.txt}
 * 另附 product-stdout.log / fake-model.log，供复核。
 * @module pet-next/bench/idle-profile/run
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, delay, freePort, waitForPageSocket } from './lib/cdp.mjs';
import { HZ, sampleRoles } from './lib/proc-roles.mjs';

const petRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const rawArgs = process.argv.slice(2);
const value = (name, fallback) => {
  const hit = rawArgs.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

if (process.platform !== 'linux') {
  console.error('bench/idle-profile/run.mjs 只用 /proc 读数，需要 Linux。');
  process.exit(2);
}
if (process.env.NODE_OPTIONS !== undefined) {
  console.error('先清 NODE_OPTIONS：env -u NODE_OPTIONS node bench/idle-profile/run.mjs ...');
  process.exit(2);
}

const arm = value('arm', 'baseline');
if (arm !== 'baseline' && arm !== 'candidate') {
  console.error('--arm 必须是 baseline 或 candidate');
  process.exit(2);
}
const seconds = Number(value('seconds', '60'));
const warmupSec = Number(value('warmup', '8'));
const state = value('state', 'visible');
if (state !== 'visible' && state !== 'hidden') {
  console.error('--state 必须是 visible 或 hidden');
  process.exit(2);
}
const probes = new Set(value('probe', 'click,recovery,drag,close').split(',').filter(Boolean));
const preview = value('preview', '');
const display = value('display', ':97');
const stamp = value('stamp', new Date().toISOString().replace(/[:.]/g, '-'));
const displayNumber = display.startsWith(':') ? display.slice(1) : display;
const displaySocket = `/tmp/.X11-unix/X${displayNumber}`;
const outDir = path.join(petRoot, 'bench/idle-profile/runs', stamp, arm);
const failures = [];
const notRun = [];
/** 产物里要写的环境归属（main 内赋值）。 */
let xvfbOwnedFlag = false;
let buildInfo = { built: false, reason: 'pending' };

/** 收尾钩子：正常结束、异常、以及被 timeout/CI 打断时都要把 GUI 清干净。 */
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

const sleep = delay;

function recordFailure(message) {
  failures.push(message);
  console.error(`[idle-profile] 失败：${message}`);
}

/** socket 文件存在 ≠ 服务活着（上次被杀会留下 stale socket），用一次连接探活。 */
function displayAlive() {
  return new Promise((resolve) => {
    const socket = net.connect({ path: displaySocket });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** 自有 Xvfb：只有探活失败才起，起过才收（不碰他人 display，也不复用别人的）。 */
async function ensureDisplay() {
  if (existsSync(displaySocket) && (await displayAlive())) return { owned: false, child: null };
  if (existsSync(displaySocket)) {
    // 无服务进程的残留 socket/lock 会让 Xvfb 拒绝启动（"Server is already active"）。
    try {
      unlinkSync(displaySocket);
    } catch {
      /* 已被他人清掉也无妨 */
    }
  }
  const lockFile = `/tmp/.X${displayNumber}-lock`;
  if (existsSync(lockFile)) {
    try {
      unlinkSync(lockFile);
    } catch {
      /* 同上 */
    }
  }
  const child = spawn('Xvfb', [display, '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  for (let i = 0; i < 60; i += 1) {
    if (existsSync(displaySocket)) return { owned: true, child };
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

/** 同一时刻只跑一个 GUI；构建只做一次，避免每次臂测都吃 18s CPU。 */
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

/** 起跑前确认 electron 能加载（本机曾出现过一次 loader 抖动，失败即报错而非空跑）。 */
function electronPreflight() {
  const binary = path.join(petRoot, 'node_modules/electron/dist/electron');
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const version = execFileSync(binary, ['--no-sandbox', '--version'], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      })
        .toString()
        .trim();
      return { binary, version, attempt };
    } catch (error) {
      if (attempt === 2) throw new Error(`electron preflight 失败：${error?.stderr?.toString?.() ?? error.message}`);
    }
  }
  return null;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
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

/** 只按本轮的 electron main pid 找窗口（同名窗口不认，避免误 unmap 别人的 GUI）。 */
function findMainPid(tag) {
  let entries = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let cmd = '';
    try {
      cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (cmd.includes('--type=') || !cmd.includes('electron/main.js')) continue;
    // 产品用 PET_NEXT_USER_DATA 注入本轮唯一目录，cmdline 里没有该路径，必须看 environ。
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

/** 拉取页面快照；renderer 冻结时不能把整轮采样拖死。 */
async function snapshot(cdp, timeoutMs = 4000) {
  try {
    return await cdp.evaluate('window.__idleProfile ? window.__idleProfile.snapshot() : null', timeoutMs);
  } catch (error) {
    recordFailure(`snapshot: ${error.message}`);
    return null;
  }
}

const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;

/**
 * 单核机器上绝不允许两个 GUI 同时跑：runs/.lock 里存 owner pid。
 * 进程已死则视为残留锁并接管。
 */
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

async function main() {
  await mkdir(outDir, { recursive: true });
  try {
    acquireLock(path.join(petRoot, 'bench/idle-profile/runs/.lock'));
  } catch (error) {
    console.error(`[idle-profile] ${error.message}`);
    process.exit(3);
  }
  const xvfb = await ensureDisplay();
  xvfbOwnedFlag = xvfb.owned;
  cleanupHooks.push(() => {
    if (!xvfb.owned) return;
    try {
      process.kill(-xvfb.child.pid, 'SIGKILL');
    } catch {
      try {
        xvfb.child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  });
  buildInfo = ensureBuild();
  const preflight = electronPreflight();

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
    const timer = setTimeout(() => reject(new Error(`fake 模型未就绪：${fakeOut}`)), 10000);
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
  delete env.PET_NEXT_CHAT_CONTEXT;
  delete env.PET_NEXT_EXPERIENCE;
  delete env.PET_NEXT_PREVIEW;
  if (preview !== '') env.PET_NEXT_PREVIEW = preview;

  let out = '';
  const startedAt = Date.now();
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
  child.stdout?.on('data', (chunk) => (out += String(chunk)));
  child.stderr?.on('data', (chunk) => (out += String(chunk)));

  let cdp = null;
  const samples = [];
  const frameRates = [];
  const probesResult = {};
  /** 单个探针失败只记该探针，不拖垮整轮（失败也必须留证据）。 */
  const runProbe = async (name, fn) => {
    try {
      probesResult[name] = await fn();
    } catch (error) {
      recordFailure(`probe ${name}: ${error?.message ?? error}`);
      probesResult[name] = { error: String(error?.message ?? error) };
    }
  };
  let hiddenSignal = 'not-applied';
  let windowId = null;
  let mainPid = null;
  let pageAtMs = null;
  let productExit = null;

  try {
    const socket = await waitForPageSocket(debugPort, () => child.exitCode !== null, Date.now() + 150000);
    pageAtMs = Date.now() - startedAt;
    cdp = await connectCdp(socket);
    mainPid = findMainPid(outDir);
    for (let i = 0; i < 20 && mainPid === null; i += 1) {
      await sleep(250);
      mainPid = findMainPid(outDir);
    }
    if (mainPid === null) recordFailure('找不到本轮 electron main pid，unmap 退回按窗口名匹配（有误伤他人 GUI 的风险）');
    for (const script of ['inject-observe.js']) {
      const text = readFileSync(path.join(petRoot, 'bench/idle-profile', script), 'utf8');
      const applied = await cdp.evaluate(text);
      if (applied !== 'ok' && applied !== 'already') recordFailure(`注入 ${script} 返回 ${String(applied)}`);
    }
    if (arm === 'candidate') {
      const text = readFileSync(path.join(petRoot, 'experiments/idle-profile/hidden-pause.js'), 'utf8');
      const applied = await cdp.evaluate(text);
      if (applied !== 'ok') recordFailure(`注入候选失败：${String(applied)}`);
    }
    const first = await snapshot(cdp);
    await sleep(warmupSec * 1000);

    // 状态：可见 = 保持原样；隐藏 = X11 unmap 产品窗，再看 visibilityState 是否翻转。
    if (state === 'hidden') {
      windowId = findPetWindow(mainPid);
      if (windowId === null) {
        recordFailure('找不到产品窗（xdotool search pet-next/electron 都为空）');
        hiddenSignal = 'window-not-found';
      } else {
        xdo(['windowunmap', windowId]);
        const deadline = Date.now() + 3000;
        let current = await snapshot(cdp);
        while (Date.now() < deadline) {
          if (current?.visibility === 'hidden') break;
          await sleep(150);
          current = await snapshot(cdp);
        }
        if (current?.visibility === 'hidden') {
          hiddenSignal = 'visibilityState';
        } else {
          hiddenSignal = 'unmapped-only';
          if (arm === 'candidate') {
            // 无窗口管理器的 Xvfb 上 Chromium 不报 hidden；由 bench 显式触发同一原型。
            await cdp.evaluate('window.__idleProfileHiddenPause.setHidden(true)');
            await sleep(300);
          }
        }
      }
      await sleep(1000);
    }

    let prev = sampleRoles(child.pid, [
      { pid: fake.pid, role: 'fake-model' },
    ]);
    let prevAt = Date.now();
    for (let tick = 0; tick < seconds; tick += 1) {
      await sleep(1000);
      if (child.exitCode !== null) {
        recordFailure(`采样中入口退出 code=${child.exitCode}`);
        break;
      }
      const now = sampleRoles(child.pid, [{ pid: fake.pid, role: 'fake-model' }]);
      const at = Date.now();
      const wallSec = (at - prevAt) / 1000;
      const roles = {};
      for (const [role, data] of Object.entries(now.roles)) {
        const before = prev.roles[role] ?? { cpuTicks: 0, rssBytes: 0, pids: [] };
        const deltaTicks = Math.max(0, data.cpuTicks - before.cpuTicks);
        roles[role] = {
          cpuPercent: wallSec > 0 ? Math.round((deltaTicks / HZ / wallSec) * 1000) / 10 : null,
          cpuSeconds: Math.round((deltaTicks / HZ) * 1000) / 1000,
          rssMb: mb(data.rssBytes),
          pids: data.pids.length,
        };
      }
      const page = await snapshot(cdp);
      samples.push({ t: tick + 1, at, wallMs: at - prevAt, roles, page });
      prev = now;
      prevAt = at;
    }

    const visibleWindow = async () => {
      if (windowId === null) return;
      xdo(['windowmap', windowId]);
    };

    if (probes.has('recovery') && state === 'hidden') {
      await runProbe('recovery', async () => {
        await cdp.evaluate("window.__idleProfile.mark('resume')");
        const startedResume = Date.now();
        await visibleWindow();
        if (arm === 'candidate' && hiddenSignal === 'unmapped-only') {
          // Xvfb 无窗口管理器，map 不触发 visibilitychange；由 bench 显式恢复同一原型。
          await cdp.evaluate('window.__idleProfileHiddenPause.setHidden(false)');
        }
        let hit = null;
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline) {
          const found = await cdp.evaluate("window.__idleProfile.sinceMark('resume','idle')");
          if (found) {
            hit = found;
            break;
          }
          await sleep(100);
        }
        const snap = await snapshot(cdp);
        if (hit === null) recordFailure('unmap 后恢复：6s 内没有出现待机帧');
        return {
          ...(hit ?? { latencyMs: null }),
          wallMs: Date.now() - startedResume,
          visibilityAfter: snap?.visibility ?? null,
          videos: snap?.videos ?? null,
        };
      });
      await sleep(1000);
    }

    if (probes.has('click')) {
      await runProbe('click', async () => {
        const before = await snapshot(cdp);
        await cdp.evaluate("window.__idleProfile.mark('click')");
        const startedClick = Date.now();
        await cdp.click(160, 120);
        let hit = null;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const found = await cdp.evaluate("window.__idleProfile.sinceMark('click','reaction')");
          if (found) {
            hit = found;
            break;
          }
          await sleep(50);
        }
        const after = await snapshot(cdp);
        if (hit === null) recordFailure('合成点击后 5s 内没有 reaction 帧');
        return {
          ...(hit ?? { latencyMs: null }),
          wallMs: Date.now() - startedClick,
          visualBefore: before?.visual ?? null,
          visualAfter: after?.visual ?? null,
          framesBefore: before?.frames ?? null,
          framesAfter: after?.frames ?? null,
        };
      });
      await sleep(1500);
    }

    if (probes.has('drag')) {
      await runProbe('drag', async () => {
        const id = findPetWindow(mainPid);
        const before = id === null ? null : windowGeometry(id);
        await cdp.drag(160, 120, 24);
        await sleep(400);
        const after = id === null ? null : windowGeometry(id);
        const boundsEvents = out.split('\n').filter((line) => line.includes('"event":"bounds"')).length;
        return { before, after, boundsEvents, moved: Boolean(before && after && (before.x !== after.x || before.y !== after.y)) };
      });
      await sleep(300);
    }

    if (probes.has('close')) {
      await runProbe('close', async () => {
        const startedClose = Date.now();
        // 关窗后 CDP 连接可能直接断开，send 的 Promise 永远不结算；这里必须有界等待。
        await Promise.race([cdp.escape().catch(() => undefined), delay(2000)]);
        const deadline = Date.now() + 12000;
        while (child.exitCode === null && Date.now() < deadline) await sleep(100);
        productExit = child.exitCode;
        if (child.exitCode !== 0) recordFailure(`关窗退出 code=${String(child.exitCode)}`);
        return { exitCode: child.exitCode, signal: child.signalCode, ms: Date.now() - startedClose };
      });
    }
  } catch (error) {
    recordFailure(String(error?.message ?? error));
  } finally {
    cleanupAll();
    cdp?.close();
    await sleep(500);
  }

  // 汇总：CPU 秒数按角色累加；RSS 是进程 RSS 求和（含共享页重复计算）。
  const totals = {};
  for (const sample of samples) {
    for (const [role, data] of Object.entries(sample.roles)) {
      const slot = (totals[role] ??= { cpuSeconds: 0, rssMb: [] });
      slot.cpuSeconds += data.cpuSeconds ?? 0;
      slot.rssMb.push(data.rssMb ?? 0);
    }
  }
  const windowSec = samples.reduce((sum, sample) => sum + sample.wallMs, 0) / 1000;
  const roleSummary = {};
  for (const [role, slot] of Object.entries(totals)) {
    const rss = [...slot.rssMb].sort((a, b) => a - b);
    roleSummary[role] = {
      cpuSeconds: Math.round(slot.cpuSeconds * 1000) / 1000,
      cpuPercentAvg: windowSec > 0 ? Math.round((slot.cpuSeconds / windowSec) * 1000) / 10 : null,
      rssSumP50Mb: rss[Math.floor(rss.length / 2)] ?? null,
      rssSumMaxMb: rss.at(-1) ?? null,
      samples: rss.length,
    };
  }
  const frameDeltas = [];
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1].page;
    const b = samples[i].page;
    if (!a || !b) continue;
    frameDeltas.push({ frames: b.frames - a.frames, wallMs: samples[i].wallMs });
    frameRates.push(b.frames - a.frames);
  }
  const posts = existsSync(requestsFile)
    ? readFileSync(requestsFile, 'utf8').split('\n').filter((line) => line.trim() !== '').length
    : 0;
  const idleAsset = path.join(petRoot, 'assets/idle.webm');
  const reactionAsset = path.join(petRoot, 'assets/reaction.webm');
  const summary = {
    arm,
    state,
    hiddenSignal,
    seconds,
    warmupSec,
    sampleCount: samples.length,
    windowSec: Math.round(windowSec * 1000) / 1000,
    platform: `${process.platform} ${os.release()} ${os.arch()}`,
    host: os.hostname(),
    node: process.version,
    electron: electronVersion(),
    electronPreflight: preflight.version,
    head: gitOut(['rev-parse', 'HEAD']),
    dirtyFiles: gitOut(['status', '--porcelain']).split('\n').filter(Boolean).length,
    assets: { idleSha256: sha256(idleAsset), reactionSha256: sha256(reactionAsset) },
    display,
    xvfbOwned: xvfbOwnedFlag,
    preview,
    productEntry: 'node scripts/chat-trial.mjs（等价 pnpm chat:trial 的第二半；构建由本脚本只做一次）',
    build: buildInfo,
    pageAtMs,
    posts,
    postsGate: posts === 0 ? 'pass' : 'fail',
    candidate: arm === 'candidate',
    candidateDefaultOff: true,
    candidateInjected: arm === 'candidate',
    roles: roleSummary,
    framesPerSec: frameRates.length > 0 ? Math.round((frameRates.reduce((a, b) => a + b, 0) / frameRates.length) * 10) / 10 : null,
    frameDeltas,
    probes: probesResult,
    productExit,
    failures,
    notRun,
    command: `node bench/idle-profile/run.mjs --arm=${arm} --seconds=${seconds} --warmup=${warmupSec} --display=${display} --state=${state}`,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(outDir, 'product-stdout.log'), out);
  await writeFile(path.join(outDir, 'samples.json'), JSON.stringify({ summary: { ...summary, roles: undefined }, samples }, null, 2));
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  if (!existsSync(requestsFile)) await writeFile(requestsFile, '');
  const exitOk = failures.length === 0 && posts === 0;
  await writeFile(
    path.join(outDir, 'exit.txt'),
    [
      `harness_exit=${exitOk ? 0 : 1}`,
      `arm=${arm} state=${state} seconds=${seconds} warmup=${warmupSec}`,
      `product_exit=${String(productExit)}`,
      `posts=${posts}`,
      `samples=${samples.length}`,
      `failures=${failures.length === 0 ? 'none' : failures.join(' | ')}`,
      `not_run=${notRun.length === 0 ? 'none' : notRun.join(' | ')}`,
      '',
    ].join('\n'),
  );
  console.log(path.join(outDir, 'summary.json'));
  console.log(
    JSON.stringify({
      arm,
      state,
      roles: roleSummary,
      framesPerSec: summary.framesPerSec,
      posts,
      failures,
    }),
  );
  if (!exitOk) process.exitCode = 1;
}

await main();
