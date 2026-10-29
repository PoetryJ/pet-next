/**
 * 用 ffprobe 读流信息，并用 libvpx 把 VP9 解成带 alpha 的 RGBA。
 */
import type { RgbaFrame } from './frame-metrics.ts';
import { MediaToolError, runMediaTool } from './media-tool.ts';

/** 抽样上限。桌宠片段只有约 48 帧，再长就只看开头。 */
export const MAX_SAMPLED_FRAMES = 64;

const PROBE_TIMEOUT_MS = 20_000;
const DECODE_TIMEOUT_MS = 60_000;

export interface VideoProbe {
  readonly codec: string | null;
  readonly pixFmt: string | null;
  readonly alphaMode: string | null;
  readonly width: number;
  readonly height: number;
}

/** 解析 ffprobe 的 JSON。缺宽高时返回 null。 */
export function parseProbeJson(raw: unknown): VideoProbe | null {
  if (typeof raw !== 'object' || raw === null || !('streams' in raw)) return null;
  const streams = (raw as { streams?: unknown }).streams;
  if (!Array.isArray(streams) || streams.length === 0) return null;
  const stream = streams[0];
  if (typeof stream !== 'object' || stream === null) return null;
  const record = stream as Record<string, unknown>;
  const width = record.width;
  const height = record.height;
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) return null;
  return {
    codec: typeof record.codec_name === 'string' ? record.codec_name : null,
    pixFmt: typeof record.pix_fmt === 'string' ? record.pix_fmt : null,
    alphaMode: readAlphaMode(record.tags),
    width,
    height,
  };
}

/** ffprobe 命令。标签原样留下，后面再认 alpha_mode。 */
export function ffprobeCommand(bin: string, file: string): readonly string[] {
  return [
    bin,
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_name,width,height,pix_fmt:stream_tags',
    '-of',
    'json',
    file,
  ];
}

/**
 * 解码命令。
 *
 * VP9 必须指定 libvpx-vp9，自动解码器会丢掉 alpha 平面。
 * `frameIndex` 为空时解抽样范围内的帧；否则只解那一帧。
 */
export function decodeRgbaCommand(bin: string, file: string, codec: string | null, frameIndex: number | null): readonly string[] {
  const command = [bin, '-v', 'error', '-an'];
  if (codec === 'vp9' || codec === 'vp8') command.push('-c:v', 'libvpx-vp9');
  command.push('-i', file);
  if (frameIndex !== null) command.push('-vf', `select=eq(n\\,${frameIndex})`, '-frames:v', '1');
  command.push('-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1');
  return command;
}

/** 跑 ffprobe 并解析第一条视频流。 */
export async function probeVideo(bin: string, file: string): Promise<VideoProbe> {
  const command = ffprobeCommand(bin, file);
  const result = await runMediaTool(command, PROBE_TIMEOUT_MS);
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout.toString('utf8')) as unknown;
  } catch (cause) {
    throw new MediaToolError(bin, 'failed', 'ffprobe 没有返回 JSON', { cause });
  }
  const parsed = parseProbeJson(raw);
  if (!parsed) throw new MediaToolError(bin, 'failed', 'ffprobe 没有视频流的宽高');
  return parsed;
}

/** 解出 RGBA 帧。长度对不齐时返回 null。 */
export async function decodeRgba(bin: string, file: string, probe: VideoProbe, frameIndex: number | null): Promise<RgbaFrame[] | null> {
  const command = decodeRgbaCommand(bin, file, probe.codec, frameIndex);
  const result = await runMediaTool(command, DECODE_TIMEOUT_MS);
  return splitRgba(result.stdout, probe.width, probe.height, frameIndex === null ? MAX_SAMPLED_FRAMES : 1);
}

/** 按帧切开原始 RGBA。空缓冲或长度不是整帧时返回 null。 */
export function splitRgba(buffer: Buffer, width: number, height: number, maxFrames: number): RgbaFrame[] | null {
  const frameBytes = width * height * 4;
  if (frameBytes <= 0 || buffer.length === 0 || buffer.length % frameBytes !== 0) return null;
  const total = Math.min(buffer.length / frameBytes, maxFrames);
  const frames: RgbaFrame[] = [];
  for (let index = 0; index < total; index += 1) {
    const start = index * frameBytes;
    frames.push({ width, height, rgba: new Uint8Array(buffer.subarray(start, start + frameBytes)) });
  }
  return frames;
}

function readAlphaMode(tags: unknown): string | null {
  if (typeof tags !== 'object' || tags === null) return null;
  for (const [key, value] of Object.entries(tags)) {
    if (key.toLowerCase() === 'alpha_mode' && typeof value === 'string') return value;
  }
  return null;
}
