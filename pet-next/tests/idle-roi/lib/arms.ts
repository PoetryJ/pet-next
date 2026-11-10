/**
 * 三臂加载、manifest 校验，以及从 O 自造 fixture 臂。
 *
 * fixture 只用来自测装置和做负控：A 的真实三臂没产出之前，用它证明
 * 「正经候选能过、裁入前景和偏移 1 DIP 会被拒」。真实判据只认
 * `experiments/idle-roi/out/` 里的已提交字节。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMediaTool } from './tool.ts';
import { decodeAllFrames, probeStream, probeTimeline, type FrameTimeline, type RawVideo, type StreamInfo } from './media.ts';
import { applyAlphaFloor, cropFrame, type Rect } from './pixels.ts';

export type ArmKey = 'O' | 'F' | 'C';

export interface Manifest {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly candidateSha256: string;
  readonly originalCanvas: { readonly width: number; readonly height: number };
  readonly crop: Rect;
  readonly alphaThreshold: number;
  readonly guard: number;
  readonly codec: string;
  readonly pixelFormat: string;
  readonly colorTags: { readonly primaries: string; readonly transfer: string; readonly matrix: string; readonly range: string };
  readonly frameCount: number;
  readonly pts: { readonly count: number; readonly firstMs: number; readonly lastMs: number; readonly stepMs: number; readonly minDeltaMs: number; readonly maxDeltaMs: number };
  readonly durationMs: number;
  readonly loopFrames: number;
  readonly generatedBy: string;
  readonly ffmpeg: string;
  readonly builtAt: string;
}

export interface Arm {
  readonly key: ArmKey;
  readonly file: string;
  readonly sha256: string;
  readonly stream: StreamInfo;
  readonly timeline: FrameTimeline;
  readonly raw: RawVideo;
}

export interface Arms {
  readonly label: string;
  readonly originalCanvas: { readonly width: number; readonly height: number };
  readonly crop: Rect;
  readonly alphaThreshold: number;
  readonly guard: number | null;
  readonly frameCount: number;
  readonly loopFrames: number | null;
  /** 布局偏移，单位画布像素。正常为 0；负控按 1 DIP 折算成画布像素。 */
  readonly restore: { readonly dx: number; readonly dy: number };
  readonly O: Arm;
  readonly F: Arm;
  readonly C: Arm;
  readonly manifest: Manifest | null;
}

export function petRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

/** 真实三臂的产出目录（A 独占）。 */
export function realArmsDir(): string {
  return path.join(petRoot(), 'experiments', 'idle-roi', 'out');
}

/**
 * 已提交三臂在本 worktree 的只读副本（C 自己的路径）。
 *
 * 为什么要副本：C 的分支从 dfeca20 出来，A 的 `experiments/idle-roi/out/` 在 C 的树上不存在；
 * 副本的 sha256 必须与 manifest 一致（`fixtures/SOURCE.json` 记了来源 commit），
 * 这样判定用的是已提交字节而不是谁的工作区快照。
 */
export function fixtureArmsDir(): string {
  return path.join(petRoot(), 'tests', 'idle-roi', 'fixtures');
}

/**
 * 三臂目录的解析顺序：
 * 1) `PET_NEXT_IDLE_ROI_ARMS` 显式指定（v2 这类还没进 fixtures 的版本用这个，不复制也能跑）；
 * 2) `tests/idle-roi/fixtures/`（已提交副本，sha 与 manifest 校验）；
 * 3) `experiments/idle-roi/out/`（A 的目录，本 worktree 通常没有）。
 */
export function resolveArmsDir(): string {
  const override = process.env.PET_NEXT_IDLE_ROI_ARMS;
  const files = ['O.webm', 'F.webm', 'C.webm', 'manifest.json'];
  const complete = (dir: string): boolean => files.every((name) => existsSync(path.join(dir, name)));
  if (override !== undefined && override.length > 0 && complete(override)) return override;
  const local = fixtureArmsDir();
  if (complete(local)) return local;
  return realArmsDir();
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const SHA = /^[0-9a-f]{64}$/;

interface ManifestCheck {
  readonly manifest: Manifest | null;
  readonly problems: readonly string[];
}

function readNumber(source: Record<string, unknown>, field: string, problems: string[]): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`${field} 不是有限数字`);
    return Number.NaN;
  }
  return value;
}

