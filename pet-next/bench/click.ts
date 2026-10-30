/**
 * 点击响应对照：单槽全母带（single-full） vs 单槽截取短片（single-short）。
 *
 * 三段时间戳同一来源（同一次点击）：
 * - clickToPlayResolvedMs：适配器 `playing` 兑现（bench 页 playResolvedMs）。
 * - clickToFirstFrameMs：画面出现首帧（bench 页 rVFC + 不透明采样）。
 * - clickToFirstClearResponseMs：首次出现"明确回应"画面 = clickToFirstFrameMs +
 *   该素材自身从第 0 帧到明确回应的时长（response-onset 逐帧运动量规则，素材内实测，
 *   不是人工标注；没有截图轮询）。
 *
 * 对照：每臂 {@link CLICK_ROUNDS} 轮 × 每轮 {@link CLICK_SAMPLES_PER_ROUND} 个样本。
 * 负对照用损坏素材（装载应失败 → 三段都记 null）；正对照用候选素材自比（必须与短片臂一致）。
 *
 * 用法：cd pet-next && node --experimental-strip-types bench/click.ts [--smoke] [--out DIR]
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLICK_ARMS, CLICK_CONTROL_SAMPLES, CLICK_ROUNDS, CLICK_SAMPLES_PER_ROUND } from '../contracts/bench-click.ts';
import type { ClickArm, ClickResponseSample } from '../contracts/bench-click.ts';
import type { BenchSample } from '../contracts/bench.ts';
import { hashFile } from '../assets-pipeline/asset-report.ts';
import { decodeRgba, probeVideo } from '../assets-pipeline/read-media.ts';
import type { RgbaFrame } from '../assets-pipeline/frame-metrics.ts';
import { responseOnsetMs } from '../assets-pipeline/response-onset.ts';
import type { BenchJob } from './job.ts';
import { DWELL_MS, WINDOW_HEIGHT, WINDOW_WIDTH, WINDOW_X, WINDOW_Y } from './protocol.ts';
import { percentile } from './stats.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const electronPath = require('electron') as string;

const smoke = process.argv.includes('--smoke');
const rounds = smoke ? 1 : CLICK_ROUNDS;
const samples = smoke ? 2 : CLICK_SAMPLES_PER_ROUND;
const controlSamples = smoke ? 1 : CLICK_CONTROL_SAMPLES;
const outFlag = process.argv.indexOf('--out');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runRoot =
  outFlag >= 0 && process.argv[outFlag + 1]
    ? path.resolve(process.argv[outFlag + 1]!)
    : path.join(root, 'bench/runs-click', stamp);

interface ArmAsset {
  readonly arm: ClickArm;
  readonly label: string;
  readonly file: string;
}

const armAssets: readonly ArmAsset[] = [
  // 成品 assets/reaction.webm 实测解码后没有任何不透明前景（assets:check 记为 source-lacks-alpha），
  // 在 Chromium 里也渲染为空，不能当"可播放基线"。全母带臂用它截取前的源母带。
  { arm: 'single-full', label: '源母带 241 帧 10.0s', file: path.join(root, 'assets/candidates/reaction/source.webm') },
  { arm: 'single-short', label: '截取短片 106 帧 4.4s', file: path.join(root, 'assets/candidates/reaction/short.webm') },
];

interface Onset {
  readonly arm: ClickArm;
  readonly sha256: string;
  readonly fps: number;
  readonly onsetMs: number | null;
  readonly onsetFrame: number | null;
  readonly frames: number;
}

async function main(): Promise<void> {
  await mkdir(runRoot, { recursive: true });
  const offsets = new Map<ClickArm, Onset>();
  for (const asset of armAssets) {
    offsets.set(asset.arm, await measureOnset(asset));
  }
  const short = offsets.get('single-short');
  if (short === undefined || short.onsetMs === null) {
    throw new Error('短片里找不到明确回应，对照无法成立');
  }

  await compile();
  await copyFile(path.join(root, 'bench/page.html'), path.join(root, 'dist/bench-build/bench/page.html'));
  const idleUrl = pathToFileUrl(path.join(root, 'assets/idle.webm'));

  const failures: string[] = [];
  const samplesByArm = new Map<ClickArm, ClickResponseSample[]>();
  for (const asset of armAssets) {
    const onset = offsets.get(asset.arm)!;
    const collected: ClickResponseSample[] = [];
    for (let round = 1; round <= rounds; round += 1) {
      const outDir = path.join(runRoot, `round-${round}`, asset.arm);
      const job: BenchJob = {
        mode: 'single',
        round,
        firstCount: samples,
        repeatCount: 0,
        dwellMs: DWELL_MS,
        idleCpuMs: 200,
        stressDelayMs: 0,
        wait: 'frame',
        assetSha256: onset.sha256,
        idleUrl,
        reactionUrl: pathToFileUrl(asset.file),
        runRoot,
        outDir,
      };
      const error = await runJob(job);
      if (error) failures.push(`${asset.arm} round ${round}: ${error}`);
      const rows = await readSamples(path.join(outDir, 'samples.jsonl'));
      for (const row of rows) {
        if (row.play !== 'first') continue;
        collected.push(toClickSample(asset.arm, row, onset));
      }
    }
    samplesByArm.set(asset.arm, collected);
    if (collected.length < rounds * samples) {
      failures.push(`${asset.arm} 样本 ${collected.length}/${rounds * samples}`);
    }
  }

  // 负对照：损坏素材必须装载失败（三段都为 null）。失败也要记，不能当 0ms。
  const corrupt = path.join(runRoot, 'controls/corrupt.webm');
  await mkdir(path.dirname(corrupt), { recursive: true });
  writeFileSync(corrupt, Buffer.from('<<not a webm>>'.repeat(256)));
  const corruptJob: BenchJob = {
    mode: 'single',
    round: 0,
    firstCount: controlSamples,
    repeatCount: 0,
    dwellMs: DWELL_MS,
    idleCpuMs: 200,
    stressDelayMs: 0,
    assetSha256: (await hashFile(corrupt))?.sha256 ?? 'unknown',
    idleUrl,
    reactionUrl: pathToFileUrl(corrupt),
    runRoot,
    outDir: path.join(runRoot, 'controls/negative'),
  };
  const negativeError = await runJob(corruptJob);
  if (negativeError) failures.push(`negative: ${negativeError}`);
  const negativeRows = await readSamples(path.join(corruptJob.outDir, 'samples.jsonl'));
  const negativeSamples = negativeRows
    .filter((row) => row.play === 'first')
    .map((row) => toClickSample('single-full', row, offsets.get('single-full')!));
  const negativeFired = negativeSamples.filter((sample) => sample.clickToFirstFrameMs === null).length;
  if (negativeRows.length > 0 && negativeFired !== negativeSamples.length) {
    failures.push(`负对照没有全部失败：${negativeFired}/${negativeSamples.length}`);
  }

  // 正对照：候选素材（与短片同一份字节）自比，必须成功且与短片臂同量级。
  const positiveAsset = armAssets.find((asset) => asset.arm === 'single-short')!;
  const positiveJob: BenchJob = {
    ...corruptJob,
    round: 0,
    assetSha256: short.sha256,
    reactionUrl: pathToFileUrl(positiveAsset.file),
    outDir: path.join(runRoot, 'controls/positive'),
  };
  const positiveError = await runJob(positiveJob);
  if (positiveError) failures.push(`positive: ${positiveError}`);
  const positiveRows = await readSamples(path.join(positiveJob.outDir, 'samples.jsonl'));
  const positiveSamples = positiveRows
    .filter((row) => row.play === 'first')
    .map((row) => toClickSample('single-short', row, short));
  const positiveOk = positiveSamples.filter((sample) => sample.clickToFirstFrameMs !== null).length;
  if (positiveRows.length > 0 && positiveOk !== positiveSamples.length) {
    failures.push(`正对照没有全部兑现：${positiveOk}/${positiveSamples.length}`);
  }

  const all = [...samplesByArm.values()].flat().concat(negativeSamples, positiveSamples);
  await writeFile(
    path.join(runRoot, 'click-samples.jsonl'),
    all.map((sample) => `${JSON.stringify(sample)}\n`).join(''),
  );
  const report = renderClickReport({
    samplesByArm,
    offsets,
    negative: negativeSamples,
    positive: positiveSamples,
    failures,
    integrity: { negativeRows: negativeRows.length, positiveRows: positiveRows.length },
  });
  await writeFile(path.join(runRoot, 'report.md'), report);
  await writeFile(
    path.join(runRoot, 'summaries.json'),
    JSON.stringify(
      {
        arms: CLICK_ARMS.map((arm) => summarize(arm, samplesByArm.get(arm) ?? [], offsets.get(arm)?.onsetMs ?? null)),
        controls: {
          negative: { samples: negativeSamples, allFailed: negativeFired === negativeSamples.length },
          positive: { samples: positiveSamples, allResolved: positiveOk === positiveSamples.length },
        },
        failures,
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(runRoot, 'environment.json'),
    JSON.stringify(
      {
        host: `${os.platform()} ${os.release()} ${os.arch()}`,
        cpu: `${os.cpus()[0]?.model ?? ''} × ${os.cpus().length}`,
        totalMem: os.totalmem(),
        electron: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).devDependencies.electron,
        window: { x: WINDOW_X, y: WINDOW_Y, width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
        behavior: false,
        dwellMs: DWELL_MS,
        rounds,
        samples,
        controlSamples,
        smoke,
        offsets: [...offsets.values()],
        command: 'cd pet-next\nnode --experimental-strip-types bench/click.ts',
      },
      null,
      2,
    ),
  );
  console.log(path.join(runRoot, 'report.md'));
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  }
}

/** 素材内"第 0 帧 → 明确回应"时长。逐帧解码 + 运动量规则（与短片截取同一套判定）。 */
async function measureOnset(asset: ArmAsset): Promise<Onset> {
  const hashed = await hashFile(asset.file);
  if (!hashed) throw new Error(`找不到素材 ${asset.file}`);
  const probe = await probeVideo('ffprobe', asset.file);
  const fps = await readFps(asset.file);
  const frames: RgbaFrame[] = [];
  const limit = smoke ? 80 : 160;
  while (frames.length < limit) {
    const one = await decodeRgba('ffmpeg', asset.file, probe, frames.length);
    if (!one || one.length === 0) break;
    frames.push(one[0]!);
  }
  const onsetMs = responseOnsetMs(frames, fps);
  return {
    arm: asset.arm,
    sha256: hashed.sha256,
    fps,
    onsetMs,
    onsetFrame: onsetMs === null ? null : Math.round((onsetMs / 1000) * fps),
    frames: frames.length,
  };
}

