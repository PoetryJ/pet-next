/**
 * 读源、保留 alpha 裁剪编码、写三背景对照和报告。
 * 不覆盖成品 assets/。背景色字符串只进报告，不进判定函数。
 * 探针没跑成时直接 fail：判定函数分不清“没读到”和“源没有 alpha”。
 * @module pet-next/assets-pipeline/run-check
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { REQUIRED_BACKGROUNDS, type AssetProcessReport, type QualityEvidence, type QualityFrame, type SourceMediaProbe } from '../contracts/assets.ts';
import { assessed, failText, hashFile, noAlphaText, toolMessage, toProbe, unread, type FileHash } from './asset-report.ts';
import { compositePlate } from './compare-plate.ts';
import { filterDeletesNearBlack, preserveAlphaEncodeCommand } from './encode-alpha.ts';
import {
  CROP_PAD_PX,
  evenCrop,
  evenFrame,
  lostNearBlackAlpha,
  observeDarkForeground,
  summarizeFrames,
  type PixelRect,
  type RgbaFrame,
} from './frame-metrics.ts';
import { runMediaTool } from './media-tool.ts';
import { encodeRgbaPng } from './png-rgba.ts';
import { decodeRgba, ffprobeCommand, probeVideo, type VideoProbe } from './read-media.ts';

const ENCODE_TIMEOUT_MS = 120_000;
const SHIPPED = new Set(['assets/idle.webm', 'assets/reaction.webm', 'assets/placeholder.png']);

export interface AssetCheckInput {
  readonly petRoot: string;
  readonly sourceRelativePath: string;
  readonly outDir: string;
  /** 只写入报告。判定函数看不到它。 */
  readonly backgroundColorString: string | null;
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
}

interface Ready {
  readonly petRoot: string;
  readonly sourcePath: string;
  readonly sourceRelative: string;
  readonly outDir: string;
}