function readObject(source: Record<string, unknown>, field: string, problems: string[]): Record<string, unknown> {
  const value = source[field];
  if (typeof value !== 'object' || value === null) {
    problems.push(`${field} 缺失`);
    return {};
  }
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, field: string, problems: string[]): string {
  const value = source[field];
  if (typeof value !== 'string' || value.length === 0) {
    problems.push(`${field} 缺失`);
    return '';
  }
  return value;
}

/**
 * 校验 manifest。任何一条不成立都返回 null，调用方必须回原片或直接判门不过。
 * 不用「缺字段就填默认值」那一套——默认值会让越界 crop 也能算过去。
 */
export function parseManifest(raw: unknown): ManifestCheck {
  const problems: string[] = [];
  if (typeof raw !== 'object' || raw === null) return { manifest: null, problems: ['manifest 不是对象'] };
  const record = raw as Record<string, unknown>;
  if (record.kind !== 'idle-roi') problems.push('kind != idle-roi');
  if (readNumber(record, 'schemaVersion', problems) !== 1) problems.push('schemaVersion != 1');
  const canvas = readObject(record, 'originalCanvas', problems);
  const canvasWidth = readNumber(canvas, 'width', problems);
  const canvasHeight = readNumber(canvas, 'height', problems);
  const cropRaw = readObject(record, 'crop', problems);
  const crop: Rect = {
    x: readNumber(cropRaw, 'x', problems),
    y: readNumber(cropRaw, 'y', problems),
    width: readNumber(cropRaw, 'width', problems),
    height: readNumber(cropRaw, 'height', problems),
  };
  const alphaThreshold = readNumber(record, 'alphaThreshold', problems);
  if (alphaThreshold !== 1) problems.push(`alphaThreshold=${alphaThreshold} 不是契约固定的 1`);
  const guard = readNumber(record, 'guard', problems);
  if (!Number.isInteger(guard) || guard < 0) problems.push('guard 不是非负整数');
  const color = readObject(record, 'colorTags', problems);
  const pts = readObject(record, 'pts', problems);
  const frameCount = readNumber(record, 'frameCount', problems);
  const durationMs = readNumber(record, 'durationMs', problems);
  const loopFrames = readNumber(record, 'loopFrames', problems);
  const sourceSha = readString(record, 'sourceSha256', problems);
  const candidateSha = readString(record, 'candidateSha256', problems);
  const sourcePath = readString(record, 'sourcePath', problems);
  const codec = readString(record, 'codec', problems);
  const pixelFormat = readString(record, 'pixelFormat', problems);
  for (const [field, value] of [
    ['sourceSha256', sourceSha],
    ['candidateSha256', candidateSha],
  ] as const) {
    if (value !== '' && !SHA.test(value)) problems.push(`${field} 不是 64 位小写 hex`);
  }
  if (!Number.isInteger(crop.x) || !Number.isInteger(crop.y) || !Number.isInteger(crop.width) || !Number.isInteger(crop.height)) {
    problems.push('crop 不是整数');
  }
  if (crop.width <= 0 || crop.height <= 0) problems.push('crop 宽高必须 > 0');
  if (crop.x < 0 || crop.y < 0) problems.push('crop 原点为负');
  if (crop.x + crop.width > canvasWidth || crop.y + crop.height > canvasHeight) problems.push('crop 越出 originalCanvas');
  if (crop.x % 2 !== 0 || crop.y % 2 !== 0 || crop.width % 2 !== 0 || crop.height % 2 !== 0) problems.push('crop 未按 2 对齐（yuva420p 色度单位）');
  if (!Number.isInteger(frameCount) || frameCount <= 0) problems.push('frameCount 不是正整数');
  if (loopFrames !== frameCount) problems.push(`loopFrames=${loopFrames} 与 frameCount=${frameCount} 不一致`);
  if (readNumber(pts, 'count', problems) !== frameCount) problems.push('pts.count 与 frameCount 不一致');
  const stepMs = readNumber(pts, 'stepMs', problems);
  if (Math.abs(stepMs - 1000 / 24) > 0.5) problems.push(`pts.stepMs=${stepMs} 不是 24fps`);
  for (const field of ['primaries', 'transfer', 'matrix', 'range'] as const) {
    const value = readString(color, field, problems);
    if (value === '') problems.push(`colorTags.${field} 缺失`);
  }
  if (problems.length > 0) return { manifest: null, problems };
  return {
    manifest: {
      schemaVersion: 1,
      kind: 'idle-roi',
      sourcePath,
      sourceSha256: sourceSha,
      candidateSha256: candidateSha,
      originalCanvas: { width: canvasWidth, height: canvasHeight },
      crop,
      alphaThreshold: 1,
      guard,
      codec,
      pixelFormat,
      colorTags: {
        primaries: readString(color, 'primaries', problems),
        transfer: readString(color, 'transfer', problems),
        matrix: readString(color, 'matrix', problems),
        range: readString(color, 'range', problems),
      },
      frameCount,
      pts: {
        count: frameCount,
        firstMs: readNumber(pts, 'firstMs', problems),
        lastMs: readNumber(pts, 'lastMs', problems),
        stepMs,
        minDeltaMs: readNumber(pts, 'minDeltaMs', problems),
        maxDeltaMs: readNumber(pts, 'maxDeltaMs', problems),
      },
      durationMs,
      loopFrames,
      generatedBy: readString(record, 'generatedBy', problems),
      ffmpeg: readString(record, 'ffmpeg', problems),
      builtAt: readString(record, 'builtAt', problems),
    },
    problems,
  };
}

