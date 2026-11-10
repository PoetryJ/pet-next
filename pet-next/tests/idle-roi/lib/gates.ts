/**
 * 门的定义与实测。判据逐条抄自 `docs/M3-12-IDLE-ROI.md` 第 6 节，一个字都不放宽。
 *
 * 每个门自己把全片重读一遍：48 帧，不抽样。报告里保留逐帧数值，
 * 这样失败时能直接指出是哪一帧、哪个通道、超过阈值的样本数。
 */
import {
  alphaStats,
  accumulateAlphaBox,
  boxRect,
  compositeFrame,
  countOpaqueByCrop,
  diffStats,
  edgeMask,
  emptyAlphaBox,
  foregroundMask,
  restoreCrop,
  type AlphaBox,
  type PlateId,
  type Rect,
} from './pixels.ts';
import { openRaw, type RawReader } from './media.ts';
import type { Arm, ArmKey, Arms } from './arms.ts';

/** 契约 §6 的判据。只在这里出现一次，测试不另写一套数字。 */
export const GATE_THRESHOLDS = {
  /** 全片覆盖：48/48 帧。 */
  frameCount: 48,
  /** ROI 外 `alpha>1` 被删除像素数。 */
  roiOutsideOpaque: 0,
  /** 逐帧 PTS 允许的封装时间基舍入误差。 */
  ptsDeltaMs: 1,
  /** 封装 duration 允许的舍入误差。 */
  durationDeltaMs: 1,
  /** F–C 每通道最大差。 */
  fToCChannelMax: 2,
  /** F–C alpha 通道最大差。 */
  fToCAlphaMax: 2,
  /** O–C 合成 MAE，单位 1/255。 */
  ocMae: 1 / 255,
  /** O–C 合成 P99，单位 1/255。 */
  ocP99: 2 / 255,
  /** 位置门：包围盒每边允许的偏移。 */
  bboxDeltaPx: 1,
  /** 位置门：质心允许的偏移。 */
  centroidDeltaPx: 0.5,
  /** 只把 `alpha <= alphaThreshold` 置零。 */
  alphaThreshold: 1,
  /** 边缘带：半透明下限。 */
  edgeBandLow: 2,
  /** 边缘带：半透明上限。 */
  edgeBandHigh: 64,
} as const;

export interface GateResult {
  readonly id: string;
  readonly title: string;
  /** 契约原文的判据。 */
  readonly criteria: string;
  readonly pass: boolean;
  readonly failures: readonly string[];
  readonly metrics: Readonly<Record<string, unknown>>;
}

const EPSILON = 1e-9;

function result(id: string, title: string, criteria: string, failures: readonly string[], metrics: Record<string, unknown>): GateResult {
  return { id, title, criteria, pass: failures.length === 0, failures, metrics };
}

interface Opened {
  readonly readers: Map<ArmKey, RawReader>;
  readonly buffers: Map<ArmKey, Buffer>;
}

function openArms(arms: Arms, keys: readonly ArmKey[]): Opened {
  const readers = new Map<ArmKey, RawReader>();
  const buffers = new Map<ArmKey, Buffer>();
  for (const key of keys) {
    const arm: Arm = arms[key];
    readers.set(key, openRaw(arm.raw));
    buffers.set(key, Buffer.allocUnsafe(arm.raw.frameBytes));
  }
  return { readers, buffers };
}

function readFrame(opened: Opened, key: ArmKey, index: number): Buffer {
  const reader = opened.readers.get(key);
  const buffer = opened.buffers.get(key);
  if (!reader || !buffer) throw new Error(`未打开 ${key}`);
  reader.read(index, buffer);
  return buffer;
}

function closeArms(opened: Opened): void {
  for (const reader of opened.readers.values()) reader.close();
}

