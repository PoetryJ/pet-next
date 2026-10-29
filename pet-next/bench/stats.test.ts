import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BENCH_ROUND_COUNT, BENCH_SAMPLE_COUNT, type BenchMode, type BenchPlay, type BenchSample } from '../contracts/bench.ts';
import { buildColumns, buildVerdicts, percentile, toSummary } from './stats.ts';

const HASH = 'a'.repeat(64);

function grid(
  mode: BenchMode,
  play: BenchPlay,
  clickMs: number | ((round: number) => number),
  patch: Partial<BenchSample> = {},
): BenchSample[] {
  const samples: BenchSample[] = [];
  for (let round = 1; round <= BENCH_ROUND_COUNT; round += 1) {
    const click = typeof clickMs === 'function' ? clickMs(round) : clickMs;
    for (let index = 1; index <= BENCH_SAMPLE_COUNT; index += 1) {
      samples.push({
        mode,
        round,
        index,
        play,
        clickToFirstFrameMs: click,
        playResolvedMs: click - 5,
        blankMs: 0,
        loadCount: 1,
        memoryBytes: 100_000_000,
        idleCpuPercent: 3,
        assetSha256: HASH,
        evidencePath: `strips/${mode}-${play}-${round}-${index}.png`,
        ...patch,
      });
    }
  }
  return samples;
}

function allModes(repeatClick: (mode: BenchMode) => number, firstClick: (mode: BenchMode) => number, patch: Partial<BenchSample> = {}): BenchSample[] {
  const modes: BenchMode[] = ['single', 'two-slot', 'two-slot-preheat'];
  return modes.flatMap((mode) => [
    ...grid(mode, 'repeat', repeatClick(mode), patch),
    ...grid(mode, 'first', firstClick(mode), patch),
  ]);
}

describe('分位和建议', () => {
  test('P50 取第 15 个，P95 取第 29 个', () => {
    const values = Array.from({ length: 30 }, (_, index) => index + 1);
    assert.equal(percentile(values, 50), 15);
    assert.equal(percentile(values, 95), 29);
    assert.equal(percentile([], 50), null);
  });

  test('收益超过波动才保留', () => {
    const samples = allModes(
      (mode) => (mode === 'single' ? 80 : 40),
      (mode) => (mode === 'single' ? 90 : 50),
    );
    const verdicts = buildVerdicts(buildColumns(samples, HASH));
    const preheat = verdicts.find((verdict) => verdict.mode === 'two-slot-preheat');
    assert.equal(preheat?.recommendation, 'keep');
    assert.equal(preheat?.reason, 'repeat-gain-exceeds-noise');
    assert.equal(preheat?.repeatGainMs, 40);
    assert.equal(toSummary(preheat!).recommendation, 'keep');
    assert.equal(verdicts.find((verdict) => verdict.mode === 'single')?.reason, 'baseline');
  });

  test('收益落在轮间波动里就停止', () => {
    const samples = [
      ...grid('single', 'repeat', (round) => 40 + (round - 1) * 10),
      ...grid('single', 'first', 80),
      ...grid('two-slot', 'repeat', (round) => 35 + (round - 1) * 10),
      ...grid('two-slot', 'first', 80),
      ...grid('two-slot-preheat', 'repeat', 80),
      ...grid('two-slot-preheat', 'first', 80),
    ];
    const verdicts = buildVerdicts(buildColumns(samples, HASH));
    assert.equal(verdicts.find((verdict) => verdict.mode === 'two-slot')?.recommendation, 'stop');
    assert.equal(verdicts.find((verdict) => verdict.mode === 'two-slot')?.reason, 'repeat-gain-within-noise');
  });

  test('重复播放变快但首次变慢、空白变多、内存升高，都停止', () => {
    const faster = allModes(
      (mode) => (mode === 'single' ? 80 : 20),
      (mode) => (mode === 'single' ? 40 : mode === 'two-slot' ? 90 : 40),
    );
    const firstSlower = buildVerdicts(buildColumns(faster, HASH)).find((verdict) => verdict.mode === 'two-slot');
    assert.equal(firstSlower?.reason, 'first-slower');
    const blank = allModes(
      (mode) => (mode === 'single' ? 80 : 20),
      () => 40,
      {},
    ).map((sample) => (sample.mode === 'two-slot-preheat' ? { ...sample, blankMs: 30 } : sample));
    assert.equal(
      buildVerdicts(buildColumns(blank, HASH)).find((verdict) => verdict.mode === 'two-slot-preheat')?.reason,
      'blank-worse',
    );
    const memory = allModes(
      (mode) => (mode === 'single' ? 80 : 20),
      () => 40,
    ).map((sample) => (sample.mode === 'two-slot' && sample.play === 'repeat' ? { ...sample, memoryBytes: 200_000_000 } : sample));
    assert.equal(
      buildVerdicts(buildColumns(memory, HASH)).find((verdict) => verdict.mode === 'two-slot')?.reason,
      'memory-worse',
    );
  });

  test('没有可见首帧时不把别的时刻当成提升，空白数字仍然保留', () => {
    const invisible = allModes(
      (mode) => (mode === 'single' ? 80 : 20),
      () => 40,
    ).map((sample) => ({ ...sample, clickToFirstFrameMs: null, blankMs: sample.mode === 'single' ? 1800 : 0 }));
    const columns = buildColumns(invisible, HASH);
    const single = columns.find((column) => column.mode === 'single' && column.play === 'repeat');
    const preheat = columns.find((column) => column.mode === 'two-slot-preheat' && column.play === 'repeat');
    assert.equal(single?.clickP50, null);
    assert.equal(single?.blankP50, 1800);
    assert.equal(preheat?.blankP50, 0);
    assert.equal(single?.playP50, 75);
    const verdicts = buildVerdicts(columns);
    assert.equal(verdicts.every((verdict) => verdict.recommendation === 'unmeasured'), true);
    assert.equal(verdicts.every((verdict) => verdict.reason === 'no-visible-frame'), true);
  });

  test('缺截图、哈希不一致或次数不够都是未测出', () => {
    const missingEvidence = allModes(
      (mode) => (mode === 'single' ? 80 : 20),
      () => 40,
    ).map((sample) => (sample.mode === 'two-slot' ? { ...sample, evidencePath: null } : sample));
    assert.equal(
      buildVerdicts(buildColumns(missingEvidence, HASH)).find((verdict) => verdict.mode === 'two-slot')?.recommendation,
      'unmeasured',
    );
    const otherHash = allModes(
      (mode) => (mode === 'single' ? 80 : 20),
      () => 40,
    ).map((sample) => (sample.index === 1 && sample.round === 1 && sample.play === 'repeat' && sample.mode === 'single'
      ? { ...sample, assetSha256: 'b'.repeat(64) }
      : sample));
    assert.equal(buildVerdicts(buildColumns(otherHash, HASH)).every((verdict) => verdict.recommendation === 'unmeasured'), true);
    const short = grid('single', 'repeat', 10).slice(0, 10);
    assert.equal(buildVerdicts(buildColumns(short, HASH))[0]?.recommendation, 'unmeasured');
  });
});
