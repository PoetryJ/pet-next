/**
 * 产品自主行为。默认桌宠不创建调度器；只有预览令牌 `behavior` 打开后才接入。
 * 不读取 Electron、DOM、`Date.now`、`Math.random`。
 *
 * 接入时只改宿主接线：`parsePreview` 的 `behavior` 为 true 才调用
 * `createDesktopPetBehavior`。关闭时继续用 `core/interaction` 的现有会话。
 * 手势点击进入 `click`，拖动开始/结束进入 `dragStart` / `dragEnd`，
 * 播放结束或失败进入 `settled`。空闲定时器调用 `considerAuto`。
 * `ports.play` 接到现有媒体适配器，`ports.showIdle` 播待机循环，`ports.cancel` 中止当前播放。
 * @module pet-next/core/behavior
 */
export { createDesktopPetBehavior } from './desktop.ts';
export type { BehaviorAssets, BehaviorPlayRequest, BehaviorPorts, DesktopPetBehavior } from './desktop.ts';
export {
  BEHAVIOR_LIMITS,
  EXPERIMENT_SAME_RANK_QUEUE,
  PRODUCT_BEHAVIOR_RULES,
  autoMayStart,
  indexFromRandom,
  isExpired,
  isIdle,
  mayProposeAuto,
} from './policy.ts';
export type { ProductBehaviorRule } from './policy.ts';
export { proposeNextAuto, selectDueAuto } from './propose.ts';
export { initialBehaviorState, stepBehavior } from './reduce.ts';
export { createBehaviorScheduler } from './scheduler.ts';
export type {
  ActiveBehavior,
  AutoCandidate,
  BehaviorCancelReason,
  BehaviorClip,
  BehaviorDeps,
  BehaviorEffect,
  BehaviorFactory,
  BehaviorHistoryEntry,
  BehaviorInput,
  BehaviorScheduler,
  BehaviorState,
  BehaviorStep,
  PendingBehavior,
} from './types.ts';