/** 画布尺寸与 crop 相乘的自检，避免 crop 越界时后面静默读错。 */
export function cropWithinCanvas(crop: Rect, width: number, height: number): boolean {
  return (
    Number.isInteger(crop.x) &&
    Number.isInteger(crop.y) &&
    Number.isInteger(crop.width) &&
    Number.isInteger(crop.height) &&
    crop.width > 0 &&
    crop.height > 0 &&
    crop.x >= 0 &&
    crop.y >= 0 &&
    crop.x + crop.width <= width &&
    crop.y + crop.height <= height
  );
}

/** 全片覆盖 + ROI 外 alpha>1 删除数 = 0。 */
export function coverageGate(arms: Arms): GateResult {
  const failures: string[] = [];
  const expected = GATE_THRESHOLDS.frameCount;
  const opened = openArms(arms, ['O', 'F', 'C']);
  const canvas = arms.originalCanvas;
  const restored = Buffer.alloc(canvas.width * canvas.height * 4);
  const perArm: Record<string, { decodedFrames: number; outsideOpaque: number; insideOpaque: number; outsideFrames: number[] }> = {};
  try {
    for (const key of ['O', 'F', 'C'] as const) {
      const arm = arms[key];
      if (arm.raw.frameCount !== expected) failures.push(`${key} 解码 ${arm.raw.frameCount}/${expected} 帧`);
      if (arm.timeline.count !== expected) failures.push(`${key} 探针 ${arm.timeline.count}/${expected} 帧`);
      let outsideOpaque = 0;
      let insideOpaque = 0;
      const outsideFrames: number[] = [];
      for (let frame = 0; frame < Math.min(arm.raw.frameCount, expected); frame += 1) {
        const rgba = readFrame(opened, key, frame);
        if (key === 'C') {
          restoreCrop(rgba, arms.crop, canvas.width, canvas.height, restored, arms.restore.dx, arms.restore.dy);
          const counts = countOpaqueByCrop(restored, canvas.width, canvas.height, { ...arms.crop, x: arms.crop.x + arms.restore.dx, y: arms.crop.y + arms.restore.dy }, arms.alphaThreshold);
          if (counts.outside > 0) outsideFrames.push(frame);
          outsideOpaque += counts.outside;
          insideOpaque += counts.inside;
          continue;
        }
        if (arm.raw.width !== canvas.width || arm.raw.height !== canvas.height) {
          failures.push(`${key} 解码尺寸 ${arm.raw.width}x${arm.raw.height} != 画布 ${canvas.width}x${canvas.height}`);
          break;
        }
        const counts = countOpaqueByCrop(rgba, canvas.width, canvas.height, arms.crop, arms.alphaThreshold);
        if (counts.outside > 0) outsideFrames.push(frame);
        outsideOpaque += counts.outside;
        insideOpaque += counts.inside;
      }
      perArm[key] = { decodedFrames: arm.raw.frameCount, outsideOpaque, insideOpaque, outsideFrames };
      if (outsideOpaque > GATE_THRESHOLDS.roiOutsideOpaque) {
        failures.push(`${key} 在 ROI 外有 ${outsideOpaque} 个 alpha>${arms.alphaThreshold} 像素（帧 ${outsideFrames.slice(0, 8).join(',')}${outsideFrames.length > 8 ? '…' : ''}）`);
      }
      if (insideOpaque === 0) failures.push(`${key} ROI 内没有 α>${arms.alphaThreshold} 的前景，无法比较`);
    }
    const expectedInside = perArm.O?.insideOpaque ?? 0;
    const fRatio = expectedInside === 0 ? 1 : (perArm.F?.insideOpaque ?? 0) / expectedInside;
    const cRatio = expectedInside === 0 ? 1 : (perArm.C?.insideOpaque ?? 0) / expectedInside;
    if (fRatio < 0.98) failures.push(`F ROI 内前景像素只剩 O 的 ${(fRatio * 100).toFixed(2)}%`);
    if (cRatio < 0.98) failures.push(`C ROI 内前景像素只剩 O 的 ${(cRatio * 100).toFixed(2)}%`);
    return result(
      'coverage',
      '全片覆盖与 ROI 合法性',
      `48/48 帧解码；ROI 外 alpha>${arms.alphaThreshold} 被删除像素数 = ${GATE_THRESHOLDS.roiOutsideOpaque}`,
      failures,
      { expectedFrames: expected, perArm, insideRatio: { F: fRatio, C: cRatio }, crop: arms.crop, restore: arms.restore },
    );
  } finally {
    closeArms(opened);
  }
}

