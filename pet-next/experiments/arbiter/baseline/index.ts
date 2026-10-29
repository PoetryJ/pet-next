/**
 * 最小优先级规则的工厂。Agent D 实现 `step`。
 * @module pet-next/experiments/arbiter/baseline
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

/** 基线仲裁。调用工厂得到的对象在 `step` 时才会执行规则。 */
export const createBaseline: ArbiterFactory = () => unimplemented('baseline arbiter');
