/**
 * 显式阶段机候选的工厂。一场的状态都在返回值里，工厂本身不保留场次。
 * 不引入状态机框架，也不读取时钟或宿主。
 * @module pet-next/experiments/arbiter/state-machine
 */
import type { ArbiterFactory } from '../../../contracts/arbiter.ts';
import { initialMachineState, stepMachine, type MachineState } from './machine.ts';

export type { MachineState };

/** 状态机仲裁。与基线共用 {@link ArbiterFactory}，可比输出是 decisions 和 queueLength。 */
export const createStateMachine: ArbiterFactory<MachineState> = () => ({
  initialState: initialMachineState,
  step: stepMachine,
});
