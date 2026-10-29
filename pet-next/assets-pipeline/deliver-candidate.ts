/**
 * 把带可用 alpha 的 reaction 源按字节写到候选路径，并出三背景对照。
 * 不覆盖三份成品，命令里也不接受色键或近黑删除。
 * 源没有可用 alpha 时停住，不在这里改成位移待机。
 * @module pet-next/assets-pipeline/deliver-candidate
 */
import { copyFile, mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AssetCandidateManifest, AssetCandidatePlate } from '../contracts/asset-candidate.ts';
import { REQUIRED_BACKGROUNDS, type QualityEvidence, type QualityFrame } from '../contracts/assets.ts';
import { assessQuality } from './assess-quality.ts';
import { hashFile, noAlphaText, toolMessage, type FileHash } from './asset-report.ts';
import { compositePlate } from './compare-plate.ts';
import { filterDeletesNearBlack } from './encode-alpha.ts';
import { observeDarkForeground, summarizeFrames, type RgbaFrame } from './frame-metrics.ts';
import { encodeRgbaPng } from './png-rgba.ts';
import { decodeRgba, probeVideo, type VideoProbe } from './read-media.ts';

/** 仓库根上的母版。运行时只比较哈希，播放不读这个路径。 */
export const ORIGINAL_REACTION_REPO_PATH = 'dsh-pet/assets/webm/点击回应-元气挥手.webm';

export const CANDIDATE_SOURCE = 'assets/candidates/reaction/source.webm';
export const CANDIDATE_OUTPUT = 'assets/candidates/reaction/reaction.webm';
export const CANDIDATE_PLATES = 'assets/candidates/reaction/plates';
export const CANDIDATE_MANIFEST = 'assets/candidates/reaction/manifest.json';
export const CANDIDATE_PROVENANCE = 'assets/candidates/reaction/provenance.json';
export const SHIPPED_REACTION = 'assets/reaction.webm';
export const SHIPPED_PLATES = 'assets/candidates/reaction/shipped-plates';

/** 24fps 下约 2.58 秒（挥手开始）和 3.5 秒（双手张开）。 */
export const PLATE_FRAMES = [62, 84] as const;

/** 成品回应只有约 2 秒。0 是裁切起点，12 是 0.5 秒。 */
export const SHIPPED_PLATE_FRAMES = [0, 12] as const;

export const CANDIDATE_NOTE =
  '候选是母版「点击回应-元气挥手」的字节副本，alpha 来自母版，没有色键，也没有删除近黑。它不是对 assets/reaction.webm 的修复。默认产品路径仍是锁定的 assets/reaction.webm；换上候选要另经 preview 与文档，本分支不改接线。';

const LOCKED = new Set(['assets/idle.webm', 'assets/reaction.webm', 'assets/placeholder.png']);

export interface PlateFrameRecord {
  readonly frameIndex: number;
  readonly darkForegroundVisible: true;
}

export interface ComparisonFrame {
  readonly frameIndex: number;
  readonly maxAlpha: number;
  readonly usableAlpha: boolean;
  readonly darkForegroundVisible: boolean | 'unobserved';
  readonly plates: readonly AssetCandidatePlate[];
}

export interface CandidateProvenance {
  readonly originalRepoPath: string;
  readonly sourceSha256: string;
  readonly outputSha256: string;
  readonly sourceMatchesOriginalBytes: true;
  readonly webmStep: 'byte-copy';
  readonly encodeFilter: null;
  readonly bannedFiltersUsed: false;
  readonly defaultProductPath: 'assets/reaction.webm';
  readonly defaultReplaced: false;
  readonly note: string;
  readonly plateFrames: readonly PlateFrameRecord[];
  readonly verdict: 'pass';
  readonly shipped: {
    readonly path: string;
    readonly sha256: string;
    readonly frames: readonly ComparisonFrame[];
  };
}

export interface DeliverCandidateInput {
  readonly petRoot: string;
  readonly sourceRelativePath: string;
  readonly outputRelativePath: string;
  readonly platesDirRelative: string;
  readonly plateFrameIndexes: readonly number[];
  readonly command: readonly string[];
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
}

export type DeliverCandidateResult =
  | { ok: true; manifest: AssetCandidateManifest; plateFrames: readonly PlateFrameRecord[] }
  | { ok: false; limitation: string };

