/**
 * 待机 ROI 的纯决策层：manifest 校验 + 是否走 ROI。
 *
 * 不读 DOM、不加载视频、不改播放生命周期。调用方（负责人落 `app/page.ts`）
 * 只消费 `kind === 'roi'` 的整套布局，其余一律回原片。
 * 旧 manifest 不得套到新素材：`decideIdleRoi` 强制要求调用方给出素材 SHA 并与
 * manifest 的 `sourceSha256` 对齐，缺 SHA 即拒绝。
 *
 * @module pet-next/experiments/idle-roi/adapter
 */

import {
  computeIdleRoiLayout,
  isValidCanvasSize,
  isValidCropRect,
  type IdleRoiLayout,
  type IdleRoiManifest,
} from './layout.ts';

/** manifest 解析成功。`manifest` 是逐字段重建的对象，不是入参的引用。 */
export interface IdleRoiManifestOk {
  ok: true;
  manifest: IdleRoiManifest;
}

/** manifest 被拒。`reason` 面向日志/断言，可读且稳定。 */
export interface IdleRoiManifestFail {
  ok: false;
  reason: string;
}

export type IdleRoiManifestResult = IdleRoiManifestOk | IdleRoiManifestFail;

/** 页面上可能出现的四种呈现；只有 `idle` 允许 ROI。 */
export type IdleRoiSelection = 'idle' | 'short' | 'reaction' | 'placeholder';

/** 走 ROI：布局与 manifest 成套给出，调用方不得只取一半。 */
export interface IdleRoiDecisionRoi {
  kind: 'roi';
  layout: IdleRoiLayout;
  manifest: IdleRoiManifest;
}

/** 走原片：全窗口 contain、`assets/idle.webm` 原字节。 */
export interface IdleRoiDecisionOriginal {
  kind: 'original';
  reason: string;
}

export type IdleRoiDecision = IdleRoiDecisionRoi | IdleRoiDecisionOriginal;

/** `decideIdleRoi` 的入参。 */
export interface IdleRoiDecisionInput {
  selection: IdleRoiSelection;
  /** 原始 manifest（可能是 JSON 解析结果、也可能是 undefined）。 */
  manifestRaw: unknown;
  viewWidth: number;
  viewHeight: number;
  enabled: boolean;
  /** 当前真正加载的 idle 素材 SHA256；缺省/非法时不允许走 ROI。 */
  sourceSha256?: string;
}

/** 冻结的契约常量；manifest 里出现别的值说明不是本契约产物。 */
const EXPECTED_ALPHA_THRESHOLD = 1;
const EXPECTED_GUARD = 2;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isIntegerAtLeast(value: unknown, min: number): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= min;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

/** 把拒因里的值渲染成短标签，避免把整个 manifest 灌进日志。 */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value.length > 32 ? `${value.slice(0, 32)}…` : value);
  return Array.isArray(value) ? 'array' : typeof value;
}

function fail(reason: string): IdleRoiManifestFail {
  return { ok: false, reason };
}

/**
 * 校验并重建 manifest。逐字段检查类型/范围；任一不符返回可读拒因。
 *
 * @param raw - 未知输入（JSON 解析结果、fetch 结果等）。
 * @param expected - `sourceSha256` 给定时必须与 manifest 一致（防旧 manifest 套新素材）。
 */
