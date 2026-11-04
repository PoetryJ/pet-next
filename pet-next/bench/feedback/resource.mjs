#!/usr/bin/env node
/**
 * M3-6 D：正式入口两臂 60s 待机资源对照（对照臂 vs --experience=companion）。
 *
 * 两臂同一正式入口 `pnpm chat:trial`、同 PET_NEXT_PREVIEW=short,behavior、同 fake 模型
 * （零真实推理），唯一差异是 companion 臂注入 PET_NEXT_EXPERIENCE=companion
 * （即 --experience=companion 参数，由入口 env 透传）。
 *
 * 每臂：fake 模型 + fake ssh 就绪 → 入口启动 → CDP 可见 → warmup → 每秒采样进程树
 * RSS/CPU（读数来自 /proc，与 bench/resource.mjs 同源）→ 结束记录 POST 次数
 * （待机硬门：0 次推理请求）。
 *
 * 可见反馈时间不由本脚本产生（待机无发送）；见 e2e 证据
 * tests/chat-evidence/feedback/companion-success/（发送→等待→成功提示时间戳）。
 *
 *   node bench/feedback/resource.mjs                    # 默认 60s + 8s warmup
 *   node bench/feedback/resource.mjs --seconds=20       # 快速冒烟
 *
 * 产物：bench/feedback/runs/<时间戳>/（control.json / companion.json / summary.json / 日志）。
 * @module pet-next/bench/feedback/resource
 */
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const require = createRequire(path.join(petRoot, 'package.json'));
const rawArgs = process.argv.slice(2);
const value = (name, fallback) => {
  const hit = rawArgs.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

if (process.platform !== 'linux') {
  console.error('bench/feedback/resource.mjs 只用 /proc 读数，需要 Linux。');
  process.exit(2);
}
if (process.env.NODE_OPTIONS !== undefined) {
  console.error('先清 NODE_OPTIONS（与 verify 同规）：env -u NODE_OPTIONS node bench/feedback/resource.mjs');
  process.exit(2);
}

const seconds = Number(value('seconds', '60'));
const warmupSec = Number(value('warmup', '8'));
const display = process.env.PET_NEXT_E2E_DISPLAY ?? ':94';
const displaySocket = `/tmp/.X11-unix/X${display.startsWith(':') ? display.slice(1) : display}`;
const SHARED_PREVIEW = 'short,behavior';

if (!existsSync(displaySocket)) {
  console.error(`X display ${display} 不存在：先起 Xvfb ${display}（verify 串行占用同 display）。`);
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(petRoot, 'bench/feedback/runs', stamp);
await mkdir(outDir, { recursive: true });

const HZ = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function statOf(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = text.lastIndexOf(')');
    const rest = text.slice(close + 2).split(' ');
    return { ppid: Number(rest[1]), utime: Number(rest[11]), stime: Number(rest[12]) };
  } catch {
    return null;
  }
}

function rssOf(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /VmRSS:\s+(\d+) kB/.exec(text);
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function treeOf(rootPid) {
  const pids = [];
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return pids;
  }
  const parent = new Map();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = statOf(Number(entry));
    if (stat) parent.set(Number(entry), stat.ppid);
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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('no port'));
      server.close(() => resolve(address.port));
    });
  });
}

function countPosts(logFile) {
  if (!existsSync(logFile)) return 0;
  let count = 0;
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    if (line.trim() !== '') count += 1;
  }
  return count;
}

function pnpmPath() {
  const beside = path.join(path.dirname(process.execPath), 'pnpm');
  return existsSync(beside) ? beside : 'pnpm';
}

async function waitForPage(debugPort, isDead, deadlineMs) {
  while (Date.now() < deadlineMs) {
    if (isDead()) throw new Error('入口提前退出');
    try {
      const list = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) ?? [];
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 未就绪 */
    }
    await sleep(250);
  }
  throw new Error(`CDP 页面 ${debugPort} 150s 未就绪`);
}

