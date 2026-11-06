/**
 * M3-9 待机节能的纯策略：只回答"现在该不该暂停/恢复当前媒体"。
 *
 * 不碰 DOM、时钟、Electron；副作用由 `adapters/media/adapter.ts` 执行。
 * 归属（lease）规则来自 CONTRACT：只有本功能真正 pause 过的元素才可能被本功能 resume。
 * @module pet-next/core/idle-suspension/policy
 */
/** 本轮只有单槽；双槽不启用该预览。 */
export const SINGLE_SLOT = 'single' as const;

/** 暂停归属。与 `contracts/idle-suspension.ts` 的结构一致，core 不能反向依赖 contracts。 */
export interface IdlePauseLease {
  generation: number;
  slot: typeof SINGLE_SLOT;
  /** 元素身份（同一适配器内稳定、不跨绑定复用）。 */
  elementIdentity: string;
}

/** 策略输入：全部是当前快照，不含历史。 */
export interface IdleSuspensionView {
  enabled: boolean;
  hidden: boolean;
  disposed: boolean;
  generation: number;
  /** 当前请求的片段；非 `idle` 一律不暂停。 */
  clip: string | null;
  /** `once` 动作不暂停。 */
  once: boolean;
  phase: string;
  lease: IdlePauseLease | null;
  /** 恢复在途：不重复调用 play。 */
  resuming: boolean;
}

export type IdleSuspensionDecision =
  | { type: 'pause'; lease: IdlePauseLease; reason: 'hidden-idle' }
  | { type: 'resume'; lease: IdlePauseLease; reason: 'visible-lease' }
  | { type: 'none'; reason: string };

/**
 * 决定当前媒体是否需要暂停或恢复。
 *
 * 判定顺序：开关 → dispose → 隐藏分支（只认 idle 且已兑现 playing）→ 恢复分支（只认仍匹配的 lease）。
 *
 * @param view - 当前播放与窗口状态。
 * @param elementIdentity - 当前元素身份；同一适配器内稳定。
 * @returns 动作；`none` 带可记录的跳过原因。
 */
export function reconcileIdleSuspension(
  view: IdleSuspensionView,
  elementIdentity: string,
): IdleSuspensionDecision {
  if (!view.enabled) return { type: 'none', reason: 'disabled' };
  if (view.disposed) return { type: 'none', reason: 'disposed' };

  const leaseMatches = (candidate: IdlePauseLease | null): candidate is IdlePauseLease =>
    candidate !== null &&
    candidate.generation === view.generation &&
    candidate.slot === SINGLE_SLOT &&
    candidate.elementIdentity === elementIdentity;

  if (view.hidden) {
    if (view.clip !== 'idle') return { type: 'none', reason: `clip-${view.clip ?? 'none'}` };
    if (view.once) return { type: 'none', reason: 'once-action' };
    if (view.phase !== 'playing') return { type: 'none', reason: `phase-${view.phase}` };
    // 已经由本功能暂停过同一 owner：重复的 hidden 事件不再 pause 第二次。
    if (leaseMatches(view.lease)) return { type: 'none', reason: 'already-suspended' };
    return {
      type: 'pause',
      reason: 'hidden-idle',
      lease: { generation: view.generation, slot: SINGLE_SLOT, elementIdentity },
    };
  }

  if (view.lease === null) return { type: 'none', reason: 'no-lease' };
  // 换代/换槽后旧 lease 失效：只清标记，绝不替旧元素补 play。
  if (!leaseMatches(view.lease)) return { type: 'none', reason: 'stale-lease' };
  if (view.resuming) return { type: 'none', reason: 'resuming' };
  return { type: 'resume', reason: 'visible-lease', lease: view.lease };
}

/**
 * 清理规则：旧 lease 在某事件后是否仍然有效。供适配器在读状态前调用。
 *
 * @param lease - 现有归属。
 * @param generation - 当前代次。
 * @param elementIdentity - 当前元素身份。
 * @returns 是否仍然有效。
 */
export function leaseStillCurrent(
  lease: IdlePauseLease | null,
  generation: number,
  elementIdentity: string,
): boolean {
  return (
    lease !== null &&
    lease.generation === generation &&
    lease.slot === SINGLE_SLOT &&
    lease.elementIdentity === elementIdentity
  );
}