export function parseIdleRoiManifest(
  raw: unknown,
  expected: { sourceSha256?: string } = {},
): IdleRoiManifestResult {
  if (!isRecord(raw)) return fail(`manifest is not an object: ${describe(raw)}`);

  if (raw.kind !== 'idle-roi') return fail(`kind must be "idle-roi": ${describe(raw.kind)}`);
  if (raw.schemaVersion !== 1) return fail(`schemaVersion must be 1: ${describe(raw.schemaVersion)}`);
  if (!isNonEmptyString(raw.sourcePath)) return fail('sourcePath must be a non-empty string');
  if (!isSha256(raw.sourceSha256)) return fail(`sourceSha256 must be 64 hex chars: ${describe(raw.sourceSha256)}`);
  if (!isSha256(raw.candidateSha256)) {
    return fail(`candidateSha256 must be 64 hex chars: ${describe(raw.candidateSha256)}`);
  }

  const originalCanvas = raw.originalCanvas;
  if (!isValidCanvasSize(originalCanvas)) {
    return fail('originalCanvas.width/height must be positive finite numbers');
  }
  const crop = raw.crop;
  if (!isValidCropRect(crop, originalCanvas)) {
    return fail('crop must be positive, non-negative offset, and inside originalCanvas');
  }

  if (raw.alphaThreshold !== EXPECTED_ALPHA_THRESHOLD) {
    return fail(`alphaThreshold must be ${EXPECTED_ALPHA_THRESHOLD}: ${describe(raw.alphaThreshold)}`);
  }
  if (raw.guard !== EXPECTED_GUARD) return fail(`guard must be ${EXPECTED_GUARD}: ${describe(raw.guard)}`);

  if (typeof raw.codec !== 'string' || raw.codec.toLowerCase() !== 'vp9') {
    return fail(`codec must be "vp9": ${describe(raw.codec)}`);
  }
  if (typeof raw.pixelFormat !== 'string' || raw.pixelFormat.toLowerCase() !== 'yuva420p') {
    return fail(`pixelFormat must be "yuva420p": ${describe(raw.pixelFormat)}`);
  }

  const colorTags = raw.colorTags;
  if (!isRecord(colorTags)) return fail('colorTags must be an object');
  const primaries = colorTags.primaries;
  const transfer = colorTags.transfer;
  const matrix = colorTags.matrix;
  const colorRange = colorTags.range;
  if (!isNonEmptyString(primaries)) return fail('colorTags.primaries must be a non-empty string');
  if (!isNonEmptyString(transfer)) return fail('colorTags.transfer must be a non-empty string');
  if (!isNonEmptyString(matrix)) return fail('colorTags.matrix must be a non-empty string');
  if (!isNonEmptyString(colorRange)) return fail('colorTags.range must be a non-empty string');

  if (!isIntegerAtLeast(raw.frameCount, 1)) {
    return fail(`frameCount must be an integer >= 1: ${describe(raw.frameCount)}`);
  }
  const frameCount = raw.frameCount;

  const pts = raw.pts;
  if (!isRecord(pts)) return fail('pts must be an object');
  if (!isIntegerAtLeast(pts.count, 1)) return fail(`pts.count must be an integer >= 1: ${describe(pts.count)}`);
  if (pts.count !== frameCount) return fail(`pts.count (${pts.count}) must equal frameCount (${frameCount})`);
  if (!isFiniteNumber(pts.firstMs)) return fail('pts.firstMs must be a finite number');
  if (!isFiniteNumber(pts.lastMs)) return fail('pts.lastMs must be a finite number');
  if (pts.lastMs < pts.firstMs) return fail('pts.lastMs must be >= pts.firstMs');
  if (!isPositiveNumber(pts.stepMs)) return fail('pts.stepMs must be a positive finite number');
  if (!isPositiveNumber(pts.minDeltaMs)) return fail('pts.minDeltaMs must be a positive finite number');
  if (!isFiniteNumber(pts.maxDeltaMs)) return fail('pts.maxDeltaMs must be a finite number');
  if (pts.maxDeltaMs < pts.minDeltaMs) return fail('pts.maxDeltaMs must be >= pts.minDeltaMs');

  if (!isPositiveNumber(raw.durationMs)) return fail('durationMs must be a positive finite number');
  if (!isIntegerAtLeast(raw.loopFrames, 1)) {
    return fail(`loopFrames must be an integer >= 1: ${describe(raw.loopFrames)}`);
  }
  if (!isNonEmptyString(raw.generatedBy)) return fail('generatedBy must be a non-empty string');
  if (!isNonEmptyString(raw.ffmpeg)) return fail('ffmpeg must be a non-empty string');
  if (!isNonEmptyString(raw.builtAt)) return fail('builtAt must be a non-empty string');

  const sourceSha256 = raw.sourceSha256.toLowerCase();
  if (expected.sourceSha256 !== undefined) {
    if (!isSha256(expected.sourceSha256)) {
      return fail(`expected sourceSha256 is not 64 hex chars: ${describe(expected.sourceSha256)}`);
    }
    if (expected.sourceSha256.toLowerCase() !== sourceSha256) {
      return fail(`sourceSha256 mismatch: manifest ${sourceSha256} vs asset ${expected.sourceSha256.toLowerCase()}`);
    }
  }

  return {
    ok: true,
    manifest: {
      schemaVersion: 1,
      kind: 'idle-roi',
      sourcePath: raw.sourcePath,
      sourceSha256,
      candidateSha256: raw.candidateSha256.toLowerCase(),
      originalCanvas: { width: originalCanvas.width, height: originalCanvas.height },
      crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
      alphaThreshold: EXPECTED_ALPHA_THRESHOLD,
      guard: EXPECTED_GUARD,
      codec: 'vp9',
      pixelFormat: 'yuva420p',
      colorTags: { primaries, transfer, matrix, range: colorRange },
      frameCount,
      pts: {
        count: pts.count,
        firstMs: pts.firstMs,
        lastMs: pts.lastMs,
        stepMs: pts.stepMs,
        minDeltaMs: pts.minDeltaMs,
        maxDeltaMs: pts.maxDeltaMs,
      },
      durationMs: raw.durationMs,
      loopFrames: raw.loopFrames,
      generatedBy: raw.generatedBy,
      ffmpeg: raw.ffmpeg,
      builtAt: raw.builtAt,
    },
  };
}

