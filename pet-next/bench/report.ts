/**
 * 把对照结果收成一页中文。数字只来自已经算好的列，这里不再解释样本。
 */
import type { BenchRecommendation } from '../contracts/bench.ts';
import type { HashedAsset } from './assets.ts';
import { BENCH_ROUND_COUNT, BENCH_SAMPLE_COUNT, DWELL_MS } from './protocol.ts';
import type { BenchVerdict, PlayColumn, VerdictReason } from './stats.ts';

export interface ReportEnvironment {
  host: string;
  electron: string;
  window: string;
  behavior: string;
  dwellMs: number;
  idleCpuMs: number;
  assetSha256: string;
  files: readonly HashedAsset[];
  outDir: string;
  command: string;
}

export interface StressLine {
  mode: string;
  count: number;
  clickP50: number | null;
  blankP50: number | null;
  delayMs: number;
  dwellMs: number;
}

export interface CallbackLine {
  mode: string;
  play: string;
  presentationP50: number | null;
  adapterP50: number | null;
}

const REASON: Record<VerdictReason, string> = {
  baseline: '对照基线，保持已验收的单槽',
  incomplete: '原始记录不齐，不能写成提升',
  'no-visible-frame': '样本、截图、play()、空白、内存和闲置 CPU 都在，但反应画面没有可见像素。点击到首帧不能结算，不能写成提升',
  'repeat-gain-within-noise': '重复播放的收益没有超过各轮波动',
  'repeat-slower': '重复播放比单槽更慢，且超过波动',
  'first-slower': '重复播放更快，但首次播放变慢超过了波动',
  'blank-worse': '点击变快，但切换空白变多，超过波动',
  'memory-worse': '点击变快，但进程内存升高，超过波动',
  'cpu-worse': '点击变快，但闲置 CPU 升高，超过波动',
  'repeat-gain-exceeds-noise': '重复播放的点击到首帧快于单槽，且超过各轮波动；首次、空白、内存、闲置 CPU 没有更差到超过波动',
};

function callbackTable(lines: readonly CallbackLine[]): string {
  if (lines.length === 0) return '没有帧回调记录。';
  const header = '| 模式 | 播放 | 画面回调 P50 | 适配器 first-frame P50 |';
  const rule = '| --- | --- | ---: | ---: |';
  const body = lines.map(
    (line) => `| ${line.mode} | ${line.play === 'first' ? '首次' : '重复'} | ${fmt(line.presentationP50)} | ${fmt(line.adapterP50)} |`,
  );
  return [header, rule, ...body].join('\n');
}

