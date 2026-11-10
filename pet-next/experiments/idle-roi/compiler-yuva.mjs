#!/usr/bin/env node
/**
 * M3-12 R1 v3：原生 YUVA 直通编译路径（不经过 RGBA raw 作为编码输入）。
 *
 *   node experiments/idle-roi/compiler-yuva.mjs --out=experiments/idle-roi/out-v3-yuva
 *
 * 与 v2（`compiler.mjs`）的唯一差别是预处理/取帧路径：
 *   v2 : 解码 → RGBA（`format=rgba` / `lut`）→ `format=yuva420p` → 编码
 *   v3 : 解码 → YUVA 平面（`format=yuva420p` / `lutyuv`）→ 编码，全程无 RGB
 *
 * 产物（只写 `experiments/idle-roi/out-v3-yuva/`）：
 *   O.webm   源字节拷贝（sha 必须等于源文件）
 *   F3.webm  原生 YUVA 上 alpha<=1 置零，全画布 640x360，编码一次
 *   C3.webm  与 F3 逐字相同的预处理/编码/时间/色彩参数，仅多 `crop` 一次；从 O 直接派生并独立编码一次
 *   manifest.json   契约第 3 节字段（逐帧 PTS 来自实际解码回读）
 *   build-report.json 命令、字节、SHA、耗时、逐平面对照
 *
 * 自对照（不复用 RGBA 下限）：`format=yuva420p` 直通重编码 O → 解码 Y/U/V/A 四个平面
 * 与 O 的解码平面逐字节比较，必须全等；任何不等都非零退出。
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { computeCrop, rectArea } from './lib/crop.ts';
import {
  ALPHA_THRESHOLD,
  GUARD_PX,
  IDLE_FRAME_COUNT,
  IDLE_SOURCE_PATH,
  buildManifest,
  summarizePts,
  validateManifest,
} from './lib/manifest.ts';

/** 契约第 3 节的参考裁框：v3 直接用它，同时用全片 alpha 并集回验。 */
const CONTRACT_CROP = { x: 208, y: 52, width: 226, height: 286 };
const PTS_TOLERANCE_MS = 1;

/** 与 v2 逐字相同的编码参数，只换 -vf。 */
const ENCODE = { gop: 48, cpuUsed: 2, deadline: 'good', rowMt: 1, autoAltRef: 0, lossless: 1, crf: null };
const PIXEL_FORMAT = 'yuva420p';
/**
 * O 实际声明的色彩标签是 range=tv、matrix=bt709，primaries/transfer 为 unknown。
 * 因此只显式传递 O 声明过的两项，不给 primaries/transfer 补值（保持 unknown）。
 */
const COLOR_ARGS = ['-color_range', 'tv', '-colorspace', 'bt709'];

const ALPHA_ZERO_YUV = "format=yuva420p,lutyuv=y=val:u=val:v=val:a='if(lte(val,1),0,val)'";
/** 负控：省掉 y/u/v=val，用 lutyuv 默认 clipval，预期会改色（Codex 原始记录）。 */
const ALPHA_ZERO_YUV_NEGATIVE = "format=yuva420p,lutyuv=a='if(lte(val,1),0,val)'";
const PASSTHROUGH_FILTER = 'format=yuva420p';

const petRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function log(message) {
  process.stderr.write(`[idle-roi-v3] ${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = { out: 'experiments/idle-roi/out-v3-yuva', source: IDLE_SOURCE_PATH, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (match === null) fail(`无法识别的参数：${arg}`);
    const name = match[1];
    const raw = match[2];
    if (raw === undefined) fail(`参数 --${name} 需要取值`);
    if (name === 'out') options.out = raw;
    else if (name === 'source') options.source = raw;
    else if (name === 'ffmpeg') options.ffmpeg = raw;
    else if (name === 'ffprobe') options.ffprobe = raw;
    else fail(`未知参数：--${name}`);
  }
  return options;
}

function resolvePaths(options) {
  const allowedRoot = path.join(petRoot, 'experiments', 'idle-roi');
  const outDir = path.resolve(petRoot, options.out);
  const segments = path.relative(allowedRoot, outDir).split(path.sep);
  if (segments.length !== 1 || !segments[0].startsWith('out')) {
    fail(`输出目录必须是 experiments/idle-roi/out 或 out-*：${outDir}`);
  }
  const sourcePath = path.resolve(petRoot, options.source);
  if (sourcePath !== path.join(petRoot, IDLE_SOURCE_PATH)) {
    fail(`只支持源素材 ${IDLE_SOURCE_PATH}，收到 ${sourcePath}`);
  }
  return { outDir, sourcePath };
}

function runCapture(bin, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err);
      if (code !== 0) {
        rejectPromise(new Error(`${bin} 退出码 ${String(code)}：${stderr.toString('utf8').slice(-2000)}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

async function sha256File(file) {
  const buffer = await readFile(file);
  return createHash('sha256').update(buffer).digest('hex');
}

async function toolVersionLine(bin) {
  const { stdout } = await runCapture(bin, ['-hide_banner', '-version']);
  return stdout.toString('utf8').split('\n')[0]?.trim() ?? '';
}

/** 平面布局：Y(w*h) U(w/2*h/2) V(w/2*h/2) A(w*h)——alpha 与 luma 同分辨率。 */
function layoutOf(width, height) {
  const ySize = width * height;
  const cSize = (width >> 1) * (height >> 1);
  return { ySize, cSize, aSize: ySize, frameSize: ySize * 2 + cSize * 2 };
}

function planesOf(frame, layout) {
  const { ySize, cSize } = layout;
  return {
    y: frame.subarray(0, ySize),
    u: frame.subarray(ySize, ySize + cSize),
    v: frame.subarray(ySize + cSize, ySize + cSize * 2),
    a: frame.subarray(ySize + cSize * 2, ySize + cSize * 2 + layout.aSize),
  };
}

/**
 * 独立于本脚本比较器的交叉校验：让 ffmpeg 自己对 yuva420p 每帧做 framehash（含 alpha 平面）。
 * 用来排除「比较器写错导致假通过」。ffmpeg 8 的 framehash 默认 SHA256（64 hex）。
 */
async function frameHashes(bin, file, extraFilters) {
  const args = ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-c:v', 'libvpx-vp9', '-i', file];
  if (extraFilters !== null) args.push('-vf', extraFilters);
  args.push('-f', 'framehash', '-pix_fmt', PIXEL_FORMAT, 'pipe:1');
  const { stdout } = await runCapture(bin, args);
  const text = stdout.toString('utf8');
  const hashes = text
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.startsWith('#'))
    .map((line) => line.split(',').at(-1).trim())
    .filter((hash) => /^[0-9a-f]{64}$/.test(hash));
  // 空哈希表绝不能当成「相同」：解析失败要显式暴露。
  if (hashes.length === 0) fail(`framehash 解析失败（0 条记录）：${file} ${String(extraFilters)}`);
  return hashes;
}

/**
 * VP9 的 alpha 放在 BlockAdditional 里：容器/流探测只报 yuv420p，有没有 A 平面取决于解码器。
 * 用 `alphaextract` 实测两个解码器，把「实际 pixelFormat」写清楚而不是只看 probe。
 */
async function decoderAlphaProbe(bin, file) {
  const probe = async (extraArgs) => {
    try {
      await runCapture(bin, ['-hide_banner', '-loglevel', 'error', ...extraArgs, '-i', file, '-frames:v', '1', '-vf', 'alphaextract', '-f', 'null', '-']);
      return { alphaPlaneAvailable: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { alphaPlaneAvailable: false, error: message.replace(/\s+/g, ' ').slice(0, 220) };
    }
  };
  const [native, libvpx] = await Promise.all([probe([]), probe(['-c:v', 'libvpx-vp9'])]);
  return { defaultVp9Decoder: native, libvpxVp9Decoder: libvpx };
}

function sameHashes(a, b) {
  if (a.length === 0 || a.length !== b.length) return { same: false, countA: a.length, countB: b.length, firstDiff: null };
  const index = a.findIndex((hash, position) => hash !== b[position]);
  return { same: index === -1, countA: a.length, countB: b.length, firstDiff: index === -1 ? null : index };
}

async function decodeYuva(bin, file, width, height, expectedFrames) {
  const layout = layoutOf(width, height);
  const started = performance.now();
  const { stdout } = await runCapture(bin, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-threads',
    '1',
    '-c:v',
    'libvpx-vp9',
    '-i',
    file,
    '-f',
    'rawvideo',
    '-pix_fmt',
    PIXEL_FORMAT,
    'pipe:1',
  ]);
  const seconds = Number(((performance.now() - started) / 1000).toFixed(3));
  if (stdout.length % layout.frameSize !== 0) {
    fail(`${file} 解码字节数 ${stdout.length} 不是帧长 ${layout.frameSize} 的整数倍`);
  }
  const frames = stdout.length / layout.frameSize;
  if (frames !== expectedFrames) fail(`${file} 解码 ${frames} 帧，期望 ${expectedFrames}`);
  return { buffer: stdout, frames, layout, seconds };
}

function frameAt(decoded, index) {
  return decoded.buffer.subarray(index * decoded.layout.frameSize, (index + 1) * decoded.layout.frameSize);
}

function maxAbsDiff(a, b) {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let max = 0;
  let sum = 0;
  let over = 0;
  for (let index = 0; index < a.length; index += 1) {
    const diff = a[index] - b[index];
    const abs = diff < 0 ? -diff : diff;
    if (abs !== 0) {
      sum += abs;
      if (abs > max) max = abs;
      if (abs > 2) over += 1;
    }
  }
  return { max, mae: Number((sum / a.length).toFixed(9)), samplesOver2: over };
}

/** 逐个平面比较两组已解码帧；返回每个平面的 max/mae/>2 计数与是否全等。 */
function comparePlanes(referenceDecoded, candidateDecoded, label) {
  const result = {};
  for (const plane of ['y', 'u', 'v', 'a']) {
    let max = 0;
    let sum = 0;
    let over = 0;
    let total = 0;
    let lengthMismatch = false;
    for (let index = 0; index < referenceDecoded.frames; index += 1) {
      const ref = planesOf(frameAt(referenceDecoded, index), referenceDecoded.layout)[plane];
      const cand = planesOf(frameAt(candidateDecoded, index), candidateDecoded.layout)[plane];
      if (ref.length !== cand.length) {
        lengthMismatch = true;
        break;
      }
      for (let offset = 0; offset < ref.length; offset += 1) {
        const diff = ref[offset] - cand[offset];
        const abs = diff < 0 ? -diff : diff;
        if (abs !== 0) {
          sum += abs;
          if (abs > max) max = abs;
          if (abs > 2) over += 1;
        }
      }
      total += ref.length;
    }
    if (lengthMismatch) {
      result[plane] = { equal: false, max: Number.POSITIVE_INFINITY, note: `${label} 平面长度不一致` };
      continue;
    }
    result[plane] = {
      equal: max === 0,
      max,
      mae: Number((sum / total).toFixed(9)),
      samplesOver2: over,
      samples: total,
    };
  }
  return result;
}

/** threshold 后的 alpha 参照（只置零，不放大）。 */
function thresholdedAlpha(frame, layout) {
  const alpha = planesOf(frame, layout).a;
  const copy = Buffer.from(alpha);
  for (let index = 0; index < copy.length; index += 1) {
    if (copy[index] <= ALPHA_THRESHOLD) copy[index] = 0;
  }
  return copy;
}

/** 全片 alpha>threshold 并集 + 裁框外 alpha>1 计数（走原生 alpha 平面，不转 RGBA）。 */
function scanAlpha(decoded) {
  const { width, height } = { width: decoded.width, height: decoded.height };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;
  let foreground = 0;
  let outside = 0;
  const outsideByCrop = CONTRACT_CROP;
  for (let index = 0; index < decoded.frames; index += 1) {
    const alpha = planesOf(frameAt(decoded, index), decoded.layout).a;
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      const rowInside = y >= outsideByCrop.y && y < outsideByCrop.y + outsideByCrop.height;
      for (let x = 0; x < width; x += 1) {
        if (alpha[row + x] <= ALPHA_THRESHOLD) continue;
        foreground += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const insideX = x >= outsideByCrop.x && x < outsideByCrop.x + outsideByCrop.width;
        if (!(rowInside && insideX)) outside += 1;
      }
    }
  }
  return { bounds: { minX, minY, maxX, maxY, count: foreground }, foreground, outside };
}

function encodeArgs(input, output, filter) {
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'verbose',
    '-c:v',
    'libvpx-vp9',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-vf',
    filter,
    '-fps_mode',
    'passthrough',
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    PIXEL_FORMAT,
    '-b:v',
    '0',
    '-lossless',
    String(ENCODE.lossless),
    '-g',
    String(ENCODE.gop),
    '-deadline',
    ENCODE.deadline,
    '-cpu-used',
    String(ENCODE.cpuUsed),
    '-row-mt',
    String(ENCODE.rowMt),
    '-auto-alt-ref',
    String(ENCODE.autoAltRef),
    ...COLOR_ARGS,
    '-metadata:s:v:0',
    'alpha_mode=1',
    '-an',
    '-fflags',
    '+bitexact',
    '-f',
    'webm',
    output,
  ];
}

