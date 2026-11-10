/**
 * F/C 两臂的编码参数。两臂必须完全一致，唯一差别是 C 多了 ROI 裁剪。
 *
 * `-auto-alt-ref 0`：VP9 alt-ref 帧不携带 alpha。
 * `-fps_mode passthrough`：不重采样时间轴，PTS 随源。
 */
import { rm, rename } from 'node:fs/promises';
import type { Rect } from './crop.ts';

export interface EncodeOptions {
  readonly input: string;
  readonly output: string;
  readonly crop: Rect | null;
  readonly crf: number;
  readonly cpuUsed: number;
  readonly gop: number;
  /** 输出像素格式，默认 yuva420p。是否真被编码器接受由 `supportedPixelFormats()` 判定。 */
  readonly pixelFormat?: string;
  /** `-lossless 1`：VP9 无损，用于把量化误差从裁剪误差里剥离。 */
  readonly lossless?: boolean;
  /** 是否做 alpha<=1 置零。C 从已预处理的 F 派生时为 false（F 已经置零过）。 */
  readonly alphaZero?: boolean;
}

export type RunLike = (bin: string, args: readonly string[]) => Promise<void>;

export const DEFAULT_CRF = 12;
export const DEFAULT_CPU_USED = 2;
export const DEFAULT_GOP = 48;
export const DEFAULT_PIXEL_FORMAT = 'yuva420p';

/** 只有 alpha<=1 置零，不抠黑、不改 RGB。 */
export function alphaZeroFilter(): string {
  return "format=rgba,lut=a='if(lte(val,1),0,val)'";
}

export interface FilterOptions {
  readonly crop: Rect | null;
  readonly pixelFormat?: string;
  readonly alphaZero?: boolean;
}

/** 预处理 → 可选裁剪 → 目标像素格式。`crop` 为 null 时即 F 臂（全画布）。 */
export function preprocessFilter(crop: Rect | null, options: Omit<FilterOptions, 'crop'> = {}): string {
  const pixelFormat = options.pixelFormat ?? DEFAULT_PIXEL_FORMAT;
  const alphaZero = options.alphaZero ?? true;
  const parts: string[] = [];
  if (alphaZero) parts.push(alphaZeroFilter());
  if (crop !== null) parts.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
  parts.push(`format=${pixelFormat}`);
  return parts.join(',');
}

export function encodeArgs(options: EncodeOptions): string[] {
  if (!Number.isInteger(options.crf) || options.crf < 0 || options.crf > 63) {
    throw new Error(`crf 非法：${String(options.crf)}`);
  }
  if (!Number.isInteger(options.cpuUsed) || options.cpuUsed < 0 || options.cpuUsed > 8) {
    throw new Error(`cpu-used 非法：${String(options.cpuUsed)}`);
  }
  if (!Number.isInteger(options.gop) || options.gop <= 0) {
    throw new Error(`gop 非法：${String(options.gop)}`);
  }
  const pixelFormat = options.pixelFormat ?? DEFAULT_PIXEL_FORMAT;
  const quality = options.lossless === true ? ['-lossless', '1'] : ['-crf', String(options.crf)];
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-c:v',
    'libvpx-vp9',
    '-i',
    options.input,
    '-map',
    '0:v:0',
    '-vf',
    preprocessFilter(options.crop, { pixelFormat, alphaZero: options.alphaZero !== false }),
    '-fps_mode',
    'passthrough',
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    pixelFormat,
    '-b:v',
    '0',
    ...quality,
    '-g',
    String(options.gop),
    '-deadline',
    'good',
    '-cpu-used',
    String(options.cpuUsed),
    '-row-mt',
    '1',
    '-auto-alt-ref',
    '0',
    '-color_range',
    'tv',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-metadata:s:v:0',
    'alpha_mode=1',
    '-an',
    // 只关掉封装层的随机 SegmentUID/DateUTC，不改编码质量；这样复跑的 sha 才可复现。
    '-fflags',
    '+bitexact',
    '-f',
    'webm',
    options.output,
  ];
}

/**
 * 先写 `*.partial`，成功后才改名为目标文件；失败时清掉半成品，不留残留。
 */
export async function encodeTo(
  bin: string,
  options: EncodeOptions,
  run: RunLike,
): Promise<void> {
  const partial = `${options.output}.partial`;
  await rm(partial, { force: true });
  try {
    await run(bin, encodeArgs({ ...options, output: partial }));
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  await rm(options.output, { force: true });
  await rename(partial, options.output);
}
