/**
 * M3-8 C：正式对照编排（同机同素材同工况、等长预热、交替顺序、3 对 × 60s）。
 *
 *   node bench/idle-profile/compare.mjs --pairs=3 --seconds=60 --warmup=8 --display=:97 --state=hidden
 *
 * 每对内部顺序交替（B→C、C→B、B→C…），逐对串行（本机单核，绝不并发 GUI）。
 * 每支臂仍走 run.mjs 的固定入口，产物落在 runs/<stamp>-p<i>/<arm>/。
 * 汇总写 runs/<stamp>/compare.json，失败与波动都在里面。
 * @module pet-next/bench/idle-profile/compare
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const rawArgs = process.argv.slice(2);
const value = (name, fallback) => {
  const hit = rawArgs.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const pairs = Number(value('pairs', '3'));
const seconds = value('seconds', '60');
const warmup = value('warmup', '8');
const display = value('display', ':97');
const state = value('state', 'hidden');
const stamp = value('stamp', new Date().toISOString().replace(/[:.]/g, '-'));
const runsRoot = path.join(petRoot, 'bench/idle-profile/runs');

const ARM_ORDER = ['baseline', 'candidate'];

async function main() {
  await mkdir(path.join(runsRoot, stamp), { recursive: true });
  const runs = [];
  const failures = [];
  for (let pair = 1; pair <= pairs; pair += 1) {
    const pairStamp = `${stamp}-p${pair}`;
    const order = pair % 2 === 1 ? ARM_ORDER : [...ARM_ORDER].reverse();
    for (const arm of order) {
      const startedAt = Date.now();
      let exitCode = 0;
      try {
        execFileSync(
          process.execPath,
          [
            'bench/idle-profile/run.mjs',
            `--arm=${arm}`,
            `--seconds=${seconds}`,
            `--warmup=${warmup}`,
            `--display=${display}`,
            `--state=${state}`,
            `--stamp=${pairStamp}`,
          ],
          { cwd: petRoot, stdio: 'inherit', env: { ...process.env } },
        );
      } catch (error) {
        exitCode = error?.status ?? 1;
        failures.push({ pair, arm, exitCode, message: String(error?.message ?? error) });
      }
      const dir = path.join(runsRoot, pairStamp, arm);
      const summaryPath = path.join(dir, 'summary.json');
      runs.push({
        pair,
        arm,
        order: order.join('>'),
        wallSec: Math.round((Date.now() - startedAt) / 100) / 10,
        harnessExit: exitCode,
        dir,
        summary: existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : null,
      });
      if (!existsSync(summaryPath)) failures.push({ pair, arm, message: '缺 summary.json' });
    }
  }

  const pick = (arm) => runs.filter((run) => run.arm === arm && run.summary !== null);
  const rolesOf = (entry, role) => entry.summary.roles?.[role] ?? null;
  const mean = (values) => (values.length === 0 ? null : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100);
  const span = (values) => (values.length === 0 ? null : `${Math.min(...values)}..${Math.max(...values)}`);

  const roles = ['main', 'renderer', 'gpu', 'utility', 'cli', 'fake-model', 'fake-ssh'];
  const table = {};
  for (const role of roles) {
    const base = pick('baseline').map((entry) => rolesOf(entry, role)?.cpuPercentAvg).filter((v) => typeof v === 'number');
    const cand = pick('candidate').map((entry) => rolesOf(entry, role)?.cpuPercentAvg).filter((v) => typeof v === 'number');
    table[role] = {
      baselineCpuPct: base,
      candidateCpuPct: cand,
      baselineMean: mean(base),
      candidateMean: mean(cand),
      deltaPct: mean(base) !== null && mean(cand) !== null ? Math.round((mean(base) - mean(cand)) * 100) / 100 : null,
      baselineSpan: span(base),
      candidateSpan: span(cand),
    };
  }

  const recoveryOf = (entry) => entry.summary.probes?.recovery?.latencyMs ?? null;
  const clickOf = (entry) => entry.summary.probes?.click?.latencyMs ?? null;
  const compare = {
    stamp,
    state,
    seconds: Number(seconds),
    warmup: Number(warmup),
    pairs,
    display,
    order: runs.map((run) => `p${run.pair}:${run.arm}`),
    baselineFramesPerSec: pick('baseline').map((entry) => entry.summary.framesPerSec),
    candidateFramesPerSec: pick('candidate').map((entry) => entry.summary.framesPerSec),
    roles: table,
    recoveryLatencyMs: {
      baseline: pick('baseline').map(recoveryOf),
      candidate: pick('candidate').map(recoveryOf),
    },
    clickLatencyMs: {
      baseline: pick('baseline').map(clickOf),
      candidate: pick('candidate').map(clickOf),
    },
    dragMoved: {
      baseline: pick('baseline').map((entry) => entry.summary.probes?.drag?.moved ?? null),
      candidate: pick('candidate').map((entry) => entry.summary.probes?.drag?.moved ?? null),
    },
    closeExit: {
      baseline: pick('baseline').map((entry) => entry.summary.probes?.close?.exitCode ?? null),
      candidate: pick('candidate').map((entry) => entry.summary.probes?.close?.exitCode ?? null),
    },
    posts: { baseline: pick('baseline').map((entry) => entry.summary.posts), candidate: pick('candidate').map((entry) => entry.summary.posts) },
    hiddenSignal: pick('baseline').map((entry) => entry.summary.hiddenSignal),
    runFailures: runs.flatMap((run) => (run.summary?.failures ?? []).map((message) => `p${run.pair}/${run.arm}: ${message}`)),
    orchestrationFailures: failures,
    runs: runs.map((run) => ({ pair: run.pair, arm: run.arm, wallSec: run.wallSec, harnessExit: run.harnessExit, dir: path.relative(petRoot, run.dir) })),
  };
  writeFileSync(path.join(runsRoot, stamp, 'compare.json'), JSON.stringify(compare, null, 2));
  console.log(JSON.stringify(compare, null, 2));
  const bad = compare.runs.some((run) => run.harnessExit !== 0) || compare.runFailures.length > 0;
  if (bad) process.exitCode = 1;
}

await main();