/** 帧数、逐帧 PTS、duration、循环首尾。 */
export function timelineGate(arms: Arms): GateResult {
  const failures: string[] = [];
  const expected = GATE_THRESHOLDS.frameCount;
  const reference = arms.O.timeline;
  const perArm: Record<string, unknown> = {};
  for (const key of ['O', 'F', 'C'] as const) {
    const timeline = arms[key].timeline;
    if (timeline.count !== expected) failures.push(`${key} 帧数 ${timeline.count} != ${expected}`);
    if (timeline.count !== reference.count) failures.push(`${key} 帧数 ${timeline.count} != O ${reference.count}`);
    let maxDelta = 0;
    let exact = true;
    let nonIncreasing = 0;
    const steps: number[] = [];
    for (let index = 0; index < Math.min(timeline.count, reference.count); index += 1) {
      const delta = Math.abs((timeline.ptsMs[index] ?? 0) - (reference.ptsMs[index] ?? 0));
      if (delta > maxDelta) maxDelta = delta;
      if (delta !== 0) exact = false;
      if (delta > GATE_THRESHOLDS.ptsDeltaMs) failures.push(`${key} 第 ${index} 帧 PTS 与 O 差 ${delta}ms`);
      if (index > 0) {
        const step = (timeline.ptsMs[index] ?? 0) - (timeline.ptsMs[index - 1] ?? 0);
        steps.push(step);
        if (step <= 0) nonIncreasing += 1;
      }
    }
    if (nonIncreasing > 0) failures.push(`${key} 有 ${nonIncreasing} 处 PTS 非严格递增（丢帧/重复帧）`);
    const minStep = steps.length === 0 ? 0 : Math.min(...steps);
    const maxStep = steps.length === 0 ? 0 : Math.max(...steps);
    if (maxStep - minStep > GATE_THRESHOLDS.ptsDeltaMs) failures.push(`${key} 帧间隔 ${minStep}..${maxStep}ms 不匀，说明有增删帧`);
    const durationDelta = Math.abs((timeline.formatDurationMs ?? 0) - (reference.formatDurationMs ?? 0));
    if (timeline.formatDurationMs === null || reference.formatDurationMs === null) failures.push(`${key} 缺容器 duration`);
    else if (durationDelta > GATE_THRESHOLDS.durationDeltaMs) failures.push(`${key} duration 与 O 差 ${durationDelta}ms`);
    const lastPts = timeline.ptsMs[timeline.ptsMs.length - 1] ?? 0;
    const lastDuration = timeline.durationsMs[timeline.durationsMs.length - 1] ?? null;
    const tail = lastDuration === null ? null : Math.abs(lastPts + lastDuration - (timeline.formatDurationMs ?? 0));
    if (tail !== null && tail > GATE_THRESHOLDS.durationDeltaMs) failures.push(`${key} 末帧结束点与 duration 差 ${tail.toFixed(3)}ms（循环首尾可能增删帧）`);
    if (arms.loopFrames !== null && arms.loopFrames !== expected) failures.push(`manifest.loopFrames=${arms.loopFrames} != ${expected}`);
    perArm[key] = { count: timeline.count, maxPtsDeltaMs: maxDelta, ptsExactlyEqual: exact, minStepMs: minStep, maxStepMs: maxStep, formatDurationMs: timeline.formatDurationMs, durationDeltaMs: durationDelta, tailMs: tail, nonIncreasing };
  }
  return result(
    'timeline',
    '时间轴与循环',
    `帧数相同；逐帧 PTS 一一对应（≤${GATE_THRESHOLDS.ptsDeltaMs}ms 时间基舍入）；duration 差 ≤${GATE_THRESHOLDS.durationDeltaMs}ms；循环不增删帧`,
    failures,
    { perArm },
  );
}

