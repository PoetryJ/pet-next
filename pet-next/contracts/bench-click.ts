/**
 * 点击响应对照的公共形状。实现放在 `bench/`，产品只读不做计算。
 * 每臂每轮样本数与轮数见常量；负对照用损坏素材，正对照用候选素材。
 * @module pet-next/contracts/bench-click
 */

/** 对照臂。`single-full` 单槽全母带，`single-short` 单槽截取短片。 */
export const CLICK_ARMS = ['single-full', 'single-short'] as const;

export type ClickArm = (typeof CLICK_ARMS)[number];

/** 单条点击响应样本。三段时间戳都来自同一次点击；`null` 表示该段未兑现（不算 0ms）。 */
export interface ClickResponseSample {
  arm: ClickArm;
  round: number;
  index: number;
  /** 点击生效到媒体请求兑现（play resolved）的毫秒数。 */
  clickToPlayResolvedMs: number | null;
  /** 点击生效到画面出现首帧的毫秒数。 */
  clickToFirstFrameMs: number | null;
  /** 点击生效到出现首帧"明确回应"画面的毫秒数。 */
  clickToFirstClearResponseMs: number | null;
  /** 样本素材的 sha256，保证两臂素材差异可审计。 */
  assetSha256: string;
}

/** 每臂每轮至少采集的样本数。 */
export const CLICK_SAMPLES_PER_ROUND = 30;

/** 每臂至少采集的轮数。 */
export const CLICK_ROUNDS = 3;

/** 负对照与正对照各自至少采集的样本数。 */
export const CLICK_CONTROL_SAMPLES = 3;