async function loadArm(key: ArmKey, file: string, workDir: string): Promise<Arm> {
  const stream = await probeStream(file);
  const timeline = await probeTimeline(file);
  // 裸帧文件名必须带文件名本身：O/F/C 和负控的 C-inset 可能同目录，撞名会互相截断。
  const raw = await decodeAllFrames(file, workDir, `${key}-${path.basename(file, '.webm')}`);
  return { key, file, sha256: sha256File(file), stream, timeline, raw };
}

export interface LoadResult {
  readonly arms: Arms | null;
  readonly problems: readonly string[];
}

/** 从目录里读 O/F/C + manifest。缺文件或 sha 对不上就返回 problems，不猜。 */
export async function loadRealArms(dir: string, workDir: string): Promise<LoadResult> {
  return loadNamedArms(dir, workDir, { O: 'O.webm', F: 'F.webm', C: 'C.webm' });
}

export interface NamedArmFiles {
  readonly O: string;
  readonly F: string;
  readonly C: string;
}

export interface LoadNamedOptions {
  /** 报告里的臂名（S / C3 这类），只影响 label。 */
  readonly label?: string;
  /**
   * 是否要求 C 槽位文件的 sha 等于 `manifest.candidateSha256`。
   *
   * f3c3 这类「C3 就是 manifest 里那个候选」的目录要校验；
   * 原生 YUVA 自对照的 S 不是候选，硬套这条只会得到一个假结论。
   */
  readonly verifyCandidateSha?: boolean;
}

/**
 * 按显式文件名读三臂 + manifest。
 *
 * 为什么不用「遍历目录找首个 manifest」：v3 目录里同时有自对照与 C3，
 * 谁对应哪个角色必须由调用方写明，不能靠目录里第一个匹配。
 */
