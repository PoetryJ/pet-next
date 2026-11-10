/**
 * M3-12：可见待机裁边的跨端契约（纯函数、零依赖、不引 Electron/DOM）。
 *
 * 只负责三件事：manifest 形状与合法性、原画布 → 视口的 contain 布局、以及
 * “这次该用原片还是 ROI”的纯决策。页面只消费结果，不自己算偏移。
 *
 * 边界：产品不 import `experiments/`；实验侧（`experiments/idle-roi/`）只 re-export 本文件，
 * 单测对同一份字节下断言。
 *
 * 重要语义：
 * - 布局数值是 DIP，调用方**不得再乘 DPR**；
 * - 无效 manifest / 开关关闭 / 非 idle 选择一律回原片，并给出可读原因；
 * - 同一帧率、同一时间轴、同一原画布；本模块不做任何像素处理。
 * @module pet-next/experiments/idle-roi/core
 */

/** 裁框（像素，原画布坐标系）。 */
export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 视口内的显示布局（DIP）。 */
export interface IdleRoiLayout {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** `width / originalCanvas.width * crop.width` 的等价缩放比，便于调用方复核。 */
  readonly scale: number;
}

/** 逐帧 PTS 摘要（毫秒）。 */
export interface IdleRoiPts {
  readonly count: number;
  readonly firstMs: number;
  readonly lastMs: number;
  readonly stepMs: number;
  readonly minDeltaMs: number;
  readonly maxDeltaMs: number;
}

/** 离线编译产物 manifest（字段冻结见 docs/M3-12-IDLE-ROI.md）。 */
export interface IdleRoiManifest {
  readonly schemaVersion: 1;
  readonly kind: 'idle-roi';
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly candidateSha256: string;
  readonly originalCanvas: { readonly width: number; readonly height: number };
  readonly crop: CropRect;
  /** 本轮固定 1；提高阈值会伤前景，契约不允许。 */
  readonly alphaThreshold: 1;
  readonly guard: number;
  readonly codec: string;
  readonly pixelFormat: string;
  readonly colorTags: {
    readonly primaries: string;
    readonly transfer: string;
    readonly matrix: string;
    readonly range: string;
  };
  readonly frameCount: number;
  readonly pts: IdleRoiPts;
  readonly durationMs: number;
  readonly loopFrames: number;
  readonly generatedBy: string;
  readonly ffmpeg: string;
  readonly builtAt: string;
}

/** 页面可消费的选择令牌；只认 idle 走 ROI。 */
export type IdleRoiSelection = 'idle' | 'short' | 'reaction' | 'placeholder';

/** 决策结果：要么给布局，要么明确回原片。 */
export type IdleRoiDecision =
  | { readonly kind: 'roi'; readonly layout: IdleRoiLayout; readonly manifest: IdleRoiManifest }
  | { readonly kind: 'original'; readonly reason: string };

const HEX64 = /^[0-9a-f]{64}$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readPositiveInt(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  if (!isFiniteNumber(value) || value <= 0 || !Number.isInteger(value)) return null;
  return value;
}

/**
 * 解析并校验 manifest。
 *
 * 只校验形状与自身一致性（crop 在画布内、PTS 单调、sha 形态），不读文件、不算哈希；
 * 调用方负责把“文件名 → sha”这一层对上（`expectedSourceSha256`）。
 *
 * @param raw - 未信任的 JSON。
 * @param expected - 期望的原片 sha（可选；给了就必须相等）。
 * @returns 合法 manifest，或带可读原因的失败。
 */
