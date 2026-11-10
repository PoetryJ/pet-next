/**
 * 一次「参照 ↔ 候选」比较的完整测量，两个口径分开给：
 *
 * - `worstAcrossFramesAndPlates`：遍历 48 帧 × 黑/白/棋盘三种底，取**最差的那一个**。
 *   这就是旧报告里 1.218 的口径，它是「哪一帧哪一种底最烂」，**不是全片平均**。
 * - `meanOverAllSamples`：把 48 帧 × 三种底的全部样本池化后算 MAE 与 P99（单一直方图）。
 *
 * 两者都来自同一次逐帧遍历、同一套掩码，不做抽样、不跳帧、不缩放。
 * 掩码永远来自**参照臂自己的 alpha**（O→X 用 O 的，F→X 用 F 的），
 * 这样「谁作参照」在数据里可查，不会出现用 F 的掩码替 O 掩码的情况。
 */
import { openRaw, type RawReader } from './media.ts';
import {
  PLATES,
  accumulateDiff,
  accumulateAlpha,
  compositeFrame,
  countOpaqueByCrop,
  edgeMask,
  emptyAlphaAccumulator,
  emptyDiffAccumulator,
  foregroundMask,
  iterateAccumulate,
  restoreCrop,
  summarizeAlpha,
  summarizeDiff,
  type AlphaStats,
  type DiffAccumulator,
  type DiffStats,
  type PlateId,
  type Rect,
} from './pixels.ts';
import type { ArmKey, Arms } from './arms.ts';

/** 一个区域在某一帧某一种底上的统计。 */
export interface RegionStat {
  readonly mae: number;
  readonly p99: number;
  readonly max: number;
  readonly samples: number;
  readonly over1: number;
  readonly over2: number;
}

/** 最差位置：值 + 出处（第几帧、哪种底）。 */
export interface RegionWorst extends RegionStat {
  readonly frame: number;
  readonly plate: PlateId | null;
}

export interface FramePlateRecord {
  readonly frame: number;
  readonly alpha: { readonly max: number; readonly mae: number };
  readonly plates: Record<PlateId, { readonly foreground: RegionStat; readonly edge: RegionStat; readonly wholeFrame: RegionStat }>;
}

export interface WorstSummary {
  /** 逐帧逐底前景 MAE 的最大值（旧报告 1.218 的口径）。 */
  readonly foregroundMae: RegionWorst;
  readonly foregroundP99: RegionWorst;
  readonly foregroundMax: RegionWorst;
  readonly edgeMae: RegionWorst;
  readonly edgeP99: RegionWorst;
  readonly edgeMax: RegionWorst;
  readonly wholeFrameMax: RegionWorst;
  readonly alpha: RegionWorst;
}

export interface MeanSummary {
  readonly foreground: DiffStats;
  readonly edge: DiffStats;
  readonly wholeFrame: DiffStats;
  readonly alpha: AlphaStats;
}

export interface ComparisonMeasurement {
  readonly id: string;
  readonly reference: ArmKey;
  readonly candidate: ArmKey;
  /** 候选是否按 crop 贴回原画布再比（C 是裁过的，F 不是）。 */
  readonly restoredFromCrop: boolean;
  readonly crop: Rect | null;
  readonly frames: number;
  readonly samplesNote: string;
  readonly worstAcrossFramesAndPlates: WorstSummary;
  readonly meanOverAllSamples: MeanSummary;
  readonly perFrame: readonly FramePlateRecord[];
}

/**
 * 最差位置的初值取第 0 帧：全片误差恒为 0 时，「最差帧」没有意义，
 * 报 0 帧比报 -1 更不容易被误读成「没数据」。真实更新只看严格更大，
 * 所以 0 不会盖掉真正的非零最差帧。
 */
function emptyRegion(frame = 0, plate: PlateId | null = null): RegionWorst {
  return { mae: 0, p99: 0, max: 0, samples: 0, over1: 0, over2: 0, frame, plate };
}

function toRegion(stats: DiffStats, frame: number, plate: PlateId): RegionWorst {
  return { mae: stats.mae, p99: stats.p99, max: stats.max, samples: stats.samples, over1: stats.over1, over2: stats.over2, frame, plate };
}

interface Targets {
  readonly foreground: DiffAccumulator;
  readonly edge: DiffAccumulator;
  readonly wholeFrame: DiffAccumulator;
}