export async function loadNamedArms(dir: string, workDir: string, files: NamedArmFiles, options: LoadNamedOptions = {}): Promise<LoadResult> {
  const problems: string[] = [];
  const paths = { O: path.join(dir, files.O), F: path.join(dir, files.F), C: path.join(dir, files.C) };
  const manifestPath = path.join(dir, 'manifest.json');
  for (const [key, file] of Object.entries(paths)) {
    if (!existsSync(file)) problems.push(`缺 ${key}（${path.relative(petRoot(), file)}）`);
  }
  if (!existsSync(manifestPath)) problems.push(`缺 manifest.json（${path.relative(petRoot(), manifestPath)}）`);
  if (problems.length > 0) return { arms: null, problems };
  const parsed = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (parsed.manifest === null) return { arms: null, problems: parsed.problems };
  const manifest = parsed.manifest;
  const [O, F, C] = await Promise.all([loadArm('O', paths.O, workDir), loadArm('F', paths.F, workDir), loadArm('C', paths.C, workDir)]);
  if (O.sha256 !== manifest.sourceSha256) problems.push(`O sha ${O.sha256} != manifest.sourceSha256 ${manifest.sourceSha256}`);
  if (options.verifyCandidateSha !== false && C.sha256 !== manifest.candidateSha256) {
    problems.push(`C sha ${C.sha256} != manifest.candidateSha256 ${manifest.candidateSha256}`);
  }
  if (problems.length > 0) return { arms: null, problems };
  return {
    arms: {
      label: options.label ?? 'real',
      originalCanvas: manifest.originalCanvas,
      crop: manifest.crop,
      alphaThreshold: manifest.alphaThreshold,
      guard: manifest.guard,
      frameCount: manifest.frameCount,
      loopFrames: manifest.loopFrames,
      restore: { dx: 0, dy: 0 },
      O,
      F,
      C,
      manifest,
    },
    problems,
  };
}

/**
 * 自造 fixture 的编码档位：0 = libvpx VP9 真无损。
 *
 * 为什么必须无损：fixture 只用来证明装置本身没问题。实测同一条预处理链在
 * crf 4 时 F–C 合成最大差已经 6/255、O–C 前景 MAE 1.48/255，编码档位的影响
 * 远大于 alpha 阈值的影响；那种噪声归 `lib/sensitivity.ts` 单独量，不该混进自检。
 */
export const FIXTURE_CRF = 0;
/** fixture 的 crop 与契约候选一致。 */
export const FIXTURE_CROP: Rect = { x: 208, y: 52, width: 226, height: 286 };
/** 「裁入前景」负控：x 内移 10px，丢掉 10 列真前景。 */
export const INSET_CROP: Rect = { x: 218, y: 52, width: 216, height: 286 };

const FIXTURE_FRAMES = 48;
const FRAMERATE = '24';

interface FixturePaths {
  readonly dir: string;
  readonly prepared: string;
  readonly manifestPath: string;
}

function fixturePaths(dir: string): FixturePaths {
  return { dir, prepared: path.join(dir, 'prepared.rgba'), manifestPath: path.join(dir, 'manifest.json') };
}

export interface EncodeOptions {
  /** 默认 yuva420p；免色度下采样时传 yuva444p。 */
  readonly pixelFormat?: string;
  /** 追加 `-lossless 1`（实测这版 ffmpeg 不一定生效，跑的时候要读回来验证）。 */
  readonly losslessFlag?: boolean;
}

