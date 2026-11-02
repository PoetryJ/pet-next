/**
 * 估算标注的单元测试：估算字段必须带 Estimate 后缀与 estimation 说明，
 * 且数值 = 实测首帧 + 素材内回应时刻；任一输入缺失时不给数、只留说明。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildClickOutcomeRecord, summarizeClickOutcomes } from './click-record.ts';

test('估算字段 = 实测首帧 + 素材内回应时刻，并带说明结构', () => {
  const record = buildClickOutcomeRecord({
    arm: 'single-short',
    round: 1,
    index: 2,
    row: { clickToFirstFrameMs: 15.5, playResolvedMs: 11, assetSha256: 'abc' },
    materialOnsetMs: 250,
    materialOnsetFrame: 6,
  });
  assert.equal(record.clickToFirstClearResponseEstimateMs, 265.5);
  assert.equal(record.estimation.method, 'observed-first-frame-plus-material-onset');
  assert.equal(record.estimation.observedFirstFrameMs, 15.5);
  assert.equal(record.estimation.materialOnsetMs, 250);
  assert.equal(record.estimation.materialOnsetFrame, 6);
  assert.equal(record.clickToFirstFrameMs, 15.5);
  assert.equal(record.clickToPlayResolvedMs, 11);
});

test('首帧未兑现时估算为 null，但仍保留估算说明', () => {
  const record = buildClickOutcomeRecord({
    arm: 'single-full',
    round: 1,
    index: 1,
    row: { clickToFirstFrameMs: null, playResolvedMs: null, assetSha256: 'abc' },
    materialOnsetMs: 2458.33,
    materialOnsetFrame: 59,
  });
  assert.equal(record.clickToFirstClearResponseEstimateMs, null);
  assert.equal(record.estimation.observedFirstFrameMs, null);
  assert.equal(record.estimation.materialOnsetMs, 2458.33);
});

test('素材内回应时刻未知时估算为 null', () => {
  const record = buildClickOutcomeRecord({
    arm: 'single-short',
    round: 1,
    index: 3,
    row: { clickToFirstFrameMs: 20, playResolvedMs: 12, assetSha256: 'abc' },
    materialOnsetMs: null,
    materialOnsetFrame: null,
  });
  assert.equal(record.clickToFirstClearResponseEstimateMs, null);
  assert.equal(record.estimation.materialOnsetMs, null);
});

test('汇总使用 Estimate 命名：P50 = 首帧 P50 + 素材内回应时刻', () => {
  const records = [10, 20, 30].map((firstFrame, index) =>
    buildClickOutcomeRecord({
      arm: 'single-short',
      round: 1,
      index: index + 1,
      row: { clickToFirstFrameMs: firstFrame, playResolvedMs: 5, assetSha256: 'abc' },
      materialOnsetMs: 250,
      materialOnsetFrame: 6,
    }),
  );
  const summary = summarizeClickOutcomes('single-short', records, 250);
  assert.equal(summary.firstFrameP50, 20);
  assert.equal(summary.clearResponseEstimateP50, 270);
  assert.equal(summary.clearResponseEstimateP95, 280);
  assert.equal(summary.estimationMethod, 'observed-first-frame-plus-material-onset');
  assert.equal('clearResponseP50' in summary, false);
});