async function runArm(name, trialArgs, extraEnv) {
  const userData = await mkdtemp(path.join(tmpdir(), `pet-fb-res-${name}-`));
  const instanceTag = path.basename(userData);
  const modelLog = path.join(outDir, `requests-${name}.ndjson`);
  const sshLog = path.join(userData, 'ssh.ndjson');
  let fakeOut = '';
  const fake = spawn(process.execPath, [path.join(petRoot, 'tests/support/fake-model-service.mjs')], {
    env: { ...process.env, FAKE_MODEL_LOG: modelLog, FAKE_MODEL_DELAY_MS: '1500', FAKE_MODEL_MODE: 'ok' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fake.stdout?.on('data', (chunk) => (fakeOut += String(chunk)));
  fake.stderr?.on('data', (chunk) => (fakeOut += String(chunk)));
  const fakePort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fake 模型未就绪：${fakeOut}`)), 10000);
    fake.stdout?.on('data', (chunk) => {
      fakeOut += String(chunk);
      const line = fakeOut.split('\n').find((item) => item.includes('fake-model-ready'));
      if (line === undefined) return;
      clearTimeout(timer);
      resolve(JSON.parse(line.slice(line.indexOf('{'))).port);
    });
  });
  const tunnelPort = await freePort();
  const debugPort = await freePort();
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
    FAKE_SSH_LOG: sshLog,
    FAKE_SSH_MODE: 'ok',
    FAKE_SSH_TARGET_PORT: String(fakePort),
    PET_NEXT_PREVIEW: SHARED_PREVIEW,
    ...extraEnv,
  };
  delete env.PET_NEXT_CHAT_CONTEXT;
  if (name === 'control') delete env.PET_NEXT_EXPERIENCE;

  let out = '';
  const startedAt = Date.now();
  const child = spawn(pnpmPath(), ['chat:trial', ...trialArgs], {
    cwd: petRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout?.on('data', (chunk) => (out += String(chunk)));
  child.stderr?.on('data', (chunk) => (out += String(chunk)));
  const samples = [];
  let failure = '';
  let pageAtMs = null;
  try {
    await waitForPage(debugPort, () => child.exitCode !== null, Date.now() + 150000);
    pageAtMs = Date.now() - startedAt;
    await sleep(warmupSec * 1000);
    let prevCpu = null;
    let prevAt = null;
    for (let tick = 0; tick < seconds; tick += 1) {
      await sleep(1000);
      if (child.exitCode !== null) {
        failure = `采样中入口退出 code=${child.exitCode}`;
        break;
      }
      const pids = [child.pid, ...treeOf(child.pid)];
      let rss = 0;
      let cpuTicks = 0;
      for (const pid of pids) {
        rss += rssOf(pid);
        const stat = statOf(pid);
        if (stat) cpuTicks += stat.utime + stat.stime;
      }
      const now = Date.now();
      const cpuPercent =
        prevCpu === null || prevAt === null ? null : ((cpuTicks - prevCpu) / HZ / ((now - prevAt) / 1000)) * 100;
      prevCpu = cpuTicks;
      prevAt = now;
      samples.push({ t: tick + 1, rssBytes: rss, cpuPercent, procs: pids.length });
    }
  } catch (error) {
    failure = String(error?.message ?? error);
  } finally {
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
      execFileSync('pkill', ['-f', instanceTag], { stdio: 'ignore' });
    } catch {
      /* 兜底清理：无匹配进程时 pkill 退 1 */
    }
    fake.kill('SIGKILL');
    await sleep(500);
  }
  await writeFile(path.join(outDir, `stdout-${name}.log`), out);
  await writeFile(path.join(outDir, `samples-${name}.json`), JSON.stringify({ pageAtMs, samples }, null, 2));

  const values = samples.map((sample) => sample.rssBytes).sort((a, b) => a - b);
  const cpus = samples.flatMap((sample) => (sample.cpuPercent === null ? [] : [sample.cpuPercent]));
  return {
    arm: name,
    trialArgs,
    experience: name === 'companion' ? 'companion' : '',
    preview: SHARED_PREVIEW,
    seconds,
    warmupSec,
    host: `${require('node:os').platform()} ${require('node:os').release()}`,
    pageAtMs,
    posts: countPosts(modelLog),
    rssP50: values[Math.floor(values.length / 2)] ?? null,
    rssMax: values.at(-1) ?? null,
    cpuAvg: cpus.length ? cpus.reduce((sum, item) => sum + item, 0) / cpus.length : null,
    cpuMax: cpus.length ? Math.max(...cpus) : null,
    procsP50: samples.map((sample) => sample.procs).sort((a, b) => a - b)[Math.floor(samples.length / 2)] ?? null,
    sampleCount: samples.length,
    failure,
    command: `cd pet-next\nenv -u NODE_OPTIONS DISPLAY=${display} node bench/feedback/resource.mjs --seconds=${seconds}`,
  };
}

const control = await runArm('control', [], {});
const companion = await runArm('companion', ['--experience=companion'], { PET_NEXT_EXPERIENCE: 'companion' });

const mb = (bytes) => (bytes === null ? null : Math.round(bytes / 1024 / 1024));
const summary = {
  generatedAt: new Date().toISOString(),
  seconds,
  warmupSec,
  display,
  feedbackVisibleEvidence: 'tests/chat-evidence/feedback/companion-success/（e2e 发送→等待→成功提示时间戳；待机无发送无反馈）',
  arms: {
    control: { ...control, rssP50MB: mb(control.rssP50), rssMaxMB: mb(control.rssMax) },
    companion: { ...companion, rssP50MB: mb(companion.rssP50), rssMaxMB: mb(companion.rssMax) },
  },
  delta: {
    rssP50MB: mb(control.rssP50) === null || mb(companion.rssP50) === null ? null : mb(companion.rssP50) - mb(control.rssP50),
    cpuAvg:
      control.cpuAvg === null || companion.cpuAvg === null
        ? null
        : Number((companion.cpuAvg - control.cpuAvg).toFixed(2)),
    posts: companion.posts - control.posts,
  },
};

const file = path.join(outDir, 'summary.json');
await writeFile(path.join(outDir, 'control.json'), JSON.stringify(control, null, 2));
await writeFile(path.join(outDir, 'companion.json'), JSON.stringify(companion, null, 2));
await writeFile(file, JSON.stringify(summary, null, 2));
console.log(file);
console.log(
  JSON.stringify({
    control: { rssP50MB: mb(control.rssP50), rssMaxMB: mb(control.rssMax), cpuAvg: control.cpuAvg, posts: control.posts, failure: control.failure },
    companion: { rssP50MB: mb(companion.rssP50), rssMaxMB: mb(companion.rssMax), cpuAvg: companion.cpuAvg, posts: companion.posts, failure: companion.failure },
    delta: summary.delta,
  }),
);
if (control.failure || companion.failure || control.posts !== 0 || companion.posts !== 0) process.exit(1);