/** 复现整份候选（含对照图）的命令。在 `pet-next` 下执行。缺省参数就是交付路径。 */
export function candidateCommand(paths: {
  readonly source?: string;
  readonly output?: string;
  readonly plates?: string;
  readonly compare?: string;
  readonly compareOut?: string;
} = {}): readonly string[] {
  return [
    'node',
    '--experimental-strip-types',
    'assets-pipeline/candidate-cli.ts',
    '--source',
    paths.source ?? CANDIDATE_SOURCE,
    '--output',
    paths.output ?? CANDIDATE_OUTPUT,
    '--plates',
    paths.plates ?? CANDIDATE_PLATES,
    '--compare',
    paths.compare ?? SHIPPED_REACTION,
    '--compare-out',
    paths.compareOut ?? SHIPPED_PLATES,
  ];
}

/** 不带覆盖参数时的交付命令。 */
export function reproductionCommand(): readonly string[] {
  return candidateCommand();
}

/** 成品三件套的相对路径。候选不能用这些路径当输出。 */
export function isLockedAsset(relativePath: string): boolean {
  return LOCKED.has(normalizeRelative(relativePath));
}

/**
 * 路径不合法时返回原因。
 *
 * 输出必须离开源文件，并且只能落在候选目录或流水线目录。
 */
export function candidatePathError(
  petRoot: string,
  sourceRelative: string,
  outputRelative: string,
  platesRelative: string,
): string | null {
  const source = resolveInside(petRoot, sourceRelative);
  const output = resolveInside(petRoot, outputRelative);
  const plates = resolveInside(petRoot, platesRelative);
  if (!source || !output || !plates) return '源、候选或对照目录超出 pet-next。';
  const outputRel = posixRelative(petRoot, output);
  const platesRel = posixRelative(petRoot, plates);
  const sourceRel = posixRelative(petRoot, source);
  if (isLockedAsset(outputRel) || isLockedAsset(platesRel)) return '候选输出不能覆盖已锁定的成品。';
  if (outputRel === sourceRel) return '候选输出必须和源分开，避免把源本身当成已处理结果。';
  if (!isDeliverable(outputRel) || !isDeliverable(platesRel)) return '候选只能写到 assets/candidates/ 或 assets-pipeline/。';
  return null;
}

/** 校验源、按字节复制，并写出候选对照。失败时不留下候选文件。 */
export async function deliverReactionCandidate(input: DeliverCandidateInput): Promise<DeliverCandidateResult> {
  const pathError = candidatePathError(input.petRoot, input.sourceRelativePath, input.outputRelativePath, input.platesDirRelative);
  if (pathError) return { ok: false, limitation: pathError };
  if (input.plateFrameIndexes.length === 0) return { ok: false, limitation: '至少要指定一张对照帧。' };
  if (input.command.some((part) => filterDeletesNearBlack(part))) {
    return { ok: false, limitation: '生成命令里有色键或近黑删除，已拒绝执行。' };
  }
  const sourcePath = resolveInside(input.petRoot, input.sourceRelativePath);
  const outputPath = resolveInside(input.petRoot, input.outputRelativePath);
  const platesDir = resolveInside(input.petRoot, input.platesDirRelative);
  if (!sourcePath || !outputPath || !platesDir) return { ok: false, limitation: '源、候选或对照目录超出 pet-next。' };

  const hashed = await hashFile(sourcePath);
  if (!hashed) return { ok: false, limitation: '找不到源文件。' };
  const ffmpeg = input.ffmpeg ?? 'ffmpeg';
  const ffprobe = input.ffprobe ?? 'ffprobe';
  const opened = await openPlateFrames(ffprobe, ffmpeg, sourcePath, input.plateFrameIndexes);
  if (!opened.ok) return opened;

  const sourceRel = posixRelative(input.petRoot, sourcePath);
  const outputRel = posixRelative(input.petRoot, outputPath);
  const plates = plateList(input.petRoot, platesDir, opened.frames);
  const evidence: QualityEvidence = {
    sourceHasAlpha: true,
    outputHasAlpha: true,
    frames: evidenceFrames(plates),
  };
  if (assessQuality(evidence) !== 'pass') {
    return { ok: false, limitation: '对照帧没有同时保住 alpha 和深色前景，已停止，不会改用删除近黑。' };
  }

  const copied = await copyBytes(sourcePath, outputPath);
  if (!copied.ok) return copied;
  if (copied.hash.sha256 !== hashed.sha256 || copied.hash.byteLength !== hashed.byteLength) {
    await unlink(outputPath).catch(() => undefined);
    return { ok: false, limitation: '复制后的候选哈希和源不一致，已删掉候选文件。' };
  }
  const written = await writePlateFiles(platesDir, plates);
  if (!written.ok) return written;

  const manifest: AssetCandidateManifest = {
    role: 'reaction',
    kind: 'alpha-source',
    sourcePath: sourceRel,
    sourceSha256: hashed.sha256,
    outputPath: outputRel,
    outputSha256: copied.hash.sha256,
    plates: plates.map((plate) => ({ background: plate.background, imagePath: plate.imagePath })),
    command: input.command,
    limitation: null,
  };
  return { ok: true, manifest, plateFrames: opened.frames.map((frame) => ({ frameIndex: frame.frameIndex, darkForegroundVisible: true })) };
}

