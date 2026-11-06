/**
 * M3-9 待机节能预览的跨进程契约：显式开关、窗口可见性快照与调试观测面。
 *
 * 默认关闭。只有 `PET_NEXT_IDLE_PAUSE=1` 时主进程才装配窗口监听、预加载才暴露
 * `petWindowVisibility`，因此三个进程都用同一个常量判断，避免“一半装配”。
 * 本文件只放常量与纯函数，不引入 Electron、不放适配器逻辑。
 * @module pet-next/contracts/idle-suspension
 */

/** 显式预览开关。空串、`0`、`false`、`off` 都视为关闭；缺省不创建任何节能对象。 */
export const IDLE_PAUSE_ENV = 'PET_NEXT_IDLE_PAUSE';

/**
 * 主进程转给页面的查询参数。只有开关打开且单槽时才写入 `1`，
 * 页面据此决定是否订阅窗口快照、是否覆盖 `__petIdleSuspension`。
 */
export const IDLE_PAUSE_QUERY = 'idlePause';

/** 主进程 → 页面：窗口状态变化推送。 */
export const WINDOW_VISIBILITY_CHANNEL = 'pet:window-visibility';

/** 页面 → 主进程：订阅时取一次权威初始快照。只回应发起窗口。 */
export const WINDOW_VISIBILITY_QUERY_CHANNEL = 'pet:window-visibility:query';

/** 页面侧观测面（测试/bench 读，产品路径不读）。 */
export const IDLE_SUSPENSION_DEBUG_KEY = '__petIdleSuspension';

/** 隐藏原因。`blur` 不是隐藏；遮挡识别本轮不做。 */
export type WindowVisibilityReason = 'visible' | 'hidden' | 'minimized';

/**
 * 主进程给出的窗口快照。`revision` 在每个窗口内单调递增，页面只接受更新的值。
 */
export interface WindowVisibilitySnapshot {
  /** 每窗口单调递增，初始快照从 1 起。 */
  revision: number;
  /** `true` 表示 `!isVisible() || isMinimized()`。 */
  hidden: boolean;
  reason: WindowVisibilityReason;
}

/** 本轮只有单槽。双槽模式不启用该预览。 */
export type IdleSuspensionSlot = 'single';

/** 暂停归属：只有本功能真正 pause 过的元素才可能被本功能 resume。 */
export interface IdlePauseLease {
  generation: number;
  slot: IdleSuspensionSlot;
  /** 元素身份（同一适配器内稳定、不跨绑定复用）。 */
  elementIdentity: string;
}

/**
 * 适配器向页面暴露的只读观测状态。用于 e2e/bench 断言归属与次数，
 * 不参与生产决策；只在页面装配后写入。
 */
export interface IdleSuspensionDebugState {
  /** 开关是否打开（`PET_NEXT_IDLE_PAUSE`）。关闭时其余字段保持初始值。 */
  enabled: boolean;
  /** 最近一次权威快照。未收到时为 null。 */
  revision: number | null;
  hidden: boolean;
  /** 当前播放代次与阶段，来自单槽适配器。 */
  generation: number | null;
  phase: string | null;
  clip: string | null;
  /** 当前 lease；无归属时为 null。 */
  lease: IdlePauseLease | null;
  /** 累计 pause/resume 次数（只统计本功能发起的）。 */
  pauseCount: number;
  resumeCount: number;
  /** 最近一次决策与跳过原因，便于定位“为什么没暂停/没恢复”。 */
  lastAction: 'pause' | 'resume' | 'none';
  lastSkipReason: string | null;
}

/**
 * 判断开关是否打开。缺省、空串、`0`、`false`、`off` 都关闭；
 * 只有 `1`、`true`、`on` 打开，避免把任意非空值当启用。
 *
 * @param env - 环境变量表，测试可注入；缺省读进程环境（渲染进程没有 `process`）。
 * @returns 是否启用本预览。
 */
export function idlePauseEnabled(env?: Record<string, string | undefined>): boolean {
  const table = env ?? (typeof process !== 'undefined' ? process.env : undefined);
  const raw = table?.[IDLE_PAUSE_ENV];
  if (raw == null) return false;
  const token = raw.trim().toLowerCase();
  return token === '1' || token === 'true' || token === 'on';
}

/**
 * 校验快照形状。跨进程边界不能信任对面，形状不符就丢弃。
 *
 * @param value - 未信任的载荷。
 * @returns 是否是合法快照。
 */
export function isWindowVisibilitySnapshot(value: unknown): value is WindowVisibilitySnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const revision = candidate.revision;
  const hidden = candidate.hidden;
  const reason = candidate.reason;
  return (
    typeof revision === 'number' &&
    Number.isInteger(revision) &&
    revision >= 1 &&
    typeof hidden === 'boolean' &&
    (reason === 'visible' || reason === 'hidden' || reason === 'minimized')
  );
}

/**
 * 页面侧接收规则：只接受比当前修订号更大的快照，旧消息（含订阅前在途推送）
 * 一律丢弃。
 *
 * @param currentRevision - 已应用的修订号；未应用过为 0。
 * @param incoming - 未信任的载荷。
 * @returns 是否应当应用。
 */
export function shouldApplySnapshot(currentRevision: number, incoming: unknown): incoming is WindowVisibilitySnapshot {
  return isWindowVisibilitySnapshot(incoming) && incoming.revision > currentRevision;
}
