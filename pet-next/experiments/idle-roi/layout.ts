/**
 * 待机 ROI 的纯布局计算，严格照 `docs/M3-12-IDLE-ROI.md` 第 4 节的 contain 公式。
 *
 * 本文件只做算术与字段校验：不读 DOM、不碰 `HTMLVideoElement`、不读窗口、
 * 不做像素回读，也**不乘 DPR**（返回值是 CSS/DIP 值）。
 * 无效输入一律返回 `null`，让调用方回原片；绝不返回“半套”尺寸。
 *
 * @module pet-next/experiments/idle-roi/layout
 */

/** 候选裁框（原画布坐标系，单位像素）。 */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 色彩标签，原样记录，不参与几何计算。 */
export interface IdleRoiColorTags {
  primaries: string;
  transfer: string;
  matrix: string;
  range: string;
}

/** 逐帧 PTS 的摘要（来自实际解码回读，见契约第 3 节）。 */
export interface IdleRoiPtsSummary {
  count: number;
  firstMs: number;
  lastMs: number;
  stepMs: number;
  minDeltaMs: number;
  maxDeltaMs: number;
}

/**
 * `experiments/idle-roi/out/manifest.json` 的结构（契约第 3 节，字段冻结）。
 * 只读；生成属于 A，接线属于负责人。
 */
export interface IdleRoiManifest {
  schemaVersion: 1;
  kind: 'idle-roi';
  sourcePath: string;
  sourceSha256: string;
  candidateSha256: string;
  originalCanvas: { width: number; height: number };
  crop: CropRect;
  /** 冻结为 `1`：只把 `alpha<=1` 置零。 */
  alphaThreshold: number;
  /** 冻结为 `2`：并集外留的像素。 */
  guard: number;
  codec: string;
  pixelFormat: string;
  colorTags: IdleRoiColorTags;
  frameCount: number;
  pts: IdleRoiPtsSummary;
  durationMs: number;
  loopFrames: number;
  generatedBy: string;
  ffmpeg: string;
  builtAt: string;
}

/**
 * 可直接落到 CSS 的几何量，单位 DIP。
 * `scale` 是 contain 的缩放系数，仅供观测/断言，CSS 不用它。
 */
export interface IdleRoiLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
}

/** `computeIdleRoiLayout` 的入参；字段在运行时可能被污染，故内部逐项复核。 */
export interface IdleRoiLayoutInput {
  viewWidth: number;
  viewHeight: number;
  originalCanvas: { width: number; height: number };
  crop: CropRect;
}

/** 浮点比较容差：manifest 来自整数像素，只防 0.1+0.2 级噪声。 */
const EPSILON = 1e-9;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

/** 原画布尺寸必须是有限正数。 */
export function isValidCanvasSize(value: unknown): value is { width: number; height: number } {
  if (typeof value !== 'object' || value === null) return false;
  const size = value as { width?: unknown; height?: unknown };
  return isPositive(size.width) && isPositive(size.height);
}

/**
 * 裁框必须：有限正宽高、非负偏移、完全落在原画布内。
 *
 * @param crop - 待校验值，可以是 `unknown`。
 * @param originalCanvas - 原画布尺寸；本身无效时直接判 false。
 */
export function isValidCropRect(
  crop: unknown,
  originalCanvas: { width: number; height: number },
): crop is CropRect {
  if (!isValidCanvasSize(originalCanvas)) return false;
  if (typeof crop !== 'object' || crop === null) return false;
  const rect = crop as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  if (!isFiniteNumber(rect.x) || !isFiniteNumber(rect.y)) return false;
  if (!isPositive(rect.width) || !isPositive(rect.height)) return false;
  if (rect.x < 0 || rect.y < 0) return false;
  if (rect.x + rect.width > originalCanvas.width + EPSILON) return false;
  if (rect.y + rect.height > originalCanvas.height + EPSILON) return false;
  return true;
}

/**
 * 按 contain 求 ROI 在视口里的盒子。
 *
 * ```
 * s     = min(viewW / origW, viewH / origH)
 * left  = (viewW - origW * s) / 2 + crop.x * s
 * top   = (viewH - origH * s) / 2 + crop.y * s
 * width = crop.width * s
 * height= crop.height * s
 * ```
 *
 * 结果不做取整：取整会额外引入 ≤0.5 DIP 的偏移误差，而画质门要求能分辨 1 DIP。
 * 结果是 DIP，调用方直接写 CSS，**不得再乘 DPR**。
 *
 * @param input - 视口尺寸、原画布、裁框。
 * @returns 布局；任何字段缺失/NaN/Infinity/视口≤0/裁框宽高≤0/裁框越界都返回 `null`。
 */
export function computeIdleRoiLayout(input: IdleRoiLayoutInput): IdleRoiLayout | null {
  if (typeof input !== 'object' || input === null) return null;
  const { viewWidth, viewHeight, originalCanvas, crop } = input;
  if (!isFiniteNumber(viewWidth) || !isFiniteNumber(viewHeight)) return null;
  if (viewWidth <= 0 || viewHeight <= 0) return null;
  if (!isValidCanvasSize(originalCanvas)) return null;
  if (!isValidCropRect(crop, originalCanvas)) return null;

  const scale = Math.min(viewWidth / originalCanvas.width, viewHeight / originalCanvas.height);
  if (!isFiniteNumber(scale) || scale <= 0) return null;

  const left = (viewWidth - originalCanvas.width * scale) / 2 + crop.x * scale;
  const top = (viewHeight - originalCanvas.height * scale) / 2 + crop.y * scale;
  const width = crop.width * scale;
  const height = crop.height * scale;
  if (!isFiniteNumber(left) || !isFiniteNumber(top)) return null;
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  if (width <= 0 || height <= 0) return null;

  // `+ 0` 把 `-0` 归一成 `0`，避免下游字符串出现 "-0px"。
  return { left: left + 0, top: top + 0, width: width + 0, height: height + 0, scale };
}