export function encodeCommand(input: string, output: string, width: number, height: number, crop: Rect | null, crf: number, options: EncodeOptions = {}): string[] {
  const command = ['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-framerate', FRAMERATE, '-i', input];
  if (crop !== null) command.push('-vf', `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
  command.push(
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    options.pixelFormat ?? 'yuva420p',
    '-crf',
    String(crf),
    '-b:v',
    '0',
    ...(options.losslessFlag === true ? ['-lossless', '1'] : []),
    '-auto-alt-ref',
    '0',
    '-row-mt',
    '1',
    '-g',
    '120',
    '-metadata:s:v:0',
    'alpha_mode=1',
    '-an',
    output,
  );
  return command;
}

/**
 * 从 `assets/idle.webm` 造 F/C（以及裁入前景的负控 C）三份 webm。
 *
 * 预处理与 A 的契约一致：全片 `alpha<=1` 置零，其余不动；F 全画布重编码，
 * C 只多一个 crop。产物落在 `tests/idle-roi/out/fixture/`，不提交。
 */
export async function buildFixtureArms(dir: string, workDir: string): Promise<LoadResult> {
  const problems: string[] = [];
  const source = path.join(petRoot(), 'assets', 'idle.webm');
  if (!existsSync(source)) return { arms: null, problems: [`缺源素材 ${source}`] };
  const sourceSha = sha256File(source);
  mkdirSync(dir, { recursive: true });
  const paths = fixturePaths(dir);
  const stamp = { sourceSha, crf: FIXTURE_CRF, crop: FIXTURE_CROP, inset: INSET_CROP };

  if (!existsSync(paths.manifestPath)) {
    const decoded = await decodeAllFrames(source, workDir, 'fixture-source');
    if (decoded.frameCount !== FIXTURE_FRAMES) problems.push(`源素材解出 ${decoded.frameCount} 帧，契约要求 ${FIXTURE_FRAMES}`);
    const whole = readFileSync(decoded.rawPath);
    const frameBytes = decoded.frameBytes;
    let floored = 0;
    for (let frame = 0; frame < decoded.frameCount; frame += 1) {
      floored += applyAlphaFloor(whole.subarray(frame * frameBytes, (frame + 1) * frameBytes), 1);
    }
    writeFileSync(paths.prepared, whole);
    await runMediaTool(encodeCommand(paths.prepared, path.join(dir, 'F.webm'), decoded.width, decoded.height, null, FIXTURE_CRF), 300_000);
    await runMediaTool(encodeCommand(paths.prepared, path.join(dir, 'C.webm'), decoded.width, decoded.height, FIXTURE_CROP, FIXTURE_CRF), 300_000);
    await runMediaTool(encodeCommand(paths.prepared, path.join(dir, 'C-inset.webm'), decoded.width, decoded.height, INSET_CROP, FIXTURE_CRF), 300_000);
    writeFileSync(
      paths.manifestPath,
      `${JSON.stringify(
        {
          ...stamp,
          width: decoded.width,
          height: decoded.height,
          frameCount: decoded.frameCount,
          alphaFlooredPixels: floored,
          note: 'fixture only: 从 assets/idle.webm 自造，用于自测与负控，不是 A 的候选',
        },
        null,
        2,
      )}\n`,
    );
    // 44MB 裸帧留着没用，编码完就删。
    rmSync(paths.prepared, { force: true });
  }

  const stampFile = JSON.parse(readFileSync(paths.manifestPath, 'utf8')) as { sourceSha?: string; crf?: number; crop?: Rect };
  const sameCrop = JSON.stringify(stampFile.crop) === JSON.stringify(FIXTURE_CROP);
  if (stampFile.sourceSha !== sourceSha || stampFile.crf !== FIXTURE_CRF || !sameCrop) {
    return { arms: null, problems: ['fixture 缓存与当前源/档位/crop 不一致，删掉 out/fixture 重跑'] };
  }

  const [O, F, C] = await Promise.all([
    loadArm('O', source, workDir),
    loadArm('F', path.join(dir, 'F.webm'), workDir),
    loadArm('C', path.join(dir, 'C.webm'), workDir),
  ]);
  return {
    arms: {
      label: 'fixture',
      originalCanvas: { width: O.stream.width, height: O.stream.height },
      crop: FIXTURE_CROP,
      alphaThreshold: 1,
      guard: 2,
      frameCount: FIXTURE_FRAMES,
      loopFrames: FIXTURE_FRAMES,
      restore: { dx: 0, dy: 0 },
      O,
      F,
      C,
      manifest: null,
    },
    problems,
  };
}

/** 负控①用的臂：C 换成「裁入前景」的那份，crop 也换成内移后的。 */
export async function loadInsetArms(dir: string, workDir: string): Promise<LoadResult> {
  const built = await buildFixtureArms(dir, workDir);
  if (!built.arms) return built;
  const inset = await loadArm('C', path.join(dir, 'C-inset.webm'), workDir);
  return {
    arms: { ...built.arms, label: 'fixture-inset', crop: INSET_CROP, C: inset },
    problems: built.problems,
  };
}

/** 按画布像素平移到「偏移 1 DIP」的臂。320×240 视口下 s=0.5，1 DIP = 2 画布像素。 */
export function shiftArms(arms: Arms, dx: number, dy: number, label: string): Arms {
  return { ...arms, label, restore: { dx, dy } };
}

/** 从整幅 raw 里取一帧的 crop 区域，供负控与 fixture 复用。 */
export function extractCrop(full: Uint8Array, width: number, crop: Rect): Uint8Array {
  const out = new Uint8Array(crop.width * crop.height * 4);
  cropFrame(full, width, crop, out);
  return out;
}
