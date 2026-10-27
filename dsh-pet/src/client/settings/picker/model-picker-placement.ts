/**
 * 模型选择器浮层的定位计算：把触发器的实测矩形与视口尺寸换算成浮层的 fixed 坐标。
 * 下方放不下且上方更宽裕时翻到上方，左右钳制在视口内，并给出高度上限——浮层自身不进文档流。
 * 纯函数，不读 `window`：矩形与视口由调用方传入，便于单测与将来的视口外定位。
 * @module dsh-pet/src/client/settings/picker/model-picker-placement
 */

/** 浮层与触发器、视口边缘之间的间距。 */
const PANEL_GAP_PX = 12;
/** 浮层离触发器的偏移，避免贴着触发器边框。 */
const PANEL_OFFSET_PX = 4;
/** 浮层宽度下限：再窄就装不下「服务商 + 模型」两段文字。 */
const MIN_WIDTH_PX = 240;
/** 浮层宽度上限：再宽会横跨整个设置页。 */
const MAX_WIDTH_PX = 420;
/** 视口更窄时宁可取整屏宽度，也不留出 16px 以外的余量。 */
const MIN_AVAILABLE_WIDTH_PX = 200;
/** 视口余量：浮层左右各留 8px，不贴死屏幕边。 */
const EDGE_MARGIN_PX = 8;
/** 视口更窄时浮层宽度的兜底余量。 */
const VIEWPORT_INSET_PX = 16;
/** 浮层高度上限，超出后清单自己滚动。 */
const MAX_HEIGHT_PX = 360;
/** 下方空间小于它才考虑翻到上方，否则即使靠近底部也优先向下展开。 */
const FLIP_THRESHOLD_PX = 240;

/** 触发器的实测矩形，语义同 `DOMRect` 的这几个字段。 */
export interface AnchorRect {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

/** 视口尺寸，通常直接取 `window.innerWidth` / `innerHeight`。 */
export interface Viewport {
  width: number;
  height: number;
}

/** 浮层的 fixed 定位与尺寸；`top` 与 `bottom` 只有一个有值。 */
export interface PanelPosition {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
}

/**
 * 算出浮层该贴在哪。
 *
 * @param anchor - 触发器的实测矩形。
 * @param viewport - 视口尺寸。
 * @returns 浮层定位；上方空间更宽裕时给出 `bottom`，否则给出 `top`。
 */
export function computePanelPlacement(anchor: AnchorRect, viewport: Viewport): PanelPosition {
  const below = viewport.height - anchor.bottom - PANEL_GAP_PX;
  const above = anchor.top - PANEL_GAP_PX;
  const available = Math.max(MIN_AVAILABLE_WIDTH_PX, Math.min(MAX_WIDTH_PX, viewport.width - VIEWPORT_INSET_PX));
  const width = Math.min(Math.max(anchor.width, MIN_WIDTH_PX), available);
  const left = Math.max(EDGE_MARGIN_PX, Math.min(anchor.left, viewport.width - width - EDGE_MARGIN_PX));
  // 下方窄到放不下且上方更宽裕才翻上去：靠近底部的触发器向下展开才不会盖住上面的字段。
  const openUp = below < FLIP_THRESHOLD_PX && above > below;
  return openUp
    ? { left, bottom: viewport.height - anchor.top + PANEL_OFFSET_PX, width, maxHeight: Math.min(MAX_HEIGHT_PX, above) }
    : { left, top: anchor.bottom + PANEL_OFFSET_PX, width, maxHeight: Math.min(MAX_HEIGHT_PX, below) };
}
