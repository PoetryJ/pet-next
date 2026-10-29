/**
 * 最小优先级仲裁基线：按来源等级比较，不老化、不随机。
 * 不读取时钟或宿主。一场的状态都在返回值里，工厂本身不保留场次。
 * 规则见 docs/arbiter-protocol.md。本目录不改契约形状。
 * @module pet-next/experiments/arbiter/baseline
 */
import type { ArbiterFactory } from '../../../contracts/arbiter.ts';
import { initialBaselineState, stepBaseline, type BaselineState } from './policy.ts';

export type { BaselineState };

/**
 * 基线仲裁。拖动期间不启动自动动作，点击高于自动提醒，同级不抢占。
 * 过期事件丢弃，对不上的完成回调不结束当前动作。
 */
export const createBaseline: ArbiterFactory<BaselineState> = () => ({
  initialState: initialBaselineState,
  step: stepBaseline,
});
