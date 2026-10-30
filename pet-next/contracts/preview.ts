/**
 * 预览开关的解析。默认关闭双槽、自主行为和候选素材。
 * 页面和主进程只读解析结果；本文件不加载适配器，也不改播放。
 * @module pet-next/contracts/preview
 */

/** 主进程转给页面的环境变量。未设置时不写入查询串。 */
export const PREVIEW_ENV = 'PET_NEXT_PREVIEW';

/** 页面查询参数名。 */
export const PREVIEW_QUERY = 'preview';

/** 已验收路径是 `single` 且 `behavior` 为 false。 */
export const PLAYBACK_MODES = ['single', 'two-slot', 'two-slot-preheat'] as const;

export type PlaybackMode = (typeof PLAYBACK_MODES)[number];

/** 自动动作节奏。`demo` 是演示节奏，`daily` 是产品日常节奏。 */
export type BehaviorCadenceKind = 'daily' | 'demo';

export interface PreviewSelection {
  /** `single` 使用现有单槽适配器。另外两个值使用双槽适配器。 */
  playback: PlaybackMode;
  /** 为 true 时才创建产品行为调度器。 */
  behavior: boolean;
  /** 为 true 时，回应地址改用候选素材。不改写成品字节。 */
  candidate: boolean;
  /** 为 true 时，回应地址改用 `assets/candidates/reaction/short.webm`（母带截取的短片）。与 `candidate` 并列时优先。 */
  short: boolean;
  /** 行为调度节奏。`behavior` 令牌给 `daily`，`behavior-demo` 给 `demo`（并隐含 `behavior`）。未开行为时为 null。 */
  behaviorCadence: BehaviorCadenceKind | null;
  /** 为 true 时页面输出 bench 打点事件（bench-click / bench-media）。只开观测，不改行为。 */
  benchObserve: boolean;
}

/**
 * 解析预览令牌。空串、`off`、`0`、`false`、`1`、`on` 和未知令牌都不打开策略。
 * 多个播放令牌时，后出现的覆盖前面的。`behavior` 可与播放令牌并列。
 *
 * @param raw - 查询参数或环境变量的原文。缺省视为关闭。
 * @returns 选择结果。未识别的内容保持已验收路径。
 */
export function parsePreview(raw: string | null | undefined): PreviewSelection {
  let playback: PlaybackMode = 'single';
  let behavior = false;
  let candidate = false;
  let short = false;
  let behaviorCadence: BehaviorCadenceKind | null = null;
  let benchObserve = false;
  if (raw == null || raw.trim() === '') {
    return { playback, behavior, candidate, short, behaviorCadence, benchObserve };
  }
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (token === 'behavior') {
      behavior = true;
      behaviorCadence = 'daily';
    } else if (token === 'behavior-demo') {
      behavior = true;
      behaviorCadence = 'demo';
    } else if (token === 'candidate') candidate = true;
    else if (token === 'short') short = true;
    else if (token === 'bench-observe') benchObserve = true;
    else if (token === 'two-slot' || token === 'two-slot-preheat') playback = token;
  }
  return { playback, behavior, candidate, short, behaviorCadence, benchObserve };
}

/** 没有任何新策略被点名。 */
export function previewUsesAcceptedPath(selection: PreviewSelection): boolean {
  return (
    selection.playback === 'single' &&
    selection.behavior === false &&
    selection.candidate === false &&
    selection.short === false &&
    selection.benchObserve === false
  );
}

/**
 * 把已打开的令牌写回查询值。已验收路径得到空串。
 *
 * @param selection - `parsePreview` 的结果。
 * @returns 逗号分隔的令牌。
 */
export function formatPreview(selection: PreviewSelection): string {
  const parts: string[] = [];
  if (selection.playback !== 'single') parts.push(selection.playback);
  if (selection.behavior) parts.push(selection.behaviorCadence === 'demo' ? 'behavior-demo' : 'behavior');
  if (selection.candidate) parts.push('candidate');
  if (selection.short) parts.push('short');
  if (selection.benchObserve) parts.push('bench-observe');
  return parts.join(',');
}