function emptyTargets(): Targets {
  return { foreground: emptyDiffAccumulator(), edge: emptyDiffAccumulator(), wholeFrame: emptyDiffAccumulator() };
}

/**
 * 全片比较。`referenceAlphaThreshold` 固定取 `arms.alphaThreshold`（契约=1）。
 */
export function measureComparison(arms: Arms, reference: ArmKey, candidate: ArmKey, id: string): ComparisonMeasurement {
  const canvas = arms.originalCanvas;
  const refArm = arms[reference];
  const candArm = arms[candidate];
  const candidates: ArmKey[] = [reference, candidate];
  const readers = new Map<ArmKey, RawReader>();
  const buffers = new Map<ArmKey, Buffer>();
  for (const key of candidates) {
    readers.set(key, openRaw(arms[key].raw));
    buffers.set(key, Buffer.alloc(arms[key].raw.frameBytes));
  }
  const needsRestore = candArm.raw.width !== canvas.width || candArm.raw.height !== canvas.height;
  const restored = needsRestore ? Buffer.alloc(canvas.width * canvas.height * 4) : null;
  const left = Buffer.alloc(canvas.width * canvas.height * 3);
  const right = Buffer.alloc(canvas.width * canvas.height * 3);
  const pooled = emptyTargets();
  const pooledAlpha = emptyAlphaAccumulator();
  let worstForegroundMae = emptyRegion();
  let worstForegroundP99 = emptyRegion();
  let worstForegroundMax = emptyRegion();
  let worstEdgeMae = emptyRegion();
  let worstEdgeP99 = emptyRegion();
  let worstEdgeMax = emptyRegion();
  let worstWholeFrameMax = emptyRegion();
  let worstAlpha = emptyRegion();
  const perFrame: FramePlateRecord[] = [];
  const frames = Math.min(arms.frameCount, refArm.raw.frameCount, candArm.raw.frameCount);
  try {
    for (let frame = 0; frame < frames; frame += 1) {
      const refReader = readers.get(reference);
      const candReader = readers.get(candidate);
      const refBuffer = buffers.get(reference);
      const candBuffer = buffers.get(candidate);
      if (!refReader || !candReader || !refBuffer || !candBuffer) throw new Error('臂未打开');
      refReader.read(frame, refBuffer);
      candReader.read(frame, candBuffer);
      let candFrame: Uint8Array = candBuffer;
      if (restored !== null) {
        restoreCrop(candBuffer, arms.crop, canvas.width, canvas.height, restored, arms.restore.dx, arms.restore.dy);
        candFrame = restored;
      }
      const frameAlpha = emptyAlphaAccumulator();
      accumulateAlpha(refBuffer, candFrame, null, frameAlpha);
      accumulateAlpha(refBuffer, candFrame, null, pooledAlpha);
      const frameAlphaStats = summarizeAlpha(frameAlpha);
      if (frameAlphaStats.max > worstAlpha.max) {
        worstAlpha = { ...frameAlphaStats, frame, plate: null };
      }
      const fgMask = foregroundMask(refBuffer, canvas.width, canvas.height, arms.alphaThreshold);
      const edMask = edgeMask(refBuffer, canvas.width, canvas.height, arms.alphaThreshold, 2, 64);
      const plates: Record<string, { foreground: RegionStat; edge: RegionStat; wholeFrame: RegionStat }> = {};
      for (const plate of PLATES) {
        compositeFrame(refBuffer, canvas.width, canvas.height, plate, left);
        compositeFrame(candFrame, canvas.width, canvas.height, plate, right);
        const frameTargets = emptyTargets();
        const masked = [
          { mask: fgMask, acc: frameTargets.foreground },
          { mask: edMask, acc: frameTargets.edge },
          { mask: null, acc: frameTargets.wholeFrame },
        ] as const;
        iterateAccumulate(left, right, masked, 3);
        // 池化：逐帧结果并入全片累加器。
        accumulateDiff(left, right, fgMask, pooled.foreground);
        accumulateDiff(left, right, edMask, pooled.edge);
        accumulateDiff(left, right, null, pooled.wholeFrame);
        const foreground = summarizeDiff(frameTargets.foreground);
        const edge = summarizeDiff(frameTargets.edge);
        const wholeFrame = summarizeDiff(frameTargets.wholeFrame);
        plates[plate] = {
          foreground: { mae: foreground.mae, p99: foreground.p99, max: foreground.max, samples: foreground.samples, over1: foreground.over1, over2: foreground.over2 },
          edge: { mae: edge.mae, p99: edge.p99, max: edge.max, samples: edge.samples, over1: edge.over1, over2: edge.over2 },
          wholeFrame: { mae: wholeFrame.mae, p99: wholeFrame.p99, max: wholeFrame.max, samples: wholeFrame.samples, over1: wholeFrame.over1, over2: wholeFrame.over2 },
        };
        if (foreground.mae > worstForegroundMae.mae) worstForegroundMae = toRegion(foreground, frame, plate);
        if (foreground.p99 > worstForegroundP99.p99) worstForegroundP99 = toRegion(foreground, frame, plate);
        if (foreground.max > worstForegroundMax.max) worstForegroundMax = toRegion(foreground, frame, plate);
        if (edge.mae > worstEdgeMae.mae) worstEdgeMae = toRegion(edge, frame, plate);
        if (edge.p99 > worstEdgeP99.p99) worstEdgeP99 = toRegion(edge, frame, plate);
        if (edge.max > worstEdgeMax.max) worstEdgeMax = toRegion(edge, frame, plate);
        if (wholeFrame.max > worstWholeFrameMax.max) worstWholeFrameMax = toRegion(wholeFrame, frame, plate);
      }
      perFrame.push({
        frame,
        alpha: { max: frameAlphaStats.max, mae: frameAlphaStats.mae },
        plates: {
          black: plates['black']!,
          white: plates['white']!,
          checker: plates['checker']!,
        },
      });
    }
  } finally {
    for (const reader of readers.values()) reader.close();
  }
  return {
    id,
    reference,
    candidate,
    restoredFromCrop: needsRestore,
    crop: needsRestore ? arms.crop : null,
    frames,
    samplesNote: 'worst = 逐帧逐底取最差；mean = 48 帧 × 3 底全场样本池化（单一直方图）',
    worstAcrossFramesAndPlates: {
      foregroundMae: worstForegroundMae,
      foregroundP99: worstForegroundP99,
      foregroundMax: worstForegroundMax,
      edgeMae: worstEdgeMae,
      edgeP99: worstEdgeP99,
      edgeMax: worstEdgeMax,
      wholeFrameMax: worstWholeFrameMax,
      alpha: worstAlpha,
    },
    meanOverAllSamples: {
      foreground: summarizeDiff(pooled.foreground),
      edge: summarizeDiff(pooled.edge),
      wholeFrame: summarizeDiff(pooled.wholeFrame),
      alpha: summarizeAlpha(pooledAlpha),
    },
    perFrame,
  };
}

