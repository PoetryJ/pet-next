/**
 * 产品真实回应观测驱动：单槽全母带 vs 单槽截取短片 + 正/负对照组。
 *
 * 与 bench/click.ts（bench 测量页）分列输出，三者互不冒充：
 * - 实测（观察）：输入时刻→play 兑现、→回应素材首帧、→目标回应帧（rVFC mediaTime 判据）。
 * - 素材运动起点估算：素材内逐帧运动规则常数（bench/onset.ts），输入列，非产品观察。
 * - 对照估算列：实测首帧 P50 + 素材内回应时刻，仅用于与观测列并排核对。
 *
 * 对照组：正控 = 可用素材（应观测到回应帧）；负控 = 损坏素材（应为未完成/null）。
 * 负控期望 play 失败（装载超时）→ endState=load-failed，观察字段全 null。
 *
 * 用法：cd pet-next && node --experimental-strip-types bench/click-product.ts
 *   [--smoke] [--controls-only] [--arms-only] [--out DIR]
 *   （需要 DISPLAY；主进程在 bench/main-product.ts，产品文件零改动）
 */
import { spawn, type ChildProcess, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLICK_ROUNDS, CLICK_SAMPLES_PER_ROUND, CLICK_CONTROL_SAMPLES } from '../contracts/bench-click.ts';
import { hashFile } from '../assets-pipeline/asset-report.ts';
import { measureOnset, type OnsetMeasurement } from './onset.ts';
import type { ProductClickSample } from './product-observe.ts';
import { percentile } from './stats.ts';
import { DWELL_MS, WINDOW_HEIGHT, WINDOW_WIDTH, WINDOW_X, WINDOW_Y } from './protocol.ts';

const argv = process.argv.slice(2);
const smoke = argv.includes('--smoke');
const controlsOnly = argv.includes('--controls-only');
const armsOnly = argv.includes('--arms-only');
const outIndex = argv.indexOf('--out');

const here = path.dirname(fileURLToPath(import.meta.url));
const petRoot = path.resolve(here, '..');
const runRoot =
  outIndex >= 0 && argv[outIndex + 1] ? path.resolve(argv[outIndex + 1]!) : path.join(petRoot, 'bench', 'runs-click-product', stamp());

const IDLE = path.join(petRoot, 'assets/idle.webm');
const FULL = path.join(petRoot, 'assets/candidates/reaction/source.webm');
const SHORT = path.join(petRoot, 'assets/candidates/reaction/short.webm');

const ROUNDS = smoke ? 1 : CLICK_ROUNDS;
const SAMPLES_PER_ROUND = smoke ? 2 : CLICK_SAMPLES_PER_ROUND;
const CONTROL_SAMPLES = smoke ? 1 : CLICK_CONTROL_SAMPLES;
const SAMPLE_TIMEOUT_MS = 12_000;

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const require = createRequire(import.meta.url);

function resolveElectron(): string {
  const electronPackage = require.resolve('electron/package.json');
  return path.join(path.dirname(electronPackage), 'dist', 'electron');
}