export function parseIdleRoiManifest(
  raw: unknown,
  expected: { readonly sourceSha256?: string } = {},
): { ok: true; manifest: IdleRoiManifest } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'manifest 不是对象' };
  }
  const m = raw as Record<string, unknown>;
  if (m['schemaVersion'] !== 1) return { ok: false, reason: 'schemaVersion 必须是 1' };
  if (m['kind'] !== 'idle-roi') return { ok: false, reason: 'kind 必须是 idle-roi' };
  if (m['alphaThreshold'] !== 1) return { ok: false, reason: 'alphaThreshold 必须是 1（不得提高）' };

  const sourceSha256 = m['sourceSha256'];
  const candidateSha256 = m['candidateSha256'];
  if (typeof sourceSha256 !== 'string' || !HEX64.test(sourceSha256)) {
    return { ok: false, reason: 'sourceSha256 必须是 64 位小写 hex' };
  }
  if (typeof candidateSha256 !== 'string' || !HEX64.test(candidateSha256)) {
    return { ok: false, reason: 'candidateSha256 必须是 64 位小写 hex' };
  }
  if (expected.sourceSha256 !== undefined && expected.sourceSha256 !== sourceSha256) {
    return { ok: false, reason: 'sourceSha256 与当前原片不匹配' };
  }

  const canvas = m['originalCanvas'];
  if (typeof canvas !== 'object' || canvas === null) return { ok: false, reason: 'originalCanvas 缺失' };
  const canvasWidth = readPositiveInt(canvas as Record<string, unknown>, 'width');
  const canvasHeight = readPositiveInt(canvas as Record<string, unknown>, 'height');
  if (canvasWidth === null || canvasHeight === null) {
    return { ok: false, reason: 'originalCanvas 宽高必须是正整数' };
  }

  const cropRaw = m['crop'];
  if (typeof cropRaw !== 'object' || cropRaw === null) return { ok: false, reason: 'crop 缺失' };
  const c = cropRaw as Record<string, unknown>;
  const cropWidth = readPositiveInt(c, 'width');
  const cropHeight = readPositiveInt(c, 'height');
  if (cropWidth === null || cropHeight === null) {
    return { ok: false, reason: 'crop 宽高必须是正整数' };
  }
  const cropX = c['x'];
  const cropY = c['y'];
  if (!isFiniteNumber(cropX) || !isFiniteNumber(cropY) || !Number.isInteger(cropX) || !Number.isInteger(cropY)) {
    return { ok: false, reason: 'crop 原点必须是整数' };
  }
  if (cropX < 0 || cropY < 0 || cropX + cropWidth > canvasWidth || cropY + cropHeight > canvasHeight) {
    return { ok: false, reason: 'crop 越出原画布' };
  }
  if (cropWidth % 2 !== 0 || cropHeight % 2 !== 0 || cropX % 2 !== 0 || cropY % 2 !== 0) {
    return { ok: false, reason: 'crop 必须偶数对齐（yuva420p 色度单位）' };
  }

  const frameCount = readPositiveInt(m, 'frameCount');
  if (frameCount === null) return { ok: false, reason: 'frameCount 必须是正整数' };

  const ptsRaw = m['pts'];
  if (typeof ptsRaw !== 'object' || ptsRaw === null) return { ok: false, reason: 'pts 摘要缺失' };
  const pts = ptsRaw as Record<string, unknown>;
  const ptsCount = readPositiveInt(pts, 'count');
  if (ptsCount === null || ptsCount !== frameCount) {
    return { ok: false, reason: 'pts.count 必须等于 frameCount' };
  }
  const firstMs = pts['firstMs'];
  const lastMs = pts['lastMs'];
  const stepMs = pts['stepMs'];
  const minDeltaMs = pts['minDeltaMs'];
  const maxDeltaMs = pts['maxDeltaMs'];
  if (![firstMs, lastMs, stepMs, minDeltaMs, maxDeltaMs].every(isFiniteNumber)) {
    return { ok: false, reason: 'pts 数值必须是有限数' };
  }
  if ((lastMs as number) < (firstMs as number)) return { ok: false, reason: 'pts 末帧早于首帧' };
  if ((minDeltaMs as number) <= 0 || (maxDeltaMs as number) <= 0) {
    return { ok: false, reason: 'pts 帧间隔必须为正' };
  }
  if ((minDeltaMs as number) > (maxDeltaMs as number)) {
    return { ok: false, reason: 'pts 最小间隔大于最大间隔' };
  }

  const durationMs = m['durationMs'];
  if (!isFiniteNumber(durationMs) || durationMs <= 0) return { ok: false, reason: 'durationMs 必须是正数' };

  const loopFrames = readPositiveInt(m, 'loopFrames');
  if (loopFrames === null) return { ok: false, reason: 'loopFrames 必须是正整数' };

  for (const key of ['sourcePath', 'codec', 'pixelFormat', 'generatedBy', 'ffmpeg', 'builtAt'] as const) {
    if (typeof m[key] !== 'string' || (m[key] as string).length === 0) {
      return { ok: false, reason: `${key} 缺失或为空` };
    }
  }
  const tags = m['colorTags'];
  if (typeof tags !== 'object' || tags === null) return { ok: false, reason: 'colorTags 缺失' };
  for (const key of ['primaries', 'transfer', 'matrix', 'range'] as const) {
    const value = (tags as Record<string, unknown>)[key];
    if (typeof value !== 'string' || value.length === 0) {
      return { ok: false, reason: `colorTags.${key} 缺失` };
    }
  }

  return {
    ok: true,
    manifest: {
      schemaVersion: 1,
      kind: 'idle-roi',
      sourcePath: m['sourcePath'] as string,
      sourceSha256,
      candidateSha256,
      originalCanvas: { width: canvasWidth, height: canvasHeight },
      crop: { x: cropX, y: cropY, width: cropWidth, height: cropHeight },
      alphaThreshold: 1,
      guard: isFiniteNumber(m['guard']) ? (m['guard'] as number) : 0,
      codec: m['codec'] as string,
      pixelFormat: m['pixelFormat'] as string,
      colorTags: {
        primaries: (tags as Record<string, string>)['primaries'] as string,
        transfer: (tags as Record<string, string>)['transfer'] as string,
        matrix: (tags as Record<string, string>)['matrix'] as string,
        range: (tags as Record<string, string>)['range'] as string,
      },
      frameCount,
      pts: {
        count: ptsCount,
        firstMs: firstMs as number,
        lastMs: lastMs as number,
        stepMs: stepMs as number,
        minDeltaMs: minDeltaMs as number,
        maxDeltaMs: maxDeltaMs as number,
      },
      durationMs,
      loopFrames,
      generatedBy: m['generatedBy'] as string,
      ffmpeg: m['ffmpeg'] as string,
      builtAt: m['builtAt'] as string,
    },
  };
}