interface BoxSummary {
  readonly union: Rect | null;
  readonly centroid: { x: number; y: number };
  readonly count: number;
}

/** 位置/边缘门：还原后的前景包围盒与质心必须和原片对齐。 */
export function layoutGate(arms: Arms): GateResult {
  const failures: string[] = [];
  const canvas = arms.originalCanvas;
  const opened = openArms(arms, ['O', 'F', 'C']);
  const restored = Buffer.alloc(canvas.width * canvas.height * 4);
  const originalBox: AlphaBox = emptyAlphaBox();
  const candidateBox: AlphaBox = emptyAlphaBox();
  let perFrameMaxDelta = 0;
  try {
    // 一趟读完 48 帧：整体并集 + 逐帧包围盒偏移。逐帧偏移比整体包围盒更早暴露结构位移。
    for (let frame = 0; frame < arms.frameCount; frame += 1) {
      const originalFrame = emptyAlphaBox();
      accumulateAlphaBox(readFrame(opened, 'O', frame), canvas.width, canvas.height, arms.alphaThreshold, originalFrame);
      accumulateAlphaBox(readFrame(opened, 'O', frame), canvas.width, canvas.height, arms.alphaThreshold, originalBox);
      restoreCrop(readFrame(opened, 'C', frame), arms.crop, canvas.width, canvas.height, restored, arms.restore.dx, arms.restore.dy);
      const candidateFrame = emptyAlphaBox();
      accumulateAlphaBox(restored, canvas.width, canvas.height, arms.alphaThreshold, candidateFrame);
      accumulateAlphaBox(restored, canvas.width, canvas.height, arms.alphaThreshold, candidateBox);
      const base = boxRect(originalFrame);
      const shifted = boxRect(candidateFrame);
      if (!base || !shifted) continue;
      const delta = Math.max(
        Math.abs(shifted.x - base.x),
        Math.abs(shifted.y - base.y),
        Math.abs(shifted.width - base.width),
        Math.abs(shifted.height - base.height),
      );
      if (delta > perFrameMaxDelta) perFrameMaxDelta = delta;
    }
    const original: BoxSummary = { union: boxRect(originalBox), centroid: { x: originalBox.centroidX, y: originalBox.centroidY }, count: originalBox.count };
    const candidate: BoxSummary = { union: boxRect(candidateBox), centroid: { x: candidateBox.centroidX, y: candidateBox.centroidY }, count: candidateBox.count };
    const pairs: Array<[string, number]> = [];
    if (!original.union || !candidate.union) {
      failures.push('前景包围盒为空，无法比较位置');
      pairs.length = 0;
    } else {
      pairs.push(['x', Math.abs(candidate.union.x - original.union.x)]);
      pairs.push(['y', Math.abs(candidate.union.y - original.union.y)]);
      pairs.push(['width', Math.abs(candidate.union.width - original.union.width)]);
      pairs.push(['height', Math.abs(candidate.union.height - original.union.height)]);
    }
    for (const [side, delta] of pairs) {
      if (delta > GATE_THRESHOLDS.bboxDeltaPx) failures.push(`全片包围盒 ${side} 偏移 ${delta}px > ${GATE_THRESHOLDS.bboxDeltaPx}px`);
    }
    const centroidDelta = Math.hypot(candidate.centroid.x - original.centroid.x, candidate.centroid.y - original.centroid.y);
    if (centroidDelta > GATE_THRESHOLDS.centroidDeltaPx) failures.push(`质心偏移 ${centroidDelta.toFixed(3)}px > ${GATE_THRESHOLDS.centroidDeltaPx}px`);
    if (perFrameMaxDelta > GATE_THRESHOLDS.bboxDeltaPx) failures.push(`逐帧包围盒最大偏移 ${perFrameMaxDelta}px > ${GATE_THRESHOLDS.bboxDeltaPx}px`);
    return result(
      'layout',
      '位置与边缘对齐',
      `还原后前景包围盒每边偏移 ≤${GATE_THRESHOLDS.bboxDeltaPx}px、质心偏移 ≤${GATE_THRESHOLDS.centroidDeltaPx}px（含逐帧）`,
      failures,
      { original, candidate, centroidDelta, perFrameMaxDelta, restore: arms.restore },
    );
  } finally {
    closeArms(opened);
  }
}

