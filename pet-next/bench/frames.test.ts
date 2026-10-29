import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assembleLatency, blankDurationMs, stageKind, type TimedFrame } from './frames.ts';

describe('空白时间', () => {
  test('旧画面一直在，空白是 0', () => {
    const frames: TimedFrame[] = [
      { tMs: 0, kind: 'held' },
      { tMs: 16, kind: 'held' },
      { tMs: 32, kind: 'reaction' },
    ];
    assert.equal(blankDurationMs(frames), 0);
  });

  test('空档按采样前的种类累计，没有反应画面则为 null', () => {
    const frames: TimedFrame[] = [
      { tMs: 0, kind: 'held' },
      { tMs: 16, kind: 'empty' },
      { tMs: 40, kind: 'empty' },
      { tMs: 70, kind: 'reaction' },
    ];
    assert.equal(blankDurationMs(frames), 54);
    assert.equal(blankDurationMs([{ tMs: 10, kind: 'empty' }]), null);
    assert.equal(blankDurationMs([{ tMs: 10, kind: 'empty' }, { tMs: 40, kind: 'empty' }], true), 30);
    assert.equal(
      blankDurationMs(
        [
          { tMs: 0, kind: 'held' },
          { tMs: 30, kind: 'held' },
        ],
        true,
      ),
      0,
    );
  });

  test('play() 兑现不会填进首帧', () => {
    const latency = assembleLatency({
      clickAt: 1000,
      presentedAt: null,
      playResolvedAt: 1040,
      frames: [{ tMs: 0, kind: 'held' }],
    });
    assert.equal(latency.clickToFirstFrameMs, null);
    assert.equal(latency.playResolvedMs, 40);
    assert.equal(latency.blankMs, null);
  });

  test('有首帧时两个时刻仍然分开', () => {
    const latency = assembleLatency({
      clickAt: 1000,
      presentedAt: 1080,
      playResolvedAt: 1030,
      frames: [
        { tMs: 0, kind: 'held' },
        { tMs: 80, kind: 'reaction' },
      ],
    });
    assert.equal(latency.clickToFirstFrameMs, 80);
    assert.equal(latency.playResolvedMs, 30);
    assert.equal(stageKind(false, 0, 30), 'empty');
    assert.equal(stageKind(true, 0, 30), 'reaction');
    assert.equal(stageKind(false, 80, 30), 'held');
  });
});
