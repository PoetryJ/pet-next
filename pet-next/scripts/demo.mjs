#!/usr/bin/env node
/**
 * 一条命令启动桌宠体验（不需要手敲环境变量）。
 *
 *   node scripts/demo.mjs                        # 日常节奏，成品素材
 *   node scripts/demo.mjs --demo                 # 演示节奏（自动动作冷却 1.6s）
 *   node scripts/demo.mjs --asset=short          # 回应改用截取短片（母带 53..158 帧）
 *   node scripts/demo.mjs --asset=candidate      # 回应改用候选素材（字节同母带）
 *   node scripts/demo.mjs --record               # 自动跑一遍演示序列并留证（Linux/X11）
 *   node scripts/demo.mjs --scale=1.25           # 模拟系统缩放（仅对照用）
 *
 * 素材选择走已冻结的预览令牌（PET_NEXT_PREVIEW），不是改写成品字节。
 * 失败注入：--record 序列按 F 键触发 failNext（行为会话内置），不走产品默认路径。
 */
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(path.join(petRoot, 'package.json'));
const rawArgs = process.argv.slice(2);

function flag(name) {
  return rawArgs.includes(`--${name}`);
}

function value(name, fallback = null) {
  const hit = rawArgs.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const demo = flag('demo');
const record = flag('record');
const asset = value('asset', 'master');
const scale = value('scale', null);
const assets = {
  master: { token: null, label: '成品 assets/reaction.webm（全母带）' },
  candidate: { token: 'candidate', label: '候选 assets/candidates/reaction/reaction.webm（字节同母带）' },
  short: { token: 'short', label: '短片 assets/candidates/reaction/short.webm（106 帧，回应 0.25s 即现）' },
};
if (!(asset in assets)) {
  console.error(`未知素材：${asset}（可选 master|candidate|short）`);
  process.exit(2);
}

const tokens = [demo ? 'behavior-demo' : 'behavior', assets[asset].token].filter(Boolean).join(',');
const env = {
  ...process.env,
  PET_NEXT_PREVIEW: tokens,
};
if (record) env.PET_NEXT_TEST = '1';

const mainPath = path.join(petRoot, 'dist/electron/main.js');
if (!existsSync(mainPath)) {
  console.error('dist/electron/main.js 不存在：先跑 pnpm build（或 use pnpm demo）。');
  process.exit(2);
}

const electronPath = require('electron');
const electronArgs = [];
if (process.platform === 'linux') electronArgs.push('--no-sandbox', '--disable-dev-shm-usage');
if (scale !== null) electronArgs.push(`--force-device-scale-factor=${scale}`);
electronArgs.push(mainPath);

console.log(
  JSON.stringify(
    {
      event: 'demo-config',
      cadence: demo ? 'demo(1.6s)' : 'daily(45s-15min)',
      asset,
      assetLabel: assets[asset].label,
      preview: tokens,
      record,
      scale: scale === null ? 'os' : `simulated ${scale}`,
      userData: env.PET_NEXT_USER_DATA ?? '(默认)',
      electronArgs,
    },
    null,
    2,
  ),
);

const logDir = path.join(petRoot, 'logs/experience-preview');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.join(logDir, `demo-${asset}-${demo ? 'demo' : 'daily'}-${stamp}.log`);

const child = spawn(electronPath, electronArgs, { cwd: petRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
const append = (chunk) => {
  log += chunk.toString();
  if (log.length > 400_000) log = log.slice(-200_000);
};
child.stdout.on('data', append);
child.stderr.on('data', append);

async function xdo(args) {
  await new Promise((resolve, reject) => {
    execFile('xdotool', args, { timeout: 10_000 }, (error) => (error ? reject(error) : resolve()));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findWindow() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const out = await new Promise((resolve, reject) => {
        execFile('xdotool', ['search', '--name', 'pet-next'], { timeout: 5000 }, (error, stdout) => {
          if (error) reject(error);
          else resolve(String(stdout).trim());
        });
      });
      const id = out.split('\n').filter(Boolean).at(-1);
      if (id) return id;
    } catch {
      // 窗口还没出来。
    }
    await sleep(200);
  }
  return null;
}

async function geometry(id) {
  const out = await new Promise((resolve, reject) => {
    execFile('xdotool', ['getwindowgeometry', '--shell', id], { timeout: 5000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
  const values = {};
  for (const line of out.split('\n')) {
    const [key, value] = line.split('=');
    if (key && value) values[key.trim()] = Number(value);
  }
  return values;
}

async function recordSequence() {
  if (process.platform !== 'linux') {
    console.log('not-run: 录制序列目前只有 Linux/X11 执行器（xdotool）；Windows 需要人工操作或后续补脚本。');
    return 'not-run';
  }
  const id = await findWindow();
  if (!id) {
    console.log('not-run: 20s 内没找到 pet-next 窗口（DISPLAY 是否正确？）');
    return 'not-run';
  }
  const box = await geometry(id);
  const cx = Math.round(box.X + box.WIDTH / 2);
  const cy = Math.round(box.Y + box.HEIGHT / 2);
  const steps = [];
  const step = async (name, fn) => {
    try {
      await fn();
      steps.push({ step: name, ok: true });
    } catch (error) {
      steps.push({ step: name, ok: false, detail: String(error) });
    }
  };

  await step('activate', () => xdo(['windowactivate', '--sync', id]));
  await step('click', async () => {
    await xdo(['mousemove', '--sync', String(cx), String(cy)]);
    await xdo(['click', '1']);
    await sleep(1200);
  });
  await step('click-x3-fast', async () => {
    for (let i = 0; i < 3; i += 1) {
      await xdo(['click', '1']);
      await sleep(150);
    }
    await sleep(600);
  });
  await step('drag', async () => {
    await xdo(['mousemove', '--sync', String(cx), String(cy)]);
    await xdo(['mousedown', '1']);
    for (let i = 1; i <= 6; i += 1) {
      await xdo(['mousemove', '--sync', String(cx + i * 10), String(cy + i * 5)]);
    }
    await xdo(['mouseup', '1']);
    await sleep(600);
  });
  await step('auto-action', () => sleep(2200));
  await step('fail-once', async () => {
    await xdo(['key', 'f']);
    await sleep(9200); // 单槽失败要等装载超时（8s）走兜底，留足余量

  });
  await step('recover', async () => {
    await xdo(['click', '1']);
    await sleep(1200);
  });
  return steps;
}

const startedAt = Date.now();
let recordResult = null;
if (record) {
  recordResult = await recordSequence();
}

if (flag('keep-alive')) {
  console.log('demo: 窗口保持打开，Ctrl-C 结束。');
  await new Promise((resolve) => {
    process.on('SIGINT', resolve);
    process.on('SIGTERM', resolve);
  });
} else {
  await sleep(1200);
}
child.kill('SIGTERM');
await new Promise((resolve) => child.on('exit', resolve));
await mkdir(logDir, { recursive: true });
await writeFile(logPath, log, 'utf8');

const previews = [...log.matchAll(/\\"visual\\":\\"(\w+)\\"/g)].map((match) => match[1]);
const summary = {
  event: 'demo-summary',
  asset,
  cadence: demo ? 'demo' : 'daily',
  record: recordResult,
  elapsedMs: Date.now() - startedAt,
  logPath: path.relative(petRoot, logPath),
  visuals: previews,
  reactions: previews.filter((item) => item === 'reaction').length,
  autos: previews.filter((item) => item === 'auto').length,
  placeholders: previews.filter((item) => item === 'placeholder').length,
};
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
