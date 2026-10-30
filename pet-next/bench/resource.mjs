#!/usr/bin/env node
/**
 * 真实产品待机资源：60s 窗口内每秒采一次进程树 RSS 与 CPU。
 *
 * 启动的是 dist 里的产品入口（与 `scripts/demo.mjs` 同一套参数），不是 bench 页面；
 * 节奏、素材都按产品默认走（日常节奏；`--asset=short` 可换成截取短片）。
 *
 *   node bench/resource.mjs                     # 成品素材，日常节奏
 *   node bench/resource.mjs --asset=short       # 截取短片
 *   node bench/resource.mjs --seconds=60 --warmup=8
 *
 * 产物：bench/runs-resource/<时间>/resource-<素材>.json
 * 读数来自 /proc（Linux）：RSS 为进程树 VmRSS 之和，CPU 为 utime+stime 增量 / 墙钟。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(path.join(petRoot, 'package.json'));
const rawArgs = process.argv.slice(2);
const value = (name, fallback) => {
  const hit = rawArgs.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

if (process.platform !== 'linux') {
  console.error('resource.mjs 只用 /proc 读数，需要 Linux。');
  process.exit(2);
}

const asset = value('asset', 'master');
const seconds = Number(value('seconds', '60'));
const warmupSec = Number(value('warmup', '8'));
const tokens = ['behavior', asset === 'short' ? 'short' : asset === 'candidate' ? 'candidate' : null]
  .filter(Boolean)
  .join(',');
const mainPath = path.join(petRoot, 'dist/electron/main.js');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(petRoot, 'bench/runs-resource', stamp);
await mkdir(outDir, { recursive: true });

const electronPath = require('electron');
const args = [
  ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
  mainPath,
];
const child = spawn(electronPath, args, {
  cwd: petRoot,
  env: { ...process.env, PET_NEXT_PREVIEW: tokens, PET_NEXT_USER_DATA: path.join(outDir, `user-data-${asset}`) },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
const logPath = path.join(outDir, `stdout-${asset}.log`);
const chunks = [];
child.stdout.on('data', (chunk) => chunks.push(String(chunk)));
child.stderr.on('data', (chunk) => chunks.push(String(chunk)));

const HZ = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function statOf(pid) {
  try {
    const text = require('node:fs').readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = text.lastIndexOf(')');
    const rest = text.slice(close + 2).split(' ');
    return { ppid: Number(rest[1]), utime: Number(rest[11]), stime: Number(rest[12]) };
  } catch {
    return null;
  }
}

function rssOf(pid) {
  try {
    const text = require('node:fs').readFileSync(`/proc/${pid}/status`, 'utf8');
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
    entries = require('node:fs').readdirSync('/proc');
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

const samples = [];
try {
  await sleep(warmupSec * 1000);
  let prevCpu = null;
  let prevAt = null;
  for (let tick = 0; tick < seconds; tick += 1) {
    await sleep(1000);
    const pids = [child.pid, ...treeOf(child.pid)].filter((pid) => pid !== undefined);
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
} finally {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  await writeFile(logPath, chunks.join(''));
}

const values = samples.map((sample) => sample.rssBytes).sort((a, b) => a - b);
const cpus = samples.flatMap((sample) => (sample.cpuPercent === null ? [] : [sample.cpuPercent]));
const summary = {
  asset,
  preview: tokens,
  seconds,
  warmupSec,
  host: `${require('node:os').platform()} ${require('node:os').release()}`,
  rssP50: values[Math.floor(values.length / 2)] ?? null,
  rssMax: values.at(-1) ?? null,
  cpuAvg: cpus.length ? cpus.reduce((sum, item) => sum + item, 0) / cpus.length : null,
  cpuMax: cpus.length ? Math.max(...cpus) : null,
  procsP50: samples.map((sample) => sample.procs).sort((a, b) => a - b)[Math.floor(samples.length / 2)] ?? null,
  samples,
  command: `cd pet-next\nnode bench/resource.mjs --asset=${asset}`,
};
const file = path.join(outDir, `resource-${asset}.json`);
await writeFile(file, JSON.stringify(summary, null, 2));
console.log(file);
console.log(
  JSON.stringify({
    asset,
    rssMB: summary.rssP50 === null ? null : Math.round(summary.rssP50 / 1024 / 1024),
    rssMaxMB: summary.rssMax === null ? null : Math.round(summary.rssMax / 1024 / 1024),
    cpuAvg: summary.cpuAvg === null ? null : Number(summary.cpuAvg.toFixed(2)),
    procs: summary.procsP50,
  }),
);
