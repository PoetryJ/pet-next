/**
 * 点击对照样本的输出形状与汇总：观察字段与估算字段分列。
 *
 * contracts/bench-click.ts 的 ClickResponseSample 是冻结的公共形状，不许在 contracts/ 改名；
 * 输出记录改在这里定义：估算字段一律带 `Estimate` 后缀并附 `estimation` 说明结构，
 * 不得以 observed 名义输出。产品真实回应观测（非估算）由 bench/click-product.ts 单独产出。
 */
import type { ClickArm } from '../contracts/bench-click.ts';
import { percentile } from './stats.ts';

/** 估算说明：方法、输入、来源。带 `Estimate` 后缀的字段都必须能对上这里。 */
export interface ClickEstimation {
  method: 'observed-first-frame-plus-material-onset';
  /** 实测首帧（bench 测量页观察值）。 */
  observedFirstFrameMs: number | null;
  /** 素材内回应时刻（素材逐帧解码的运动量规则常数，不是产品观察）。 */
  materialOnsetMs: number | null;
  materialOnsetFrame: number | null;
  rule: 'assets-pipeline/response-onset.ts';
  note: string;
}

/** 一条点击对照输出记录。观察值与估算值分开，估算值显式标注。 */
export interface ClickOutcomeRecord {
  arm: ClickArm;
  round: number;
  index: number;
  /** 观察：点击生效→媒体请求兑现（play resolved）。 */
  clickToPlayResolvedMs: number | null;
  /** 观察：点击生效→画面出现首帧（bench 页 rVFC + 不透明采样）。 */
  clickToFirstFrameMs: number | null;
  /**
   * 估算：点击生效→首"明确回应"画面 = 实测首帧 + 素材内回应时刻。
   * 产品回应终点未被观测，这里不是观察值。
   */
  clickToFirstClearResponseEstimateMs: number | null;
  estimation: ClickEstimation;
  assetSha256: string;
}

/** 由 bench 原始样本 + 素材内回应时刻组装输出记录。 */
export function buildClickOutcomeRecord(input: {
  arm: ClickArm;
  round: number;
  index: number;
  row: {
    clickToFirstFrameMs: number | null;
    playResolvedMs: number | null;
    assetSha256: string;
  };
  materialOnsetMs: number | null;
  materialOnsetFrame: number | null;
}): ClickOutcomeRecord {
  const firstFrame = finiteOrNull(input.row.clickToFirstFrameMs);
  return {
    arm: input.arm,
    round: input.round,
    index: input.index,
    clickToPlayResolvedMs: finiteOrNull(input.row.playResolvedMs),
    clickToFirstFrameMs: firstFrame,
    clickToFirstClearResponseEstimateMs:
      firstFrame === null || input.materialOnsetMs === null ? null : firstFrame + input.materialOnsetMs,
    estimation: {
      method: 'observed-first-frame-plus-material-onset',
      observedFirstFrameMs: firstFrame,
      materialOnsetMs: input.materialOnsetMs,
      materialOnsetFrame: input.materialOnsetFrame,
      rule: 'assets-pipeline/response-onset.ts',
      note: '估算 = 实测首帧 + 素材内回应时刻（素材逐帧运动规则常数）；产品回应终点未被观测',
    },
    assetSha256: input.row.assetSha256,
  };
}

export interface ClickOutcomeSummary {
  arm: ClickArm;
  count: number;
  resolvedCount: number;
  firstFrameCount: number;
  playResolvedP50: number | null;
  playResolvedP95: number | null;
  firstFrameP50: number | null;
  firstFrameP95: number | null;
  /** 估算列（P50 相加，方法见 estimation）。 */
  clearResponseEstimateP50: number | null;
  clearResponseEstimateP95: number | null;
  estimationMethod: ClickEstimation['method'];
  materialOnsetMs: number | null;
}

export function summarizeClickOutcomes(
  arm: ClickArm,
  samples: readonly ClickOutcomeRecord[],
  materialOnsetMs: number | null,
): ClickOutcomeSummary {
  const pick = (read: (sample: ClickOutcomeRecord) => number | null): number[] =>
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
    clearResponseEstimateP50: percentile(pick((sample) => sample.clickToFirstClearResponseEstimateMs), 50),
    clearResponseEstimateP95: percentile(pick((sample) => sample.clickToFirstClearResponseEstimateMs), 95),
    estimationMethod: 'observed-first-frame-plus-material-onset',
    materialOnsetMs,
  };
}

function finiteOrNull(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