async function readFps(file: string): Promise<number> {
  const { execFile } = await import('node:child_process');
  const raw = await new Promise<string>((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'json', file],
      { timeout: 20_000 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });
  const parsed = JSON.parse(raw) as { streams?: Array<{ r_frame_rate?: string }> };
  const [num = 0, den = 0] = (parsed.streams?.[0]?.['r_frame_rate'] ?? '0/1').split('/').map(Number);
  if (!den) throw new Error(`读不出帧率：${file}`);
  return num / den;
}

function toClickSample(arm: ClickArm, row: BenchSample, onset: Onset): ClickResponseSample {
  const firstFrame = finiteOrNull(row.clickToFirstFrameMs);
  return {
    arm,
    round: row.round,
    index: row.index,
    clickToPlayResolvedMs: finiteOrNull(row.playResolvedMs),
    clickToFirstFrameMs: firstFrame,
    clickToFirstClearResponseMs:
      firstFrame === null || onset.onsetMs === null ? null : firstFrame + onset.onsetMs,
    assetSha256: row.assetSha256,
  };
}

function finiteOrNull(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface ArmSummary {
  arm: ClickArm;
  count: number;
  resolvedCount: number;
  firstFrameCount: number;
  playResolvedP50: number | null;
  playResolvedP95: number | null;
  firstFrameP50: number | null;
  firstFrameP95: number | null;
  clearResponseP50: number | null;
  clearResponseP95: number | null;
  onsetMs: number | null;
}

function summarize(arm: ClickArm, samples: readonly ClickResponseSample[], onsetMs: number | null): ArmSummary {
  const pick = (read: (sample: ClickResponseSample) => number | null): number[] =>
    samples.flatMap((sample) => (read(sample) === null ? [] : [read(sample)!]));
  return {
    arm,
    count: samples.length,
    resolvedCount: samples.filter((sample) => sample.clickToPlayResolvedMs !== null).length,
    firstFrameCount: samples.filter((sample) => sample.clickToFirstFrameMs !== null).length,
    playResolvedP50: percentile(pick((sample) => sample.clickToPlayResolvedMs), 50),
    playResolvedP95: percentile(pick((sample) => sample.clickToPlayResolvedMs), 95),
    firstFrameP50: percentile(pick((sample) => sample.clickToFirstFrameMs), 50),
    firstFrameP95: percentile(pick((sample) => sample.clickToFirstFrameMs), 95),
    clearResponseP50: percentile(pick((sample) => sample.clickToFirstClearResponseMs), 50),
    clearResponseP95: percentile(pick((sample) => sample.clickToFirstClearResponseMs), 95),
    onsetMs,
  };
}

function renderClickReport(input: {
  samplesByArm: Map<ClickArm, ClickResponseSample[]>;
  offsets: Map<ClickArm, Onset>;
  negative: readonly ClickResponseSample[];
  positive: readonly ClickResponseSample[];
  failures: readonly string[];
  integrity: { negativeRows: number; positiveRows: number };
}): string {
  const summaries = CLICK_ARMS.map((arm) =>
    summarize(arm, input.samplesByArm.get(arm) ?? [], input.offsets.get(arm)?.onsetMs ?? null),
  );
  const [full, short] = summaries;
  const cell = (value: number | null): string => (value === null ? '—' : `${Math.round(value)}`);
  const delta = (a: number | null, b: number | null): string =>
    a === null || b === null ? '—' : `${Math.round(b - a) >= 0 ? '+' : ''}${Math.round(b - a)}`;

  const lines: string[] = [];
  lines.push('# 点击响应对照：单槽全母带 vs 单槽截取短片');
  lines.push('');
  lines.push('两臂的播放实现相同（单槽适配器、同一窗口参数、关闭自主行为），只有回应素材不同。');
  lines.push('三段毫秒数都来自同一次点击；`—` 表示该段没有兑现，不按 0ms 计。');
  lines.push('');
  lines.push('## 素材');
  lines.push('');
  lines.push('| 臂 | 素材 | sha256 | 帧率 | 素材内明确回应时刻 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const asset of armAssets) {
    const onset = input.offsets.get(asset.arm)!;
    lines.push(
      `| \`${asset.arm}\` | ${asset.label} | \`${onset.sha256.slice(0, 16)}…\` | ${onset.fps} | ${onset.onsetMs === null ? '未检出' : `${Math.round(onset.onsetMs)} ms（第 ${onset.onsetFrame} 帧）`} |`,
    );
  }
  lines.push('');
  lines.push('素材内回应时刻由逐帧运动量判定（任一 RGB 通道差 > 24 的像素数 ≥ 5% 画幅且后续窗口持续），');
  lines.push('脚本 `assets-pipeline/response-onset.ts`，与短片截取用同一套规则。');
  lines.push('');
  lines.push('## 结果');
  lines.push('');
  lines.push('| 臂 | 样本 | 兑现率 | 点击→兑现 P50/P95 | 点击→首帧 P50/P95 | 点击→首明确回应 P50/P95 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const summary of summaries) {
    const rate = summary.count === 0 ? '—' : `${summary.firstFrameCount}/${summary.count}`;
    lines.push(
      `| \`${summary.arm}\` | ${summary.count} | ${rate} | ${cell(summary.playResolvedP50)}/${cell(summary.playResolvedP95)} | ${cell(summary.firstFrameP50)}/${cell(summary.firstFrameP95)} | ${cell(summary.clearResponseP50)}/${cell(summary.clearResponseP95)} |`,
    );
  }
  lines.push('');
  lines.push('点击→首明确回应 = 点击→首帧 + 素材内回应时刻（P50 相加：两者都是同一次点击的分段量）。');
  lines.push('');
  lines.push('| 口径 | P50 差值（短片 − 全母带） | P95 差值 |');
  lines.push('| --- | --- | --- |');
  lines.push(
    `| 点击→首帧 | ${delta(full?.firstFrameP50 ?? null, short?.firstFrameP50 ?? null)} ms | ${delta(full?.firstFrameP95 ?? null, short?.firstFrameP95 ?? null)} ms |`,
  );
  lines.push(
    `| 点击→首明确回应 | ${delta(full?.clearResponseP50 ?? null, short?.clearResponseP50 ?? null)} ms | ${delta(full?.clearResponseP95 ?? null, short?.clearResponseP95 ?? null)} ms |`,
  );
  lines.push('');
  lines.push('## 对照');
  lines.push('');
  lines.push(
    `- 负对照（损坏素材，${input.negative.length} 样本）：期望全部兑现失败——实际首帧为 \`—\` 的 ${input.negative.filter((sample) => sample.clickToFirstFrameMs === null).length}/${input.negative.length}。`,
  );
  lines.push(
    `- 正对照（候选素材自比，${input.positive.length} 样本）：期望全部兑现——实际 ${input.positive.filter((sample) => sample.clickToFirstFrameMs !== null).length}/${input.positive.length}。`,
  );
  lines.push('');
  if (input.failures.length > 0) {
    lines.push('## 未达成项');
    lines.push('');
    for (const failure of input.failures) lines.push(`- ${failure}`);
    lines.push('');
  }
  lines.push('## 复现');
  lines.push('');
  lines.push('```');
  lines.push('cd pet-next');
  lines.push('node --experimental-strip-types bench/click.ts');
  lines.push('```');
  lines.push('');
  lines.push(`原始样本：\`click-samples.jsonl\`；每轮每臂的屏幕条带与帧记录在 \`round-*/<arm>/strips\`、\`frames.jsonl\`。`);
  lines.push('');
  return lines.join('\n');
}

async function compile(): Promise<void> {
  const tsc = path.join(root, 'node_modules/typescript/lib/tsc.js');
  const code = await exec(process.execPath, [tsc, '-p', path.join(root, 'bench/tsconfig.json')], root, 120_000);
  if (code !== 0) throw new Error(`tsc exited ${code}`);
}

async function runJob(job: BenchJob): Promise<string | null> {
  await mkdir(job.outDir, { recursive: true });
  await writeFile(path.join(job.outDir, 'job.json'), JSON.stringify(job, null, 2));
  const userData = path.join(job.outDir, 'user-data');
  await mkdir(userData, { recursive: true });
  const mainJs = path.join(root, 'dist/bench-build/bench/main.js');
  const args = [...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []), mainJs];
  const timeoutMs = (job.firstCount + 2) * 25_000 + 30_000;
  console.log(`start ${job.mode} ${job.outDir} samples ${job.firstCount}`);
  const code = await exec(electronPath, args, root, timeoutMs, {
    BENCH_JOB: JSON.stringify(job),
    BENCH_ROOT: root,
    BENCH_USER_DATA: userData,
  });
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

function pathToFileUrl(file: string): string {
  return pathToFileURL(file).href;
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

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