export interface ComparisonInput {
  readonly petRoot: string;
  readonly sourceRelativePath: string;
  readonly platesDirRelative: string;
  readonly frameIndexes: readonly number[];
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
}

export type ComparisonResult = { ok: true; sha256: string; frames: readonly ComparisonFrame[] } | { ok: false; limitation: string };

/** 只读地给一份已有视频写对照。不复制、不编码、不改源文件。 */
export async function writeComparisonPlates(input: ComparisonInput): Promise<ComparisonResult> {
  const sourcePath = resolveInside(input.petRoot, input.sourceRelativePath);
  const platesDir = resolveInside(input.petRoot, input.platesDirRelative);
  if (!sourcePath || !platesDir) return { ok: false, limitation: '对照源或目录超出 pet-next。' };
  const platesRel = posixRelative(input.petRoot, platesDir);
  if (isLockedAsset(platesRel) || !isDeliverable(platesRel)) {
    return { ok: false, limitation: '对照图只能写到 assets/candidates/ 或 assets-pipeline/，不能覆盖成品。' };
  }
  const hashed = await hashFile(sourcePath);
  if (!hashed) return { ok: false, limitation: '找不到要对照的成品文件。' };
  const ffmpeg = input.ffmpeg ?? 'ffmpeg';
  const ffprobe = input.ffprobe ?? 'ffprobe';
  let video: VideoProbe;
  try {
    video = await probeVideo(ffprobe, sourcePath);
  } catch (error) {
    return { ok: false, limitation: toolMessage(error) };
  }
  const frames: ComparisonFrame[] = [];
  for (const frameIndex of input.frameIndexes) {
    const decoded = await decodeOne(ffmpeg, sourcePath, video, frameIndex);
    if (!decoded.ok) return decoded;
    const summary = summarizeFrames([decoded.frame]);
    const visible = observeDarkForeground(decoded.frame);
    const plates = plateList(input.petRoot, platesDir, [{ frameIndex, frame: decoded.frame }]);
    const written = await writePlateFiles(platesDir, plates);
    if (!written.ok) return written;
    frames.push({
      frameIndex,
      maxAlpha: summary.maxAlpha,
      usableAlpha: summary.usableAlpha,
      darkForegroundVisible: visible,
      plates: plates.map((plate) => ({ background: plate.background, imagePath: plate.imagePath })),
    });
  }
  return { ok: true, sha256: hashed.sha256, frames };
}

/** 把交付结果和成品对照收成一份可追溯记录。 */
export function buildProvenance(
  manifest: AssetCandidateManifest,
  plateFrames: readonly PlateFrameRecord[],
  originalSha256: string,
  shipped: CandidateProvenance['shipped'],
): CandidateProvenance | { ok: false; limitation: string } {
  if (manifest.sourceSha256 !== originalSha256 || manifest.outputSha256 !== originalSha256) {
    return { ok: false, limitation: '候选哈希和仓库母版不一致。' };
  }
  return {
    originalRepoPath: ORIGINAL_REACTION_REPO_PATH,
    sourceSha256: manifest.sourceSha256,
    outputSha256: manifest.outputSha256,
    sourceMatchesOriginalBytes: true,
    webmStep: 'byte-copy',
    encodeFilter: null,
    bannedFiltersUsed: false,
    defaultProductPath: 'assets/reaction.webm',
    defaultReplaced: false,
    note: CANDIDATE_NOTE,
    plateFrames,
    verdict: 'pass',
    shipped,
  };
}

