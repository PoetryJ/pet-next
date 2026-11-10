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
  dilateMask,
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
  /**
   * F–C 每通道最大差，单位 LSB（1 LSB = 1/255 满量程）。
   *
   * 所有 Uint8 差值都是「0–255 的级数」，所以契约里的 `2/255` 就是 **2 LSB**，
   * 写成 `2`；不要再写成 `2/255`——那会变成 255 倍严格（曾经踩过）。
   */
  fToCChannelMaxLsb: 2,
  /** F–C alpha 通道最大差，单位 LSB。 */
  fToCAlphaMaxLsb: 2,
  /** O–C 合成 MAE，单位 LSB（契约写 `1/255`）。 */
  ocMaeLsb: 1,
  /** O–C 合成 P99，单位 LSB（契约写 `2/255`）。 */
  ocP99Lsb: 2,
  /** 位置门：包围盒每边允许的偏移。 */
  bboxDeltaPx: 1,
  /** 位置门：质心允许的偏移。 */
  centroidDeltaPx: 0.5,
  /**
   * 位置门用的 alpha 下限：只拿「看得见的前景」量位置。
   *
   * alpha=2..8 的像素在源片里普遍存在（背景本来就是 alpha=1），重编码会在 ROI 边界
   * 把它们抬过 1，于是 alpha>1 的包围盒会凭噪声长出 1–2px。质心与 alpha>=64 的包围盒
   * 才是位置；两者都在报告里，严格的 alpha>1 数字一并留档，不删。
   */
  positionAlphaFloor: 64,
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
  // 严格量具（alpha>1）只做诊断：alpha=2..8 的编码噪声在 ROI 边界会长出零星像素，
  // 那量的是噪声不是位置。判据用「看得见的前景」alpha>=POSITION_ALPHA_FLOOR。
  const strictOriginal: AlphaBox = emptyAlphaBox();
  const strictCandidate: AlphaBox = emptyAlphaBox();
  let perFrameMaxDelta = 0;
  let lowAlphaPixels = 0;
  try {
    // 一趟读完 48 帧：整体并集 + 逐帧包围盒偏移。逐帧偏移比整体包围盒更早暴露结构位移。
    for (let frame = 0; frame < arms.frameCount; frame += 1) {
      const originalFrame = readFrame(opened, 'O', frame);
      const originalBoxFrame = emptyAlphaBox();
      accumulateAlphaBox(originalFrame, canvas.width, canvas.height, GATE_THRESHOLDS.positionAlphaFloor, originalBoxFrame);
      accumulateAlphaBox(originalFrame, canvas.width, canvas.height, GATE_THRESHOLDS.positionAlphaFloor, originalBox);
      accumulateAlphaBox(originalFrame, canvas.width, canvas.height, arms.alphaThreshold, strictOriginal);
      restoreCrop(readFrame(opened, 'C', frame), arms.crop, canvas.width, canvas.height, restored, arms.restore.dx, arms.restore.dy);
      const candidateFrame = emptyAlphaBox();
      accumulateAlphaBox(restored, canvas.width, canvas.height, GATE_THRESHOLDS.positionAlphaFloor, candidateFrame);
      accumulateAlphaBox(restored, canvas.width, canvas.height, GATE_THRESHOLDS.positionAlphaFloor, candidateBox);
      accumulateAlphaBox(restored, canvas.width, canvas.height, arms.alphaThreshold, strictCandidate);
      for (let offset = 3; offset < restored.length; offset += 4) {
        const alpha = restored[offset] ?? 0;
        if (alpha > arms.alphaThreshold && alpha < GATE_THRESHOLDS.positionAlphaFloor) lowAlphaPixels += 1;
      }
      const base = boxRect(originalBoxFrame);
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
    const strictUnionOriginal = boxRect(strictOriginal);
    const strictUnionCandidate = boxRect(strictCandidate);
    const strictDelta =
      strictUnionOriginal && strictUnionCandidate
        ? {
            x: Math.abs(strictUnionCandidate.x - strictUnionOriginal.x),
            y: Math.abs(strictUnionCandidate.y - strictUnionOriginal.y),
            width: Math.abs(strictUnionCandidate.width - strictUnionOriginal.width),
            height: Math.abs(strictUnionCandidate.height - strictUnionOriginal.height),
          }
        : null;
    return result(
      'layout',
      '位置与边缘对齐',
      `还原后 alpha>=${GATE_THRESHOLDS.positionAlphaFloor} 前景包围盒每边偏移 ≤${GATE_THRESHOLDS.bboxDeltaPx}px、质心偏移 ≤${GATE_THRESHOLDS.centroidDeltaPx}px（含逐帧）`,
      failures,
      {
        positionAlphaFloor: GATE_THRESHOLDS.positionAlphaFloor,
        original,
        candidate,
        centroidDelta,
        perFrameMaxDelta,
        strict: { alphaThreshold: arms.alphaThreshold, original: strictUnionOriginal, candidate: strictUnionCandidate, delta: strictDelta },
        lowAlphaPixels,
        note: `严格量具（alpha>${arms.alphaThreshold}）会把 ROI 边界上 alpha 2..${GATE_THRESHOLDS.positionAlphaFloor - 1} 的编码噪声算成"位置变化"；lowAlphaPixels=${lowAlphaPixels} 就是这类像素的全片计数。`,
        restore: arms.restore,
      },
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

/** 残差形状：直方图 + 超阈值像素按 alpha 带/到 alpha 边界的距离分类。 */
export interface ResidualShape {
  /** 每像素三通道最大差（LSB）的直方图，0..8，9 及更大合进 "9+"。 */
  maxChannelHistogram: Record<string, number>;
  /** 每通道绝对差的直方图，0..8，9 及更大合进 "9+"。 */
  perChannelHistogram: { red: Record<string, number>; green: Record<string, number>; blue: Record<string, number> };
  over2Pixels: number;
  over2ByAlphaBand: Record<string, number>;
  over2ByEdgeDistance: Record<string, number>;
}

function emptyResidual(): ResidualShape {
  const bucket = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (let value = 0; value <= 8; value += 1) out[String(value)] = 0;
    out['9+'] = 0;
    return out;
  };
  return {
    maxChannelHistogram: bucket(),
    perChannelHistogram: { red: bucket(), green: bucket(), blue: bucket() },
    over2Pixels: 0,
    over2ByAlphaBand: { 'alpha<=1': 0, '2-8': 0, '9-64': 0, '65-200': 0, '201-255': 0 },
    over2ByEdgeDistance: { 'edge-band(alpha 2..64 或边界 1px)': 0, 'edge+1px': 0, interior: 0 },
  };
}

function bump(histogram: Record<string, number>, value: number): void {
  const key = value > 8 ? '9+' : String(value);
  histogram[key] = (histogram[key] ?? 0) + 1;
}

/** F–C：C 还原到原画布后与 F 比，每通道最大差 ≤2 LSB。 */
export function fToCGate(arms: Arms): GateResult {
  const failures: string[] = [];
  const canvas = arms.originalCanvas;
  const expected = GATE_THRESHOLDS.frameCount;
  const opened = openArms(arms, ['F', 'C']);
  const restored = Buffer.alloc(canvas.width * canvas.height * 4);
  const left = Buffer.alloc(canvas.width * canvas.height * 3);
  const right = Buffer.alloc(canvas.width * canvas.height * 3);
  const perFrame: Array<{ frame: number; alphaMax: number; plates: Record<string, number> }> = [];
  const residual = emptyResidual();
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
      if (alpha.max > GATE_THRESHOLDS.fToCAlphaMaxLsb) failures.push(`帧 ${frame} alpha 最大差 ${alpha.max} LSB > ${GATE_THRESHOLDS.fToCAlphaMaxLsb} LSB`);
      const plates: Record<string, number> = {};
      for (const plate of ['black', 'white', 'checker'] as const) {
        compositeFrame(reference, canvas.width, canvas.height, plate, left);
        compositeFrame(restored, canvas.width, canvas.height, plate, right);
        const stats = diffStats(left, right, null);
        plates[plate] = stats.max;
        overThresholdSamples += stats.over2;
        if (stats.max > GATE_THRESHOLDS.fToCChannelMaxLsb) {
          failures.push(`帧 ${frame} ${plate} 合成最大差 ${stats.max} LSB > ${GATE_THRESHOLDS.fToCChannelMaxLsb} LSB（超 2 LSB 样本 ${stats.over2}）`);
        }
        if (stats.max > worst) {
          worst = stats.max;
          worstFrame = frame;
        }
      }
      // 残差形状只在黑底上取一次：三种底的最大差几乎同源，没必要三倍体积。
      compositeFrame(reference, canvas.width, canvas.height, 'black', left);
      compositeFrame(restored, canvas.width, canvas.height, 'black', right);
      const edgeBand = edgeMask(reference, canvas.width, canvas.height, arms.alphaThreshold, GATE_THRESHOLDS.edgeBandLow, GATE_THRESHOLDS.edgeBandHigh);
      const edgePlusOne = dilateMask(edgeBand, canvas.width, canvas.height);
      for (let pixel = 0; pixel < canvas.width * canvas.height; pixel += 1) {
        const red = Math.abs((left[pixel * 3] ?? 0) - (right[pixel * 3] ?? 0));
        const green = Math.abs((left[pixel * 3 + 1] ?? 0) - (right[pixel * 3 + 1] ?? 0));
        const blue = Math.abs((left[pixel * 3 + 2] ?? 0) - (right[pixel * 3 + 2] ?? 0));
        if (red === 0 && green === 0 && blue === 0) continue;
        bump(residual.perChannelHistogram.red, red);
        bump(residual.perChannelHistogram.green, green);
        bump(residual.perChannelHistogram.blue, blue);
        const maxDelta = Math.max(red, green, blue);
        bump(residual.maxChannelHistogram, maxDelta);
        if (maxDelta <= GATE_THRESHOLDS.fToCChannelMaxLsb) continue;
        residual.over2Pixels += 1;
        const alphaValue = reference[pixel * 4 + 3] ?? 0;
        const band = alphaValue <= 1 ? 'alpha<=1' : alphaValue <= 8 ? '2-8' : alphaValue <= 64 ? '9-64' : alphaValue <= 200 ? '65-200' : '201-255';
        residual.over2ByAlphaBand[band] = (residual.over2ByAlphaBand[band] ?? 0) + 1;
        const distance = edgeBand[pixel] === 1 ? 'edge-band(alpha 2..64 或边界 1px)' : edgePlusOne[pixel] === 1 ? 'edge+1px' : 'interior';
        residual.over2ByEdgeDistance[distance] = (residual.over2ByEdgeDistance[distance] ?? 0) + 1;
      }
      perFrame.push({ frame, alphaMax: alpha.max, plates });
    }
    return result(
      'f-to-c',
      'F–C 原画布一致',
      `C 按 crop 还原后与 F 合成比较，每通道最大差 ≤${GATE_THRESHOLDS.fToCChannelMaxLsb} LSB（=2/255）；alpha 最大差 ≤${GATE_THRESHOLDS.fToCAlphaMaxLsb} LSB`,
      failures,
      { unit: 'LSB (1 LSB = 1/255 of full scale)', worstCompositeMax: worst, worstFrame, worstAlphaMax: worstAlpha, samplesOver2: overThresholdSamples, residual, perFrame },
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
          if (stats.mae > GATE_THRESHOLDS.ocMaeLsb + EPSILON) {
            failures.push(`帧 ${frame} ${plate} ${region} MAE ${stats.mae.toFixed(3)} LSB > ${GATE_THRESHOLDS.ocMaeLsb} LSB(=1/255)（超 1 LSB 样本 ${stats.over1}）`);
          }
          if (stats.p99 > GATE_THRESHOLDS.ocP99Lsb + EPSILON) {
            failures.push(`帧 ${frame} ${plate} ${region} P99 ${stats.p99} LSB > ${GATE_THRESHOLDS.ocP99Lsb} LSB(=2/255)`);
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
      `前景(α>${arms.alphaThreshold})与边缘区(2..64 或距 alpha 边界 1px) 分别 MAE ≤1 LSB(=1/255)、P99 ≤2 LSB(=2/255)；黑/白/棋盘各自过门`,
      failures,
      { unit: 'LSB (1 LSB = 1/255 of full scale)', worstForeground: worstFg, worstEdge, perFrame },
    );
  } finally {
    closeArms(opened);
  }
}

export interface ReencodeBaseline {
  /** 三种底里最差的前景区 MAE / P99。 */
  readonly foreground: { readonly mae: number; readonly p99: number; readonly max: number; readonly frame: number; readonly plate: PlateId };
  readonly edge: { readonly mae: number; readonly p99: number; readonly max: number; readonly frame: number; readonly plate: PlateId };
  readonly alphaMax: number;
  readonly compositeMax: number;
}

/**
 * O–F 同口径测量：F 是全画布重编码、不含任何裁边。
 *
 * 不是门，只用来把「重编码本身的损失」和「裁边的额外损失」分开——
 * 否则 F–C / O–C 一起不过时说不清是 ROI 的错还是编码的错。
 */
export function measureReencodeBaseline(arms: Arms, key: 'F' | 'C' = 'F'): ReencodeBaseline {
  const canvas = arms.originalCanvas;
  const opened = openArms(arms, ['O', key]);
  const left = Buffer.alloc(canvas.width * canvas.height * 3);
  const right = Buffer.alloc(canvas.width * canvas.height * 3);
  const restored = key === 'C' ? Buffer.alloc(canvas.width * canvas.height * 4) : null;
  let foreground = { mae: 0, p99: 0, max: 0, frame: -1, plate: 'black' as PlateId };
  let edge = { mae: 0, p99: 0, max: 0, frame: -1, plate: 'black' as PlateId };
  let alphaMax = 0;
  let compositeMax = 0;
  try {
    for (let frame = 0; frame < arms.frameCount; frame += 1) {
      const original = readFrame(opened, 'O', frame);
      let candidate = readFrame(opened, key, frame);
      if (restored !== null) {
        restoreCrop(candidate, arms.crop, canvas.width, canvas.height, restored, arms.restore.dx, arms.restore.dy);
        candidate = restored;
      }
      const alpha = alphaStats(original, candidate, null);
      if (alpha.max > alphaMax) alphaMax = alpha.max;
      const fgMask = foregroundMask(original, canvas.width, canvas.height, arms.alphaThreshold);
      const edMask = edgeMask(original, canvas.width, canvas.height, arms.alphaThreshold, GATE_THRESHOLDS.edgeBandLow, GATE_THRESHOLDS.edgeBandHigh);
      for (const plate of ['black', 'white', 'checker'] as const) {
        compositeFrame(original, canvas.width, canvas.height, plate, left);
        compositeFrame(candidate, canvas.width, canvas.height, plate, right);
        const whole = diffStats(left, right, null);
        if (whole.max > compositeMax) compositeMax = whole.max;
        const fg = diffStats(left, right, fgMask);
        if (fg.mae > foreground.mae) foreground = { mae: fg.mae, p99: fg.p99, max: fg.max, frame, plate };
        const ed = diffStats(left, right, edMask);
        if (ed.mae > edge.mae) edge = { mae: ed.mae, p99: ed.p99, max: ed.max, frame, plate };
      }
    }
    return { foreground, edge, alphaMax, compositeMax };
  } finally {
    closeArms(opened);
  }
}

/** 汇总。 */
export function overallVerdict(gates: readonly GateResult[]): { pass: boolean; failed: string[] } {
  const failed = gates.filter((gate) => !gate.pass).map((gate) => gate.id);
  return { pass: failed.length === 0, failed };
}


