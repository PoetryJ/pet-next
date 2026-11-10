/**
 * 画质门的像素运算：straight-alpha 合成、区域掩码、逐通道差值统计。
 *
 * 三条硬约束写在这里，不写在测试里，免得被顺手放宽：
 * 1) 合成一律按 straight alpha（未预乘）做。解码出的 RGBA 是直通 alpha，
 *    透明区那些没预乘的 RGB 乘 0 之后不进误差，不能拿它们当差异；
 * 2) 前景区与边缘区必须分开统计。背景占 70% 面积，混在一起算会把边缘误差稀释掉；
 * 3) 不抽样、不缩放、不跳帧。调用方给哪一帧就算哪一帧。
 *
 * 本文件不定义任何门限，阈值由 {@link module:pet-next/tests/idle-roi/lib/gates} 传入。
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type PlateId = 'black' | 'white' | 'checker';

/** 三种底必须分别过门，顺序固定。 */
export const PLATES: readonly PlateId[] = ['black', 'white', 'checker'];

/** 棋盘格边长，与素材观察用的同一组灰。 */
export const CHECKER_CELL_PX = 8;
export const CHECKER_DARK = 138;
export const CHECKER_LIGHT = 217;

const BLACK = 0;
const WHITE = 255;

export interface AlphaBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** `alpha > threshold` 的像素数。 */
  count: number;
  /** 这些像素的质心，单位是画布像素。 */
  centroidX: number;
  centroidY: number;
}

export interface DiffStats {
  /** 参与统计的通道样本数（像素数 × 3）。 */
  readonly samples: number;
  readonly max: number;
  readonly mae: number;
  /** 最近秩 99 分位，单位 1/255。 */
  readonly p99: number;
  readonly channelMax: readonly [number, number, number];
  readonly channelMae: readonly [number, number, number];
  readonly over1: number;
  readonly over2: number;
  readonly over4: number;
  readonly over8: number;
}

export interface AlphaStats {
  readonly samples: number;
  readonly max: number;
  readonly mae: number;
  readonly over1: number;
  readonly over2: number;
}

/** 棋盘底的单通道查找表，按画布缓存。 */
const checkerCache = new Map<string, Uint8Array>();

function checkerLut(width: number, height: number): Uint8Array {
  const key = `${width}x${height}`;
  const cached = checkerCache.get(key);
  if (cached) return cached;
  const lut = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const rowCell = Math.floor(y / CHECKER_CELL_PX) % 2;
    for (let x = 0; x < width; x += 1) {
      const cell = (Math.floor(x / CHECKER_CELL_PX) + rowCell) % 2;
      lut[y * width + x] = cell === 0 ? CHECKER_LIGHT : CHECKER_DARK;
    }
  }
  checkerCache.set(key, lut);
  return lut;
}

/** 背景在第 `pixel` 个像素上的单通道值（三种底都是灰阶，三通道同值）。 */
export function plateValue(plate: PlateId, width: number, height: number, pixel: number): number {
  if (plate === 'black') return BLACK;
  if (plate === 'white') return WHITE;
  return checkerLut(width, height)[pixel] ?? 0;
}

/**
 * 把一帧 RGBA 按 straight alpha 合成到指定底上，写出 RGB。
 *
 * @param rgba - 恰好一帧，长度 `width*height*4`。
 * @param out - 长度 `width*height*3`。
 */
export function compositeFrame(rgba: Uint8Array, width: number, height: number, plate: PlateId, out: Uint8Array): void {
  const pixels = width * height;
  const lut = plate === 'checker' ? checkerLut(width, height) : null;
  const constant = plate === 'white' ? WHITE : BLACK;
  for (let pixel = 0, offset = 0, target = 0; pixel < pixels; pixel += 1, offset += 4, target += 3) {
    const alpha = rgba[offset + 3] ?? 0;
    const background = lut === null ? constant : (lut[pixel] ?? 0);
    const keep = 255 - alpha;
    out[target] = (((rgba[offset] ?? 0) * alpha + background * keep) / 255 + 0.5) | 0;
    out[target + 1] = (((rgba[offset + 1] ?? 0) * alpha + background * keep) / 255 + 0.5) | 0;
    out[target + 2] = (((rgba[offset + 2] ?? 0) * alpha + background * keep) / 255 + 0.5) | 0;
  }
}

/** `alpha > threshold` 的像素记为 1。 */
export function foregroundMask(rgba: Uint8Array, width: number, height: number, threshold: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let pixel = 0, offset = 3; pixel < mask.length; pixel += 1, offset += 4) {
    mask[pixel] = (rgba[offset] ?? 0) > threshold ? 1 : 0;
  }
  return mask;
}

