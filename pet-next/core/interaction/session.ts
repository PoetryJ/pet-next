/**
 * 待机与回应的请求身份。旧请求的回调不能改变更新的请求。
 * @module pet-next/core/interaction/session
 */
import type { PetSessionEvent, PetSessionReduction, PetSessionState } from './types.ts';

/** 尚未开机。 */
export function initialPetSessionState(): PetSessionState {
  throw new Error('not implemented');
}

/**
 * 折叠开机、点击和片段结果。
 * 只有当前回应结束或失败才尝试回待机；待机失败只进入占位，不再自动重试。
 */
export function reducePetSession(_state: PetSessionState, _event: PetSessionEvent): PetSessionReduction {
  throw new Error('not implemented');
}