/** 覆盖统计：ROI 内外 alpha>threshold 的像素数。 */
export function countCoverage(arms: Arms, key: ArmKey): { inside: number; outside: number; frames: number; outsideFrames: number[] } {
  const canvas = arms.originalCanvas;
  const arm = arms[key];
  const reader = openRaw(arm.raw);
  const frame = Buffer.alloc(arm.raw.frameBytes);
  const restored = Buffer.alloc(canvas.width * canvas.height * 4);
  const frames = Math.min(arms.frameCount, arm.raw.frameCount);
  let inside = 0;
  let outside = 0;
  const outsideFrames: number[] = [];
  try {
    for (let index = 0; index < frames; index += 1) {
      reader.read(index, frame);
      let target: Uint8Array = frame;
      let crop = arms.crop;
      if (arm.raw.width !== canvas.width || arm.raw.height !== canvas.height) {
        restoreCrop(frame, arms.crop, canvas.width, canvas.height, restored, arms.restore.dx, arms.restore.dy);
        target = restored;
        crop = { ...arms.crop, x: arms.crop.x + arms.restore.dx, y: arms.crop.y + arms.restore.dy };
      }
      const counts = countOpaqueByCrop(target, canvas.width, canvas.height, crop, arms.alphaThreshold);
      inside += counts.inside;
      outside += counts.outside;
      if (counts.outside > 0) outsideFrames.push(index);
    }
  } finally {
    reader.close();
  }
  return { inside, outside, frames, outsideFrames };
}
