/**
 * 素材内"第 0 帧 → 明确回应"时长的离线测量（逐帧解码 + 运动量规则）。
 * 从 bench/click.ts 抽出共用：bench 测量页对照与产品真实回应观测（bench/click-product.ts）
 * 用同一判据，保证"估算列"与"回应终点判据（固定帧号）"可互相复算。
 *
 * 这是素材自身常数的实测（素材逐帧运动规则，assets-pipeline/response-onset.ts），
 * 不是产品延迟观测值。
 */
import { hashFile } from '../assets-pipeline/asset-report.ts';
import { decodeRgba, probeVideo } from '../assets-pipeline/read-media.ts';
import type { RgbaFrame } from '../assets-pipeline/frame-metrics.ts';
import { responseOnsetMs } from '../assets-pipeline/response-onset.ts';

export interface OnsetMeasurement {
  readonly sha256: string;
  readonly fps: number;
  /** 素材内明确回应时刻（毫秒）。找不到回应为 null。 */
  readonly onsetMs: number | null;
  readonly onsetFrame: number | null;
  readonly frames: number;
}

/** 逐帧解码 {@link limitFrames} 帧后按运动量规则测素材内回应时刻。 */
export async function measureOnset(file: string, limitFrames: number): Promise<OnsetMeasurement> {
  const hashed = await hashFile(file);
  if (!hashed) throw new Error(`找不到素材 ${file}`);
  const probe = await probeVideo('ffprobe', file);
  const fps = await readFps(file);
  const frames: RgbaFrame[] = [];
  while (frames.length < limitFrames) {
    const one = await decodeRgba('ffmpeg', file, probe, frames.length);
    if (!one || one.length === 0) break;
    frames.push(one[0]!);
  }
  const onsetMs = responseOnsetMs(frames, fps);
  return {
    sha256: hashed.sha256,
    fps,
    onsetMs,
    onsetFrame: onsetMs === null ? null : Math.round((onsetMs / 1000) * fps),
    frames: frames.length,
  };
}

export async function readFps(file: string): Promise<number> {
  const { execFile } = await import('node:child_process');
  const raw = await new Promise<string>((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'json', file],
      { timeout: 20_000 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });
  const parsed = JSON.parse(raw) as { streams?: Array<{ r_frame_rate?: string }> };
  const [num = 0, den = 0] = (parsed.streams?.[0]?.['r_frame_rate'] ?? '0/1').split('/').map(Number);
  if (!den) throw new Error(`读不出帧率：${file}`);
  return num / den;
}
