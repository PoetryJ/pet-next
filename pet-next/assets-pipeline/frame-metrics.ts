/**
 * 帧上的 alpha 覆盖、偶数裁剪和深色前景观察。
 */
export interface RgbaFrame {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Rgb {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

/** 不低于此值才算不透明前景。 */
export const OPAQUE_ALPHA = 200;

/** 低于此值算透明。 */
export const TRANSPARENT_ALPHA = 16;

/** 亮度不超过此值才拿来检查深色前景。 */
export const DARK_LUMA_MAX = 40;

/** 少于此数记为 unobserved，不把零星噪声写成看见了前景。 */
export const MIN_DARK_PIXELS = 32;

/** 合成到深色底后，通道差至少这么多才算还看得见。 */
export const VISIBLE_CHANNEL_DELTA = 12;

/** 裁透明边时留出的像素。 */
export const CROP_PAD_PX = 2;

/** 深色对照底。不是纯黑，近黑前景才能和底分开。 */
export const DARK_PLATE: Rgb = { red: 27, green: 36, blue: 48 };

export const LIGHT_PLATE: Rgb = { red: 244, green: 241, blue: 234 };

export const CHECKER_LIGHT: Rgb = { red: 217, green: 217, blue: 217 };

export const CHECKER_DARK: Rgb = { red: 138, green: 138, blue: 138 };

export const CHECKER_CELL_PX = 8;

export interface FrameSummary {
  readonly usableAlpha: boolean;
  /** 抽样帧里见过的最大 alpha。 */
  readonly maxAlpha: number;
  readonly bounds: PixelRect | null;
  /** 不透明深色像素最多的帧。 */
  readonly frameIndex: number;
}

/** 近似亮度，只用于把近黑前景和亮色分开。 */
export function lumaOf(red: number, green: number, blue: number): number {
  return Math.floor((red * 3 + green * 6 + blue) / 10);
}

/** 直线 alpha 合成一个通道。 */
export function blendChannel(foreground: number, alpha: number, background: number): number {
  return Math.round((foreground * alpha + background * (255 - alpha)) / 255);
}

/** 扫描抽样帧：可用 alpha、不透明范围，以及深色前景最多的帧。 */
export function summarizeFrames(frames: readonly RgbaFrame[]): FrameSummary {
  let sawOpaque = false;
  let sawTransparent = false;
  let maxAlpha = 0;
  let bounds: PixelRect | null = null;
  let frameIndex = 0;
  let bestDark = -1;
  frames.forEach((frame, index) => {
    const stats = scanFrame(frame);
    if (stats.maxAlpha > maxAlpha) maxAlpha = stats.maxAlpha;
    if (stats.sawOpaque) sawOpaque = true;
    if (stats.sawTransparent) sawTransparent = true;
    if (stats.bounds) bounds = bounds ? unionRect(bounds, stats.bounds) : stats.bounds;
    if (stats.darkOpaque > bestDark) {
      bestDark = stats.darkOpaque;
      frameIndex = index;
    }
  });
  return { usableAlpha: sawOpaque && sawTransparent, maxAlpha, bounds, frameIndex };
}

/** 扩成偶数原点与偶数边长，并留在画面内。yuv420 要偶数。 */
export function evenCrop(bounds: PixelRect, frameWidth: number, frameHeight: number, padPx: number): PixelRect {
  let x = clamp(bounds.x - padPx, 0, frameWidth);
  let y = clamp(bounds.y - padPx, 0, frameHeight);
  let right = clamp(bounds.x + bounds.width + padPx, 0, frameWidth);
  let bottom = clamp(bounds.y + bounds.height + padPx, 0, frameHeight);
  if (x % 2 === 1) x -= 1;
  if (y % 2 === 1) y -= 1;
  if ((right - x) % 2 === 1) right += 1;
  if ((bottom - y) % 2 === 1) bottom += 1;
  if (right > frameWidth) right -= 2;
  if (bottom > frameHeight) bottom -= 2;
  if (right - x < 2 || bottom - y < 2) return evenFrame(frameWidth, frameHeight);
  return { x, y, width: right - x, height: bottom - y };
}

/** 整帧的偶数矩形。奇数边长丢掉最后一行或一列。 */
export function evenFrame(frameWidth: number, frameHeight: number): PixelRect {
  return {
    x: 0,
    y: 0,
    width: frameWidth - (frameWidth % 2),
    height: frameHeight - (frameHeight % 2),
  };
}

/**
 * 深色不透明像素合成到 {@link DARK_PLATE} 之后是否还看得见。
 *
 * @returns 候选像素不够时为 `unobserved`。
 */
export function observeDarkForeground(frame: RgbaFrame): boolean | 'unobserved' {
  let candidates = 0;
  let visible = 0;
  for (let offset = 0; offset < frame.rgba.length; offset += 4) {
    const red = frame.rgba[offset] ?? 0;
    const green = frame.rgba[offset + 1] ?? 0;
    const blue = frame.rgba[offset + 2] ?? 0;
    const alpha = frame.rgba[offset + 3] ?? 0;
    if (alpha < OPAQUE_ALPHA || lumaOf(red, green, blue) > DARK_LUMA_MAX) continue;
    candidates += 1;
    if (darkDelta(red, green, blue, alpha) >= VISIBLE_CHANNEL_DELTA) visible += 1;
  }
  if (candidates < MIN_DARK_PIXELS) return 'unobserved';
  return visible * 2 >= candidates;
}

/**
 * 源里近黑且不透明的像素，有一半以上在输出里变成透明。
 *
 * @param output - 已经按 `crop` 裁过的帧，左上角对齐裁剪原点。
 */
export function lostNearBlackAlpha(source: RgbaFrame, output: RgbaFrame, crop: PixelRect): boolean {
  if (output.width !== crop.width || output.height !== crop.height) return false;
  let candidates = 0;
  let lost = 0;
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const sourcePixel = readPixel(source, crop.x + x, crop.y + y);
      if (!isDarkOpaque(sourcePixel)) continue;
      candidates += 1;
      const outputPixel = readPixel(output, x, y);
      if (!outputPixel || outputPixel.alpha < TRANSPARENT_ALPHA) lost += 1;
    }
  }
  if (candidates < MIN_DARK_PIXELS) return false;
  return lost * 2 >= candidates;
}

