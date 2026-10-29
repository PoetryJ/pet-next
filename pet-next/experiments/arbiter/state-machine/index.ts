/**
 * 显式状态机候选的工厂。Agent E 实现 `step`。
 * @module pet-next/experiments/arbiter/state-machine
 */
import type { Arbiter, ArbiterFactory } from '../../../contracts/arbiter.ts';

function unimplemented(label: string): Arbiter<unknown> {
  return {
    initialState() {
      throw new Error(`${label} 尚未实现`);
    },
    step(_state, _input) {
      throw new Error(`${label} 尚未实现`);
    },
  };
}

/** 状态机仲裁。与基线使用同一 {@link ArbiterFactory}。 */
export const createStateMachine: ArbiterFactory = () => unimplemented('state-machine arbiter');
