#!/usr/bin/env node
/**
 * M3-8 B：chat-demo-core.test.ts 挂起的有界定位探针（只读测试文件，不改产品源码）。
 * 每个被测进程外部总限 10s；到点只 SIGKILL 本次 spawn 的进程组，记录 kill 返回值、
 * exit/close/error 的真实次序与时间戳、最后开始的测试名、最后一行输出、用时与退出码。
 * stopGraceMs=20 是 runDemo 内部 SIGTERM→SIGKILL 的升级等待，不是总超时；本探针不调大任何超时。
 *
 * 用法：node tests/chat-evidence/m38-b/run-hang-probe.mjs --tag=single --procs=1 --rounds=3 --out=<dir>
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PET_ROOT = path.resolve(HERE, '../../..');
const TEST_FILE = 'scripts/chat-demo-core.test.ts';
const REAP_LIMIT_MS = 5000;

function parseArgs(argv) {
  const out = { tag: 'probe', procs: 1, rounds: 3, limitMs: 10000, target: TEST_FILE, out: path.join(HERE, 'runs', 'probe') };
  for (const raw of argv) {
    const [key, value] = raw.split('=');
    if (key === '--tag') out.tag = value;
    else if (key === '--procs') out.procs = Number(value);
    else if (key === '--rounds') out.rounds = Number(value);
    else if (key === '--limit-ms') out.limitMs = Number(value);
    else if (key === '--target') out.target = value;
    else if (key === '--out') out.out = path.resolve(value);
    else throw new Error(`未知参数：${raw}`);
  }
  return out;
}

const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** 单进程一次运行：外部看门狗 + 事件时间线。 */
function runOnce({ index, round, args }) {
  const dir = path.join(args.out, `round-${round}`, `p${index}`);
  mkdirSync(dir, { recursive: true });
  const events = [];
  const startedAt = Date.now();
  const record = (kind, extra = {}) => events.push({ at: Date.now(), offsetMs: Date.now() - startedAt, kind, ...extra });

  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  env.PATH = `/tmp/m38-tools/bin:${env.PATH ?? ''}`;
  const cmdArgs = ['--experimental-strip-types', '--test', '--test-reporter', 'spec', args.target];
  writeJson(path.join(dir, 'command.json'), {
    round, index, command: process.execPath, args: cmdArgs, cwd: PET_ROOT,
    env: { PATH: env.PATH, NODE_OPTIONS: env.NODE_OPTIONS ?? null, DISPLAY: env.DISPLAY ?? null },
    limitMs: args.limitMs, startedAt: new Date().toISOString(),
  });

  record('spawn-request');
  const child = spawn(process.execPath, cmdArgs, {
    cwd: PET_ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  record('spawn', { pid: child.pid ?? null });

  let stdout = '';
  let stderr = '';
  let lastLine = '';
  let lastStarted = null;
  let lastFinished = null;
  let startedCount = 0;
  let finishedCount = 0;
  const consume = (text, isStdout) => {
    if (isStdout) stdout += text; else stderr += text;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      lastLine = line;
      const started = /^\s*▶\s+(.*)$/.exec(line);
      if (started) {
        lastStarted = started[1].trim(); startedCount += 1;
        record('test-start', { name: lastStarted });
      }
      const done = /^\s*[✔✖]\s+(.*)$/.exec(line);
      if (done) {
        lastFinished = done[1].trim(); finishedCount += 1;
        record('test-finish', { name: lastFinished });
      }
    }
  };

  let killReturn = null;
  let killError = null;
  let timedOut = false;
  let reaping = null;
  let settled = false;
  let resolveRun = () => {};
  const promise = new Promise((resolve) => { resolveRun = resolve; });

  const finish = (extra = {}) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    if (reaping !== null) clearTimeout(reaping);
    record('finished', extra);
    const timeline = {
      round, index, pid: child.pid ?? null, startedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt, timedOut, limitMs: args.limitMs,
      exitCode: child.exitCode, signalCode: child.signalCode,
      kill: { returned: killReturn, error: killError },
      lastStartedTest: lastStarted, lastFinishedTest: lastFinished, lastOutputLine: lastLine,
      startedCount, finishedCount,
      eventOrder: events.map((e) => e.kind).filter((k) => k !== 'stdout' && k !== 'stderr'),
      events,
    };
    writeFileSync(path.join(dir, 'stdout.log'), stdout);
    writeFileSync(path.join(dir, 'stderr.log'), stderr);
    writeJson(path.join(dir, 'timeline.json'), timeline);
    resolveRun(timeline);
  };

  const watchdog = setTimeout(() => {
    timedOut = true;
    record('limit-reached', { limitMs: args.limitMs });
    try {
      killReturn = process.kill(-child.pid, 'SIGKILL');
      record('kill-return', { signal: 'SIGKILL', target: `-${child.pid}`, returned: killReturn });
    } catch (error) {
      killError = `${error.code ?? ''} ${error.message}`.trim();
      record('kill-error', { message: killError });
    }
    reaping = setTimeout(() => {
      record('reap-timeout', { waitedMs: REAP_LIMIT_MS });
      finish({ forced: true });
    }, REAP_LIMIT_MS);
  }, args.limitMs);

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { record('stdout', { bytes: Buffer.byteLength(chunk) }); consume(chunk, true); });
  child.stderr.on('data', (chunk) => { record('stderr', { bytes: Buffer.byteLength(chunk) }); consume(chunk, false); });
  child.once('exit', (code, signal) => {
    record('exit', { code, signal });
    setTimeout(() => finish({ note: 'close-not-received-within-1000ms' }), 1000);
  });
  child.once('close', (code, signal) => { record('close', { code, signal }); finish(); });
  child.once('error', (error) => {
    record('error', { message: error instanceof Error ? error.message : String(error) });
    finish({ note: 'spawn-error' });
  });
  return promise;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(args.procs) || args.procs < 1) throw new Error('--procs 必须是正整数');
  if (!Number.isInteger(args.rounds) || args.rounds < 1) throw new Error('--rounds 必须是正整数');
  mkdirSync(args.out, { recursive: true });
  const environment = {
    tag: args.tag, startedAt: new Date().toISOString(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version,
    cpus: os.cpus().length, loadavg: os.loadavg(), cwd: PET_ROOT, target: args.target,
    limitMs: args.limitMs, procs: args.procs, rounds: args.rounds,
    nodeOptionsUnset: !Object.hasOwn(process.env, 'NODE_OPTIONS'), display: process.env.DISPLAY ?? null,
  };
  writeJson(path.join(args.out, 'environment.json'), environment);

  const runs = [];
  for (let round = 1; round <= args.rounds; round += 1) {
    const batch = [];
    for (let index = 1; index <= args.procs; index += 1) batch.push(runOnce({ index, round, args }));
    runs.push(...(await Promise.all(batch)));
  }
  const summary = {
    ...environment,
    finishedAt: new Date().toISOString(),
    hung: runs.filter((run) => run.timedOut).length,
    failed: runs.filter((run) => !run.timedOut && run.exitCode !== 0).length,
    passed: runs.filter((run) => !run.timedOut && run.exitCode === 0).length,
    runs,
  };
  writeJson(path.join(args.out, 'summary.json'), summary);
  const lines = [
    `tag=${args.tag} procs=${args.procs} rounds=${args.rounds} limitMs=${args.limitMs}`,
    `node=${process.version} cpus=${os.cpus().length} platform=${environment.platform}`,
    'round\tproc\tdurationMs\ttimedOut\texit\tsignal\tlastStarted\tlastLine\teventOrder',
  ];
  for (const run of runs) {
    lines.push([
      run.round, run.index, run.durationMs, run.timedOut, run.exitCode ?? 'null', run.signalCode ?? 'null',
      run.lastStartedTest ?? '-', JSON.stringify(run.lastOutputLine ?? '-'), run.eventOrder.join('>'),
    ].join('\t'));
  }
  writeFileSync(path.join(args.out, 'summary.txt'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}

await main();
