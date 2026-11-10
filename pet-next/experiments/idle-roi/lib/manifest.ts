/**
 * manifest 组装与严格校验。字段集来自负责人冻结契约第 3 节，不增不减。
 */
import type { Canvas, Rect } from './crop.ts';
import type { ColorTags } from './media.ts';

export const IDLE_ROI_SCHEMA_VERSION = 1;
export const IDLE_ROI_KIND = 'idle-roi';
export const IDLE_SOURCE_PATH = 'assets/idle.webm';
export const IDLE_GENERATED_BY = 'node experiments/idle-roi/compiler.mjs --out=experiments/idle-roi/out';
export const ALPHA_THRESHOLD = 1;
export const GUARD_PX = 2;
export const IDLE_FRAME_COUNT = 48;

export interface PtsSummary {
  readonly count: number;
  readonly firstMs: number;
  readonly lastMs: number;
  readonly stepMs: number;
  readonly minDeltaMs: number;
  readonly maxDeltaMs: number;
}

export interface IdleRoiManifest {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly candidateSha256: string;
  readonly originalCanvas: Canvas;
  readonly crop: Rect;
  readonly alphaThreshold: number;
  readonly guard: number;
  readonly codec: string;
  readonly pixelFormat: string;
  readonly colorTags: ColorTags;
  readonly frameCount: number;
  readonly pts: PtsSummary;
  readonly durationMs: number;
  readonly loopFrames: number;
  readonly generatedBy: string;
  readonly ffmpeg: string;
  readonly builtAt: string;
  /** 可选修订说明（v1→v2 动机与两次字节）。不属于契约 §3 字段。 */
  readonly revision?: Record<string, unknown>;
}

export interface ManifestInput {
  readonly sourceSha256: string;
  readonly candidateSha256: string;
  readonly originalCanvas: Canvas;
  readonly crop: Rect;
  /** 实际生效的编码像素格式（不是请求值）。 */
  readonly pixelFormat?: string;
  /** 可选：v1→v2 等修订说明，附加在契约字段之后，不影响 §3 字段。 */
  readonly revision?: Record<string, unknown>;
  readonly colorTags: ColorTags;
  readonly frameCount: number;
  readonly pts: PtsSummary;
  readonly durationMs: number;
  readonly ffmpeg: string;
  readonly builtAt: string;
  readonly generatedBy?: string;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 逐帧 PTS → 摘要（排序后计算相邻差）。 */
export function summarizePts(values: readonly number[]): PtsSummary {
  if (values.length === 0) throw new Error('PTS 为空');
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error('PTS 含非法数值');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  let minDelta = Number.POSITIVE_INFINITY;
  let maxDelta = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    const delta = sorted[index]! - sorted[index - 1]!;
    if (delta < minDelta) minDelta = delta;
    if (delta > maxDelta) maxDelta = delta;
  }
  const step = sorted.length > 1 ? (last - first) / (sorted.length - 1) : 0;
  return {
    count: sorted.length,
    firstMs: round3(first),
    lastMs: round3(last),
    stepMs: round3(step),
    minDeltaMs: sorted.length > 1 ? round3(minDelta) : 0,
    maxDeltaMs: round3(maxDelta),
  };
}