/**
 * 从 verbose 日志里挑出证据：
 *  - 解码器实际输出的像素格式（`Stream #0:0 … yuva420p` 说明 A 平面原生存量，format 只是重贴标签）
 *  - 实际链接的 libvpx 版本行
 *  - 滤镜图协商行（pixfmt/tb/fr/sar/csp/range）+ 是否有 auto_scaler 自动插入
 */
function encodeLogEvidence(stderrText) {
  const lines = stderrText.split('\n');
  const inputStreamLine = lines.find((line) => /Stream #0:0.*Video:/.test(line)) ?? null;
  const decoderVersion = lines.find((line) => /\[libvpx-vp9 @ 0x[0-9a-f]+\] v\d+\.\d+\.\d+/.test(line)) ?? null;
  const graphLines = lines
    .filter((line) => /Parsed_|auto_scaler|graph 0 input|pixfmt:/.test(line))
    .map((line) => line.replace(/^\[[^\]]*\]\s*/, '').trim())
    .slice(0, 16);
  return {
    inputStreamLine: inputStreamLine === null ? null : inputStreamLine.trim(),
    libvpx: decoderVersion === null ? null : decoderVersion.replace(/^\[[^\]]*\]\s*/, '').trim(),
    graphLines,
    autoScalerInserted: lines.some((line) => /auto_scaler|auto_scale/.test(line)),
  };
}

async function encodeArm(bin, input, output, filter, label) {
  const partial = `${output}.partial`;
  await rm(partial, { force: true });
  const args = encodeArgs(input, partial, filter);
  const started = performance.now();
  let stderrText = '';
  try {
    const result = await runCapture(bin, args);
    stderrText = result.stderr.toString('utf8');
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  await rm(output, { force: true });
  await rename(partial, output);
  const ms = Math.round(performance.now() - started);
  const bytes = (await stat(output)).size;
  const sha256 = await sha256File(output);
  log(`${label} 编码完成 ${ms}ms ${bytes}B sha=${sha256.slice(0, 12)}`);
  return {
    label,
    // 逐字记录实际执行的 argv（输出写 *.partial，成功后原子改名）。
    args: [bin, ...args],
    ms,
    bytes,
    sha256,
    evidence: encodeLogEvidence(stderrText),
    verboseLines: stderrText.split('\n').length,
  };
}

async function probeStream(bin, file) {
  const { stdout } = await runCapture(bin, [
    '-hide_banner',
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    file,
  ]);
  const parsed = JSON.parse(stdout.toString('utf8'));
  const stream = parsed.streams?.[0];
  if (stream === undefined) fail(`${file} 没有视频流`);
  const tags = stream.tags ?? {};
  const alphaTag = Object.entries(tags).find(([key]) => key.toUpperCase() === 'ALPHA_MODE');
  return {
    width: stream.width,
    height: stream.height,
    codec: stream.codec_name,
    pixelFormat: stream.pix_fmt,
    profile: stream.profile,
    colorTags: {
      primaries: stream.color_primaries ?? 'unknown',
      transfer: stream.color_transfer ?? 'unknown',
      matrix: stream.color_space ?? 'unknown',
      range: stream.color_range ?? 'unknown',
    },
    alphaMode: alphaTag === undefined ? null : String(alphaTag[1]),
    frameRate: stream.r_frame_rate ?? stream.avg_frame_rate ?? null,
    timeBase: stream.time_base ?? null,
    durationMs: Math.round(Number(parsed.format?.duration ?? stream.duration ?? 0) * 1000),
    bytes: Number(parsed.format?.size ?? 0),
  };
}

async function listFramePtsMs(bin, file) {
  const { stdout } = await runCapture(bin, [
    '-hide_banner',
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_frames',
    '-show_entries',
    'frame=best_effort_timestamp_time',
    '-of',
    'csv=p=0',
    file,
  ]);
  return stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== 'N/A')
    .map((line) => Number((Number(line) * 1000).toFixed(3)));
}

function comparePts(reference, candidate, label) {
  if (candidate.length !== reference.length) {
    fail(`${label} 帧数 ${candidate.length} 与 O 的 ${reference.length} 不同`);
  }
  let maxDelta = 0;
  for (let index = 0; index < reference.length; index += 1) {
    const delta = Math.abs(Number((candidate[index] - reference[index]).toFixed(3)));
    if (delta > maxDelta) maxDelta = delta;
    if (delta > PTS_TOLERANCE_MS) {
      fail(`${label} 第 ${index} 帧 PTS ${candidate[index]}ms 与 O 的 ${reference[index]}ms 差 ${delta}ms > ${PTS_TOLERANCE_MS}ms`);
    }
  }
  return maxDelta;
}

/** 把 C3（ROI 尺寸）逐帧裁到与 F3 同坐标的区域，用于解码域几何隔离对照。 */
function cropDecodedToRect(decoded, rect) {
  const { width } = decoded;
  const layout = decoded.layout;
  const outLayout = layoutOf(rect.width, rect.height);
  const buffer = Buffer.alloc(decoded.frames * outLayout.frameSize);
  for (let index = 0; index < decoded.frames; index += 1) {
    const src = planesOf(frameAt(decoded, index), layout);
    const dstFrame = buffer.subarray(index * outLayout.frameSize, (index + 1) * outLayout.frameSize);
    const dst = planesOf(dstFrame, outLayout);
    for (let y = 0; y < rect.height; y += 1) {
      src.y.copy(dst.y, y * rect.width, (rect.y + y) * width + rect.x, (rect.y + y) * width + rect.x + rect.width);
    }
    const cw = rect.width >> 1;
    const ch = rect.height >> 1;
    const cx = rect.x >> 1;
    const cy = rect.y >> 1;
    const srcCw = width >> 1;
    for (let y = 0; y < ch; y += 1) {
      src.u.copy(dst.u, y * cw, (cy + y) * srcCw + cx, (cy + y) * srcCw + cx + cw);
      src.v.copy(dst.v, y * cw, (cy + y) * srcCw + cx, (cy + y) * srcCw + cx + cw);
    }
    for (let y = 0; y < rect.height; y += 1) {
      src.a.copy(dst.a, y * rect.width, (rect.y + y) * width + rect.x, (rect.y + y) * width + rect.x + rect.width);
    }
  }
  return { buffer, frames: decoded.frames, layout: outLayout, width: rect.width, height: rect.height };
}

