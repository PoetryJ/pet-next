/**
 * 跑三种播放模式的对照，写出原始样本和一页报告。
 * 冒烟次数不够 30×3，建议保持未测出，不能拿来当收益。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BenchSample } from '../contracts/bench.ts';
import { hashShippedAssets } from './assets.ts';
import type { BenchJob } from './job.ts';
import {
  BENCH_ROUND_COUNT,
  BENCH_SAMPLE_COUNT,
  DWELL_MS,
  IDLE_CPU_MS,
  STRESS_DELAY_MS,
  STRESS_DWELL_MS,
  STRESS_SAMPLE_COUNT,
  WINDOW_HEIGHT,
  WINDOW_WIDTH,
  WINDOW_X,
  WINDOW_Y,
  modeOrder,
} from './protocol.ts';
import { renderReport, type CallbackLine, type StressLine } from './report.ts';
import { buildColumns, buildVerdicts, percentile, toSummary } from './stats.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const electronPath = require('electron') as string;

const smoke = process.argv.includes('--smoke');
const skipStress = process.argv.includes('--skip-stress') || smoke;
const rounds = smoke ? 1 : BENCH_ROUND_COUNT;
const samples = smoke ? 2 : BENCH_SAMPLE_COUNT;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFlag = process.argv.indexOf('--out');
const runRoot =
  outFlag >= 0 && process.argv[outFlag + 1]
    ? path.resolve(process.argv[outFlag + 1]!)
    : smoke
      ? path.join('/tmp', `pet-next-bench-smoke-${stamp}`)
      : path.join(root, 'bench/runs', stamp);

async function main(): Promise<void> {
  const reuseAt = process.argv.indexOf('--reuse');
  if (reuseAt >= 0) {
    const dir = process.argv[reuseAt + 1];
    if (!dir) throw new Error('--reuse needs a run directory');
    await refreshReport(path.resolve(dir));
    return;
  }
  const assets = await hashShippedAssets(root);
  await compile();
  await copyFile(path.join(root, 'bench/page.html'), path.join(root, 'dist/bench-build/bench/page.html'));
  await mkdir(runRoot, { recursive: true });
  const idleUrl = pathToFileUrl(path.join(root, 'assets/idle.webm'));
  const reactionUrl = pathToFileUrl(path.join(root, 'assets/reaction.webm'));
  const benefitDirs: string[] = [];
  const failures: string[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    for (const mode of modeOrder(round)) {
      const outDir = path.join(runRoot, `round-${round}`, mode);
      benefitDirs.push(outDir);
      const job: BenchJob = {
        mode,
        round,
        firstCount: samples,
        repeatCount: samples,
        dwellMs: DWELL_MS,
        idleCpuMs: IDLE_CPU_MS,
        stressDelayMs: 0,
        assetSha256: assets.assetSha256,
        idleUrl,
        reactionUrl,
        runRoot,
        outDir,
      };
      const error = await runJob(job);
      if (error) failures.push(`${mode} round ${round}: ${error}`);
    }
  }
  const stressDirs: string[] = [];
  if (!skipStress) {
    for (const mode of modeOrder(1)) {
      const outDir = path.join(runRoot, 'stress', mode);
      stressDirs.push(outDir);
      const job: BenchJob = {
        mode,
        round: 1,
        firstCount: STRESS_SAMPLE_COUNT,
        repeatCount: 0,
        dwellMs: STRESS_DWELL_MS,
        idleCpuMs: 200,
        stressDelayMs: STRESS_DELAY_MS,
        assetSha256: assets.assetSha256,
        idleUrl,
        reactionUrl,
        runRoot,
        outDir,
      };
      const error = await runJob(job);
      if (error) failures.push(`stress ${mode}: ${error}`);
    }
  }
  await concat(benefitDirs.map((dir) => path.join(dir, 'samples.jsonl')), path.join(runRoot, 'samples.jsonl'));
  await concat(benefitDirs.map((dir) => path.join(dir, 'frames.jsonl')), path.join(runRoot, 'frames.jsonl'));
  const benefit = await readSamples(path.join(runRoot, 'samples.jsonl'));
  const columns = buildColumns(benefit, assets.assetSha256);
  const verdicts = buildVerdicts(columns);
  await concat(stressDirs.map((dir) => path.join(dir, 'samples.jsonl')), path.join(runRoot, 'stress-samples.jsonl'));
  const stress = await readSamples(path.join(runRoot, 'stress-samples.jsonl'));
  const stressLines = stressSummary(stress);
  const callbacks = callbackSummary(await readFrames(path.join(runRoot, 'frames.jsonl')));
  const electronVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies.electron as string;
  const command = 'cd pet-next\nnode --experimental-strip-types bench/cli.ts';
  const report = renderReport({
    env: {
      host: `${os.platform()} ${os.release()} ${os.arch()} ${os.cpus()[0]?.model ?? ''} × ${os.cpus().length}，内存 ${Math.round(os.totalmem() / (1024 * 1024))} MiB`,
      electron: electronVersion,
      window: `${WINDOW_WIDTH}×${WINDOW_HEIGHT} @ ${WINDOW_X},${WINDOW_Y}，Linux 关闭硬件加速，透明无边框`,
      behavior: '关闭',
      dwellMs: DWELL_MS,
      idleCpuMs: IDLE_CPU_MS,
      assetSha256: assets.assetSha256,
      files: assets.files,
      outDir: path.relative(root, runRoot) || runRoot,
      command,
    },
    columns,
    verdicts,
    stress: stressLines,
    callbacks,
  });
  const reportBody = smoke ? `> 这是冒烟，样本不足，建议保持未测出。\n\n${report}` : report;
  await writeFile(path.join(runRoot, 'report.md'), reportBody);
  await writeFile(
    path.join(runRoot, 'summaries.json'),
    JSON.stringify({ summaries: verdicts.map((verdict) => toSummary(verdict)), columns, failures }, null, 2),
  );
  await writeFile(
    path.join(runRoot, 'environment.json'),
    JSON.stringify(
      {
        host: os.platform(),
        release: os.release(),
        arch: os.arch(),
        cpus: os.cpus().map((cpu) => cpu.model),
        cpuCount: os.cpus().length,
        totalMem: os.totalmem(),
        electron: electronVersion,
        window: { x: WINDOW_X, y: WINDOW_Y, width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
        behavior: false,
        dwellMs: DWELL_MS,
        idleCpuMs: IDLE_CPU_MS,
        rounds,
        samples,
        smoke,
        assets,
        failures,
      },
      null,
      2,
    ),
  );
  console.log(path.join(runRoot, 'report.md'));
  if (!smoke && benefit.length < rounds * samples * 2 * 3) {
    failures.push(`benefit samples ${benefit.length}`);
  }
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  }
}

async function refreshReport(dir: string): Promise<void> {
  const saved = JSON.parse(await readFile(path.join(dir, 'environment.json'), 'utf8')) as {
    assets: { files: { path: string; sha256: string }[]; assetSha256: string };
    failures?: string[];
  };
  const benefit = await readSamples(path.join(dir, 'samples.jsonl'));
  const columns = buildColumns(benefit, saved.assets.assetSha256);
  const verdicts = buildVerdicts(columns);
  const stress = await readSamples(path.join(dir, 'stress-samples.jsonl'));
  const callbacks = callbackSummary(await readFrames(path.join(dir, 'frames.jsonl')));
  const electronVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies.electron as string;
  const report = renderReport({
    env: {
      host: `${os.platform()} ${os.release()} ${os.arch()} ${os.cpus()[0]?.model ?? ''} × ${os.cpus().length}，内存 ${Math.round(os.totalmem() / (1024 * 1024))} MiB`,
      electron: electronVersion,
      window: `${WINDOW_WIDTH}×${WINDOW_HEIGHT} @ ${WINDOW_X},${WINDOW_Y}，Linux 关闭硬件加速，透明无边框`,
      behavior: '关闭',
      dwellMs: DWELL_MS,
      idleCpuMs: IDLE_CPU_MS,
      assetSha256: saved.assets.assetSha256,
      files: saved.assets.files,
      outDir: path.relative(root, dir) || dir,
      command: 'cd pet-next\nnode --experimental-strip-types bench/cli.ts',
    },
    columns,
    verdicts,
    stress: stressSummary(stress),
    callbacks,
  });
  await writeFile(path.join(dir, 'report.md'), report);
  await writeFile(
    path.join(dir, 'summaries.json'),
    JSON.stringify({ summaries: verdicts.map((verdict) => toSummary(verdict)), columns, failures: saved.failures ?? [] }, null, 2),
  );
  console.log(path.join(dir, 'report.md'));
}

function callbackSummary(records: readonly FrameRecord[]): CallbackLine[] {
  const lines: CallbackLine[] = [];
  for (const mode of ['single', 'two-slot', 'two-slot-preheat'] as const) {
    for (const play of ['first', 'repeat'] as const) {
      const mine = records.filter((record) => record.mode === mode && record.play === play);
      if (mine.length === 0) continue;
      lines.push({
        mode,
        play,
        presentationP50: percentile(
          mine.flatMap((record) => (typeof record.sidecar?.presentationMs === 'number' ? [record.sidecar.presentationMs] : [])),
          50,
        ),
        adapterP50: percentile(
          mine.flatMap((record) =>
            typeof record.sidecar?.adapterFirstFrameMs === 'number' ? [record.sidecar.adapterFirstFrameMs] : [],
          ),
          50,
        ),
      });
    }
  }
  return lines;
}

interface FrameRecord {
  mode?: string;
  play?: string;
  sidecar?: { presentationMs?: number | null; adapterFirstFrameMs?: number | null };
}

function stressSummary(samples: readonly BenchSample[]): StressLine[] {
  const lines: StressLine[] = [];
  for (const mode of ['single', 'two-slot', 'two-slot-preheat'] as const) {
    const mine = samples.filter((sample) => sample.mode === mode);
    if (mine.length === 0) continue;
    lines.push({
      mode,
      count: mine.length,
      clickP50: percentile(mine.flatMap((sample) => (sample.clickToFirstFrameMs === null ? [] : [sample.clickToFirstFrameMs])), 50),
      blankP50: percentile(mine.flatMap((sample) => (sample.blankMs === null ? [] : [sample.blankMs])), 50),
      delayMs: STRESS_DELAY_MS,
      dwellMs: STRESS_DWELL_MS,
    });
  }
  return lines;
}

async function compile(): Promise<void> {
  const tsc = path.join(root, 'node_modules/typescript/lib/tsc.js');
  const code = await exec(process.execPath, [tsc, '-p', path.join(root, 'bench/tsconfig.json')], root, 120000);
  if (code !== 0) throw new Error(`tsc exited ${code}`);
}

async function runJob(job: BenchJob): Promise<string | null> {
  await mkdir(job.outDir, { recursive: true });
  await writeFile(path.join(job.outDir, 'job.json'), JSON.stringify(job, null, 2));
  const userData = path.join(job.outDir, 'user-data');
  await mkdir(userData, { recursive: true });
  const mainJs = path.join(root, 'dist/bench-build/bench/main.js');
  const args = [...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []), mainJs];
  const timeoutMs = (job.firstCount + job.repeatCount + 2) * 25000 + 30000;
  console.log(`start ${job.mode} round ${job.round} stress ${job.stressDelayMs}`);
  const code = await exec(electronPath, args, root, timeoutMs, {
    BENCH_JOB: JSON.stringify(job),
    BENCH_ROOT: root,
    BENCH_USER_DATA: userData,
  });
  await rm(userData, { recursive: true, force: true });
  if (code !== 0) return `exit ${code}`;
  return null;
}

function exec(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(file, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const timer = setTimeout(() => {
      kill(child);
      resolve(124);
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(127);
    });
  });
}

function kill(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已经退出。
    }
  }
}

async function concat(files: readonly string[], dest: string): Promise<void> {
  let body = '';
  for (const file of files) {
    try {
      const text = await readFile(file, 'utf8');
      body += text;
      if (text.length > 0 && !text.endsWith('\n')) body += '\n';
    } catch {
      // 这一轮没有写出样本。
    }
  }
  await writeFile(dest, body);
}

async function readFrames(file: string): Promise<FrameRecord[]> {
  try {
    const text = await readFile(file, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as FrameRecord);
  } catch {
    return [];
  }
}

async function readSamples(file: string): Promise<BenchSample[]> {
  try {
    const text = await readFile(file, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as BenchSample);
  } catch {
    return [];
  }
}

function pathToFileUrl(file: string): string {
  return pathToFileURL(file).href;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
