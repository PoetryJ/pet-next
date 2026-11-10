#!/usr/bin/env node
/**
 * M3-12 离线素材编译器：可见待机裁边的三臂候选。
 *
 *   node experiments/idle-roi/compiler.mjs --out=experiments/idle-roi/out
 *
 * 产物（只写 `experiments/idle-roi/out/`）：
 *   O.webm 源字节拷贝（sha 必须等于源文件）
 *   F.webm alpha<=1 置零后全画布 640x360 重编码
 *   C.webm 与 F 同一预处理/编码/色彩/PTS，仅多 ROI 裁剪
 *   manifest.json 契约第 3 节字段（逐帧 PTS 来自解码回读）
 *   build-report.json 命令、字节、SHA、耗时、自检明细
 *
 * 任何自检失败都以非零退出并打印原因，不放宽阈值、不静默重试。
 */
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  ALPHA_THRESHOLD,
  GUARD_PX,
  accumulateAlphaBounds,
  boundsToRect,
  computeCrop,
  countAlphaAboveOutside,
  emptyBounds,
  rectArea,
} from './lib/crop.ts';
import { DEFAULT_CRF, DEFAULT_CPU_USED, DEFAULT_GOP, encodeTo, preprocessFilter } from './lib/encode.ts';
import { sha256File } from './lib/hash.ts';
import { IDLE_FRAME_COUNT, IDLE_SOURCE_PATH, buildManifest, summarizePts, validateManifest } from './lib/manifest.ts';
import { decodeRgbaFrames, encoderPixelFormats, ffmpegVersionLine, listFramePtsMs, probeStream, runCapture } from './lib/media.ts';

/** 契约第 3 节的参考裁框，仅用于报告差异，不参与计算。 */
const CONTRACT_CROP = { x: 208, y: 52, width: 226, height: 286 };
const PTS_TOLERANCE_MS = 1;

const petRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function log(message) {
  process.stderr.write(`[idle-roi] ${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    out: 'experiments/idle-roi/out',
    source: IDLE_SOURCE_PATH,
    crf: DEFAULT_CRF,
    cpuUsed: DEFAULT_CPU_USED,
    gop: DEFAULT_GOP,
    guard: GUARD_PX,
    pixelFormat: 'yuva420p',
    lossless: false,
    cFromF: false,
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
  };
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (match === null) fail(`无法识别的参数：${arg}`);
    const name = match[1];
    const raw = match[2];
    if (raw === undefined) fail(`参数 --${name} 需要取值`);
    if (name === 'out') options.out = raw;
    else if (name === 'source') options.source = raw;
    else if (name === 'crf') options.crf = Number(raw);
    else if (name === 'cpu-used') options.cpuUsed = Number(raw);
    else if (name === 'gop') options.gop = Number(raw);
    else if (name === 'guard') options.guard = Number(raw);
    else if (name === 'pix-fmt') options.pixelFormat = raw;
    else if (name === 'lossless') options.lossless = raw === '1' || raw === 'true';
    else if (name === 'c-from-f') options.cFromF = raw === '1' || raw === 'true';
    else if (name === 'ffmpeg') options.ffmpeg = raw;
    else if (name === 'ffprobe') options.ffprobe = raw;
    else fail(`未知参数：--${name}`);
  }
  if (!Number.isInteger(options.crf)) fail('crf 必须是整数');
  if (!Number.isInteger(options.cpuUsed)) fail('cpu-used 必须是整数');
  if (!Number.isInteger(options.gop)) fail('gop 必须是整数');
  if (!Number.isInteger(options.guard) || options.guard < 0) fail('guard 必须是非负整数');
  return options;
}

function resolvePaths(options) {
  // 只允许 experiments/idle-roi/out 或 out-*（v2 等并存版本），绝不写进 assets/ 或其他目录。
  const allowedRoot = path.join(petRoot, 'experiments', 'idle-roi');
  const outDir = path.resolve(petRoot, options.out);
  const relative = path.relative(allowedRoot, outDir);
  const segments = relative.split(path.sep);
  if (segments.length !== 1 || !segments[0].startsWith('out')) {
    fail(`输出目录必须是 experiments/idle-roi/out 或 out-*：${outDir}`);
  }
  const sourcePath = path.resolve(petRoot, options.source);
  if (sourcePath !== path.join(petRoot, IDLE_SOURCE_PATH)) {
    fail(`只支持源素材 ${IDLE_SOURCE_PATH}，收到 ${sourcePath}`);
  }
  return { outDir, sourcePath };
}

function assertNearPts(value, expected, label) {
  const diff = Number((value - expected).toFixed(3));
  if (Math.abs(diff) > PTS_TOLERANCE_MS) {
    fail(`${label}：${String(value)}ms 与期望 ${String(expected)}ms 差异超过 ${PTS_TOLERANCE_MS}ms`);
  }
}

function comparePts(reference, candidate, label) {
  if (candidate.length !== reference.length) {
    fail(`${label} 帧数 ${candidate.length} 与 O 的 ${reference.length} 不同`);
  }
  for (let index = 0; index < reference.length; index += 1) {
    assertNearPts(candidate[index], reference[index], `${label} 第 ${index} 帧 PTS`);
  }
}

async function decodeArmStats(bin, input, width, height, crop) {
  let frames = 0;
  let foreground = 0;
  let outside = 0;
  for await (const frame of decodeRgbaFrames(bin, input, width, height)) {
    frames += 1;
    foreground += accumulateAlphaBounds(emptyBounds(), frame, width, height).count;
    if (crop !== null) outside += countAlphaAboveOutside(frame, width, height, crop);
  }
  return { frames, foreground, outside };
}

async function toolVersion(bin) {
  const { stdout } = await runCapture(bin, ['-hide_banner', '-version']);
  return stdout.split('\n')[0]?.trim() ?? '';
}

/** 读上一版（v1）的报告，供 manifest 记录「v1→v2」两次字节；缺文件就返回 null，不猜。 */
async function readPreviousBuild() {
  try {
    const parsed = JSON.parse(await readFile(path.join(petRoot, 'experiments', 'idle-roi', 'out', 'build-report.json'), 'utf8'));
    const pick = (arm) => {
      const found = (parsed.arms ?? []).find((item) => item.arm === arm);
      if (found === undefined) return null;
      return { file: found.file, bytes: found.bytes, sha256: found.sha256, width: found.width, height: found.height };
    };
    return { source: 'experiments/idle-roi/out', encode: parsed.encode?.params ?? null, F: pick('F'), C: pick('C') };
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { outDir, sourcePath } = resolvePaths(options);
  const outRel = path.relative(petRoot, outDir).split(path.sep).join('/');
  const generatedBy = `node experiments/idle-roi/compiler.mjs --out=${outRel}`;
  const started = performance.now();

  const ffmpegVersion = await ffmpegVersionLine(options.ffmpeg);
  const ffprobeVersion = await toolVersion(options.ffprobe);
  const sourceSha = await sha256File(sourcePath);
  const sourceStat = await stat(sourcePath);
  const probe = await probeStream(options.ffprobe, sourcePath);
  const canvas = { width: probe.width, height: probe.height };
  log(`源 ${IDLE_SOURCE_PATH} ${canvas.width}x${canvas.height} sha=${sourceSha.slice(0, 12)} frames(target)=${IDLE_FRAME_COUNT}`);
  log(`${ffmpegVersion}`);

  // 编码器真正接受的像素格式：请求 444 时这台 libvpx-vp9 会静默退回 420，必须先探测再决定。
  const supportedFormats = await encoderPixelFormats(options.ffmpeg, 'libvpx-vp9');
  const requestedPixelFormat = options.pixelFormat;
  const pixelFormatFallback =
    supportedFormats.length === 0 || supportedFormats.includes(requestedPixelFormat)
      ? null
      : {
          requested: requestedPixelFormat,
          actual: 'yuva420p',
          reason: `libvpx-vp9 支持列表不含 ${requestedPixelFormat}（仅有 ${supportedFormats.filter((f) => f.includes('a')).join(' ') || 'yuva420p'} 带 alpha），ffmpeg 会静默退回 yuva420p`,
        };
  const pixelFormat = pixelFormatFallback === null ? requestedPixelFormat : 'yuva420p';
  log(`像素格式：请求 ${requestedPixelFormat} → 实际 ${pixelFormat}${pixelFormatFallback === null ? '' : '（不支持，已退回 420）'}`);
  if (options.lossless) log('编码模式：-lossless 1（VP9 无损）');

  // 1) 全片扫描 alpha>1 并集（显式 libvpx-vp9 解码到 rgba，逐帧读完）
  const scanStart = performance.now();
  let bounds = emptyBounds();
  let scannedFrames = 0;
  for await (const frame of decodeRgbaFrames(options.ffmpeg, sourcePath, canvas.width, canvas.height)) {
    scannedFrames += 1;
    bounds = accumulateAlphaBounds(bounds, frame, canvas.width, canvas.height);
  }
  if (scannedFrames !== IDLE_FRAME_COUNT) {
    fail(`全片解码到 ${scannedFrames} 帧，与契约 ${IDLE_FRAME_COUNT} 帧不符（拒绝采样/截断输入）`);
  }
  const unionRect = boundsToRect(bounds);
  if (unionRect === null) fail('全片没有 alpha>1 像素，无法裁框');
  const crop = computeCrop(bounds, canvas, options.guard);
  if (crop === null) fail('裁框计算失败');
  const scanMs = Math.round(performance.now() - scanStart);
  log(
    `扫描 ${scannedFrames} 帧：并集 ${unionRect.x},${unionRect.y} ${unionRect.width}x${unionRect.height} → guard ${options.guard} → 偶数对齐 ${crop.x},${crop.y} ${crop.width}x${crop.height}`,
  );

  // 2) 回读源片核对「ROI 外 alpha>1 = 0」，并统计裁框内前景像素
  const verifyStart = performance.now();
  let oFrames = 0;
  let oForeground = 0;
  let outsideForeground = 0;
  let oInsideForeground = 0;
  for await (const frame of decodeRgbaFrames(options.ffmpeg, sourcePath, canvas.width, canvas.height)) {
    oFrames += 1;
    const frameBounds = accumulateAlphaBounds(emptyBounds(), frame, canvas.width, canvas.height);
    const outside = countAlphaAboveOutside(frame, canvas.width, canvas.height, crop);
    oForeground += frameBounds.count;
    outsideForeground += outside;
    oInsideForeground += frameBounds.count - outside;
  }
  if (oFrames !== scannedFrames) fail(`源片两次解码帧数不一致：${scannedFrames} 与 ${oFrames}`);
  if (outsideForeground !== 0) {
    fail(`裁框外仍有 ${outsideForeground} 个 alpha>${ALPHA_THRESHOLD} 像素（ROI 必须为 0）`);
  }
  const verifyMs = Math.round(performance.now() - verifyStart);

  // 3) 只在 out/ 下写，先落临时目录，自检全通过才改名
  await mkdir(outDir, { recursive: true });
  for (const entry of await readdir(outDir)) {
    if (entry.startsWith('.tmp-')) await rm(path.join(outDir, entry), { recursive: true, force: true });
  }
  const tmpDir = path.join(outDir, `.tmp-${process.pid}`);
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  try {
    const oTmp = path.join(tmpDir, 'O.webm');
    const fTmp = path.join(tmpDir, 'F.webm');
    const cTmp = path.join(tmpDir, 'C.webm');
    await copyFile(sourcePath, oTmp);
    const oCopiedSha = await sha256File(oTmp);
    if (oCopiedSha !== sourceSha) fail('O.webm 拷贝后 sha 与源不一致');

    const executed = { F: null, C: null };
    const encoderFor = (arm) => async (bin, args) => {
      executed[arm] = [bin, ...args];
      await runCapture(bin, args);
    };

    const encodeStart = performance.now();
    log(`编码 F（全画布 ${canvas.width}x${canvas.height}）…`);
    const fStart = performance.now();
    const sharedEncode = {
      crf: options.crf,
      cpuUsed: options.cpuUsed,
      gop: options.gop,
      pixelFormat,
      lossless: options.lossless,
    };
    await encodeTo(
      options.ffmpeg,
      { ...sharedEncode, input: sourcePath, output: fTmp, crop: null },
      encoderFor('F'),
    );
    const fMs = Math.round(performance.now() - fStart);
    log(`编码 C（ROI ${crop.width}x${crop.height}${options.cFromF ? '，从 F 的编码域裁剪' : ''}）…`);
    const cStart = performance.now();
    await encodeTo(
      options.ffmpeg,
      {
        ...sharedEncode,
        // 编码域裁剪：C 从 F 的无损字节裁剪而来，色度平面与 F 同源；F 已经做过阈值置零，不再重复 lut。
        input: options.cFromF ? fTmp : sourcePath,
        output: cTmp,
        crop,
        alphaZero: options.cFromF ? false : true,
      },
      encoderFor('C'),
    );
    const cMs = Math.round(performance.now() - cStart);
    const encodeMs = Math.round(performance.now() - encodeStart);
    log(`编码完成 F=${fMs}ms C=${cMs}ms`);

    // 4) 解码回读：帧数、逐帧 PTS、时长、alpha
    const readbackStart = performance.now();
    const [oPts, fPts, cPts] = await Promise.all([
      listFramePtsMs(options.ffprobe, sourcePath),
      listFramePtsMs(options.ffprobe, fTmp),
      listFramePtsMs(options.ffprobe, cTmp),
    ]);
    const [fProbe, cProbe] = await Promise.all([
      probeStream(options.ffprobe, fTmp),
      probeStream(options.ffprobe, cTmp),
    ]);

    if (oPts.length !== IDLE_FRAME_COUNT) fail(`O 帧数 ${oPts.length} 与契约 ${IDLE_FRAME_COUNT} 不符`);
    if (cPts.length !== IDLE_FRAME_COUNT) fail(`C 帧数 ${cPts.length}，期望 ${IDLE_FRAME_COUNT}`);
    if (fPts.length !== IDLE_FRAME_COUNT) fail(`F 帧数 ${fPts.length}，期望 ${IDLE_FRAME_COUNT}`);
    comparePts(oPts, cPts, 'C');
    comparePts(oPts, fPts, 'F');
    if (fProbe.durationMs !== cProbe.durationMs) {
      fail(`F/C 封装时长不同：${fProbe.durationMs} 与 ${cProbe.durationMs}`);
    }
    if (Math.abs(cProbe.durationMs - probe.durationMs) > PTS_TOLERANCE_MS) {
      fail(`C 时长 ${cProbe.durationMs}ms 与 O 的 ${probe.durationMs}ms 差异超过 ${PTS_TOLERANCE_MS}ms`);
    }
    if (fProbe.width !== canvas.width || fProbe.height !== canvas.height) {
      fail(`F 尺寸 ${fProbe.width}x${fProbe.height} 不等于原画布`);
    }
    if (cProbe.width !== crop.width || cProbe.height !== crop.height) {
      fail(`C 尺寸 ${cProbe.width}x${cProbe.height} 不等于裁框 ${crop.width}x${crop.height}`);
    }
    // VP9 的 alpha 在 BlockAdditional 里，容器仍上报 yuv420p；带 alpha 的证据是 alpha_mode=1 + 解码后 alpha>1 像素。
    if (cProbe.alphaMode !== '1') fail(`C 缺少 alpha_mode=1 标记（实测 ${String(cProbe.alphaMode)}）`);
    if (fProbe.alphaMode !== '1') fail(`F 缺少 alpha_mode=1 标记（实测 ${String(fProbe.alphaMode)}）`);
    for (const key of ['primaries', 'transfer', 'matrix', 'range']) {
      if (fProbe.colorTags[key] !== cProbe.colorTags[key]) {
        fail(`F/C 色彩标签 ${key} 不一致：${fProbe.colorTags[key]} 与 ${cProbe.colorTags[key]}`);
      }
    }

    const [cStats, fStats] = await Promise.all([
      decodeArmStats(options.ffmpeg, cTmp, cProbe.width, cProbe.height, null),
      decodeArmStats(options.ffmpeg, fTmp, fProbe.width, fProbe.height, crop),
    ]);
    if (cStats.frames !== IDLE_FRAME_COUNT) fail(`C 解码回读 ${cStats.frames} 帧，期望 ${IDLE_FRAME_COUNT}`);
    if (fStats.frames !== IDLE_FRAME_COUNT) fail(`F 解码回读 ${fStats.frames} 帧，期望 ${IDLE_FRAME_COUNT}`);
    if (cStats.foreground <= 0) fail('C 解码后没有任何 alpha>1 前景像素');
    if (fStats.outside !== 0) fail(`F 在裁框外仍有 ${fStats.outside} 个 alpha>1 像素（预处理未生效）`);
    const readbackMs = Math.round(performance.now() - readbackStart);

    // 5) manifest + 报告，最后改名
    const cSha = await sha256File(cTmp);
    const fSha = await sha256File(fTmp);
    const fTmpBytes = (await stat(fTmp)).size;
    const cTmpBytes = (await stat(cTmp)).size;
    const builtAt = new Date().toISOString();
    const v1 = await readPreviousBuild();
    const revision = {
      version: 'v2',
      previous: 'v1',
      motivation:
        'v1(4:2:0 + crf 12) 的 F–C 差 max 8、O–C 前景 MAE 1.30 未过画质门；v2 用 -lossless 1 去掉量化误差，用来证明「裁边本身零误差、门槛被编码往返吃掉」。',
      request: {
        pixelFormat: requestedPixelFormat,
        lossless: options.lossless,
        cFromF: options.cFromF,
        appliedPixelFormat: pixelFormat,
        fallback: pixelFormatFallback,
      },
      v1,
      v2: {
        F: { file: 'F.webm', bytes: fTmpBytes, sha256: fSha },
        C: { file: 'C.webm', bytes: cTmpBytes, sha256: cSha },
      },
    };
    const manifest = buildManifest({
      sourceSha256: sourceSha,
      candidateSha256: cSha,
      originalCanvas: canvas,
      crop,
      pixelFormat,
      revision,
      colorTags: cProbe.colorTags,
      frameCount: oPts.length,
      pts: summarizePts(oPts),
      durationMs: probe.durationMs,
      ffmpeg: ffmpegVersion,
      builtAt,
      generatedBy,
    });
    const validation = validateManifest(manifest);
    if (!validation.ok) fail(`manifest 自校验失败：${validation.errors.join('; ')}`);

    await rename(oTmp, path.join(outDir, 'O.webm'));
    await rename(fTmp, path.join(outDir, 'F.webm'));
    await rename(cTmp, path.join(outDir, 'C.webm'));

    const fBytes = (await stat(path.join(outDir, 'F.webm'))).size;
    const cBytes = (await stat(path.join(outDir, 'C.webm'))).size;
    const totalMs = Math.round(performance.now() - started);
    const cropMatchesContract =
      crop.x === CONTRACT_CROP.x &&
      crop.y === CONTRACT_CROP.y &&
      crop.width === CONTRACT_CROP.width &&
      crop.height === CONTRACT_CROP.height;

    const report = {
      schemaVersion: 1,
      kind: 'idle-roi-build-report',
      builtAt,
      node: process.version,
      ffmpeg: ffmpegVersion,
      ffprobe: ffprobeVersion,
      host: { cpus: os.cpus().length, loadavg: os.loadavg(), platform: os.platform(), arch: os.arch() },
      source: { path: IDLE_SOURCE_PATH, bytes: sourceStat.size, sha256: sourceSha, ...probe },
      alphaScan: {
        threshold: ALPHA_THRESHOLD,
        frames: scannedFrames,
        union: unionRect,
        guard: options.guard,
        crop,
        cropArea: rectArea(crop),
        canvasArea: canvas.width * canvas.height,
        retainedRatio: Number((rectArea(crop) / (canvas.width * canvas.height)).toFixed(6)),
        foregroundPixelsTotal: oForeground,
        insideCropForegroundPixels: oInsideForeground,
        outsideCropForegroundPixels: outsideForeground,
        contractCrop: CONTRACT_CROP,
        matchesContract: cropMatchesContract,
      },
      revision,
      encode: {
        params: {
          decoder: 'libvpx-vp9',
          encoder: 'libvpx-vp9',
          pixelFormat,
          pixelFormatRequested: requestedPixelFormat,
          pixelFormatFallback,
          encoderSupportedPixelFormats: supportedFormats,
          lossless: options.lossless,
          cFromF: options.cFromF,
          crf: options.lossless ? null : options.crf,
          cpuUsed: options.cpuUsed,
          gop: options.gop,
          deadline: 'good',
          rowMt: 1,
          autoAltRef: 0,
          fpsMode: 'passthrough',
          bitrate: 'vbr (b:v 0, constant quality)',
          muxFlags: '+bitexact（仅去掉随机 SegmentUID/DateUTC，不改编码质量，使复跑 sha 可复现）',
          colorTags: { range: 'tv', matrix: 'bt709', primaries: 'bt709', transfer: 'bt709' },
        },
        filters: {
          F: preprocessFilter(null, { pixelFormat }),
          C: preprocessFilter(crop, { pixelFormat, alphaZero: options.cFromF ? false : true }),
        },
        note: '两臂参数逐字相同，仅 -vf 多一段 crop、输出分辨率不同；输出先写 *.partial，自检通过后原子改名。',
        commands: { F: executed.F, C: executed.C },
        durationsMs: { F: fMs, C: cMs, total: encodeMs },
      },
      arms: [
        { arm: 'O', file: 'O.webm', bytes: sourceStat.size, sha256: sourceSha, width: canvas.width, height: canvas.height, frameCount: oPts.length, durationMs: probe.durationMs, colorTags: probe.colorTags, containerPixelFormat: probe.pixelFormat, alphaMode: probe.alphaMode, pts: summarizePts(oPts) },
        { arm: 'F', file: 'F.webm', bytes: fBytes, sha256: fSha, width: fProbe.width, height: fProbe.height, frameCount: fPts.length, durationMs: fProbe.durationMs, colorTags: fProbe.colorTags, containerPixelFormat: fProbe.pixelFormat, alphaMode: fProbe.alphaMode, pts: summarizePts(fPts) },
        { arm: 'C', file: 'C.webm', bytes: cBytes, sha256: cSha, width: cProbe.width, height: cProbe.height, frameCount: cPts.length, durationMs: cProbe.durationMs, colorTags: cProbe.colorTags, containerPixelFormat: cProbe.pixelFormat, alphaMode: cProbe.alphaMode, pts: summarizePts(cPts), alphaForegroundPixels: cStats.foreground },
      ],
      selfCheck: {
        oBytesEqualToSource: true,
        cropMatchesContract,
        outsideCropForegroundPixels: outsideForeground,
        frameCounts: { O: oPts.length, F: fPts.length, C: cPts.length },
        ptsToleranceMs: PTS_TOLERANCE_MS,
        durationDeltaMs: Number((cProbe.durationMs - probe.durationMs).toFixed(3)),
        fCColorTagsEqual: true,
        decoderReadback: { F: fStats.frames, C: cStats.frames },
      },
      timings: { scanMs, verifyMs, encodeMs, readbackMs, totalMs },
    };

    await writeFile(path.join(tmpDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(tmpDir, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    await rename(path.join(tmpDir, 'manifest.json'), path.join(outDir, 'manifest.json'));
    await rename(path.join(tmpDir, 'build-report.json'), path.join(outDir, 'build-report.json'));

    if (!cropMatchesContract) {
      log(`注意：实测裁框 ${crop.x},${crop.y} ${crop.width}x${crop.height} 与契约参考 ${CONTRACT_CROP.x},${CONTRACT_CROP.y} ${CONTRACT_CROP.width}x${CONTRACT_CROP.height} 不同`);
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          out: outRel,
          crop,
          cropMatchesContract,
          arms: report.arms.map((arm) => ({ arm: arm.arm, bytes: arm.bytes, sha256: arm.sha256, size: `${arm.width}x${arm.height}`, frames: arm.frameCount, durationMs: arm.durationMs })),
          pts: report.arms[0].pts,
          encodeMs: { F: fMs, C: cMs },
          totalMs,
        },
        null,
        2,
      )}\n`,
    );
    log(`完成，用时 ${totalMs}ms`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[idle-roi] 失败：${message}\n`);
  process.exitCode = 1;
});
