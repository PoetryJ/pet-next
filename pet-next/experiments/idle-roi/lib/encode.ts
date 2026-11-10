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
}

export type RunLike = (bin: string, args: readonly string[]) => Promise<void>;

export const DEFAULT_CRF = 12;
export const DEFAULT_CPU_USED = 2;
export const DEFAULT_GOP = 48;

/** 只有 alpha<=1 置零，不抠黑、不改 RGB。 */
export function alphaZeroFilter(): string {
  return "format=rgba,lut=a='if(lte(val,1),0,val)'";
}

/** 预处理 → 可选裁剪 → yuva420p。`crop` 为 null 时即 F 臂（全画布）。 */
export function preprocessFilter(crop: Rect | null): string {
  const parts = [alphaZeroFilter()];
  if (crop !== null) parts.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
  parts.push('format=yuva420p');
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
    preprocessFilter(options.crop),
    '-fps_mode',
    'passthrough',
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuva420p',
    '-b:v',
    '0',
    '-crf',
    String(options.crf),
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