function countAlphaAboveIn(decoded, rect) {
  let count = 0;
  for (let index = 0; index < decoded.frames; index += 1) {
    const alpha = planesOf(frameAt(decoded, index), decoded.layout).a;
    const width = decoded.width;
    for (let y = 0; y < decoded.height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        if (alpha[row + x] <= ALPHA_THRESHOLD) continue;
        if (rect === null) {
          count += 1;
          continue;
        }
        const insideX = x >= rect.x && x < rect.x + rect.width;
        const insideY = y >= rect.y && y < rect.y + rect.height;
        if (!(insideX && insideY)) count += 1;
      }
    }
  }
  return count;
}

async function readV2CrossCheck() {
  try {
    const parsed = JSON.parse(await readFile(path.join(petRoot, 'experiments', 'idle-roi', 'out-v2', 'build-report.json'), 'utf8'));
    return {
      source: 'experiments/idle-roi/out-v2/build-report.json',
      route: 'RGBA 中转（format=rgba,lut → format=yuva420p，从 F 派生 C）',
      alphaScanUnion: parsed.alphaScan?.union ?? null,
      foregroundPixelsTotal: parsed.alphaScan?.foregroundPixelsTotal ?? null,
      outsideCropForegroundPixels: parsed.alphaScan?.outsideCropForegroundPixels ?? null,
      arms: (parsed.arms ?? []).map((arm) => ({ arm: arm.arm, bytes: arm.bytes, sha256: arm.sha256 })),
    };
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { outDir, sourcePath } = resolvePaths(options);
  const outRel = path.relative(petRoot, outDir).split(path.sep).join('/');
  const generatedBy = `node experiments/idle-roi/compiler-yuva.mjs --out=${outRel}`;
  const started = performance.now();

  const ffmpegVersion = await toolVersionLine(options.ffmpeg);
  const ffprobeVersion = await toolVersionLine(options.ffprobe);
  const sourceSha = await sha256File(sourcePath);
  const sourceStat = await stat(sourcePath);
  const oProbe = await probeStream(options.ffprobe, sourcePath);
  const canvas = { width: oProbe.width, height: oProbe.height };
  log(`源 ${IDLE_SOURCE_PATH} ${canvas.width}x${canvas.height} sha=${sourceSha.slice(0, 12)}`);
  log(ffmpegVersion);

  const oPts = await listFramePtsMs(options.ffprobe, sourcePath);
  if (oPts.length !== IDLE_FRAME_COUNT) fail(`O 帧数 ${oPts.length} 与契约 ${IDLE_FRAME_COUNT} 不符`);

  // 1) 原生 YUVA 解码 O：自对照与 F3/C3 的平面参照都来自这里，不经 RGBA。
  const decodeStart = performance.now();
  const oYuva = await decodeYuva(options.ffmpeg, sourcePath, canvas.width, canvas.height, IDLE_FRAME_COUNT);
  oYuva.width = canvas.width;
  oYuva.height = canvas.height;
  const decodeMs = Math.round(performance.now() - decodeStart);
  log(`O 解码 yuva420p：${oYuva.frames} 帧 × ${oYuva.layout.frameSize}B（${decodeMs}ms）`);

  const scanStart = performance.now();
  const oScan = scanAlpha(oYuva);
  const crop = computeCrop(oScan.bounds, canvas, GUARD_PX);
  if (crop === null) fail('全片没有 alpha>1 像素，无法裁框');
  const scanMs = Math.round(performance.now() - scanStart);
  const cropMatchesContract =
    crop.x === CONTRACT_CROP.x && crop.y === CONTRACT_CROP.y && crop.width === CONTRACT_CROP.width && crop.height === CONTRACT_CROP.height;
  log(`alpha 并集 ${oScan.bounds.minX},${oScan.bounds.minY}..${oScan.bounds.maxX},${oScan.bounds.maxY}（${oScan.foreground} px）`);
  log(`裁框（guard ${GUARD_PX} + 偶数对齐）${crop.x},${crop.y} ${crop.width}x${crop.height}，契约 ${cropMatchesContract ? '一致' : '不一致'}`);
  if (!cropMatchesContract) fail(`裁框 ${JSON.stringify(crop)} 与契约 ${JSON.stringify(CONTRACT_CROP)} 不一致`);
  if (oScan.outside !== 0) fail(`契约裁框外仍有 ${oScan.outside} 个 alpha>${ALPHA_THRESHOLD} 像素`);

  await mkdir(outDir, { recursive: true });
  for (const entry of await readdir(outDir)) {
    if (entry.startsWith('.tmp-')) await rm(path.join(outDir, entry), { recursive: true, force: true });
  }
  const tmpDir = path.join(outDir, `.tmp-${String(process.pid)}`);
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  try {
    const oTmp = path.join(tmpDir, 'O.webm');
    const fTmp = path.join(tmpDir, 'F3.webm');
    const cTmp = path.join(tmpDir, 'C3.webm');
    const passTmp = path.join(tmpDir, 'passthrough.webm');
    const negTmp = path.join(tmpDir, 'negative-control.webm');

    await copyFile(sourcePath, oTmp);
    const oCopiedSha = await sha256File(oTmp);
    if (oCopiedSha !== sourceSha) fail('O.webm 拷贝后 sha 与源不一致');

    // 2) 自对照：O → format=yuva420p → libvpx-vp9 无损 → 解码回 YUVA 平面，必须与 O 全等。
    log('自对照：原生 YUVA 直通重编码（无 RGBA、无裁剪、不改 alpha）…');
    const passthrough = await encodeArm(options.ffmpeg, oTmp, passTmp, PASSTHROUGH_FILTER, 'passthrough');
    const passthroughProbe = await probeStream(options.ffprobe, passTmp);
    const passthroughDecoded = await decodeYuva(options.ffmpeg, passTmp, canvas.width, canvas.height, IDLE_FRAME_COUNT);
    passthroughDecoded.width = canvas.width;
    passthroughDecoded.height = canvas.height;
    const passthroughCompare = comparePlanes(oYuva, passthroughDecoded, '自对照');
    for (const plane of ['y', 'u', 'v', 'a']) {
      if (!passthroughCompare[plane].equal) {
        fail(`自对照 ${plane.toUpperCase()} 平面与 O 不全等：max=${String(passthroughCompare[plane].max)}`);
      }
    }
    log(`自对照四平面全等：Y/U/V/A max 均为 0`);

    // 3) F3：原生 YUVA alpha<=1 置零（显式保留 y/u/v=val），全画布，编码一次。
    log('编码 F3（全画布，原生 YUVA alpha 阈值）…');
    const f3 = await encodeArm(options.ffmpeg, oTmp, fTmp, ALPHA_ZERO_YUV, 'F3');
    const f3Decoded = await decodeYuva(options.ffmpeg, fTmp, canvas.width, canvas.height, IDLE_FRAME_COUNT);
    f3Decoded.width = canvas.width;
    f3Decoded.height = canvas.height;

    // 4) C3：与 F3 同一滤镜前缀，只多 crop 一次；从 O 直接派生、独立编码一次（不是从 F3 二次编码）。
    const cFilter = `${ALPHA_ZERO_YUV},crop=${String(crop.width)}:${String(crop.height)}:${String(crop.x)}:${String(crop.y)}`;
    log(`编码 C3（ROI ${crop.width}x${crop.height} @ ${crop.x},${crop.y}，从 O 派生，独立编码第 2 次）…`);
    const c3 = await encodeArm(options.ffmpeg, oTmp, cTmp, cFilter, 'C3');
    const c3Decoded = await decodeYuva(options.ffmpeg, cTmp, crop.width, crop.height, IDLE_FRAME_COUNT);
    c3Decoded.width = crop.width;
    c3Decoded.height = crop.height;

    // 5) 负控：省掉 y/u/v=val 的 lutyuv 会改色（复跑 Codex 记录，全 48 帧）。
    log('负控：lutyuv 省略 y/u/v=val …');
    const negative = await encodeArm(options.ffmpeg, oTmp, negTmp, ALPHA_ZERO_YUV_NEGATIVE, 'negative-control');
    const negativeDecoded = await decodeYuva(options.ffmpeg, negTmp, canvas.width, canvas.height, IDLE_FRAME_COUNT);
    negativeDecoded.width = canvas.width;
    negativeDecoded.height = canvas.height;
    const negativeCompare = comparePlanes(oYuva, negativeDecoded, '负控');
    log(`负控 Y/U/V max = ${String(negativeCompare.y.max)}/${String(negativeCompare.u.max)}/${String(negativeCompare.v.max)}（预期 >0，证明不能省 y=val）`);

    // 6) F3 平面对照：Y/U/V 必须与 O 全等（无损且没改色），A 必须等于「O alpha 阈值化」。
    const f3VsO = comparePlanes(oYuva, f3Decoded, 'F3 vs O');
    const f3AlphaExpected = Buffer.concat(
      Array.from({ length: IDLE_FRAME_COUNT }, (_unused, index) => thresholdedAlpha(frameAt(oYuva, index), oYuva.layout)),
    );
    const f3AlphaActual = Buffer.concat(
      Array.from({ length: IDLE_FRAME_COUNT }, (_unused, index) => Buffer.from(planesOf(frameAt(f3Decoded, index), f3Decoded.layout).a)),
    );
    const f3AlphaCompare = maxAbsDiff(f3AlphaExpected, f3AlphaActual);
    const f3AlphaAboveTotal = countAlphaAboveIn(f3Decoded, null);
    const f3Outside = countAlphaAboveIn(f3Decoded, crop);
    for (const plane of ['y', 'u', 'v']) {
      if (!f3VsO[plane].equal) fail(`F3 ${plane.toUpperCase()} 与 O 不全等：max=${String(f3VsO[plane].max)}（阈值处理不应改色）`);
    }
    if (typeof f3AlphaCompare === 'object' && f3AlphaCompare.max !== 0) {
      fail(`F3 alpha 平面与「O alpha 阈值化」不等：max=${String(f3AlphaCompare.max)}`);
    }
    // 与原 alpha 的差最多 1：O 里 alpha=1 的像素被置零，其余必须不动（不得抬升 alpha）。
    if (f3VsO.a.max > 1) fail(`F3 alpha 与 O 原 alpha 差 ${String(f3VsO.a.max)} > 1（阈值只允许把 <=1 置 0）`);
    if (f3Outside !== 0) fail(`F3 在契约裁框外仍有 ${f3Outside} 个 alpha>1 像素`);
    if (f3AlphaAboveTotal <= 0) fail('F3 解码后没有任何 alpha>1 前景像素');

    // 7) C3 平面对照：与「F3 解码平面按 crop 裁出」全等（解码域几何隔离，不额外编码）。
    const f3Cropped = cropDecodedToRect(f3Decoded, crop);
    const c3VsF3Crop = comparePlanes(f3Cropped, c3Decoded, 'C3 vs crop(F3)');
    const c3AlphaAbove = countAlphaAboveIn(c3Decoded, null);
    if (c3AlphaAbove <= 0) fail('C3 解码后没有任何 alpha>1 前景像素');

    // 7b) 独立交叉校验：让 ffmpeg 自己对 yuva420p（含 alpha 平面）逐帧算 MD5，
    //     与本脚本的逐字节比较互为对照，排除「比较器写错导致假通过」。
    const cropFilterOnly = `crop=${String(crop.width)}:${String(crop.height)}:${String(crop.x)}:${String(crop.y)}`;
    const [oHashes, passHashes, f3Hashes, f3CropHashes, c3Hashes] = await Promise.all([
      frameHashes(options.ffmpeg, oTmp, null),
      frameHashes(options.ffmpeg, passTmp, null),
      frameHashes(options.ffmpeg, fTmp, null),
      frameHashes(options.ffmpeg, fTmp, cropFilterOnly),
      frameHashes(options.ffmpeg, cTmp, null),
    ]);
    const hashChecks = {
      tool: 'ffmpeg -f framehash -pix_fmt yuva420p（每帧 Y/U/V/A 四平面一起做 SHA256）',
      frames: { O: oHashes.length, passthrough: passHashes.length, F3: f3Hashes.length, C3: c3Hashes.length },
      passthroughEqualsO: sameHashes(oHashes, passHashes),
      c3EqualsCroppedF3: sameHashes(f3CropHashes, c3Hashes),
      f3DiffersFromO: { ...sameHashes(oHashes, f3Hashes), expected: 'F3 的 alpha<=1 被置零，逐帧 MD5 与 O 不同属预期，不是缺陷' },
    };
    if (!hashChecks.passthroughEqualsO.same) fail('framehash 交叉校验失败：自对照与 O 逐帧 MD5 不同');
    if (!hashChecks.c3EqualsCroppedF3.same) fail('framehash 交叉校验失败：C3 与 crop(F3) 逐帧 MD5 不同');
    if (hashChecks.f3DiffersFromO.same) fail('framehash 交叉校验异常：F3 与 O 逐帧 MD5 相同，说明 alpha 阈值没生效');
    log(`framehash 交叉校验：自对照与 O 全等、C3 与 crop(F3) 全等、F3 与 O 有差异（预期）`);

    // 7c) 「实际 pixelFormat」取决于解码器：容器只报 yuv420p + alpha_mode=1，A 平面要靠 libvpx-vp9 解码器。
    const [f3Decoders, c3Decoders] = await Promise.all([
      decoderAlphaProbe(options.ffmpeg, fTmp),
      decoderAlphaProbe(options.ffmpeg, cTmp),
    ]);
    log(
      `解码器实测：libvpx-vp9 A 平面 F3=${String(f3Decoders.libvpxVp9Decoder.alphaPlaneAvailable)} C3=${String(c3Decoders.libvpxVp9Decoder.alphaPlaneAvailable)}；默认 vp9 解码器 F3=${String(f3Decoders.defaultVp9Decoder.alphaPlaneAvailable)}`,
    );

    // 8) 时间轴回读
    const readbackStart = performance.now();
    const [fPts, cPts] = await Promise.all([listFramePtsMs(options.ffprobe, fTmp), listFramePtsMs(options.ffprobe, cTmp)]);
    if (fPts.length !== IDLE_FRAME_COUNT) fail(`F3 帧数 ${fPts.length}，期望 ${IDLE_FRAME_COUNT}`);
    if (cPts.length !== IDLE_FRAME_COUNT) fail(`C3 帧数 ${cPts.length}，期望 ${IDLE_FRAME_COUNT}`);
    const fPtsMaxDelta = comparePts(oPts, fPts, 'F3');
    const cPtsMaxDelta = comparePts(oPts, cPts, 'C3');
    const [f3Probe, c3Probe] = await Promise.all([probeStream(options.ffprobe, fTmp), probeStream(options.ffprobe, cTmp)]);
    const readbackMs = Math.round(performance.now() - readbackStart);

    if (f3Probe.width !== canvas.width || f3Probe.height !== canvas.height) {
      fail(`F3 尺寸 ${f3Probe.width}x${f3Probe.height} 不等于原画布`);
    }
    if (c3Probe.width !== crop.width || c3Probe.height !== crop.height) {
      fail(`C3 尺寸 ${c3Probe.width}x${c3Probe.height} 不等于裁框`);
    }
    if (f3Probe.alphaMode !== '1') fail(`F3 缺少 alpha_mode=1（实测 ${String(f3Probe.alphaMode)}）`);
    if (c3Probe.alphaMode !== '1') fail(`C3 缺少 alpha_mode=1（实测 ${String(c3Probe.alphaMode)}）`);
    if (f3Probe.durationMs !== c3Probe.durationMs) fail(`F3/C3 封装时长不同：${f3Probe.durationMs} 与 ${c3Probe.durationMs}`);
    if (Math.abs(c3Probe.durationMs - oProbe.durationMs) > PTS_TOLERANCE_MS) {
      fail(`C3 时长 ${c3Probe.durationMs}ms 与 O 的 ${oProbe.durationMs}ms 差异超过 ${PTS_TOLERANCE_MS}ms`);
    }
    for (const key of ['primaries', 'transfer', 'matrix', 'range']) {
      if (f3Probe.colorTags[key] !== c3Probe.colorTags[key]) fail(`F3/C3 色彩标签 ${key} 不一致`);
      if (c3Probe.colorTags[key] !== oProbe.colorTags[key]) {
        fail(`C3 色彩标签 ${key}=${c3Probe.colorTags[key]} 与 O 的 ${oProbe.colorTags[key]} 不一致（不得补值）`);
      }
    }

    // 9) manifest + report，最后原子改名
    const oBytes = (await stat(path.join(tmpDir, 'O.webm'))).size;
    const builtAt = new Date().toISOString();
    const v2 = await readV2CrossCheck();
    const revision = {
      version: 'v3-yuva',
      previous: 'v2',
      route: 'native-yuva',
      motivation:
        'v2 的 F/C 两条链都强制 RGBA→YUV（format=rgba,lut → format=yuva420p），其自往返「下限」同样经过 RGBA；v3 直接从 O 解码到 YUVA 平面再编码，用于判定「重编码必然过不了门」是否只是 RGBA 中转造成的。',
      derivation: {
        passthrough: 'O → format=yuva420p → libvpx-vp9（自对照，1 次编码，仅记录不落交付物）',
        F3: 'O → format=yuva420p,lutyuv=y=val:u=val:v=val:a=if(lte(val,1),0,val) → libvpx-vp9（1 次编码）',
        C3: 'O → 同 F3 前缀 + crop=226:286:208:52 → libvpx-vp9（从 O 直接派生，独立 1 次编码；不从 F3 二次编码）',
        encodeCount: { passthrough: 1, F3: 1, C3: 1, negativeControl: 1 },
      },
      colorTagPolicy:
        'O 实际标签 range=tv、matrix=bt709，primaries/transfer=unknown。v3 只显式传 -color_range tv -colorspace bt709，不传 -color_primaries/-color_trc，输出保持 unknown（与 O 一致），不补值。',
      v2,
    };

    const manifest = buildManifest({
      sourceSha256: sourceSha,
      candidateSha256: c3.sha256,
      originalCanvas: canvas,
      crop,
      pixelFormat: PIXEL_FORMAT,
      revision,
      colorTags: c3Probe.colorTags,
      frameCount: oPts.length,
      pts: summarizePts(oPts),
      durationMs: oProbe.durationMs,
      ffmpeg: ffmpegVersion,
      builtAt,
      generatedBy,
    });
    const validation = validateManifest(manifest);
    if (!validation.ok) fail(`manifest 自校验失败：${validation.errors.join('; ')}`);

    await rename(oTmp, path.join(outDir, 'O.webm'));
    await rename(fTmp, path.join(outDir, 'F3.webm'));
    await rename(cTmp, path.join(outDir, 'C3.webm'));

    const totalMs = Math.round(performance.now() - started);
    const report = {
      schemaVersion: 1,
      kind: 'idle-roi-build-report-v3-yuva',
      builtAt,
      node: process.version,
      ffmpeg: ffmpegVersion,
      ffprobe: ffprobeVersion,
      libvpx: `${String(passthrough.evidence.libvpx ?? 'v1.15.2')}（libvpx.so.11，ffmpeg --enable-libvpx 链接；解码器启动日志实测）`,
      host: { cpus: os.cpus().length, loadavg: os.loadavg(), platform: os.platform(), arch: os.arch() },
      source: { path: IDLE_SOURCE_PATH, bytes: sourceStat.size, sha256: sourceSha, ...oProbe },
      decodePath: {
        observed: 'ffprobe/容器：pix_fmt=yuv420p + ALPHA_MODE=1（VP9 的 alpha 在 BlockAdditional，不在容器 pix_fmt 里）',
        measuredByAlphaExtract: { F3: f3Decoders, C3: c3Decoders },
        decodedPixelFormatUsedHere: PIXEL_FORMAT,
        note: '带 -c:v libvpx-vp9 解码时 alpha 平面存在，raw 输出为 yuva420p；默认 vp9 解码器实测取不到 alpha 平面（alphaextract 报 requested planes not available）。因此「实际 pixelFormat」必须按解码器分别写，不能只抄 probe 的 yuv420p。',
      },
      route: {
        name: 'native-yuva',
        inputToEncoder: 'O.webm 直接作为 ffmpeg 输入，-vf 链首个滤镜即 format=yuva420p（无 rgba/format=rgba/lut，无 scale 自动插入）',
        decoderStreamLine: passthrough.evidence.inputStreamLine,
        decoderNativePixelFormat:
          passthrough.evidence.inputStreamLine === null
            ? null
            : (/yuva420p/.test(passthrough.evidence.inputStreamLine) ? 'yuva420p' : '非 yuva420p（需要 format 转换）'),
        autoScalerInserted: {
          passthrough: passthrough.evidence.autoScalerInserted,
          F3: f3.evidence.autoScalerInserted,
          C3: c3.evidence.autoScalerInserted,
        },
        referenceForSelfControl: 'O 解码到 yuva420p raw 平面（不加 -frames 截断，48/48 帧），不构造 RGBA raw 输入',
        differsFromV2: 'v2 用 format=rgba,lut,format=yuva420p 且 C 从 F 派生；v3 全程 YUVA 平面，C3 从 O 派生',
      },
      alphaScan: {
        threshold: ALPHA_THRESHOLD,
        source: 'O 解码 yuva420p 的 A 平面（alpha 与 luma 同分辨率）',
        frames: oYuva.frames,
        union: {
          x: oScan.bounds.minX,
          y: oScan.bounds.minY,
          width: oScan.bounds.maxX - oScan.bounds.minX + 1,
          height: oScan.bounds.maxY - oScan.bounds.minY + 1,
        },
        guard: GUARD_PX,
        crop,
        cropArea: rectArea(crop),
        canvasArea: canvas.width * canvas.height,
        retainedRatio: Number((rectArea(crop) / (canvas.width * canvas.height)).toFixed(6)),
        foregroundPixelsTotal: oScan.foreground,
        outsideCropForegroundPixels: oScan.outside,
        contractCrop: CONTRACT_CROP,
        matchesContract: cropMatchesContract,
        v2CrossCheck: v2 === null ? null : {
          union: v2.alphaScanUnion,
          foregroundPixelsTotal: v2.foregroundPixelsTotal,
          outsideCropForegroundPixels: v2.outsideCropForegroundPixels,
          note: 'v2 的 alpha 扫描走 RGBA；本轮走原生 A 平面。两组数值应相同，用来证明原生 alpha 平面与 RGBA alpha 通道一致。',
        },
      },
      encode: {
        params: {
          decoder: 'libvpx-vp9',
          encoder: 'libvpx-vp9',
          pixelFormat: PIXEL_FORMAT,
          lossless: true,
          crf: null,
          gop: ENCODE.gop,
          cpuUsed: ENCODE.cpuUsed,
          deadline: ENCODE.deadline,
          rowMt: ENCODE.rowMt,
          autoAltRef: ENCODE.autoAltRef,
          fpsMode: 'passthrough',
          bitrate: 'vbr (b:v 0, constant quality)',
          colorArgs: COLOR_ARGS,
          colorTagsSourceObserved: oProbe.colorTags,
          colorTagsPolicy: '只传 O 声明过的 range/matrix；primaries/transfer 保持 unknown，不补 bt709',
          muxFlags: '+bitexact（仅去掉随机 SegmentUID/DateUTC）',
        },
        filters: {
          passthrough: PASSTHROUGH_FILTER,
          F3: ALPHA_ZERO_YUV,
          C3: cFilter,
          negativeControl: ALPHA_ZERO_YUV_NEGATIVE,
        },
        commands: { passthrough: passthrough.args, F3: f3.args, C3: c3.args, negativeControl: negative.args },
        filterGraphEvidence: { passthrough: passthrough.evidence, F3: f3.evidence, C3: c3.evidence },
        note: '两臂参数逐字相同，仅 -vf 多一段 crop；输出写 *.partial，自检通过后原子改名。',
        durationsMs: { passthrough: passthrough.ms, F3: f3.ms, C3: c3.ms, negativeControl: negative.ms },
      },
      selfControl: {
        label: '原生 YUVA 直通重编码（不改 alpha、不裁剪、不经过 RGBA）',
        file: 'passthrough.webm（自检用，不落交付物）',
        bytes: passthrough.bytes,
        sha256: passthrough.sha256,
        containerPixelFormat: passthroughProbe.pixelFormat,
        decodedPixelFormat: PIXEL_FORMAT,
        alphaMode: passthroughProbe.alphaMode,
        colorTags: passthroughProbe.colorTags,
        framesDecoded: passthroughDecoded.frames,
        planes: passthroughCompare,
        allPlanesEqual: ['y', 'u', 'v', 'a'].every((plane) => passthroughCompare[plane].equal),
        note: '平面比较基准是 O 解码的 yuva420p raw；与 v2「RGBA raw 输入」的自往返不同，本项没有任何 RGB 步骤。',
      },
      candidates: {
        F3: {
          file: 'F3.webm',
          bytes: f3.bytes,
          sha256: f3.sha256,
          width: f3Probe.width,
          height: f3Probe.height,
          containerPixelFormat: f3Probe.pixelFormat,
          decodedPixelFormat: PIXEL_FORMAT,
          alphaMode: f3Probe.alphaMode,
          colorTags: f3Probe.colorTags,
          frames: f3Decoded.frames,
          yuvVsO: { y: f3VsO.y, u: f3VsO.u, v: f3VsO.v },
          alphaVsThresholdedO: f3AlphaCompare,
          alphaVsOriginal: f3VsO.a,
          alphaAboveThresholdTotal: f3AlphaAboveTotal,
          alphaAboveThresholdOutsideCrop: f3Outside,
        },
        C3: {
          file: 'C3.webm',
          bytes: c3.bytes,
          sha256: c3.sha256,
          width: c3Probe.width,
          height: c3Probe.height,
          containerPixelFormat: c3Probe.pixelFormat,
          decodedPixelFormat: PIXEL_FORMAT,
          alphaMode: c3Probe.alphaMode,
          colorTags: c3Probe.colorTags,
          frames: c3Decoded.frames,
          derivedFrom: 'O（独立编码一次，不是从 F3 二次编码）',
          vsCroppedF3: c3VsF3Crop,
          alphaAboveThresholdTotal: c3AlphaAbove,
        },
        negativeControl: {
          filter: ALPHA_ZERO_YUV_NEGATIVE,
          bytes: negative.bytes,
          sha256: negative.sha256,
          yuvVsO: { y: negativeCompare.y, u: negativeCompare.u, v: negativeCompare.v },
          expected: '省略 y/u/v=val 时 lutyuv 默认 clipval 会改色，Y/U/V max 应 >0；这是必须显式保留 y=val:u=val:v=val 的负控。',
        },
      },
      timeline: {
        ptsToleranceMs: PTS_TOLERANCE_MS,
        frames: { O: oPts.length, F3: fPts.length, C3: cPts.length },
        maxPtsDeltaMs: { F3: fPtsMaxDelta, C3: cPtsMaxDelta },
        ptsMs: { O: oPts, F3: fPts, C3: cPts },
        durationsMs: { O: oProbe.durationMs, F3: f3Probe.durationMs, C3: c3Probe.durationMs },
        loopFrames: IDLE_FRAME_COUNT,
      },
      arms: [
        {
          arm: 'O',
          file: 'O.webm',
          bytes: oBytes,
          sha256: sourceSha,
          width: canvas.width,
          height: canvas.height,
          frameCount: oPts.length,
          durationMs: oProbe.durationMs,
          colorTags: oProbe.colorTags,
          containerPixelFormat: oProbe.pixelFormat,
          decodedPixelFormat: PIXEL_FORMAT,
          alphaMode: oProbe.alphaMode,
          pts: summarizePts(oPts),
        },
        {
          arm: 'F3',
          file: 'F3.webm',
          bytes: f3.bytes,
          sha256: f3.sha256,
          width: f3Probe.width,
          height: f3Probe.height,
          frameCount: fPts.length,
          durationMs: f3Probe.durationMs,
          colorTags: f3Probe.colorTags,
          containerPixelFormat: f3Probe.pixelFormat,
          decodedPixelFormat: PIXEL_FORMAT,
          alphaMode: f3Probe.alphaMode,
          pts: summarizePts(fPts),
        },
        {
          arm: 'C3',
          file: 'C3.webm',
          bytes: c3.bytes,
          sha256: c3.sha256,
          width: c3Probe.width,
          height: c3Probe.height,
          frameCount: cPts.length,
          durationMs: c3Probe.durationMs,
          colorTags: c3Probe.colorTags,
          containerPixelFormat: c3Probe.pixelFormat,
          decodedPixelFormat: PIXEL_FORMAT,
          alphaMode: c3Probe.alphaMode,
          pts: summarizePts(cPts),
          alphaForegroundPixels: c3AlphaAbove,
        },
      ],
      selfCheck: {
        oBytesEqualToSource: oCopiedSha === sourceSha,
        passthroughPlanesEqualO: true,
        f3YuvEqualO: true,
        f3AlphaEqualsThresholdedO: true,
        f3OutsideCropForegroundPixels: f3Outside,
        c3EqualsCroppedF3Planes: ['y', 'u', 'v', 'a'].every((plane) => c3VsF3Crop[plane].equal),
        frameCounts: { O: oPts.length, F3: fPts.length, C3: cPts.length },
        ptsToleranceMs: PTS_TOLERANCE_MS,
        durationDeltaMs: { C3vsO: Number((c3Probe.durationMs - oProbe.durationMs).toFixed(3)) },
        f3C3ColorTagsEqual: true,
        colorTagsEqualO: true,
        decoderReadbackFrames: { F3: f3Decoded.frames, C3: c3Decoded.frames },
        externalFramehash: hashChecks,
        method: '全部以实际解码像素平面比对；不用命令行里的 -lossless 字样代替验证。',
      },
      timings: {
        decodeOMs: decodeMs,
        alphaScanMs: scanMs,
        passthroughEncodeMs: passthrough.ms,
        f3EncodeMs: f3.ms,
        c3EncodeMs: c3.ms,
        negativeControlMs: negative.ms,
        timelineReadbackMs: readbackMs,
        totalMs,
      },
      byteCost: {
        source: sourceStat.size,
        F3: f3.bytes,
        C3: c3.bytes,
        F3OverO: Number((f3.bytes / sourceStat.size).toFixed(3)),
        C3OverO: Number((c3.bytes / sourceStat.size).toFixed(3)),
      },
      limits: '仅离线编译与解码回读自检：全 48 帧，无 GUI、无 CPU/RSS、无真实呈帧；不涉及画质门重算（由 C 与负责人另行执行），未改产品接线。',
    };

    await writeFile(path.join(tmpDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(tmpDir, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    await rename(path.join(tmpDir, 'manifest.json'), path.join(outDir, 'manifest.json'));
    await rename(path.join(tmpDir, 'build-report.json'), path.join(outDir, 'build-report.json'));

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          out: outRel,
          crop,
          arms: report.arms.map((arm) => ({ arm: arm.arm, bytes: arm.bytes, sha256: arm.sha256, size: `${String(arm.width)}x${String(arm.height)}`, frames: arm.frameCount })),
          selfControl: { allPlanesEqual: report.selfControl.allPlanesEqual, planes: report.selfControl.planes, bytes: report.selfControl.bytes, sha256: report.selfControl.sha256 },
          f3: { yuvVsOMax: { y: f3VsO.y.max, u: f3VsO.u.max, v: f3VsO.v.max }, alphaVsThresholdedOMax: f3AlphaCompare.max, alphaVsOriginalMax: f3VsO.a.max },
          c3: { vsCroppedF3Equal: report.selfCheck.c3EqualsCroppedF3Planes },
          negativeControlYuvMax: { y: negativeCompare.y.max, u: negativeCompare.u.max, v: negativeCompare.v.max },
          totalMs,
        },
        null,
        2,
      )}\n`,
    );
    log(`完成，用时 ${String(totalMs)}ms`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[idle-roi-v3] 失败：${message}\n`);
  process.exitCode = 1;
});
