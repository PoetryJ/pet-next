/**
 * 全片独立解码：每个臂只起一条 ffmpeg，直出 rawvideo 到临时文件，再按帧偏移流式读。
 *
 * 为什么不是每帧一条命令：48 帧 × 3 臂 × 640×360，一次导出 + 顺序读才跑得动；
 * 为什么不是整段读进内存：640×360×4×48 ≈ 44MB/臂，三臂同时比对要常驻 90MB 以上，
 * 而且 `execFile` 的 80MB stdout 上限也顶不住。
 *
 * VP9 的 alpha 必须显式 `-c:v libvpx-vp9`，默认解码器会丢掉 alpha 平面。
 */
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

import { runMediaTool } from './tool.ts';

/** 一帧的裸字节。 */
export interface RawVideo {
  readonly file: string;
  readonly rawPath: string;
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly frameBytes: number;
  readonly bytes: number;
}

export interface ColorTags {
  readonly range: string | null;
  readonly matrix: string | null;
  readonly primaries: string | null;
  readonly transfer: string | null;
}

export interface StreamInfo {
  readonly width: number;
  readonly height: number;
  readonly codec: string | null;
  readonly pixFmt: string | null;
  readonly alphaMode: string | null;
  readonly color: ColorTags;
}

export interface FrameTimeline {
  readonly count: number;
  /** 逐帧 PTS，毫秒，未取整。 */
  readonly ptsMs: readonly number[];
  /** 逐帧 duration，毫秒；缺失记 null。 */
  readonly durationsMs: readonly (number | null)[];
  /** 容器 duration，毫秒；缺失记 null。 */
  readonly formatDurationMs: number | null;
}

const PROBE_TIMEOUT_MS = 30_000;
const DECODE_TIMEOUT_MS = 180_000;

/** 读第一条视频流。 */
export async function probeStream(file: string): Promise<StreamInfo> {
  const command = [
    'ffprobe',
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,codec_name,pix_fmt,color_range,color_space,color_primaries,color_transfer:stream_tags=alpha_mode',
    '-of',
    'json',
    file,
  ];
  const result = await runMediaTool(command, PROBE_TIMEOUT_MS);
  const parsed = JSON.parse(result.stdout.toString('utf8')) as {
    streams?: Array<Record<string, unknown> & { tags?: Record<string, unknown> }>;
  };
  const stream = parsed.streams?.[0];
  if (!stream) throw new Error(`${path.basename(file)}: ffprobe 没有视频流`);
  const width = typeof stream.width === 'number' ? stream.width : 0;
  const height = typeof stream.height === 'number' ? stream.height : 0;
  if (width <= 0 || height <= 0) throw new Error(`${path.basename(file)}: 宽高缺失`);
  const tags = stream.tags ?? {};
  const alphaMode = Object.entries(tags).find(([key]) => key.toLowerCase() === 'alpha_mode')?.[1];
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    width,
    height,
    codec: text(stream.codec_name),
    pixFmt: text(stream.pix_fmt),
    alphaMode: typeof alphaMode === 'string' ? alphaMode : null,
    color: {
      range: text(stream.color_range),
      matrix: text(stream.color_space),
      primaries: text(stream.color_primaries),
      transfer: text(stream.color_transfer),
    },
  };
}

/** 逐帧 PTS + duration。必须来自实际封装，不是命令行假设。 */
export async function probeTimeline(file: string): Promise<FrameTimeline> {
  const command = [
    'ffprobe',
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'frame=pts_time,duration_time:format=duration',
    '-of',
    'json',
    file,
  ];
  const result = await runMediaTool(command, PROBE_TIMEOUT_MS);
  const parsed = JSON.parse(result.stdout.toString('utf8')) as {
    frames?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const frames = parsed.frames ?? [];
  const ptsMs: number[] = [];
  const durationsMs: Array<number | null> = [];
  for (const frame of frames) {
    const pts = toMs(frame.pts_time);
    if (pts === null) throw new Error(`${path.basename(file)}: 有帧缺 PTS`);
    ptsMs.push(pts);
    durationsMs.push(toMs(frame.duration_time));
  }
  return { count: frames.length, ptsMs, durationsMs, formatDurationMs: toMs(parsed.format?.duration) };
}

/** 把秒字段转毫秒，保留 3 位小数。 */
function toMs(value: unknown): number | null {
  if (typeof value === 'number') return Math.round(value * 1000) / 1000;
  if (typeof value !== 'string' || value.length === 0 || value === 'N/A') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 1000) / 1000;
}

/**
 * 全片解码成裸 RGBA。一条 ffmpeg 出全部帧，`-fps_mode passthrough` 禁止补帧丢帧。
 *
 * @param workDir - 裸帧落盘的目录（不入库）。
 */
export async function decodeAllFrames(file: string, workDir: string, label: string): Promise<RawVideo> {
  const stream = await probeStream(file);
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
  const rawPath = path.join(workDir, `${label}.rgba`);
  const frameBytes = stream.width * stream.height * 4;
  const command = [
    'ffmpeg',
    '-y',
    '-v',
    'error',
    '-an',
    '-c:v',
    'libvpx-vp9',
    '-i',
    file,
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    rawPath,
  ];
  await runMediaTool(command, DECODE_TIMEOUT_MS);
  const bytes = statSync(rawPath).size;
  if (bytes === 0 || bytes % frameBytes !== 0) {
    throw new Error(`${label}: 解码字节 ${bytes} 不是 ${stream.width}x${stream.height} RGBA 的整数帧`);
  }
  return { file, rawPath, width: stream.width, height: stream.height, frameCount: bytes / frameBytes, frameBytes, bytes };
}

/** 逐帧读裸文件的读头。调用方自己复用同一块缓冲。 */
export interface RawReader {
  readonly video: RawVideo;
  /** 读第 `index` 帧到 `into`，返回实际字节数。 */
  read(index: number, into: Buffer): number;
  close(): void;
}

export function openRaw(video: RawVideo): RawReader {
  const fd = openSync(video.rawPath, 'r');
  let closed = false;
  return {
    video,
    read(index, into) {
      if (closed) throw new Error('reader closed');
      if (index < 0 || index >= video.frameCount) throw new RangeError(`帧号越界 ${index}/${video.frameCount}`);
      if (into.length !== video.frameBytes) throw new RangeError(`缓冲 ${into.length} != ${video.frameBytes}`);
      const read = readSync(fd, into, 0, video.frameBytes, index * video.frameBytes);
      if (read !== video.frameBytes) throw new Error(`第 ${index} 帧只读到 ${read}/${video.frameBytes} 字节`);
      return read;
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}
