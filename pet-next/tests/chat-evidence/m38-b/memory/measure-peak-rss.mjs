#!/usr/bin/env node
/**
 * M3-8 B 辅助测量：跑一次被测命令，采样其进程树（按 ppid 链）的 RSS 总和峰值。
 * /usr/bin/time 在本机不可用，故用 ps 轮询；只读 /proc 与 ps，不改被测代码。
 * 用法：node measure-peak-rss.mjs <outDir> [命令...]
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [outDir, ...command] = process.argv.slice(2);
const [bin, ...args] = command;
mkdirSync(outDir, { recursive: true });

const started = Date.now();
const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
const stdoutFile = path.join(outDir, 'stdout.log');
const stderrFile = path.join(outDir, 'stderr.log');
child.stdout.pipe(createWriteStream(stdoutFile));
child.stderr.pipe(createWriteStream(stderrFile));

const sample = () => {
  try {
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number));
    const children = new Map();
    const rssByPid = new Map();
    for (const [pid, ppid, rss] of rows) {
      rssByPid.set(pid, rss);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
    let total = 0;
    const stack = [child.pid];
    const seen = new Set();
    while (stack.length > 0) {
      const pid = stack.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      total += rssByPid.get(pid) ?? 0;
      for (const next of children.get(pid) ?? []) stack.push(next);
    }
    return { total, count: seen.size };
  } catch {
    return { total: 0, count: 0 };
  }
};

let peakRssKb = 0;
let peakProcs = 0;
const timer = setInterval(() => {
  const { total, count } = sample();
  if (total > peakRssKb) peakRssKb = total;
  if (count > peakProcs) peakProcs = count;
}, 50);

child.once('close', (code, signal) => {
  clearInterval(timer);
  const result = {
    command: [bin, ...args],
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    exitCode: code,
    signal,
    peakTreeRssKb: peakRssKb,
    peakTreeRssMb: Math.round((peakRssKb / 1024) * 10) / 10,
    peakTreeProcs: peakProcs,
  };
  writeFileSync(path.join(outDir, 'peak-rss.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
});