/**
 * 边缘区：`low <= alpha <= high` 的半透明带，加上 alpha 边界两侧各 1 像素。
 *
 * 边界用 4 邻域判定，所以带子宽 1 像素、跨界两侧都被算进来。
 */
export function edgeMask(rgba: Uint8Array, width: number, height: number, threshold: number, low: number, high: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const opaque = (pixel: number): boolean => (rgba[pixel * 4 + 3] ?? 0) > threshold;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const alpha = rgba[pixel * 4 + 3] ?? 0;
      if (alpha >= low && alpha <= high) {
        mask[pixel] = 1;
        continue;
      }
      const foreground = alpha > threshold;
      let boundary = false;
      if (x > 0 && opaque(pixel - 1) !== foreground) boundary = true;
      else if (x + 1 < width && opaque(pixel + 1) !== foreground) boundary = true;
      else if (y > 0 && opaque(pixel - width) !== foreground) boundary = true;
      else if (y + 1 < height && opaque(pixel + width) !== foreground) boundary = true;
      mask[pixel] = boundary ? 1 : 0;
    }
  }
  return mask;
}

/** 4 邻域膨胀 1 像素。用来把「边缘带」再向外扩一圈。 */
export function dilateMask(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (mask[pixel] === 1) continue;
      if (
        (x > 0 && mask[pixel - 1] === 1) ||
        (x + 1 < width && mask[pixel + 1] === 1) ||
        (y > 0 && mask[pixel - width] === 1) ||
        (y + 1 < height && mask[pixel + width] === 1)
      ) {
        out[pixel] = 1;
      }
    }
  }
  return out;
}

/** 新建一个空累加器。 */
export function emptyAlphaBox(): AlphaBox {
  return { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: -1, maxY: -1, count: 0, centroidX: 0, centroidY: 0 };
}

/** 把一帧 `alpha > threshold` 的包围盒与质心并进累加器。 */
export function accumulateAlphaBox(rgba: Uint8Array, width: number, height: number, threshold: number, box: AlphaBox): void {
  let sumX = box.centroidX * box.count;
  let sumY = box.centroidY * box.count;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((rgba[(y * width + x) * 4 + 3] ?? 0) <= threshold) continue;
      if (x < box.minX) box.minX = x;
      if (y < box.minY) box.minY = y;
      if (x > box.maxX) box.maxX = x;
      if (y > box.maxY) box.maxY = y;
      box.count += 1;
      sumX += x;
      sumY += y;
    }
  }
  box.centroidX = box.count === 0 ? 0 : sumX / box.count;
  box.centroidY = box.count === 0 ? 0 : sumY / box.count;
}

/** 累加器转成可比较的矩形，空集时返回 null。 */
export function boxRect(box: AlphaBox): Rect | null {
  if (box.count === 0) return null;
  return { x: box.minX, y: box.minY, width: box.maxX - box.minX + 1, height: box.maxY - box.minY + 1 };
}

/** 两个 mask 的三通道绝对差统计。`mask` 为 null 时统计整帧。 */
export function diffStats(left: Uint8Array, right: Uint8Array, mask: Uint8Array | null): DiffStats {
  const histogram = new Uint32Array(256);
  const channelSum: [number, number, number] = [0, 0, 0];
  const channelMax: [number, number, number] = [0, 0, 0];
  let samples = 0;
  let over1 = 0;
  let over2 = 0;
  let over4 = 0;
  let over8 = 0;
  const pixels = mask === null ? Math.floor(left.length / 3) : mask.length;
  for (let pixel = 0, offset = 0; pixel < pixels; pixel += 1, offset += 3) {
    if (mask !== null && mask[pixel] !== 1) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs((left[offset + channel] ?? 0) - (right[offset + channel] ?? 0));
      channelSum[channel] = (channelSum[channel] ?? 0) + delta;
      if (delta > (channelMax[channel] ?? 0)) channelMax[channel] = delta;
      histogram[delta] = (histogram[delta] ?? 0) + 1;
      samples += 1;
      if (delta > 1) over1 += 1;
      if (delta > 2) over2 += 1;
      if (delta > 4) over4 += 1;
      if (delta > 8) over8 += 1;
    }
  }
  return {
    samples,
    max: Math.max(channelMax[0], channelMax[1], channelMax[2]),
    mae: samples === 0 ? 0 : (channelSum[0] + channelSum[1] + channelSum[2]) / samples,
    p99: percentile(histogram, samples, 0.99),
    channelMax,
    channelMae: [samples === 0 ? 0 : channelSum[0] / (samples / 3), samples === 0 ? 0 : channelSum[1] / (samples / 3), samples === 0 ? 0 : channelSum[2] / (samples / 3)],
    over1,
    over2,
    over4,
    over8,
  };
}

