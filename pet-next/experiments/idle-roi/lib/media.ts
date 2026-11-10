/**
 * ffmpeg/ffprobe 适配层。
 *
 * 解码一律显式指定 `-c:v libvpx-vp9`：VP9 的 alpha 在 BlockAdditional 里，
 * 默认解码器会直接丢掉 alpha。
 */
import { spawn } from 'node:child_process';

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ColorTags {
  readonly primaries: string;
  readonly transfer: string;
  readonly matrix: string;
  readonly range: string;
}

export interface StreamProbe {
  readonly width: number;
  readonly height: number;
  readonly codec: string;
  /**
   * 容器上报的像素格式。VP9 的 alpha 存在 BlockAdditional 里，
   * 带 alpha 的 webm 也仍然上报 `yuv420p`；是否带 alpha 看 alphaMode 和实际解码。
   */
  readonly pixelFormat: string;
  /** `alpha_mode` 标签：VP9 alpha 流的显式标记（`1` 表示有 alpha 平面）。 */
  readonly alphaMode: string | null;
  readonly frameRate: string;
  readonly timeBase: string;
  readonly colorTags: ColorTags;
  readonly durationMs: number;
}

function spawnCapture(bin: string, args: readonly string[]): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => reject(new Error(`${bin} 无法启动：${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${bin} 退出码 ${String(code)}：${stderr.trim().slice(-2000)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export { spawnCapture as runCapture };

export async function ffmpegVersionLine(bin: string): Promise<string> {
  const { stdout } = await spawnCapture(bin, ['-hide_banner', '-version']);
  const first = stdout.split('\n')[0]?.trim() ?? '';
  if (first.length === 0) throw new Error('读不到 ffmpeg 版本行');
  return first;
}

interface ProbeJson {
  streams?: Array<Record<string, unknown>>;
  format?: Record<string, unknown>;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function probeStream(ffprobeBin: string, input: string): Promise<StreamProbe> {
  const { stdout } = await spawnCapture(ffprobeBin, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    input,
  ]);
  const parsed = JSON.parse(stdout) as ProbeJson;
  const stream = parsed.streams?.[0];
  if (stream === undefined) throw new Error(`${input} 没有视频流`);
  const width = Number(stream['width']);
  const height = Number(stream['height']);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`${input} 尺寸非法：${String(stream['width'])}x${String(stream['height'])}`);
  }
  const formatDuration = Number(parsed.format?.['duration']);
  const durationMs = Number.isFinite(formatDuration) ? Math.round(formatDuration * 1000) : Number.NaN;
  const tags = isRecord(stream['tags']) ? stream['tags'] : {};
  // ffprobe 把 webm 的 AlphaMode 报成大写 `ALPHA_MODE`，按键名大小写不敏感地找。
  const alphaModeKey = Object.keys(tags).find((key) => key.toUpperCase() === 'ALPHA_MODE');
  const alphaModeRaw = alphaModeKey === undefined ? undefined : tags[alphaModeKey];
  return {
    width,
    height,
    codec: text(stream['codec_name'], 'unknown'),
    pixelFormat: text(stream['pix_fmt'], 'unknown'),
    alphaMode: typeof alphaModeRaw === 'string' ? alphaModeRaw : null,
    frameRate: text(stream['r_frame_rate'], 'unknown'),
    timeBase: text(stream['time_base'], 'unknown'),
    colorTags: {
      primaries: text(stream['color_primaries'], 'unknown'),
      transfer: text(stream['color_transfer'], 'unknown'),
      matrix: text(stream['color_space'], 'unknown'),
      range: text(stream['color_range'], 'unknown'),
    },
    durationMs,
  };
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

interface FramesJson {
  frames?: Array<Record<string, unknown>>;
}

/** 逐帧 PTS（毫秒）。必须来自实际解码，不接受命令行推算。 */
export async function listFramePtsMs(ffprobeBin: string, input: string): Promise<number[]> {
  const { stdout } = await spawnCapture(ffprobeBin, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'frame=pts_time,best_effort_timestamp_time',
    '-of',
    'json',
    input,
  ]);
  const parsed = JSON.parse(stdout) as FramesJson;
  const frames = parsed.frames ?? [];
  const values: number[] = [];
  for (const frame of frames) {
    const raw = Number(frame['pts_time'] ?? frame['best_effort_timestamp_time']);
    if (!Number.isFinite(raw)) throw new Error(`${input} 存在无 PTS 的帧`);
    values.push(round3(raw * 1000));
  }
  if (values.length === 0) throw new Error(`${input} 解码后没有任何帧`);
  return values;
}

const DECODE_FILTER = 'format=rgba';

/**
 * 逐帧解码成 RGBA 并流式产出。调用方逐帧处理，不把整段读进内存。
 */
export async function* decodeRgbaFrames(
  ffmpegBin: string,
  input: string,
  width: number,
  height: number,
): AsyncGenerator<Uint8Array> {
  const frameSize = width * height * 4;
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-c:v',
    'libvpx-vp9',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-vf',
    DECODE_FILTER,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-',
  ];
  const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', (error) => reject(new Error(`${ffmpegBin} 无法启动：${error.message}`)));
    child.on('close', (code) => resolve(code ?? -1));
  });
  let pending: Uint8Array = new Uint8Array(0);
  let completed = false;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Uint8Array>) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= frameSize) {
        yield pending.subarray(0, frameSize);
        pending = pending.subarray(frameSize);
      }
    }
    completed = true;
  } finally {
    if (!completed && child.exitCode === null) child.kill('SIGKILL');
  }
  const code = await exited;
  if (code !== 0) {
    throw new Error(`${input} 解码失败（退出码 ${String(code)}）：${stderr.trim().slice(-2000)}`);
  }
  if (pending.length !== 0) {
    throw new Error(`${input} 解码数据不完整：残留 ${pending.length} 字节（帧大小 ${frameSize}）`);
  }
}
