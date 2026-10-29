/**
 * 由原始样本得出分位和保留/停止建议。
 * 收益不超过各轮波动时建议停止。记录不齐时保持 unmeasured。
 */
import {
  BENCH_ROUND_COUNT,
  BENCH_SAMPLE_COUNT,
  type BenchMode,
  type BenchPlay,
  type BenchRecommendation,
  type BenchSample,
  type BenchSummary,
} from '../contracts/bench.ts';
import { BENCH_MODES } from './protocol.ts';

export type VerdictReason =
  | 'baseline'
  | 'incomplete'
  | 'no-visible-frame'
  | 'repeat-gain-within-noise'
  | 'repeat-slower'
  | 'first-slower'
  | 'blank-worse'
  | 'memory-worse'
  | 'cpu-worse'
  | 'repeat-gain-exceeds-noise';

export interface BenchVerdict {
  mode: BenchMode;
  recommendation: BenchRecommendation;
  reason: VerdictReason;
  clickToFirstFrameP50Ms: number | null;
  clickToFirstFrameP95Ms: number | null;
  repeatGainMs: number | null;
  repeatNoiseMs: number | null;
}

export interface PlayColumn {
  mode: BenchMode;
  play: BenchPlay;
  count: number;
  complete: boolean;
  clickP50: number | null;
  clickP95: number | null;
  playP50: number | null;
  playP95: number | null;
  blankP50: number | null;
  loadP50: number | null;
  memoryP50: number | null;
  cpuP50: number | null;
  roundClickP50: Array<number | null>;
  clickNoise: number | null;
  blankNoise: number | null;
  memoryNoise: number | null;
  cpuNoise: number | null;
  /** 其它字段齐全，只缺可见首帧。 */
  visibleFrameMissing: boolean;
}

