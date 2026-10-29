/**
 * 保留 alpha 的裁剪编码。滤镜只有 crop 和 format，不用抠黑。
 */
import type { PixelRect } from './frame-metrics.ts';

const BANNED_FILTERS = new Set(['colorkey', 'chromakey', 'lumakey', 'geq', 'colorhold', 'hsvkey']);

/** 滤镜名是不是在用近黑或色键制造透明。 */
export function filterDeletesNearBlack(filter: string): boolean {
  return filter.split(',').some((part) => BANNED_FILTERS.has(part.split('=')[0]?.trim() ?? ''));
}

/**
 * 组装保留 alpha 的编码参数。
 *
 * `-auto-alt-ref 0` 是因为 VP9 的 alt-ref 帧不带 alpha。
 * CRF 32 与仓库里现有的 VP9 缩略图转码同一档，不按某一条素材回调。
 */
export function preserveAlphaEncodeCommand(
  bin: string,
  input: string,
  output: string,
  crop: PixelRect,
  codec: string | null,
): readonly string[] {
  const filter = `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},format=yuva420p`;
  const command = [bin, '-y', '-hide_banner', '-loglevel', 'error'];
  if (codec === 'vp9' || codec === 'vp8') command.push('-c:v', 'libvpx-vp9');
  command.push(
    '-i',
    input,
    '-vf',
    filter,
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuva420p',
    '-auto-alt-ref',
    '0',
    '-metadata:s:v:0',
    'alpha_mode=1',
    '-b:v',
    '0',
    '-crf',
    '32',
    '-an',
    '-row-mt',
    '1',
    output,
  );
  return command;
}
