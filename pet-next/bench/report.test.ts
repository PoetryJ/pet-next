import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { HashedAsset } from './assets.ts';
import { renderReport } from './report.ts';
import type { BenchVerdict, PlayColumn } from './stats.ts';

function column(mode: PlayColumn['mode'], play: PlayColumn['play'], click: number): PlayColumn {
  return {
    mode,
    play,
    count: 90,
    complete: true,
    clickP50: click,
    clickP95: click + 5,
    playP50: click - 4,
    playP95: click,
    blankP50: 0,
    loadP50: 1,
    memoryP50: 100_000_000,
    cpuP50: 2,
    roundClickP50: [click, click, click],
    clickNoise: 0,
    blankNoise: 0,
    memoryNoise: 0,
    cpuNoise: 0,
    visibleFrameMissing: false,
  };
}

describe('一页报告', () => {
  test('同时列出 play() 和首帧，并写明停止理由和素材边界', () => {
    const files: HashedAsset[] = [
      { path: 'assets/idle.webm', sha256: 'abc' },
      { path: 'assets/reaction.webm', sha256: 'def' },
    ];
    const columns = [
      column('single', 'repeat', 40),
      column('single', 'first', 50),
      column('two-slot', 'repeat', 39),
      column('two-slot', 'first', 50),
      column('two-slot-preheat', 'repeat', 10),
      column('two-slot-preheat', 'first', 20),
    ];
    const verdicts: BenchVerdict[] = [
      {
        mode: 'single',
        recommendation: 'keep',
        reason: 'baseline',
        clickToFirstFrameP50Ms: 40,
        clickToFirstFrameP95Ms: 45,
        repeatGainMs: null,
        repeatNoiseMs: null,
      },
      {
        mode: 'two-slot',
        recommendation: 'stop',
        reason: 'repeat-gain-within-noise',
        clickToFirstFrameP50Ms: 39,
        clickToFirstFrameP95Ms: 44,
        repeatGainMs: 1,
        repeatNoiseMs: 5,
      },
      {
        mode: 'two-slot-preheat',
        recommendation: 'keep',
        reason: 'repeat-gain-exceeds-noise',
        clickToFirstFrameP50Ms: 10,
        clickToFirstFrameP95Ms: 15,
        repeatGainMs: 30,
        repeatNoiseMs: 2,
      },
    ];
    const text = renderReport({
      env: {
        host: 'linux test',
        electron: '43.3.0',
        window: '320×240',
        behavior: '关闭',
        dwellMs: 500,
        idleCpuMs: 2000,
        assetSha256: 'ff',
        files,
        outDir: 'bench/runs/example',
        command: 'cd pet-next\nnode --experimental-strip-types bench/cli.ts',
      },
      columns,
      verdicts,
      stress: [{ mode: 'single', count: 5, clickP50: 400, blankP50: 80, delayMs: 400, dwellMs: 100 }],
      callbacks: [{ mode: 'single', play: 'repeat', presentationP50: 14, adapterP50: null }],
    });
    assert.equal(text.includes('play() P50'), true);
    assert.equal(text.includes('点击→首帧 P50'), true);
    assert.equal(text.includes('停止'), true);
    assert.equal(text.includes('不能写成素材改善'), true);
    assert.equal(text.includes('不用 play() 或帧回调去填'), true);
    assert.equal(text.includes('底下的待机还在'), true);
    assert.equal(text.includes('不要把双槽或预热保留成已证明的优化'), false);
    assert.equal(text.includes('不能代替正常环境的收益'), true);
    assert.equal(text.includes('bench/runs/example'), true);
    assert.equal(text.includes('node --experimental-strip-types bench/cli.ts'), true);
  });
});
