/**
 * 点击响应对照：单槽全母带（single-full） vs 单槽截取短片（single-short）。
 *
 * 本脚本的"点击→首明确回应"是估算值，不是产品观察值：
 * - clickToPlayResolvedMs（观察）：适配器 `playing` 兑现（bench 页 playResolvedMs）。
 * - clickToFirstFrameMs（观察）：画面出现首帧（bench 页 rVFC + 不透明采样）。
 * - clickToFirstClearResponseEstimateMs（估算）：实测首帧 + 该素材自身从第 0 帧到明确
 *   回应的时长（response-onset 逐帧运动量规则，素材内实测常数；主臂只记录首帧附近，
 *   产品回应终点从未被观测）。估算字段带 Estimate 后缀并附 estimation 说明结构。
 *
 * 产品真实回应观测（到目标回应帧才算兑现）在 bench/click-product.ts，与本脚本分列。
 *
 * 对照：每臂 {@link CLICK_ROUNDS} 轮 × 每轮 {@link CLICK_SAMPLES_PER_ROUND} 个样本。
 * 负对照用损坏素材（装载应失败 → 三段都记 null）；正对照用候选素材自比（必须与短片臂一致）。
 *
 * 用法：cd pet-next && node --experimental-strip-types bench/click.ts [--smoke] [--out DIR]
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLICK_ARMS, CLICK_CONTROL_SAMPLES, CLICK_ROUNDS, CLICK_SAMPLES_PER_ROUND } from '../contracts/bench-click.ts';
import type { ClickArm } from '../contracts/bench-click.ts';
import type { BenchSample } from '../contracts/bench.ts';
import { hashFile } from '../assets-pipeline/asset-report.ts';
import { measureOnset as measureAssetOnset, type OnsetMeasurement } from './onset.ts';
import { buildClickOutcomeRecord, summarizeClickOutcomes, type ClickOutcomeRecord, type ClickOutcomeSummary } from './click-record.ts';
import type { BenchJob } from './job.ts';
import { DWELL_MS, WINDOW_HEIGHT, WINDOW_WIDTH, WINDOW_X, WINDOW_Y } from './protocol.ts';

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

type Onset = OnsetMeasurement & { readonly arm: ClickArm };

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
  const samplesByArm = new Map<ClickArm, ClickOutcomeRecord[]>();
  for (const asset of armAssets) {
    const onset = offsets.get(asset.arm)!;
    const collected: ClickOutcomeRecord[] = [];
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
        arms: CLICK_ARMS.map((arm) =>
          summarizeClickOutcomes(arm, samplesByArm.get(arm) ?? [], offsets.get(arm)?.onsetMs ?? null),
        ),
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
        estimation: {
          field: 'clickToFirstClearResponseEstimateMs',
          method: 'observed-first-frame-plus-material-onset',
          materialOnsetRule: 'assets-pipeline/response-onset.ts',
          note: 'offsets 是素材逐帧运动规则测得的素材内回应时刻（素材常数，非产品观察）；估算 = 实测首帧 + 该常数，产品回应终点未观测',
        },
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

/** 素材内"第 0 帧 → 明确回应"时长（bench/onset.ts：逐帧解码 + 运动量规则，与短片截取同一套判定）。 */
async function measureOnset(asset: ArmAsset): Promise<Onset> {
  const limit = smoke ? 80 : 160;
  return { arm: asset.arm, ...(await measureAssetOnset(asset.file, limit)) };
}

function toClickSample(arm: ClickArm, row: BenchSample, onset: Onset): ClickOutcomeRecord {
  return buildClickOutcomeRecord({
    arm,
    round: row.round,
    index: row.index,
    row: {
      clickToFirstFrameMs: finiteOrNull(row.clickToFirstFrameMs),
      playResolvedMs: finiteOrNull(row.playResolvedMs),
      assetSha256: row.assetSha256,
    },
    materialOnsetMs: onset.onsetMs,
    materialOnsetFrame: onset.onsetFrame,
  });
}

