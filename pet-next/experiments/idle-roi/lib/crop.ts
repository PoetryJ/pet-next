/**
 * 全片 alpha 并集与裁框计算（纯函数）。
 *
 * 阈值固定 1：只有 `alpha <= 1` 的像素可以被丢弃，不得提高阈值，也不得抠黑。
 * 裁框 = 全片 `alpha > 1` 并集 → 向外留 guard → x/y/宽高偶数对齐（yuva420p 色度单位）。
 */

export interface Canvas {
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 全片 `alpha > threshold` 像素的并集包围盒（含端点）。 */
export interface AlphaBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly count: number;
}

export const ALPHA_THRESHOLD = 1;
export const GUARD_PX = 2;

export function emptyBounds(): AlphaBounds {
  return { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: -1, maxY: -1, count: 0 };
}

function requireRgba(rgba: Uint8Array, width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`画布尺寸非法：${String(width)}x${String(height)}`);
  }
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`RGBA 字节数不符：期望 ${expected}，实际 ${rgba.length}`);
  }
}

/** 把一帧的 `alpha > threshold` 像素并入包围盒；返回新的包围盒。 */
export function accumulateAlphaBounds(
  bounds: AlphaBounds,
  rgba: Uint8Array,
  width: number,
  height: number,
  threshold: number = ALPHA_THRESHOLD,
): AlphaBounds {
  requireRgba(rgba, width, height);
  let { minX, minY, maxX, maxY, count } = bounds;
  const rowBytes = width * 4;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    for (let x = 0; x < width; x += 1) {
      if (rgba[rowStart + x * 4 + 3]! > threshold) {
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY, count };
}

/** 包围盒 → 矩形；空包围盒返回 null。 */
export function boundsToRect(bounds: AlphaBounds): Rect | null {
  if (bounds.count <= 0 || bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) return null;
  return { x: bounds.minX, y: bounds.minY, width: bounds.maxX - bounds.minX + 1, height: bounds.maxY - bounds.minY + 1 };
}

/** 向四周留 guard 像素（可越出画布，越界由 {@link alignEvenRect} 收回）。 */
export function expandRect(rect: Rect, guard: number = GUARD_PX): Rect {
  if (!Number.isInteger(guard) || guard < 0) throw new Error(`guard 非法：${String(guard)}`);
  return { x: rect.x - guard, y: rect.y - guard, width: rect.width + guard * 2, height: rect.height + guard * 2 };
}

function oddOffset(value: number): number {
  return ((value % 2) + 2) % 2;
}

/** 收回画布内，并把起点向下、终点向上取偶数，保证 x/y/宽/高全部为偶数。 */
export function alignEvenRect(rect: Rect, canvas: Canvas): Rect {
  const startX = Math.max(0, rect.x - oddOffset(rect.x));
  const startY = Math.max(0, rect.y - oddOffset(rect.y));
  const endX = Math.min(canvas.width, rect.x + rect.width + oddOffset(rect.x + rect.width));
  const endY = Math.min(canvas.height, rect.y + rect.height + oddOffset(rect.y + rect.height));
  const aligned: Rect = { x: startX, y: startY, width: endX - startX, height: endY - startY };
  if (oddOffset(canvas.width) !== 0 || oddOffset(canvas.height) !== 0) {
    throw new Error(`画布宽高必须为偶数：${canvas.width}x${canvas.height}`);
  }
  if (oddOffset(aligned.width) !== 0 || oddOffset(aligned.height) !== 0) {
    throw new Error(`偶数对齐失败：${JSON.stringify(aligned)}`);
  }
  if (aligned.width <= 0 || aligned.height <= 0) {
    throw new Error(`裁框为空：${JSON.stringify(aligned)}`);
  }
  return aligned;
}

/** 全片并集 → guard → 偶数对齐。没有 `alpha > threshold` 像素时返回 null。 */
export function computeCrop(
  bounds: AlphaBounds,
  canvas: Canvas,
  guard: number = GUARD_PX,
): Rect | null {
  const rect = boundsToRect(bounds);
  if (rect === null) return null;
  return alignEvenRect(expandRect(rect, guard), canvas);
}

export function rectArea(rect: Rect): number {
  return rect.width * rect.height;
}

/** 统计整帧 `alpha > threshold` 的像素数。 */
export function countAlphaAbove(
  rgba: Uint8Array,
  width: number,
  height: number,
  threshold: number = ALPHA_THRESHOLD,
): number {
  requireRgba(rgba, width, height);
  let count = 0;
  const rowBytes = width * 4;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    for (let x = 0; x < width; x += 1) {
      if (rgba[rowStart + x * 4 + 3]! > threshold) count += 1;
    }
  }
  return count;
}

/** 统计矩形以外 `alpha > threshold` 的像素数；契约要求这个数必须是 0。 */
export function countAlphaAboveOutside(
  rgba: Uint8Array,
  width: number,
  height: number,
  rect: Rect,
  threshold: number = ALPHA_THRESHOLD,
): number {
  requireRgba(rgba, width, height);
  const insideYStart = rect.y;
  const insideYEnd = rect.y + rect.height;
  const insideXStart = rect.x;
  const insideXEnd = rect.x + rect.width;
  let count = 0;
  const rowBytes = width * 4;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    const rowInside = y >= insideYStart && y < insideYEnd;
    for (let x = 0; x < width; x += 1) {
      if (rowInside && x >= insideXStart && x < insideXEnd) continue;
      if (rgba[rowStart + x * 4 + 3]! > threshold) count += 1;
    }
  }
  return count;
}
