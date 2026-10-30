/**
 * 从已验证母带截取回应短片（保留 alpha 的帧区间重编码）。
 *
 * 规则（都可从原始记录复核）：
 * - 不做黑帧删除、不用任何抠像滤镜（守卫照抄 encode-alpha 的禁用清单）。
 * - 基线 B = 前 6 帧不透明像素数（alpha ≥ 200）的中位数。
 * - 最早明确回应帧 t*：从基线之后起，连续 3 帧 opaquePx ≥ max(2B, B+32) 的最早一帧。
 * - 起点取 max(0, t*-6)：仍是自然首帧（覆盖回应起点，保留少量预备动作）。
 * - 终点取尾部 opaquePx ≥ 25%·峰值的最后一帧，且至少覆盖到 t*+2。
 * - 产物必须 pix_fmt=yuva420p、alpha_mode=1，且逐帧与母带 alpha 差 |Δα|≤16 的像素占比 ≥ 99%。
 *
 * 用法：cd pet-next && node --experimental-strip-types assets-pipeline/short-clip.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { AssetCandidateManifest } from '../contracts/asset-candidate.ts';
import { hashFile } from './asset-report.ts';
import { runMediaTool } from './media-tool.ts';
import { decodeRgba, probeVideo, type VideoProbe } from './read-media.ts';
import type { RgbaFrame } from './frame-metrics.ts';
import { writeComparisonPlates } from './deliver-candidate.ts';
import {
  BURST_AREA_RATIO,
  MOTION_CHANNEL_DELTA,
  RESPONSE_WINDOW,
  RESPONSE_WINDOW_MIN_HITS,
  SETTLE_MOTION_MAX,
  SETTLE_QUIET_RUN,
  findEarliestResponse,
  findNaturalEnd,
  frameMotionCurve,
} from './response-onset.ts';

const PET_ROOT = process.cwd();
const FFMPEG = 'ffmpeg';
const FFPROBE = 'ffprobe';
const SAFE_FRAME_CAP = 400;
const ALPHA_DIFF_TOLERANCE = 16;
const ALPHA_MISMATCH_RATIO_MAX = 0.01;
const OPAQUE_ALPHA_MIN = 200;
const LEAD_IN_FRAMES = 6;

interface Timing {
  readonly fps: number;
  readonly durationSec: number;
}

function fail(message: string): never {
  console.error(JSON.stringify({ ok: false, limitation: message }, null, 2));
  process.exit(1);
}

async function probeTiming(file: string): Promise<Timing> {
  const result = await runMediaTool(
    [FFPROBE, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,duration', '-of', 'json', file],
    20_000,
  );
  const parsed = JSON.parse(result.stdout.toString('utf8')) as { streams?: Array<{ 'r_frame_rate'?: string; duration?: string }> };
  const stream = parsed.streams?.[0];
  const [num = 0, den = 0] = (stream?.['r_frame_rate'] ?? '0/1').split('/').map((part) => Number(part));
  const fps = den ? num / den : 0;
  const durationSec = Number(stream?.duration ?? 0);
  if (!Number.isFinite(fps) || fps <= 0) fail('读不到有效帧率。');
  return { fps, durationSec };
}

function maxAlphaOf(frame: RgbaFrame): number {
  let max = 0;
  for (let at = 3; at < frame.rgba.length; at += 4) {
    const alpha = frame.rgba[at]!;
    if (alpha > max) max = alpha;
  }
  return max;
}


/** 解出母带全部帧（逐帧解码：批量模式会超过 media-tool 的 stdout 上限）。 */
async function decodeAllFrames(file: string, probe: VideoProbe): Promise<RgbaFrame[]> {
  const frames: RgbaFrame[] = [];
  while (frames.length < SAFE_FRAME_CAP) {
    const one = await decodeRgba(FFMPEG, file, probe, frames.length);
    if (!one || one.length === 0) break;
    frames.push(one[0]!);
  }
  return frames;
}