function finiteOrNull(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function renderClickReport(input: {
  samplesByArm: Map<ClickArm, ClickOutcomeRecord[]>;
  offsets: Map<ClickArm, Onset>;
  negative: readonly ClickOutcomeRecord[];
  positive: readonly ClickOutcomeRecord[];
  failures: readonly string[];
  integrity: { negativeRows: number; positiveRows: number };
}): string {
  const summaries = CLICK_ARMS.map((arm) =>
    summarizeClickOutcomes(arm, input.samplesByArm.get(arm) ?? [], input.offsets.get(arm)?.onsetMs ?? null),
  );
  const [full, short] = summaries;
  const cell = (value: number | null): string => (value === null ? '—' : `${Math.round(value)}`);
  const delta = (a: number | null, b: number | null): string =>
    a === null || b === null ? '—' : `${Math.round(b - a) >= 0 ? '+' : ''}${Math.round(b - a)}`;

  const lines: string[] = [];
  lines.push('# 点击响应对照：单槽全母带 vs 单槽截取短片');
  lines.push('');
  lines.push('两臂的播放实现相同（单槽适配器、同一窗口参数、关闭自主行为），只有回应素材不同。');
  lines.push('各段毫秒数都来自同一次点击；`—` 表示该段没有兑现，不按 0ms 计。');
  lines.push('兑现与首帧是实测；"点击→首明确回应"是估算（见结果表下说明）。');
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
  lines.push('| 臂 | 样本 | 兑现率 | 点击→兑现 P50/P95（实测） | 点击→首帧 P50/P95（实测） | 点击→首明确回应 P50/P95（估算） |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const summary of summaries) {
    const rate = summary.count === 0 ? '—' : `${summary.firstFrameCount}/${summary.count}`;
    lines.push(
      `| \`${summary.arm}\` | ${summary.count} | ${rate} | ${cell(summary.playResolvedP50)}/${cell(summary.playResolvedP95)} | ${cell(summary.firstFrameP50)}/${cell(summary.firstFrameP95)} | ${cell(summary.clearResponseEstimateP50)}/${cell(summary.clearResponseEstimateP95)} |`,
    );
  }
  lines.push('');
  lines.push('**"点击→首明确回应"是估算值，不是观察值**：估算 = 实测首帧 + 素材内回应时刻');
  lines.push('（response-onset 逐帧运动规则常数；P50 相加，两者都是同一次点击的分段量）。');
  lines.push('本脚本主臂只记录首帧附近，产品回应终点从未被观测；样本级 `estimation` 结构记录方法与输入。');
  lines.push('产品内实测到目标回应帧的观测见 `bench/click-product.ts` 的 runs-click-product 报告（分列输出）。');
  lines.push('');
  lines.push('| 口径 | P50 差值（短片 − 全母带） | P95 差值 |');
  lines.push('| --- | --- | --- |');
  lines.push(
    `| 点击→首帧（实测） | ${delta(full?.firstFrameP50 ?? null, short?.firstFrameP50 ?? null)} ms | ${delta(full?.firstFrameP95 ?? null, short?.firstFrameP95 ?? null)} ms |`,
  );
  lines.push(
    `| 点击→首明确回应（估算） | ${delta(full?.clearResponseEstimateP50 ?? null, short?.clearResponseEstimateP50 ?? null)} ms | ${delta(full?.clearResponseEstimateP95 ?? null, short?.clearResponseEstimateP95 ?? null)} ms |`,
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
  // Electron profile 放临时目录（与 click-product.ts 一致）：run 目录只留有效证据，
  // 不再产生 user-data/ 运行时垃圾（bench/.gitignore 兜底排除）。
  const userData = await mkdtemp(path.join(os.tmpdir(), 'pet-next-bench-'));
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