export interface FramePlateStat {
  readonly mae: number;
  readonly p99: number;
  readonly max: number;
  readonly samples: number;
  readonly over1: number;
  readonly over2: number;
}

export interface OcFrameRecord {
  readonly frame: number;
  readonly plates: Record<PlateId, { readonly foreground: FramePlateStat; readonly edge: FramePlateStat }>;
}

/** F–C：C 还原到原画布后与 F 比，每通道最大差 ≤2。 */
export function fToCGate(arms: Arms): GateResult {
  const failures: string[] = [];
  const canvas = arms.originalCanvas;
  const expected = GATE_THRESHOLDS.frameCount;
  const opened = openArms(arms, ['F', 'C']);
  const restored = Buffer.alloc(canvas.width * canvas.height * 4);
  const left = Buffer.alloc(canvas.width * canvas.height * 3);
  const right = Buffer.alloc(canvas.width * canvas.height * 3);
  const perFrame: Array<{ frame: number; alphaMax: number; plates: Record<string, number> }> = [];
  let worst = 0;
  let worstFrame = -1;
  let worstAlpha = 0;
  let overThresholdSamples = 0;
  try {
    for (let frame = 0; frame < expected; frame += 1) {
      const candidateRaw = readFrame(opened, 'C', frame);
      restoreCrop(candidateRaw, arms.crop, canvas.width, canvas.height, restored, arms.restore.dx, arms.restore.dy);
      const reference = readFrame(opened, 'F', frame);
      if (reference.length !== canvas.width * canvas.height * 4) {
        failures.push(`F 帧 ${frame} 尺寸 ${reference.length} 不是原画布 RGBA`);
        break;
      }
      const alpha = alphaStats(reference, restored, null);
      if (alpha.max > worstAlpha) worstAlpha = alpha.max;
      if (alpha.max > GATE_THRESHOLDS.fToCAlphaMax) failures.push(`帧 ${frame} alpha 最大差 ${alpha.max} > ${GATE_THRESHOLDS.fToCAlphaMax}`);
      const plates: Record<string, number> = {};
      for (const plate of ['black', 'white', 'checker'] as const) {
        compositeFrame(reference, canvas.width, canvas.height, plate, left);
        compositeFrame(restored, canvas.width, canvas.height, plate, right);
        const stats = diffStats(left, right, null);
        plates[plate] = stats.max;
        overThresholdSamples += stats.over2;
        if (stats.max > GATE_THRESHOLDS.fToCChannelMax) {
          failures.push(`帧 ${frame} ${plate} 合成最大差 ${stats.max} > ${GATE_THRESHOLDS.fToCChannelMax}（超 2/255 样本 ${stats.over2}）`);
        }
        if (stats.max > worst) {
          worst = stats.max;
          worstFrame = frame;
        }
      }
      perFrame.push({ frame, alphaMax: alpha.max, plates });
    }
    return result(
      'f-to-c',
      'F–C 原画布一致',
      `C 按 crop 还原后与 F 合成比较，每通道最大差 ≤${GATE_THRESHOLDS.fToCChannelMax}/255；alpha 最大差 ≤${GATE_THRESHOLDS.fToCAlphaMax}/255`,
      failures,
      { worstCompositeMax: worst, worstFrame, worstAlphaMax: worstAlpha, samplesOver2: overThresholdSamples, perFrame },
    );
  } finally {
    closeArms(opened);
  }
}