/** 最近秩。p=50、n=30 取第 15 个；p=95、n=30 取第 29 个。 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0 || !(p > 0) || p > 100) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index] ?? null;
}

function values(samples: readonly BenchSample[], read: (sample: BenchSample) => number | null): number[] | null {
  const out: number[] = [];
  for (const sample of samples) {
    const value = read(sample);
    if (value === null || !Number.isFinite(value)) return null;
    out.push(value);
  }
  return out;
}

function sliceComplete(samples: readonly BenchSample[], assetSha256: string): boolean {
  if (samples.length < BENCH_SAMPLE_COUNT) return false;
  for (const sample of samples) {
    if (sample.assetSha256 !== assetSha256) return false;
    if (sample.evidencePath === null || sample.evidencePath === '') return false;
    if (sample.clickToFirstFrameMs === null || sample.playResolvedMs === null || sample.blankMs === null) return false;
    if (sample.memoryBytes === null || sample.idleCpuPercent === null) return false;
  }
  return true;
}

function columnFor(samples: readonly BenchSample[], mode: BenchMode, play: BenchPlay, assetSha256: string): PlayColumn {
  const mine = samples.filter((sample) => sample.mode === mode && sample.play === play);
  const rounds: BenchSample[][] = [];
  let complete = mine.length >= BENCH_SAMPLE_COUNT * BENCH_ROUND_COUNT;
  for (let round = 1; round <= BENCH_ROUND_COUNT; round += 1) {
    const group = mine.filter((sample) => sample.round === round);
    rounds.push(group);
    if (!sliceComplete(group, assetSha256)) complete = false;
  }
  const counted = rounds.every((group) => group.length >= BENCH_SAMPLE_COUNT);
  const series = (read: (sample: BenchSample) => number | null): number[] | null => {
    if (!counted) return null;
    return values(mine, read);
  };
  const roundClickP50 = rounds.map((group) => {
    const click = values(group, (sample) => sample.clickToFirstFrameMs);
    return click === null ? null : percentile(click, 50);
  });
  const clickAll = series((sample) => sample.clickToFirstFrameMs);
  const playAll = series((sample) => sample.playResolvedMs);
  const blankAll = series((sample) => sample.blankMs);
  const loadAll = series((sample) => sample.loadCount);
  const memoryAll = series((sample) => sample.memoryBytes);
  const roundBlank = rounds.map((group) => {
    const blank = values(group, (sample) => sample.blankMs);
    return blank === null ? null : percentile(blank, 50);
  });
  const roundMemory = rounds.map((group) => {
    const memory = values(group, (sample) => sample.memoryBytes);
    return memory === null ? null : percentile(memory, 50);
  });
  const roundCpu = rounds.map((group) => {
    const cpu = values(group, (sample) => sample.idleCpuPercent);
    return cpu === null ? null : percentile(cpu, 50);
  });
  const cpuAll = roundCpu.every((value) => value !== null) ? (roundCpu as number[]) : null;
  const restOk = rounds.every((group) => metricsExceptClick(group, assetSha256));
  const visibleFrameMissing =
    restOk &&
    rounds.every(
      (group) => group.length >= BENCH_SAMPLE_COUNT && group.every((sample) => sample.clickToFirstFrameMs === null),
    );
  return {
    mode,
    play,
    count: mine.length,
    complete,
    clickP50: clickAll === null ? null : percentile(clickAll, 50),
    clickP95: clickAll === null ? null : percentile(clickAll, 95),
    playP50: playAll === null ? null : percentile(playAll, 50),
    playP95: playAll === null ? null : percentile(playAll, 95),
    blankP50: blankAll === null ? null : percentile(blankAll, 50),
    loadP50: loadAll === null ? null : percentile(loadAll, 50),
    memoryP50: memoryAll === null ? null : percentile(memoryAll, 50),
    cpuP50: cpuAll === null ? null : percentile(cpuAll, 50),
    roundClickP50,
    clickNoise: noise(roundClickP50),
    blankNoise: noise(roundBlank),
    memoryNoise: noise(roundMemory),
    cpuNoise: noise(roundCpu),
    visibleFrameMissing,
  };
}

function metricsExceptClick(samples: readonly BenchSample[], assetSha256: string): boolean {
  if (samples.length < BENCH_SAMPLE_COUNT) return false;
  for (const sample of samples) {
    if (sample.assetSha256 !== assetSha256) return false;
    if (sample.evidencePath === null || sample.evidencePath === '') return false;
    if (sample.playResolvedMs === null || sample.blankMs === null) return false;
    if (sample.memoryBytes === null || sample.idleCpuPercent === null) return false;
  }
  return true;
}

function noise(valuesIn: readonly (number | null)[]): number | null {
  if (valuesIn.some((value) => value === null)) return null;
  const numbers = valuesIn as readonly number[];
  if (numbers.length === 0) return null;
  return Math.max(...numbers) - Math.min(...numbers);
}

type Relation = 'faster' | 'slower' | 'tie' | 'unmeasured';

/** 数值越小越好。正的 gain 表示候选更快。不超过波动则为 tie。 */
function lowerIsBetter(base: number | null, cand: number | null, baseNoise: number | null, candNoise: number | null): Relation {
  if (base === null || cand === null || baseNoise === null || candNoise === null) return 'unmeasured';
  const gain = base - cand;
  const threshold = Math.max(baseNoise, candNoise);
  if (gain > threshold) return 'faster';
  if (gain < -threshold) return 'slower';
  return 'tie';
}

/** 数值越大越差。 */
function higherIsWorse(base: number | null, cand: number | null, baseNoise: number | null, candNoise: number | null): Relation {
  if (base === null || cand === null || baseNoise === null || candNoise === null) return 'unmeasured';
  const worse = cand - base;
  const threshold = Math.max(baseNoise, candNoise);
  if (worse > threshold) return 'slower';
  if (worse < -threshold) return 'faster';
  return 'tie';
}

