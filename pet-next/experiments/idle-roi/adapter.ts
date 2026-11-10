/**
 * 待机 ROI 的接线适配层。
 *
 * 决策与 manifest 校验的**唯一实现**在 `experiments/idle-roi/core.ts`，这里原样转出；
 * 本层只补一件产品树不需要的东西：把 `IdleRoiLayout`（DIP）变成成套 CSS 值。
 * 不复制公式、不读 DOM、不加载视频。
 *
 * @module pet-next/experiments/idle-roi/adapter
 */

export { computeIdleRoiLayout, decideIdleRoi, parseIdleRoiManifest } from './core.ts';
export type {
  CropRect,
  IdleRoiDecision,
  IdleRoiLayout,
  IdleRoiManifest,
  IdleRoiPts,
  IdleRoiSelection,
} from './core.ts';

import type { IdleRoiLayout } from './core.ts';

/** 四个 CSS 自定义属性名：页面写 `style.setProperty` 时用。 */
export type IdleRoiCssVariableName =
  | '--idle-roi-left'
  | '--idle-roi-top'
  | '--idle-roi-width'
  | '--idle-roi-height';

/** 四个内联样式值：页面直接写 `style.left` 等时用。 */
export interface IdleRoiStyle {
  left: string;
  top: string;
  width: string;
  height: string;
}

/** DIP → CSS 字符串：最多 3 位小数，去掉 `0.30000000000000004` 这类浮点噪声。 */
function toCssPixels(value: number): string {
  return `${Math.round(value * 1000) / 1000}px`;
}

/**
 * 布局转 CSS 自定义属性。四个键成套出现或都不出现——调用方不得只写一半。
 *
 * 值是 DIP，**不得再乘 DPR**。
 *
 * @param layout - `decideIdleRoi` 返回的 `layout`（只接受 roi 分支）。
 */
export function idleRoiCssVariables(
  layout: IdleRoiLayout,
): Record<IdleRoiCssVariableName, string> {
  return {
    '--idle-roi-left': toCssPixels(layout.left),
    '--idle-roi-top': toCssPixels(layout.top),
    '--idle-roi-width': toCssPixels(layout.width),
    '--idle-roi-height': toCssPixels(layout.height),
  };
}

/**
 * 布局转内联样式值（不想用 CSS 变量时的等价写法）。
 *
 * @param layout - `decideIdleRoi` 返回的 `layout`（只接受 roi 分支）。
 */
export function formatIdleRoiStyle(layout: IdleRoiLayout): IdleRoiStyle {
  return {
    left: toCssPixels(layout.left),
    top: toCssPixels(layout.top),
    width: toCssPixels(layout.width),
    height: toCssPixels(layout.height),
  };
}
