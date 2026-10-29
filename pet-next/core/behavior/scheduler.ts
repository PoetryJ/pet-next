/**
 * 产品调度器工厂。`step` 不读取 `deps.nowMs()`。
 * @module pet-next/core/behavior/scheduler
 */
import { initialBehaviorState, stepBehavior } from './reduce.ts';
import type { BehaviorDeps, BehaviorScheduler, BehaviorState } from './types.ts';

/** 用调用方注入的随机数创建调度器。时钟不参与 `step`。 */
export function createBehaviorScheduler(deps: BehaviorDeps): BehaviorScheduler<BehaviorState> {
  return {
    initialState: initialBehaviorState,
    step(state, input) {
      return stepBehavior(state, input, deps.random);
    },
  };
}