/** O–C：黑/白/棋盘三种底，前景区与边缘区分别过 MAE/P99。 */
export function ocGate(arms: Arms): GateResult {
  const failures: string[] = [];
  const canvas = arms.originalCanvas;
  const expected = GATE_THRESHOLDS.frameCount;
  const opened = openArms(arms, ['O', 'C']);
  const restored = Buffer.alloc(canvas.width * canvas.height * 4);
  const left = Buffer.alloc(canvas.width * canvas.height * 3);
  const right = Buffer.alloc(canvas.width * canvas.height * 3);
  const perFrame: OcFrameRecord[] = [];
  let worstFg = { mae: 0, p99: 0, frame: -1, plate: 'black' as PlateId };
  let worstEdge = { mae: 0, p99: 0, frame: -1, plate: 'black' as PlateId };
  try {
    for (let frame = 0; frame < expected; frame += 1) {
      const original = readFrame(opened, 'O', frame);
      const candidateRaw = readFrame(opened, 'C', frame);
      restoreCrop(candidateRaw, arms.crop, canvas.width, canvas.height, restored, arms.restore.dx, arms.restore.dy);
      const foreground = foregroundMask(original, canvas.width, canvas.height, arms.alphaThreshold);
      const edge = edgeMask(original, canvas.width, canvas.height, arms.alphaThreshold, GATE_THRESHOLDS.edgeBandLow, GATE_THRESHOLDS.edgeBandHigh);
      const plates = {} as Record<PlateId, { foreground: FramePlateStat; edge: FramePlateStat }>;
      for (const plate of ['black', 'white', 'checker'] as const) {
        compositeFrame(original, canvas.width, canvas.height, plate, left);
        compositeFrame(restored, canvas.width, canvas.height, plate, right);
        const fgStats = diffStats(left, right, foreground);
        const edgeStats = diffStats(left, right, edge);
        const toStat = (stats: ReturnType<typeof diffStats>): FramePlateStat => ({
          mae: stats.mae,
          p99: stats.p99,
          max: stats.max,
          samples: stats.samples,
          over1: stats.over1,
          over2: stats.over2,
        });
        plates[plate] = { foreground: toStat(fgStats), edge: toStat(edgeStats) };
        for (const [region, stats] of [
          ['foreground', fgStats],
          ['edge', edgeStats],
        ] as const) {
          if (stats.samples === 0) {
            failures.push(`帧 ${frame} ${plate} ${region} 区为空，门不成立`);
            continue;
          }
          if (stats.mae > GATE_THRESHOLDS.ocMae + EPSILON) {
            failures.push(`帧 ${frame} ${plate} ${region} MAE ${stats.mae.toFixed(4)}/255 > ${(GATE_THRESHOLDS.ocMae * 255).toFixed(0)}/255（超 1 样本 ${stats.over1}）`);
          }
          if (stats.p99 > GATE_THRESHOLDS.ocP99 + EPSILON) {
            failures.push(`帧 ${frame} ${plate} ${region} P99 ${stats.p99}/255 > ${GATE_THRESHOLDS.ocP99 * 255}/255`);
          }
        }
        if (fgStats.mae > worstFg.mae) worstFg = { mae: fgStats.mae, p99: fgStats.p99, frame, plate };
        if (edgeStats.mae > worstEdge.mae) worstEdge = { mae: edgeStats.mae, p99: edgeStats.p99, frame, plate };
      }
      perFrame.push({ frame, plates });
    }
    return result(
      'o-to-c',
      'O–C 三种底合成',
      `前景(α>${arms.alphaThreshold})与边缘区(2..64 或距 alpha 边界 1px) 分别 MAE ≤1/255、P99 ≤2/255；黑/白/棋盘各自过门`,
      failures,
      { worstForeground: worstFg, worstEdge, perFrame },
    );
  } finally {
    closeArms(opened);
  }
}

/** 汇总。 */
export function overallVerdict(gates: readonly GateResult[]): { pass: boolean; failed: string[] } {
  const failed = gates.filter((gate) => !gate.pass).map((gate) => gate.id);
  return { pass: failed.length === 0, failed };
}