/**
 * 计算 ROI 在视口中的显示布局（沿用 `object-fit: contain`）。
 *
 * ```
 * s = min(viewW / origW, viewH / origH)
 * left = (viewW - origW * s) / 2 + crop.x * s
 * top  = (viewH - origH * s) / 2 + crop.y * s
 * ```
 *
 * @param input - 视口尺寸（DIP）、原画布、裁框。
 * @returns 布局；任何非有限/非正输入返回 null（调用方必须回原片）。
 */
export function computeIdleRoiLayout(input: {
  readonly viewWidth: number;
  readonly viewHeight: number;
  readonly originalCanvas: { readonly width: number; readonly height: number };
  readonly crop: CropRect;
}): IdleRoiLayout | null {
  const { viewWidth, viewHeight, originalCanvas, crop } = input;
  if (![viewWidth, viewHeight].every((v) => isFiniteNumber(v) && v > 0)) return null;
  if (![originalCanvas.width, originalCanvas.height].every((v) => isFiniteNumber(v) && v > 0)) return null;
  if (![crop.width, crop.height].every((v) => isFiniteNumber(v) && v > 0)) return null;
  if (![crop.x, crop.y].every(isFiniteNumber)) return null;
  if (crop.x < 0 || crop.y < 0) return null;
  if (crop.x + crop.width > originalCanvas.width || crop.y + crop.height > originalCanvas.height) return null;

  const scale = Math.min(viewWidth / originalCanvas.width, viewHeight / originalCanvas.height);
  if (!isFiniteNumber(scale) || scale <= 0) return null;

  return {
    left: (viewWidth - originalCanvas.width * scale) / 2 + crop.x * scale,
    top: (viewHeight - originalCanvas.height * scale) / 2 + crop.y * scale,
    width: crop.width * scale,
    height: crop.height * scale,
    scale,
  };
}