/** alpha 通道的绝对差统计。alpha 在透明区也有意义，所以不受 RGB 影响。 */
export function alphaStats(left: Uint8Array, right: Uint8Array, mask: Uint8Array | null): AlphaStats {
  let samples = 0;
  let sum = 0;
  let max = 0;
  let over1 = 0;
  let over2 = 0;
  const pixels = mask === null ? Math.floor(left.length / 4) : mask.length;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    if (mask !== null && mask[pixel] !== 1) continue;
    const delta = Math.abs((left[pixel * 4 + 3] ?? 0) - (right[pixel * 4 + 3] ?? 0));
    sum += delta;
    if (delta > max) max = delta;
    samples += 1;
    if (delta > 1) over1 += 1;
    if (delta > 2) over2 += 1;
  }
  return { samples, max, mae: samples === 0 ? 0 : sum / samples, over1, over2 };
}

/** 最近秩 p 分位。空样本记 0。 */
export function percentile(histogram: Uint32Array, samples: number, fraction: number): number {
  if (samples === 0) return 0;
  const target = Math.ceil(samples * fraction);
  let seen = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value] ?? 0;
    if (seen >= target) return value;
  }
  return histogram.length - 1;
}

/** 把 `cropped` 贴回原画布；其余像素清零（alpha=0）。`dx/dy` 是整幅布局偏移，负控用。 */
export function restoreCrop(
  cropped: Uint8Array,
  crop: Rect,
  originalWidth: number,
  originalHeight: number,
  out: Uint8Array,
  dx = 0,
  dy = 0,
): void {
  out.fill(0);
  const originX = crop.x + dx;
  const originY = crop.y + dy;
  const rowBytes = crop.width * 4;
  for (let y = 0; y < crop.height; y += 1) {
    const targetY = originY + y;
    if (targetY < 0 || targetY >= originalHeight) continue;
    const sourceStart = y * rowBytes;
    // 逐像素搬，避免整行越界拷贝。
    for (let x = 0; x < crop.width; x += 1) {
      const targetX = originX + x;
      if (targetX < 0 || targetX >= originalWidth) continue;
      const from = sourceStart + x * 4;
      const to = (targetY * originalWidth + targetX) * 4;
      out[to] = cropped[from] ?? 0;
      out[to + 1] = cropped[from + 1] ?? 0;
      out[to + 2] = cropped[from + 2] ?? 0;
      out[to + 3] = cropped[from + 3] ?? 0;
    }
  }
}

/** 从整幅里取出 crop 区域。 */
export function cropFrame(full: Uint8Array, width: number, crop: Rect, out: Uint8Array): void {
  const rowBytes = crop.width * 4;
  for (let y = 0; y < crop.height; y += 1) {
    const start = ((crop.y + y) * width + crop.x) * 4;
    out.set(full.subarray(start, start + rowBytes), y * rowBytes);
  }
}

/** `alpha <= threshold` 置零，返回被改的像素数。 */
export function applyAlphaFloor(rgba: Uint8Array, threshold: number): number {
  let changed = 0;
  for (let offset = 3; offset < rgba.length; offset += 4) {
    if ((rgba[offset] ?? 0) > threshold) continue;
    if (rgba[offset] === 0) continue;
    rgba[offset] = 0;
    changed += 1;
  }
  return changed;
}

/**
 * 整幅里落在 `crop` 之外的 `alpha > threshold` 像素数，以及 crop 之内的同计数。
 *
 * 「裁入前景」的负控就是让 outside 不为 0。
 */
export function countOpaqueByCrop(rgba: Uint8Array, width: number, height: number, crop: Rect, threshold: number): { inside: number; outside: number } {
  let inside = 0;
  let outside = 0;
  for (let y = 0; y < height; y += 1) {
    const inRows = y >= crop.y && y < crop.y + crop.height;
    for (let x = 0; x < width; x += 1) {
      if ((rgba[(y * width + x) * 4 + 3] ?? 0) <= threshold) continue;
      if (inRows && x >= crop.x && x < crop.x + crop.width) inside += 1;
      else outside += 1;
    }
  }
  return { inside, outside };
}