function original(reason: string): IdleRoiDecisionOriginal {
  return { kind: 'original', reason };
}

/**
 * 判定本次呈现用 ROI 还是原片。
 *
 * 顺序：开关 → selection → 素材 SHA 是否对齐 → manifest → 布局。
 * 任一环节不成立都回原片并带可读 `reason`；成功时布局与 manifest 成套返回。
 *
 * @param input - 选择、原始 manifest、视口尺寸、开关、当前素材 SHA。
 */
export function decideIdleRoi(input: IdleRoiDecisionInput): IdleRoiDecision {
  if (!isRecord(input)) return original('invalid input: expected an object');

  if (input.enabled !== true) return original('disabled: switch is off, keep original idle video');

  const selection = input.selection;
  if (selection !== 'idle') return original(`selection=${describe(selection)}: only idle may use ROI`);

  if (!isSha256(input.sourceSha256)) {
    return original('missing source sha: cannot prove manifest matches the loaded asset');
  }

  const parsed = parseIdleRoiManifest(input.manifestRaw, { sourceSha256: input.sourceSha256 });
  if (!parsed.ok) return original(`manifest rejected: ${parsed.reason}`);

  const layout = computeIdleRoiLayout({
    viewWidth: input.viewWidth,
    viewHeight: input.viewHeight,
    originalCanvas: parsed.manifest.originalCanvas,
    crop: parsed.manifest.crop,
  });
  if (layout === null) {
    return original(
      `layout unavailable: viewport ${describe(input.viewWidth)}x${describe(input.viewHeight)} is invalid`,
    );
  }

  return { kind: 'roi', layout, manifest: parsed.manifest };
}

/** 四个 CSS 声明，成套产生（调用方不得只写其中一部分）。 */
export interface IdleRoiStyle {
  left: string;
  top: string;
  width: string;
  height: string;
}

/** DIP → CSS 字符串：保留 3 位小数，去掉浮点噪声，不加 `px` 以外的单位。 */
function toCssPixels(value: number): string {
  return `${Math.round(value * 1000) / 1000}px`;
}

/**
 * 把布局转成 CSS 左/上/宽/高。纯 DIP，**不乘 DPR**。
 *
 * @param layout - `decideIdleRoi` 的 `layout`。
 */
export function formatIdleRoiStyle(layout: IdleRoiLayout): IdleRoiStyle {
  return {
    left: toCssPixels(layout.left),
    top: toCssPixels(layout.top),
    width: toCssPixels(layout.width),
    height: toCssPixels(layout.height),
  };
}