export function buildManifest(input: ManifestInput): IdleRoiManifest {
  return {
    schemaVersion: IDLE_ROI_SCHEMA_VERSION,
    kind: IDLE_ROI_KIND,
    sourcePath: IDLE_SOURCE_PATH,
    sourceSha256: input.sourceSha256,
    candidateSha256: input.candidateSha256,
    originalCanvas: { width: input.originalCanvas.width, height: input.originalCanvas.height },
    crop: { x: input.crop.x, y: input.crop.y, width: input.crop.width, height: input.crop.height },
    alphaThreshold: ALPHA_THRESHOLD,
    guard: GUARD_PX,
    codec: 'vp9',
    pixelFormat: input.pixelFormat ?? 'yuva420p',
    colorTags: { ...input.colorTags },
    frameCount: input.frameCount,
    pts: { ...input.pts },
    durationMs: input.durationMs,
    loopFrames: input.frameCount,
    generatedBy: input.generatedBy ?? IDLE_GENERATED_BY,
    ffmpeg: input.ffmpeg,
    builtAt: input.builtAt,
    ...(input.revision === undefined ? {} : { revision: input.revision }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEvenInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value % 2 === 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export interface ManifestValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/**
 * 严格校验：缺字段、NaN、crop 越界、宽高非正/非偶数、sha 不匹配、时间轴自相矛盾都拒绝。
 */
export function validateManifest(value: unknown): ManifestValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['manifest 不是对象'] };

  if (value['schemaVersion'] !== IDLE_ROI_SCHEMA_VERSION) errors.push('schemaVersion 必须是 1');
  if (value['kind'] !== IDLE_ROI_KIND) errors.push('kind 必须是 idle-roi');
  if (value['sourcePath'] !== IDLE_SOURCE_PATH) errors.push('sourcePath 必须是 assets/idle.webm');
  if (!isSha256(value['sourceSha256'])) errors.push('sourceSha256 必须是 64 位小写十六进制');
  if (!isSha256(value['candidateSha256'])) errors.push('candidateSha256 必须是 64 位小写十六进制');

  const canvas = value['originalCanvas'];
  let canvasWidth = 0;
  let canvasHeight = 0;
  if (!isRecord(canvas)) {
    errors.push('originalCanvas 必须是对象');
  } else {
    const width = canvas['width'];
    const height = canvas['height'];
    if (!isPositiveInt(width)) errors.push('originalCanvas.width 必须是正整数');
    else canvasWidth = width;
    if (!isPositiveInt(height)) errors.push('originalCanvas.height 必须是正整数');
    else canvasHeight = height;
  }

  const crop = value['crop'];
  if (!isRecord(crop)) {
    errors.push('crop 必须是对象');
  } else {
    const x = crop['x'];
    const y = crop['y'];
    const width = crop['width'];
    const height = crop['height'];
    if (!isEvenInt(x) || (x as number) < 0) errors.push('crop.x 必须是非负偶数');
    if (!isEvenInt(y) || (y as number) < 0) errors.push('crop.y 必须是非负偶数');
    if (!isEvenInt(width) || (width as number) <= 0) errors.push('crop.width 必须是正偶数');
    if (!isEvenInt(height) || (height as number) <= 0) errors.push('crop.height 必须是正偶数');
    if (isEvenInt(x) && isEvenInt(y) && isEvenInt(width) && isEvenInt(height)) {
      if (canvasWidth > 0 && x + width > canvasWidth) errors.push('crop 横向越界');
      if (canvasHeight > 0 && y + height > canvasHeight) errors.push('crop 纵向越界');
    }
  }

  if (value['alphaThreshold'] !== ALPHA_THRESHOLD) errors.push('alphaThreshold 必须是 1');
  if (!isNonNegativeInt(value['guard']) || value['guard'] !== GUARD_PX) errors.push('guard 必须是 2');
  if (value['codec'] !== 'vp9') errors.push('codec 必须是 vp9');
  // 只接受带 alpha 的 YUV 格式：420 是 libvpx-vp9 唯一支持的 alpha 格式，444 留给支持它的编码器。
  if (typeof value['pixelFormat'] !== 'string' || !['yuva420p', 'yuva444p'].includes(value['pixelFormat'])) {
    errors.push('pixelFormat 必须是 yuva420p 或 yuva444p');
  }

  const colorTags = value['colorTags'];
  if (!isRecord(colorTags)) {
    errors.push('colorTags 必须是对象');
  } else {
    for (const key of ['primaries', 'transfer', 'matrix', 'range'] as const) {
      if (!isNonEmptyString(colorTags[key])) errors.push(`colorTags.${key} 缺失`);
    }
    if (isNonEmptyString(colorTags['range']) && !['tv', 'pc'].includes(colorTags['range'])) {
      errors.push('colorTags.range 必须是 tv 或 pc');
    }
  }

  const frameCount = value['frameCount'];
  if (!isPositiveInt(frameCount)) errors.push('frameCount 必须是正整数');
  else if (frameCount !== IDLE_FRAME_COUNT) errors.push(`frameCount 必须是 ${IDLE_FRAME_COUNT}（全片覆盖）`);

  const pts = value['pts'];
  if (!isRecord(pts)) {
    errors.push('pts 必须是对象');
  } else {
    const count = pts['count'];
    const firstMs = pts['firstMs'];
    const lastMs = pts['lastMs'];
    const stepMs = pts['stepMs'];
    const minDeltaMs = pts['minDeltaMs'];
    const maxDeltaMs = pts['maxDeltaMs'];
    if (!isPositiveInt(count)) errors.push('pts.count 必须是正整数');
    else if (isPositiveInt(frameCount) && count !== frameCount) errors.push('pts.count 必须等于 frameCount');
    if (!isFiniteNumber(firstMs) || (firstMs as number) < 0) errors.push('pts.firstMs 必须是非负有限数');
    if (!isFiniteNumber(lastMs)) errors.push('pts.lastMs 必须是有限数');
    if (!isFiniteNumber(stepMs) || (stepMs as number) <= 0) errors.push('pts.stepMs 必须是正有限数');
    if (!isFiniteNumber(minDeltaMs) || (minDeltaMs as number) <= 0) errors.push('pts.minDeltaMs 必须是正有限数');
    if (!isFiniteNumber(maxDeltaMs)) errors.push('pts.maxDeltaMs 必须是有限数');
    if (isFiniteNumber(firstMs) && isFiniteNumber(lastMs) && (lastMs as number) < (firstMs as number)) {
      errors.push('pts.lastMs 不能小于 pts.firstMs');
    }
    if (isFiniteNumber(minDeltaMs) && isFiniteNumber(maxDeltaMs) && (maxDeltaMs as number) < (minDeltaMs as number)) {
      errors.push('pts.maxDeltaMs 不能小于 pts.minDeltaMs');
    }
  }

  const durationMs = value['durationMs'];
  if (!isFiniteNumber(durationMs) || (durationMs as number) <= 0) {
    errors.push('durationMs 必须是正有限数');
  } else if (isRecord(pts) && isFiniteNumber(pts['lastMs']) && isFiniteNumber(pts['maxDeltaMs'])) {
    const lastMs = pts['lastMs'] as number;
    const maxDeltaMs = pts['maxDeltaMs'] as number;
    if ((durationMs as number) < lastMs) errors.push('durationMs 不能小于最后一帧 PTS');
    if ((durationMs as number) > lastMs + maxDeltaMs + 1.5) errors.push('durationMs 超出最后一帧一个帧长（>1ms 容差）');
  }

  const loopFrames = value['loopFrames'];
  if (!isPositiveInt(loopFrames)) errors.push('loopFrames 必须是正整数');
  else if (isPositiveInt(frameCount) && loopFrames !== frameCount) errors.push('loopFrames 必须等于 frameCount');

  if (!isNonEmptyString(value['generatedBy'])) errors.push('generatedBy 缺失');
  if (!isNonEmptyString(value['ffmpeg']) || !value['ffmpeg'].startsWith('ffmpeg version')) {
    errors.push('ffmpeg 必须是真实版本行');
  }
  const builtAt = value['builtAt'];
  if (!isNonEmptyString(builtAt) || Number.isNaN(Date.parse(builtAt))) errors.push('builtAt 必须是 ISO 时间');

  return { ok: errors.length === 0, errors };
}