function fmt(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

function mib(value: number | null): string {
  if (value === null) return '—';
  return (value / (1024 * 1024)).toFixed(1);
}

function rec(value: BenchRecommendation | undefined): string {
  if (value === 'keep') return '保留';
  if (value === 'stop') return '停止';
  return '未测出';
}

function table(columns: readonly PlayColumn[], verdicts: readonly BenchVerdict[], play: 'first' | 'repeat'): string {
  const header =
    play === 'repeat'
      ? '| 模式 | 点击→首帧 P50 | P95 | play() P50 | 空白 P50 | load P50 | 内存 MiB | 闲置 CPU | 轮间波动 | 建议 |'
      : '| 模式 | 点击→首帧 P50 | P95 | play() P50 | 空白 P50 | load P50 | 内存 MiB | 闲置 CPU | 轮间波动 |';
  const rule =
    play === 'repeat'
      ? '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
      : '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |';
  const lines = [header, rule];
  for (const column of columns.filter((item) => item.play === play)) {
    const verdict = verdicts.find((item) => item.mode === column.mode);
    const cells = [
      column.mode,
      fmt(column.clickP50),
      fmt(column.clickP95),
      fmt(column.playP50),
      fmt(column.blankP50),
      fmt(column.loadP50, 0),
      mib(column.memoryP50),
      fmt(column.cpuP50),
      fmt(column.clickNoise),
    ];
    if (play === 'repeat') cells.push(rec(verdict?.recommendation));
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

function rounds(columns: readonly PlayColumn[]): string {
  const header = ['| 模式 | 播放 |', ...Array.from({ length: BENCH_ROUND_COUNT }, (_, i) => ` 第 ${i + 1} 轮 P50 |`)].join('');
  const rule = ['| --- | --- |', ...Array.from({ length: BENCH_ROUND_COUNT }, () => ' ---: |')].join('');
  const lines = [header, rule];
  for (const column of columns) {
    const cells = column.roundClickP50.map((value) => fmt(value));
    lines.push(`| ${column.mode} | ${column.play === 'first' ? '首次' : '重复'} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

export function renderReport(input: {
  env: ReportEnvironment;
  columns: readonly PlayColumn[];
  verdicts: readonly BenchVerdict[];
  stress: readonly StressLine[];
  callbacks: readonly CallbackLine[];
}): string {
  const adviceBody = input.verdicts
    .map((verdict) => `- **${verdict.mode}**：${rec(verdict.recommendation)}。${REASON[verdict.reason]}。重复播放收益 ${fmt(verdict.repeatGainMs)} ms，波动门槛 ${fmt(verdict.repeatNoiseMs)} ms。`)
    .join('\n');
  const advice = input.verdicts.every((verdict) => verdict.reason === 'no-visible-frame')
    ? `${adviceBody}\n\n不要把双槽或预热保留成已证明的优化。可见的点击到首帧没有测出来。双槽空白更少，是因为反应帧几乎全透明，底下的待机还留在画面上。`
    : adviceBody;
  const assets = input.env.files.map((file) => `- \`${file.path}\` \`${file.sha256}\``).join('\n');
  const stress =
    input.stress.length === 0
      ? '本轮没有压力样本。'
      : [
          `人工延迟 ${input.stress[0]?.delayMs ?? '—'} ms，点击前只停留 ${input.stress[0]?.dwellMs ?? '—'} ms。这组样本用来看慢加载时旧画面还在不在，**不能代替正常环境的收益**，也不进入上面的建议。`,
          '',
          '| 模式 | 次数 | 点击→首帧 P50 | 空白 P50 |',
          '| --- | ---: | ---: | ---: |',
          ...input.stress.map(
            (line) => `| ${line.mode} | ${line.count} | ${fmt(line.clickP50)} | ${fmt(line.blankP50)} |`,
          ),
        ].join('\n');
  return `# 播放模式对照

同一台机器、同一窗口、同一组成品素材。行为开关关闭。每种模式 ${BENCH_ROUND_COUNT} 轮，每轮首次 ${BENCH_SAMPLE_COUNT} 次、重复 ${BENCH_SAMPLE_COUNT} 次。点击前的停留都是 ${input.env.dwellMs || DWELL_MS} ms。建议看重复播放的点击到首帧：收益要大于单槽和该模式各自的轮间 P50 波动。首次播放若变慢超过波动，或空白、内存、闲置 CPU 变差超过波动，也不保留。

P50/P95 的单位是毫秒。内存是进程组工作集。闲置 CPU 是单核百分比，每轮测一次，写进该轮全部样本。play() 兑现和可见首帧是两次独立计时。可见首帧指反应画面里出现了不透明的角色像素；没有出现就留空，不用 play() 或帧回调去填。空白由合成画面的不透明像素计算，没有截图的样本不会被当成「没有空白」。

## 条件

- 机器：${input.env.host}
- Electron：${input.env.electron}
- 窗口：${input.env.window}
- 行为：${input.env.behavior}
- 素材指纹：\`${input.env.assetSha256}\`
${assets}

指纹只覆盖上面两个成品文件。没有换用候选素材，因此表里的差别只可能来自播放路径，不能写成素材改善。

## 重复播放

${table(input.columns, input.verdicts, 'repeat')}

## 帧回调

这是画面回调，不是可见首帧。单槽没有适配器 \`first-frame\`。数字来自 \`frames.jsonl\`，没有写入上面的点击到首帧。

${callbackTable(input.callbacks)}

点击到首帧为空，表示没有测到可见的反应角色。截图里棋盘格露出来就是没有角色；双槽若仍看得到角色，那是底下的待机还在，不是反应姿势已经出现。这种差别不写成播放算法的收益。

## 首次播放

首次指一次页面加载里的第一次反应播放。重复指同一页里先完整播完一次之后的后续点击。

${table(input.columns, input.verdicts, 'first')}

## 各轮点击到首帧 P50

${rounds(input.columns)}

## 建议

${advice}

## 压力测试

${stress}

## 复现

\`\`\`bash
${input.env.command}
\`\`\`

原始记录：\`${input.env.outDir}\`。\`samples.jsonl\` 是收益样本，\`frames.jsonl\` 是逐帧分类，\`strips/\` 是空白核对截图。

## 还不能声称的事

产品页面还没有按预览开关接上双槽，这里直接调用单槽适配器和双槽适配器。没有测 Windows，也没有测系统缩放。正常环境下的收益不能用人工慢加载来代替。
`;
}