/** 检查一个源，并把 {@link AssetProcessReport} 写到 `outDir/report.json`。 */
export async function runAssetCheck(input: AssetCheckInput): Promise<AssetProcessReport> {
  const ready = resolveReady(input);
  if (!ready.ok) return ready.report;
  const ffmpeg = input.ffmpeg ?? 'ffmpeg';
  const ffprobe = input.ffprobe ?? 'ffprobe';
  const report = await inspect(ready.ready, ffmpeg, ffprobe, input.backgroundColorString);
  await mkdir(ready.ready.outDir, { recursive: true });
  await writeFile(path.join(ready.ready.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function inspect(ready: Ready, ffmpeg: string, ffprobe: string, backgroundColorString: string | null): Promise<AssetProcessReport> {
  const hashed = await hashFile(ready.sourcePath);
  if (!hashed) return unread(ready.sourceRelative, backgroundColorString, [], '找不到源文件。');
  const probeCommand = ffprobeCommand(ffprobe, ready.sourcePath);
  const opened = await openSource(ready, ffprobe, ffmpeg, hashed, probeCommand, backgroundColorString);
  if (opened.kind === 'report') return opened.report;
  return encodeAndCompare(ready, ffmpeg, ffprobe, opened, backgroundColorString);
}

interface OpenedSource {
  readonly kind: 'opened';
  readonly source: SourceMediaProbe;
  readonly video: VideoProbe;
  readonly frames: readonly RgbaFrame[];
  readonly crop: PixelRect;
  readonly frameIndex: number;
}

async function openSource(
  ready: Ready,
  ffprobe: string,
  ffmpeg: string,
  hashed: FileHash,
  probeCommand: readonly string[],
  backgroundColorString: string | null,
): Promise<OpenedSource | { kind: 'report'; report: AssetProcessReport }> {
  let video: VideoProbe;
  try {
    video = await probeVideo(ffprobe, ready.sourcePath);
  } catch (error) {
    return { kind: 'report', report: unread(ready.sourceRelative, backgroundColorString, probeCommand, toolMessage(error), hashed) };
  }
  let frames: RgbaFrame[] | null;
  try {
    frames = await decodeRgba(ffmpeg, ready.sourcePath, video, null);
  } catch (error) {
    return { kind: 'report', report: unread(ready.sourceRelative, backgroundColorString, probeCommand, toolMessage(error), hashed, video) };
  }
  if (!frames || frames.length === 0) {
    return { kind: 'report', report: unread(ready.sourceRelative, backgroundColorString, probeCommand, '解出的帧长度对不上，读不到 alpha。', hashed, video) };
  }
  const summary = summarizeFrames(frames);
  const source = toProbe(ready.sourceRelative, hashed, video, summary.usableAlpha);
  if (!summary.usableAlpha) {
    const evidence = { sourceHasAlpha: false, outputHasAlpha: null, frames: [] } as const;
    return { kind: 'report', report: assessed(source, probeCommand, null, evidence, backgroundColorString, noAlphaText(video, summary.maxAlpha)) };
  }
  const crop = summary.bounds ? evenCrop(summary.bounds, video.width, video.height, CROP_PAD_PX) : evenFrame(video.width, video.height);
  return { kind: 'opened', source, video, frames, crop, frameIndex: summary.frameIndex };
}

async function encodeAndCompare(
  ready: Ready,
  ffmpeg: string,
  ffprobe: string,
  opened: OpenedSource,
  backgroundColorString: string | null,
): Promise<AssetProcessReport> {
  const encodedPath = path.join(ready.outDir, 'encoded.webm');
  const encodeCommand = preserveAlphaEncodeCommand(ffmpeg, ready.sourcePath, encodedPath, opened.crop, opened.video.codec);
  const filter = encodeCommand[encodeCommand.indexOf('-vf') + 1] ?? '';
  if (filterDeletesNearBlack(filter) || SHIPPED.has(posixRelative(ready.petRoot, encodedPath))) {
    const evidence = { sourceHasAlpha: true, outputHasAlpha: null, frames: [] } as const;
    return assessed(opened.source, encodeCommand, null, evidence, backgroundColorString, '裁剪滤镜会删除近黑像素，或会覆盖成品，已拒绝执行。');
  }
  try {
    await mkdir(ready.outDir, { recursive: true });
    await runMediaTool(encodeCommand, ENCODE_TIMEOUT_MS);
  } catch (error) {
    const evidence = { sourceHasAlpha: true, outputHasAlpha: null, frames: [] } as const;
    return assessed(opened.source, encodeCommand, null, evidence, backgroundColorString, toolMessage(error));
  }
  return compareOutput(ready, ffmpeg, ffprobe, opened, encodeCommand, encodedPath, backgroundColorString);
}

async function compareOutput(
  ready: Ready,
  ffmpeg: string,
  ffprobe: string,
  opened: OpenedSource,
  encodeCommand: readonly string[],
  encodedPath: string,
  backgroundColorString: string | null,
): Promise<AssetProcessReport> {
  const loaded = await loadOutput(ffprobe, ffmpeg, encodedPath, opened.frameIndex);
  if (!loaded.ok) {
    const evidence = { sourceHasAlpha: true, outputHasAlpha: null, frames: [] } as const;
    return assessed(opened.source, encodeCommand, null, evidence, backgroundColorString, loaded.limitation);
  }
  const output = toProbe(posixRelative(ready.petRoot, encodedPath), loaded.hash, loaded.video, loaded.usable);
  if (!loaded.frame || !loaded.usable) {
    const evidence = { sourceHasAlpha: true, outputHasAlpha: false, frames: [] } as const;
    return assessed(opened.source, encodeCommand, output, evidence, backgroundColorString, '输出没有可用的 alpha 平面。');
  }
  const sourceFrame = opened.frames[opened.frameIndex];
  const deleted = sourceFrame ? lostNearBlackAlpha(sourceFrame, loaded.frame, opened.crop) : false;
  const visible = deleted ? false : observeDarkForeground(loaded.frame);
  const frames = await writePlates(ready, loaded.frame, opened.frameIndex, visible);
  const evidence: QualityEvidence = { sourceHasAlpha: true, outputHasAlpha: true, frames };
  return assessed(opened.source, encodeCommand, output, evidence, backgroundColorString, failText(deleted, visible));
}

async function loadOutput(
  ffprobe: string,
  ffmpeg: string,
  encodedPath: string,
  frameIndex: number,
): Promise<{ ok: true; video: VideoProbe; hash: FileHash; frame: RgbaFrame | null; usable: boolean } | { ok: false; limitation: string }> {
  try {
    const video = await probeVideo(ffprobe, encodedPath);
    const decoded = await decodeRgba(ffmpeg, encodedPath, video, frameIndex);
    const hash = await hashFile(encodedPath);
    if (!hash) return { ok: false, limitation: '编码结果写出来之后又读不到。' };
    const frame = decoded?.[0] ?? null;
    const usable = frame ? summarizeFrames([frame]).usableAlpha : false;
    return { ok: true, video, hash, frame, usable };
  } catch (error) {
    return { ok: false, limitation: toolMessage(error) };
  }
}

async function writePlates(ready: Ready, frame: RgbaFrame, frameIndex: number, visible: boolean | 'unobserved'): Promise<QualityFrame[]> {
  const framesDir = path.join(ready.outDir, 'frames');
  await mkdir(framesDir, { recursive: true });
  const written: QualityFrame[] = [];
  for (const background of REQUIRED_BACKGROUNDS) {
    const absolute = path.join(framesDir, `frame-${frameIndex}-${background}.png`);
    await writeFile(absolute, encodeRgbaPng(frame.width, frame.height, compositePlate(frame, background)));
    written.push({
      frameIndex,
      background,
      imagePath: posixRelative(ready.petRoot, absolute),
      darkForegroundVisible: visible,
    });
  }
  return written;
}

function resolveReady(input: AssetCheckInput): { ok: true; ready: Ready } | { ok: false; report: AssetProcessReport } {
  const sourcePath = resolveInside(input.petRoot, input.sourceRelativePath);
  const outDir = resolveOut(input.petRoot, input.outDir);
  const sourceRelative = sourcePath ? posixRelative(input.petRoot, sourcePath) : input.sourceRelativePath;
  if (!sourcePath || !outDir) {
    const evidence = { sourceHasAlpha: false, outputHasAlpha: null, frames: [] } as const;
    return {
      ok: false,
      report: {
        source: toProbe(sourceRelative, { sha256: '', byteLength: 0 }, undefined, false),
        command: [],
        output: null,
        verdict: 'fail',
        evidence,
        backgroundColorString: input.backgroundColorString,
        limitation: '源或输出目录超出 pet-next，或输出落在成品 assets/ 里。',
      },
    };
  }
  return { ok: true, ready: { petRoot: input.petRoot, sourcePath, sourceRelative, outDir } };
}

function resolveInside(root: string, relative: string): string | null {
  const absolute = path.resolve(root, relative);
  const back = path.relative(root, absolute);
  if (back.startsWith('..') || path.isAbsolute(back)) return null;
  return absolute;
}

function resolveOut(root: string, relative: string): string | null {
  const absolute = resolveInside(root, relative);
  if (!absolute) return null;
  const back = posixRelative(root, absolute);
  if (back === 'assets' || back.startsWith('assets/')) return null;
  return absolute;
}

function posixRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}