/**
 * 纯决策：这次该用 ROI 还是原片。
 *
 * @param input - 开关、当前选择、视口、未信任 manifest、可选的原片 sha。
 * @returns `roi`（附布局与 manifest）或 `original`（附原因）。
 */
export function decideIdleRoi(input: {
  readonly enabled: boolean;
  readonly selection: IdleRoiSelection;
  readonly manifestRaw: unknown;
  readonly viewWidth: number;
  readonly viewHeight: number;
  readonly sourceSha256?: string;
}): IdleRoiDecision {
  if (!input.enabled) return { kind: 'original', reason: '开关关闭' };
  if (input.selection !== 'idle') return { kind: 'original', reason: `当前选择是 ${input.selection}，只对 idle 生效` };
  const parsed = parseIdleRoiManifest(input.manifestRaw, { sourceSha256: input.sourceSha256 });
  if (!parsed.ok) return { kind: 'original', reason: parsed.reason };
  const layout = computeIdleRoiLayout({
    viewWidth: input.viewWidth,
    viewHeight: input.viewHeight,
    originalCanvas: parsed.manifest.originalCanvas,
    crop: parsed.manifest.crop,
  });
  if (layout === null) return { kind: 'original', reason: '视口/画布参数无法得出布局' };
  return { kind: 'roi', layout, manifest: parsed.manifest };
}

/** 页面查询参数：主进程只在开关打开且 manifest 合法时注入 `x,y,w,h,ow,oh`。 */
export const IDLE_ROI_QUERY = 'idleRoi';

/** 开关环境变量（默认关闭，只有字面量 `1` 才算开）。 */
export const IDLE_ROI_ENV = 'PET_NEXT_IDLE_ROI';

/** manifest 路径环境变量（只在实验/预览时设置；缺省不启用）。 */
export const IDLE_ROI_MANIFEST_ENV = 'PET_NEXT_IDLE_ROI_MANIFEST';

/** 页面需要的全部几何信息。 */
export interface IdleRoiSpec {
  readonly crop: CropRect;
  readonly originalCanvas: { readonly width: number; readonly height: number };
}

/**
 * 把几何信息编码进 URL（主进程 → 页面）。
 *
 * 格式固定为 `x,y,w,h,ow,oh` 六个整数，避免把整份 manifest 塞进 URL。
 *
 * @param spec - 裁框与原画布。
 * @returns 查询参数值。
 */
export function encodeIdleRoiQuery(spec: IdleRoiSpec): string {
  const { crop, originalCanvas } = spec;
  return [crop.x, crop.y, crop.width, crop.height, originalCanvas.width, originalCanvas.height].join(',');
}

/**
 * 解析页面收到的几何参数；任何缺项/非整数返回 null（调用方回原片）。
 *
 * @param raw - URL 查询参数原值。
 * @returns 几何信息，或 null。
 */
export function parseIdleRoiQuery(raw: string | null): IdleRoiSpec | null {
  if (raw === null || raw === '') return null;
  const parts = raw.split(',');
  if (parts.length !== 6) return null;
  const nums = parts.map((part) => Number(part));
  if (!nums.every((value) => Number.isInteger(value) && Number.isFinite(value))) return null;
  const [x, y, width, height, canvasWidth, canvasHeight] = nums as [number, number, number, number, number, number];
  if (width <= 0 || height <= 0 || canvasWidth <= 0 || canvasHeight <= 0) return null;
  if (x < 0 || y < 0 || x + width > canvasWidth || y + height > canvasHeight) return null;
  return {
    crop: { x, y, width, height },
    originalCanvas: { width: canvasWidth, height: canvasHeight },
  };
}

/**
 * 开关判定。
 *
 * @param env - 进程环境。
 * @returns 是否启用。
 */
export function idleRoiEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[IDLE_ROI_ENV] === '1';
}