interface DecodedPlate {
  readonly frameIndex: number;
  readonly frame: RgbaFrame;
}

interface PlannedPlate extends AssetCandidatePlate {
  readonly frameIndex: number;
  readonly png: Buffer;
}

async function openPlateFrames(
  ffprobe: string,
  ffmpeg: string,
  sourcePath: string,
  frameIndexes: readonly number[],
): Promise<{ ok: true; frames: readonly DecodedPlate[] } | { ok: false; limitation: string }> {
  let video: VideoProbe;
  try {
    video = await probeVideo(ffprobe, sourcePath);
  } catch (error) {
    return { ok: false, limitation: toolMessage(error) };
  }
  const frames: DecodedPlate[] = [];
  for (const frameIndex of frameIndexes) {
    const decoded = await decodeOne(ffmpeg, sourcePath, video, frameIndex);
    if (!decoded.ok) return decoded;
    frames.push({ frameIndex, frame: decoded.frame });
  }
  const summary = summarizeFrames(frames.map((item) => item.frame));
  if (!summary.usableAlpha) {
    return { ok: false, limitation: noAlphaText(video, summary.maxAlpha) };
  }
  for (const item of frames) {
    if (observeDarkForeground(item.frame) !== true) {
      return { ok: false, limitation: `第 ${item.frameIndex} 帧的深色前景不可见。已停止，不会用删除近黑来补。` };
    }
  }
  return { ok: true, frames };
}

async function decodeOne(
  ffmpeg: string,
  file: string,
  video: VideoProbe,
  frameIndex: number,
): Promise<{ ok: true; frame: RgbaFrame } | { ok: false; limitation: string }> {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) return { ok: false, limitation: `帧号 ${frameIndex} 不合法。` };
  try {
    const decoded = await decodeRgba(ffmpeg, file, video, frameIndex);
    const frame = decoded?.[0];
    if (!frame) return { ok: false, limitation: `解不出第 ${frameIndex} 帧。` };
    return { ok: true, frame };
  } catch (error) {
    return { ok: false, limitation: toolMessage(error) };
  }
}

function plateList(petRoot: string, platesDir: string, frames: readonly DecodedPlate[]): PlannedPlate[] {
  const planned: PlannedPlate[] = [];
  for (const item of frames) {
    for (const background of REQUIRED_BACKGROUNDS) {
      const filename = `frame-${item.frameIndex}-${background}.png`;
      planned.push({
        frameIndex: item.frameIndex,
        background,
        imagePath: posixRelative(petRoot, path.join(platesDir, filename)),
        png: encodeRgbaPng(item.frame.width, item.frame.height, compositePlate(item.frame, background)),
      });
    }
  }
  return planned;
}

function evidenceFrames(plates: readonly PlannedPlate[]): QualityFrame[] {
  return plates.map((plate) => ({
    frameIndex: plate.frameIndex,
    background: plate.background,
    imagePath: plate.imagePath,
    darkForegroundVisible: true,
  }));
}

async function writePlateFiles(
  platesDir: string,
  plates: readonly PlannedPlate[],
): Promise<{ ok: true } | { ok: false; limitation: string }> {
  await mkdir(platesDir, { recursive: true });
  for (const plate of plates) {
    const absolute = path.resolve(platesDir, path.basename(plate.imagePath));
    await writeFile(absolute, plate.png);
  }
  return { ok: true };
}

async function copyBytes(source: string, output: string): Promise<{ ok: true; hash: FileHash } | { ok: false; limitation: string }> {
  await mkdir(path.dirname(output), { recursive: true });
  await copyFile(source, output);
  const hash = await hashFile(output);
  if (!hash) return { ok: false, limitation: '候选写出来之后又读不到。' };
  return { ok: true, hash };
}

function isDeliverable(relativePath: string): boolean {
  return relativePath.startsWith('assets/candidates/') || relativePath.startsWith('assets-pipeline/');
}

function resolveInside(root: string, relative: string): string | null {
  const absolute = path.resolve(root, relative);
  const back = path.relative(root, absolute);
  if (back.startsWith('..') || path.isAbsolute(back)) return null;
  return absolute;
}

function posixRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function normalizeRelative(relativePath: string): string {
  return relativePath.split('\\').join('/').replace(/^\.\//, '');
}