function verdictFor(mode: BenchMode, columns: readonly PlayColumn[]): BenchVerdict {
  const repeat = columns.find((column) => column.mode === mode && column.play === 'repeat');
  const first = columns.find((column) => column.mode === mode && column.play === 'first');
  const baseRepeat = columns.find((column) => column.mode === 'single' && column.play === 'repeat');
  const baseFirst = columns.find((column) => column.mode === 'single' && column.play === 'first');
  const summary = {
    mode,
    clickToFirstFrameP50Ms: repeat?.clickP50 ?? null,
    clickToFirstFrameP95Ms: repeat?.clickP95 ?? null,
    repeatGainMs: null as number | null,
    repeatNoiseMs: null as number | null,
  };
  const slices = [repeat, first, baseRepeat, baseFirst];
  if (slices.every((column) => column?.visibleFrameMissing === true)) {
    return { ...summary, recommendation: 'unmeasured', reason: 'no-visible-frame' };
  }
  if (!repeat?.complete || !first?.complete || !baseRepeat?.complete || !baseFirst?.complete) {
    return { ...summary, recommendation: 'unmeasured', reason: 'incomplete' };
  }
  if (mode === 'single') {
    return { ...summary, recommendation: 'keep', reason: 'baseline' };
  }
  const gain = baseRepeat.clickP50 !== null && repeat.clickP50 !== null ? baseRepeat.clickP50 - repeat.clickP50 : null;
  const threshold =
    baseRepeat.clickNoise !== null && repeat.clickNoise !== null
      ? Math.max(baseRepeat.clickNoise, repeat.clickNoise)
      : null;
  const withGain = { ...summary, repeatGainMs: gain, repeatNoiseMs: threshold };
  const repeatRelation = lowerIsBetter(baseRepeat.clickP50, repeat.clickP50, baseRepeat.clickNoise, repeat.clickNoise);
  if (repeatRelation === 'unmeasured') return { ...withGain, recommendation: 'unmeasured', reason: 'incomplete' };
  if (repeatRelation === 'tie') return { ...withGain, recommendation: 'stop', reason: 'repeat-gain-within-noise' };
  if (repeatRelation === 'slower') return { ...withGain, recommendation: 'stop', reason: 'repeat-slower' };
  const firstRelation = lowerIsBetter(baseFirst.clickP50, first.clickP50, baseFirst.clickNoise, first.clickNoise);
  if (firstRelation === 'slower') return { ...withGain, recommendation: 'stop', reason: 'first-slower' };
  if (firstRelation === 'unmeasured') return { ...withGain, recommendation: 'unmeasured', reason: 'incomplete' };
  const blankRepeat = higherIsWorse(baseRepeat.blankP50, repeat.blankP50, baseRepeat.blankNoise, repeat.blankNoise);
  const blankFirst = higherIsWorse(baseFirst.blankP50, first.blankP50, baseFirst.blankNoise, first.blankNoise);
  if (blankRepeat === 'slower' || blankFirst === 'slower') {
    return { ...withGain, recommendation: 'stop', reason: 'blank-worse' };
  }
  const memory = higherIsWorse(baseRepeat.memoryP50, repeat.memoryP50, baseRepeat.memoryNoise, repeat.memoryNoise);
  if (memory === 'slower') return { ...withGain, recommendation: 'stop', reason: 'memory-worse' };
  const cpu = higherIsWorse(baseRepeat.cpuP50, repeat.cpuP50, baseRepeat.cpuNoise, repeat.cpuNoise);
  if (cpu === 'slower') return { ...withGain, recommendation: 'stop', reason: 'cpu-worse' };
  if (blankRepeat === 'unmeasured' || blankFirst === 'unmeasured' || memory === 'unmeasured' || cpu === 'unmeasured') {
    return { ...withGain, recommendation: 'unmeasured', reason: 'incomplete' };
  }
  return { ...withGain, recommendation: 'keep', reason: 'repeat-gain-exceeds-noise' };
}

export function buildColumns(samples: readonly BenchSample[], assetSha256: string): PlayColumn[] {
  const columns: PlayColumn[] = [];
  for (const mode of BENCH_MODES) {
    for (const play of ['first', 'repeat'] as const) {
      columns.push(columnFor(samples, mode, play, assetSha256));
    }
  }
  return columns;
}

export function buildVerdicts(columns: readonly PlayColumn[]): BenchVerdict[] {
  return BENCH_MODES.map((mode) => verdictFor(mode, columns));
}

export function toSummary(verdict: BenchVerdict): BenchSummary {
  return {
    mode: verdict.mode,
    clickToFirstFrameP50Ms: verdict.clickToFirstFrameP50Ms,
    clickToFirstFrameP95Ms: verdict.clickToFirstFrameP95Ms,
    recommendation: verdict.recommendation,
  };
}