function preserveAlphaTrimCommand(): readonly string[] {
  // 实测（ffmpeg 8.0.1）：webm(VP9+alpha) → webm 同进程转码会把 alpha 平面反转
  // （透明区变 254）。改走 rawvideo rgba 管道：帧选择在 Node 内完成，
  // 编码器从原始像素起步，往返 alpha 逐像素校验 0 失配。全程不用任何视频滤镜。
  return [FFMPEG, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-i', 'pipe:0', '-c:v', 'libvpx-vp9', '-an'];
}

/** 把母带 [startFrame, endFrame] 区间经 raw RGBA 管道重编码为保留 alpha 的 webm。 */
async function encodeFromFrames(
  frames: readonly RgbaFrame[],
  startFrame: number,
  endFrame: number,
  outputAbs: string,
  fps: number,
): Promise<void> {
  const width = frames[0]!.width;
  const height = frames[0]!.height;
  const args = [
    FFMPEG,
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${width}x${height}`,
    '-r',
    String(fps),
    '-i',
    'pipe:0',
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
    '-row-mt',
    '1',
    '-an',
    outputAbs,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`编码超时（>300s）：${outputAbs}`));
    }, 300_000);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}: ${stderr.slice(0, 400)}`));
    });
    try {
      for (let index = startFrame; index <= endFrame; index += 1) {
        const frame = frames[index]!;
        if (frame.width !== width || frame.height !== height) {
          throw new Error(`帧 ${index} 尺寸不一致：${frame.width}x${frame.height}`);
        }
        const view = frame.rgba;
        child.stdin.write(Buffer.from(view.buffer, view.byteOffset, view.byteLength));
      }
      child.stdin.end();
    } catch (error) {
      child.kill('SIGKILL');
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** 逐帧比较短片与母带对应区间的 alpha 平面。 */
function alphaMismatchRatio(short: RgbaFrame, master: RgbaFrame): number {
  const total = short.width * short.height;
  let mismatch = 0;
  for (let at = 3; at < short.rgba.length; at += 4) {
    if (Math.abs(short.rgba[at]! - master.rgba[at]!) > ALPHA_DIFF_TOLERANCE) mismatch += 1;
  }
  return total === 0 ? 1 : mismatch / total;
}

async function main(): Promise<void> {
  const sourceRel = 'assets/candidates/reaction/source.webm';
  const outputRel = 'assets/candidates/reaction/short.webm';
  const manifestRel = 'assets/candidates/reaction/short-manifest.json';
  if (!outputRel.startsWith('assets/candidates/')) fail('输出路径只能落在 assets/candidates/ 下。');
  const sourceAbs = join(PET_ROOT, sourceRel);
  const outputAbs = join(PET_ROOT, outputRel);

  const hashed = await hashFile(sourceAbs);
  if (!hashed) fail('找不到母带 source.webm。');
  const probe = await probeVideo(FFPROBE, sourceAbs);
  const timing = await probeTiming(sourceAbs);
  const frames = await decodeAllFrames(sourceAbs, probe);
  if (frames.length === 0) fail('母带一帧都解不出来。');

  // 检测用帧间运动量：宠物全程不透明，回应是姿态变化而不是面积增长。
  const motion = frameMotionCurve(frames);
  const pixelsPerFrame = frames[0]!.width * frames[0]!.height;
  const burstThreshold = Math.round(BURST_AREA_RATIO * pixelsPerFrame);
  const earliestResponse = findEarliestResponse(motion, burstThreshold);
  if (earliestResponse < 0) {
    fail(`按规则找不到明确回应起点（运动阈值 ${burstThreshold}px），不出片。`);
  }
  const endFrame = findNaturalEnd(motion, earliestResponse);
  if (endFrame < earliestResponse + 2) fail('尾部可用帧不足，不出片。');
  const startFrame = Math.max(0, earliestResponse - LEAD_IN_FRAMES);

  const encodeCommand = preserveAlphaTrimCommand();
  await encodeFromFrames(frames, startFrame, endFrame, outputAbs, timing.fps);

  const outProbe = await probeVideo(FFPROBE, outputAbs);
  // VP9 alpha webm 的颜色平面探测为 yuv420p，alpha 走 alpha_mode=1 标签（与母带一致）。
  const hasAlpha = outProbe.alphaMode === '1' || outProbe.pixFmt === 'yuva420p';
  if (!hasAlpha) {
    fail(`短片容器不合格：pix_fmt=${outProbe.pixFmt} alpha_mode=${outProbe.alphaMode}`);
  }
  const outFrames: RgbaFrame[] = [];
  for (;;) {
    const one = await decodeRgba(FFMPEG, outputAbs, outProbe, outFrames.length);
    if (!one || one.length === 0) break;
    outFrames.push(one[0]!);
  }
  if (outFrames.length !== endFrame - startFrame + 1) {
    fail(`短片帧数 ${outFrames.length} 与区间 [${startFrame},${endFrame}] 不符。`);
  }
  let worstMismatch = 0;
  const perFrameMaxAlpha: number[] = [];
  for (let index = 0; index < outFrames.length; index += 1) {
    perFrameMaxAlpha.push(maxAlphaOf(outFrames[index]!));
    const ratio = alphaMismatchRatio(outFrames[index]!, frames[startFrame + index]!);
    if (ratio > worstMismatch) worstMismatch = ratio;
  }
  if (worstMismatch > ALPHA_MISMATCH_RATIO_MAX) {
    fail(`alpha 逐帧校验未过：最差失配率 ${(worstMismatch * 100).toFixed(3)}%`);
  }
  if (Math.max(...perFrameMaxAlpha) < OPAQUE_ALPHA_MIN) fail('短片没有任何一帧存在不透明前景。');

  const plateIndexes = [earliestResponse - startFrame, endFrame - startFrame];
  const platesDirRel = 'assets/candidates/reaction/short-plates';
  await mkdir(dirname(join(PET_ROOT, manifestRel)), { recursive: true });
  const comparison = await writeComparisonPlates({
    petRoot: PET_ROOT,
    sourceRelativePath: outputRel,
    platesDirRelative: platesDirRel,
    frameIndexes: plateIndexes,
  });
  if (!comparison.ok) fail(comparison.limitation);

  const outHashed = await hashFile(outputAbs);
  if (!outHashed) fail('短片写盘后读不到。');
  const manifest: AssetCandidateManifest = {
    role: 'reaction',
    kind: 'alpha-source',
    sourcePath: sourceRel,
    sourceSha256: hashed.sha256,
    outputPath: outputRel,
    outputSha256: outHashed.sha256,
    plates: comparison.frames.flatMap((frame) => frame.plates),
    command: ['node', '--experimental-strip-types', 'assets-pipeline/short-clip.ts'],
    limitation: null,
  };
  await writeFile(join(PET_ROOT, manifestRel), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const provenancePath = join(PET_ROOT, 'assets/candidates/reaction/provenance.json');
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8')) as Record<string, unknown>;
  provenance.short = {
    outputPath: outputRel,
    outputSha256: outHashed.sha256,
    sourceSha256: hashed.sha256,
    webmStep: 'trim-reencode-raw-rgba',
    encodeFilter: 'rawvideo rgba pipe（帧区间选择在 Node 内完成，无视频滤镜；规避 ffmpeg 8.0.1 webm→webm 转码 alpha 反转）',
    bannedFiltersUsed: false,
    encodeCommandPrefix: encodeCommand.join(' '),
    earliestResponse: {
      frameIndex: earliestResponse,
      timeSec: Number((earliestResponse / timing.fps).toFixed(3)),
      rule: `帧间运动量 D（RGB 任一通道差>${MOTION_CHANNEL_DELTA} 的像素数）≥ ${(BURST_AREA_RATIO * 100).toFixed(0)}% 画幅，且后 ${RESPONSE_WINDOW} 帧内 ≥${RESPONSE_WINDOW_MIN_HITS} 帧达到半阈值的最早帧`,
      motionAtResponse: motion[earliestResponse] ?? null,
    },
    trim: {
      startFrame,
      endFrame,
      startTimeSec: Number((startFrame / timing.fps).toFixed(3)),
      endTimeSec: Number((endFrame / timing.fps).toFixed(3)),
      durationSec: Number(((endFrame - startFrame + 1) / timing.fps).toFixed(3)),
      sourceFrameCount: frames.length,
      sourceDurationSec: Number(timing.durationSec.toFixed(3)),
      fps: Number(timing.fps.toFixed(3)),
      endRule: `回应后首次出现连续 ${SETTLE_QUIET_RUN} 帧运动量 <${SETTLE_MOTION_MAX} 的前一帧（自然收尾，不删黑帧）`,
    },
    alphaCheck: {
      verified: true,
      frames: outFrames.length,
      alphaDeltaTolerance: ALPHA_DIFF_TOLERANCE,
      worstMismatchRatio: Number(worstMismatch.toFixed(6)),
      perFrameMaxAlpha: perFrameMaxAlpha,
    },
    plateFrameIndexes: plateIndexes,
    command: ['node', '--experimental-strip-types', 'assets-pipeline/short-clip.ts'],
  };
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');

  console.log(
    JSON.stringify(
      {
        ok: true,
        output: outputRel,
        sha256: outHashed.sha256,
        earliestResponseFrame: earliestResponse,
        startFrame,
        endFrame,
        frames: outFrames.length,
        durationSec: Number(((endFrame - startFrame + 1) / timing.fps).toFixed(3)),
        worstMismatchRatio: Number(worstMismatch.toFixed(6)),
      },
      null,
      2,
    ),
  );
}

await main();