interface FrameScan {
  readonly sawOpaque: boolean;
  readonly sawTransparent: boolean;
  readonly maxAlpha: number;
  readonly darkOpaque: number;
  readonly bounds: PixelRect | null;
}

interface Pixel {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

function scanFrame(frame: RgbaFrame): FrameScan {
  let sawOpaque = false;
  let sawTransparent = false;
  let maxAlpha = 0;
  let darkOpaque = 0;
  let minX = frame.width;
  let minY = frame.height;
  let maxX = -1;
  let maxY = -1;
  for (let offset = 0; offset < frame.rgba.length; offset += 4) {
    const alpha = frame.rgba[offset + 3] ?? 0;
    if (alpha > maxAlpha) maxAlpha = alpha;
    if (alpha >= OPAQUE_ALPHA) sawOpaque = true;
    if (alpha < TRANSPARENT_ALPHA) sawTransparent = true;
    if (alpha <= TRANSPARENT_ALPHA) continue;
    const pixel = offset >> 2;
    const x = pixel % frame.width;
    const y = (pixel - x) / frame.width;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    const red = frame.rgba[offset] ?? 0;
    const green = frame.rgba[offset + 1] ?? 0;
    const blue = frame.rgba[offset + 2] ?? 0;
    if (alpha >= OPAQUE_ALPHA && lumaOf(red, green, blue) <= DARK_LUMA_MAX) darkOpaque += 1;
  }
  const bounds = maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  return { sawOpaque, sawTransparent, maxAlpha, darkOpaque, bounds };
}

function darkDelta(red: number, green: number, blue: number, alpha: number): number {
  return Math.max(
    Math.abs(blendChannel(red, alpha, DARK_PLATE.red) - DARK_PLATE.red),
    Math.abs(blendChannel(green, alpha, DARK_PLATE.green) - DARK_PLATE.green),
    Math.abs(blendChannel(blue, alpha, DARK_PLATE.blue) - DARK_PLATE.blue),
  );
}

function isDarkOpaque(pixel: Pixel | null): pixel is Pixel {
  return pixel !== null && pixel.alpha >= OPAQUE_ALPHA && lumaOf(pixel.red, pixel.green, pixel.blue) <= DARK_LUMA_MAX;
}

function readPixel(frame: RgbaFrame, x: number, y: number): Pixel | null {
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return null;
  const offset = (y * frame.width + x) * 4;
  return {
    red: frame.rgba[offset] ?? 0,
    green: frame.rgba[offset + 1] ?? 0,
    blue: frame.rgba[offset + 2] ?? 0,
    alpha: frame.rgba[offset + 3] ?? 0,
  };
}

function unionRect(left: PixelRect, right: PixelRect): PixelRect {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.width, right.x + right.width);
  const bottom = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: rightEdge - x, height: bottom - y };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