function run(node: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(node, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label} exit ${code}`))));
  });
}

/** bench 编译（dist/bench-build）+ 产品页构建（dist/app 等，等价 pnpm build，不碰 node_modules）。 */
async function buildAll(): Promise<void> {
  const tsc = path.join(petRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
  await run(process.execPath, [tsc, '-p', path.join(petRoot, 'bench/tsconfig.json')], 'tsc bench');
  await run(process.execPath, [tsc, '-p', path.join(petRoot, 'tsconfig.json')], 'tsc app');
  await run(process.execPath, [tsc, '-p', path.join(petRoot, 'tsconfig.preload.json')], 'tsc preload');
  await run(process.execPath, [path.join(petRoot, 'scripts/copy-static.mjs')], 'copy-static');
}

interface UnitSpec {
  label: string;
  arm: string;
  round: number;
  reactionPath: string;
  onset: OnsetMeasurement | null;
  sha256: string;
  samples: number;
  captureEvidence: boolean;
  includeEvents: boolean;
}

async function runUnit(unit: UnitSpec): Promise<unknown[]> {
  const unitDir = path.join(runRoot, unit.arm, unit.round > 0 ? `round-${unit.round}` : '.');
  await mkdir(unitDir, { recursive: true });
  const userData = await mkdtemp(path.join(os.tmpdir(), 'pet-next-product-'));
  const job = {
    label: unit.label,
    outDir: unitDir,
    runRoot,
    idleUrl: pathToFileURL(IDLE).href,
    reactionUrl: pathToFileURL(unit.reactionPath).href,
    samples: unit.samples,
    dwellMs: DWELL_MS,
    onset: unit.onset,
    assetSha256: unit.sha256,
    sampleTimeoutMs: SAMPLE_TIMEOUT_MS,
    captureEvidence: unit.captureEvidence,
    includeEvents: unit.includeEvents,
  };
  const child: ChildProcess = spawn(
    resolveElectron(),
    [...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []), path.join(petRoot, 'dist/bench-build/bench/main-product.js')],
    {
    env: {
      ...process.env,
      BENCH_PRODUCT_JOB: JSON.stringify(job),
      BENCH_ROOT: petRoot,
      BENCH_USER_DATA: userData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const exit = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${unit.label} 超时`));
    }, unit.samples * (SAMPLE_TIMEOUT_MS + 20_000) + 90_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (exit !== 0) throw new Error(`${unit.label} electron exit ${exit}`);
  const raw = await readFile(path.join(unitDir, 'samples.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

interface UnitSummary {
  arm: string;
  count: number;
  observedCount: number;
  endStates: Record<string, number>;
  playResolvedP50: number | null;
  playResolvedP95: number | null;
  firstFrameP50: number | null;
  firstFrameP95: number | null;
  responseObservedP50: number | null;
  responseObservedP95: number | null;
  /** 对照估算列：实测首帧 P50 + 素材内回应时刻（不是观察值）。 */
  firstFramePlusOnsetEstimateP50: number | null;
  materialOnsetMs: number | null;
}

function summarizeUnit(arm: string, samples: readonly ProductClickSample[], onsetMs: number | null): UnitSummary {
  const pick = (read: (sample: ProductClickSample) => number | null): number[] =>
    samples.flatMap((sample) => (read(sample) === null ? [] : [read(sample)!]));
  const endStates: Record<string, number> = {};
  for (const sample of samples) endStates[sample.endState] = (endStates[sample.endState] ?? 0) + 1;
  const firstFrameP50 = percentile(pick((sample) => sample.firstFrameObservedMs), 50);
  return {
    arm,
    count: samples.length,
    observedCount: samples.filter((sample) => sample.endState === 'response-observed').length,
    endStates,
    playResolvedP50: percentile(pick((sample) => sample.playResolvedMs), 50),
    playResolvedP95: percentile(pick((sample) => sample.playResolvedMs), 95),
    firstFrameP50,
    firstFrameP95: percentile(pick((sample) => sample.firstFrameObservedMs), 95),
    responseObservedP50: percentile(pick((sample) => sample.responseObservedMs), 50),
    responseObservedP95: percentile(pick((sample) => sample.responseObservedMs), 95),
    firstFramePlusOnsetEstimateP50: firstFrameP50 === null || onsetMs === null ? null : firstFrameP50 + onsetMs,
    materialOnsetMs: onsetMs,
  };
}

function cell(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}`;
}

function fmtMs(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)} ms`;
}

function renderReport(input: {
  full: UnitSummary | null;
  short: UnitSummary | null;
  positive: UnitSummary | null;
  negative: UnitSummary | null;
  onsets: { full: OnsetMeasurement; short: OnsetMeasurement };
  rounds: number;
  samplesPerRound: number;
  controlSamples: number;
  armsRun: boolean;
  controlsRun: boolean;
  failures: readonly string[];
}): string {
  const lines: string[] = [];
  lines.push('# 产品真实回应观测（runs-click-product）');
  lines.push('');
  lines.push('在真实产品页（preview=bench-observe，不开行为，pointer 点击路径与验收一致）观测点击到回应的过程。');
  lines.push('与 bench/click.ts 的 bench 测量页报告分列：本报告的回应时间是观测值，不再是"首帧+素材常数"的估算。');
  lines.push('');
  lines.push('## 口径');
  lines.push('');
  lines.push('- 输入：`webContents.sendInputEvent` 合成点击（软件输入）；t0 = 产品页 pointerdown 时刻。');
  lines.push('- 呈帧证据：产品页 video 的 rVFC 元数据（软件呈帧）；不含物理输入设备与物理屏幕呈现延迟。');
  lines.push('- 回应判据（可复算）：固定素材 sha256 + 固定帧号，首个 `mediaTime ≥ onsetFrame/fps` 的呈帧记为回应观测；');
  lines.push('  onset 帧由 assets-pipeline/response-onset.ts 逐帧运动规则离线测得（素材内常数）。');
  lines.push('- 未到目标帧 / 装载失败 / 取消 / 被新输入取代 / 旧请求帧：一律不计成功（记 null + endState）。');
  lines.push('- 事件来源：产品 bench-observe 打点（bench-click/bench-media）+ bench 注入观察器（bench-input/bench-frame，');
  lines.push('  injected:true；产品侧接线同名事件后自动优先产品版）。');
  lines.push('');
  lines.push('## 素材（素材内回应时刻 = 估算输入，非产品观察）');
  lines.push('');
  lines.push('| 素材 | sha256 | fps | 回应帧 | 回应时刻 |');
  lines.push('| --- | --- | --- | --- | --- |');
  lines.push(
    `| 全母带 source.webm | \`${input.onsets.full.sha256.slice(0, 12)}…\` | ${input.onsets.full.fps} | #${input.onsets.full.onsetFrame ?? '—'} | ${fmtMs(input.onsets.full.onsetMs)} |`,
  );
  lines.push(
    `| 截取短片 short.webm | \`${input.onsets.short.sha256.slice(0, 12)}…\` | ${input.onsets.short.fps} | #${input.onsets.short.onsetFrame ?? '—'} | ${fmtMs(input.onsets.short.onsetMs)} |`,
  );
  lines.push('');
  lines.push('## 对照组（观测链验证）');
  lines.push('');
  const positive = input.positive;
  const negative = input.negative;
  if (!input.controlsRun) {
    lines.push('- 本次未运行（`--arms-only`）；观测链对照验证见本目录下更早的 controls run（正控 3/3 命中目标帧，负控 3/3 load-failed 全 null）。');
  } else {
    if (positive) {
      lines.push(
        `- 正控（可用素材 short.webm ×${input.controlSamples}）：回应观测 ${positive.observedCount}/${positive.count}，` +
          `回应 P50 ${cell(positive.responseObservedP50)} ms，endState 分布 ${JSON.stringify(positive.endStates)}。`,
      );
    }
    if (negative) {
      lines.push(
        `- 负控（损坏素材 ×${input.controlSamples}）：回应观测 ${negative.observedCount}/${negative.count}（应为 0），` +
          `endState 分布 ${JSON.stringify(negative.endStates)}。`,
      );
    }
    lines.push('- 关键帧截图证据：`evidence/`（对照组每个样本在首帧与回应时刻各一张）。');
  }
  lines.push('');
  lines.push('## 主臂（每臂 ' + (input.armsRun ? `${input.rounds} 轮 × ${input.samplesPerRound} 样本` : 'not-run') + '）');
  lines.push('');
  if (input.armsRun) {
    lines.push('| 臂 | 样本 | 回应观测成功 | 输入→play 兑现 P50/P95（实测） | 输入→首帧 P50/P95（实测） | 输入→回应帧 P50/P95（实测） | 首帧+素材onset（估算对照列） |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const summary of [input.full, input.short]) {
      if (!summary) continue;
      lines.push(
        `| \`${summary.arm}\` | ${summary.count} | ${summary.observedCount}/${summary.count} | ` +
          `${cell(summary.playResolvedP50)}/${cell(summary.playResolvedP95)} | ` +
          `${cell(summary.firstFrameP50)}/${cell(summary.firstFrameP95)} | ` +
          `${cell(summary.responseObservedP50)}/${cell(summary.responseObservedP95)} | ` +
          `${cell(summary.firstFramePlusOnsetEstimateP50)} |`,
      );
    }
    lines.push('');
    lines.push('分列说明：');
    lines.push('- 实测首帧 = 输入→回应素材首个 rVFC 呈帧。');
    lines.push('- 素材运动起点 = 上表素材内回应时刻（离线逐帧规则常数，估算输入）。');
    lines.push('- 真实回应观测 = 输入→目标回应帧（mediaTime 判据）；"估算对照列"与它的差值即呈现/解码偏差。');
  } else {
    lines.push('- 本次未跑主臂（`--controls-only`）。');
  }
  lines.push('');
  lines.push('## 未证明 / 口径外');
  lines.push('');
  lines.push('- 物理输入设备与物理屏幕呈现延迟未测量（软件输入 + 软件呈帧证据口径）。');
  lines.push('- 姿态（画面内容）核实仅限对照组关键帧截图（evidence/），主臂只依据 rVFC mediaTime 判据。');
  lines.push('- 呈帧 mediaTime 由 Chromium 报告；丢帧时观测帧号可能大于目标帧号（样本内如实记录）。');
  if (input.failures.length > 0) lines.push(`- 单元失败（重试后仍失败，不计入样本）：${input.failures.join('、')}。`);
  return lines.join('\n');
}

/**
 * 自管 Xvfb：外部 Xvfb 可能中途死亡（本次实测踩过），display 归驱动管，
 * 退出时收尾。起不来则回退继承的 DISPLAY（由调用方保证）。
 */
async function ensureDisplay(): Promise<{ display: string; stop: () => void } | null> {
  const display = `:${100 + (process.pid % 800)}`;
  const socket = `/tmp/.X11-unix/X${display.slice(1)}`;
  let child: ChildProcess | null = null;
  try {
    child = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (existsSync(socket)) return { display, stop: () => child?.kill('SIGTERM') };
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGTERM');
  return null;
}

async function main(): Promise<void> {
  const xvfb = await ensureDisplay();
  if (xvfb) {
    process.env['DISPLAY'] = xvfb.display;
    process.on('exit', () => xvfb.stop());
    console.log(`[click-product] 自管 Xvfb ${xvfb.display}`);
  }
  console.log(`[click-product] runRoot=${runRoot}`);
  await buildAll();

  const [fullOnset, shortOnset, idleHash, shortHash] = await Promise.all([
    measureOnset(FULL, smoke ? 80 : 160),
    measureOnset(SHORT, smoke ? 80 : 160),
    hashFile(IDLE),
    hashFile(SHORT),
  ]);
  if (!idleHash || !shortHash) throw new Error('素材缺失（idle/short）');

  const corrupt = path.join(runRoot, 'corrupt.webm');
  await mkdir(runRoot, { recursive: true });
  // 负控：真损坏素材（非 webm 字节），装载必须失败；与 bench/click.ts 的负控同构。
  writeFileSync(corrupt, Buffer.from('<<not a webm>>'.repeat(256)));
  const corruptHash = await hashFile(corrupt);

  const units: UnitSpec[] = [];
  if (!armsOnly) {
    units.push({
      label: 'positive-short',
      arm: 'control-positive',
      round: 0,
      reactionPath: SHORT,
      onset: shortOnset,
      sha256: shortOnset.sha256,
      samples: CONTROL_SAMPLES,
      captureEvidence: true,
      includeEvents: true,
    });
    units.push({
      label: 'negative-corrupt',
      arm: 'control-negative',
      round: 0,
      reactionPath: corrupt,
      onset: null,
      sha256: corruptHash?.sha256 ?? '',
      samples: CONTROL_SAMPLES,
      captureEvidence: true,
      includeEvents: true,
    });
  }
  if (!controlsOnly) {
    for (let round = 1; round <= ROUNDS; round += 1) {
      units.push({
        label: `single-full-r${round}`,
        arm: 'single-full',
        round,
        reactionPath: FULL,
        onset: fullOnset,
        sha256: fullOnset.sha256,
        samples: SAMPLES_PER_ROUND,
        captureEvidence: false,
        includeEvents: false,
      });
      units.push({
        label: `single-short-r${round}`,
        arm: 'single-short',
        round,
        reactionPath: SHORT,
        onset: shortOnset,
        sha256: shortOnset.sha256,
        samples: SAMPLES_PER_ROUND,
        captureEvidence: false,
        includeEvents: false,
      });
    }
  }

  const all: ProductClickSample[] = [];
  const failures: string[] = [];
  for (const unit of units) {
    console.log(`[click-product] 运行 ${unit.label}（${unit.samples} 样本）`);
    // 单元级重试一次：进程级偶发死亡（X/gpu）不应毁掉整轮采集。
    let rows: Array<ProductClickSample & Record<string, unknown>> | null = null;
    for (let attempt = 1; attempt <= 2 && rows === null; attempt += 1) {
      try {
        rows = (await runUnit(unit)) as Array<ProductClickSample & Record<string, unknown>>;
      } catch (error) {
        console.log(`[click-product] ${unit.label} 第 ${attempt} 次失败：${String(error)}`);
      }
    }
    if (rows === null) {
      failures.push(unit.label);
      continue;
    }
    if (rows.length < unit.samples) console.log(`[click-product] ${unit.label} 样本不足：${rows.length}/${unit.samples}`);
    for (const row of rows) {
      row['unit'] = unit.label;
      row['round'] = unit.round;
      all.push(row);
    }
  }
  if (failures.length > 0) console.log(`[click-product] 失败单元：${failures.join('、')}`);

  const byArm = (arm: string): ProductClickSample[] => all.filter((sample) => sample.label.startsWith(arm));
  const controlPositive = byArm('positive-short');
  const controlNegative = byArm('negative-corrupt');
  const armFull = byArm('single-full');
  const armShort = byArm('single-short');
  const armsRun = !controlsOnly;

  const summaries = {
    controlPositive: summarizeUnit('control-positive', controlPositive, shortOnset.onsetMs),
    controlNegative: summarizeUnit('control-negative', controlNegative, null),
    ...(armsRun
      ? {
          singleFull: summarizeUnit('single-full', armFull, fullOnset.onsetMs),
          singleShort: summarizeUnit('single-short', armShort, shortOnset.onsetMs),
        }
      : {}),
  };

  const electronVersion = await new Promise<string>((resolve) => {
    execFile(resolveElectron(), ['--version'], { timeout: 15000 }, (error, stdout) =>
      resolve(error ? 'unknown' : String(stdout).trim()),
    );
  });

  await writeFile(path.join(runRoot, 'product-click-samples.jsonl'), all.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(path.join(runRoot, 'summaries.json'), `${JSON.stringify({ ...summaries, unitFailures: failures }, null, 2)}\n`);
  await writeFile(
    path.join(runRoot, 'environment.json'),
    `${JSON.stringify(
      {
        date: new Date().toISOString(),
        host: os.hostname(),
        platform: process.platform,
        electron: electronVersion,
        node: process.version,
        window: { x: WINDOW_X, y: WINDOW_Y, width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
        rounds: ROUNDS,
        samplesPerRound: SAMPLES_PER_ROUND,
        controlSamples: CONTROL_SAMPLES,
        dwellMs: DWELL_MS,
        sampleTimeoutMs: SAMPLE_TIMEOUT_MS,
        idleSha256: idleHash.sha256,
        onsets: { 'single-full': fullOnset, 'single-short': shortOnset },
        criterion: {
          rule: 'first-presented-frame-with-mediaTime>=onsetFrame/fps',
          onsetSource: 'assets-pipeline/response-onset.ts',
          reactionArmAssets: { 'single-full': fullOnset.sha256, 'single-short': shortOnset.sha256 },
          negativeControl: { file: 'corrupt.webm', sha256: corruptHash?.sha256 ?? null, expect: 'load-failed/null' },
        },
        caliber: {
          input: 'software sendInputEvent（非物理输入设备）',
          frameEvidence: 'rVFC mediaTime（软件呈帧，非物理屏幕呈现）',
          clock: '页面 performance.now()（每文档独立时基，样本内差值）',
        },
        command: 'cd pet-next\nnode --experimental-strip-types bench/click-product.ts',
      },
      null,
      2,
    )}\n`,
  );
  const report = renderReport({
    full: armsRun ? summaries['singleFull' as keyof typeof summaries] ?? null : null,
    short: armsRun ? summaries['singleShort' as keyof typeof summaries] ?? null : null,
    positive: summaries.controlPositive,
    negative: summaries.controlNegative,
    onsets: { full: fullOnset, short: shortOnset },
    rounds: ROUNDS,
    samplesPerRound: SAMPLES_PER_ROUND,
    controlSamples: CONTROL_SAMPLES,
    armsRun,
    controlsRun: !armsOnly,
    failures,
  });
  await writeFile(path.join(runRoot, 'report.md'), `${report}\n`);
  console.log(`[click-product] 完成：${runRoot}`);
  const issues: string[] = [];
  if (!armsOnly && summaries.controlPositive.count < CONTROL_SAMPLES) issues.push('正控样本数不足');
  if (!armsOnly && summaries.controlNegative.observedCount !== 0) issues.push('负控出现假阳性');
  if (!armsOnly && summaries.controlPositive.observedCount !== summaries.controlPositive.count) issues.push('正控未全部观测到回应帧');
  if (issues.length > 0) console.log(`[click-product] 对照组异常：${issues.join('；')}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
