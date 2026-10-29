/**
 * 待机与回应的请求身份。
 * 只有当前回应结束或失败才回待机；待机失败停在占位，不再自动重播。
 * @module pet-next/core/interaction/session
 */
import type { ClipKind, PetSessionEvent, PetSessionReduction, PetSessionState } from './types.ts';

/** 尚未开机。画面先停在占位，直到 boot 发出待机请求。 */
export function initialPetSessionState(): PetSessionState {
  return { requestId: 0, visual: 'placeholder' };
}

/**
 * 折叠开机、点击和片段结果。
 * 请求编号只增不减；编号或片段对不上的回调保持原状态、不产生动作。
 */
export function reducePetSession(state: PetSessionState, event: PetSessionEvent): PetSessionReduction {
  switch (event.type) {
    case 'boot':
      if (state.requestId !== 0) return keep(state);
      return play(state, 'idle');
    case 'click':
      return play(state, 'reaction');
    case 'clip-ended':
      if (!matches(state, event.requestId, event.clip)) return keep(state);
      if (event.clip === 'reaction') return play(state, 'idle');
      return keep(state);
    case 'clip-failed':
      if (!matches(state, event.requestId, event.clip)) return keep(state);
      if (event.clip === 'reaction') return play(state, 'idle');
      return { state: { ...state, visual: 'placeholder' }, effects: [{ type: 'placeholder' }] };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

function play(state: PetSessionState, clip: ClipKind): PetSessionReduction {
  const requestId = state.requestId + 1;
  return {
    state: { requestId, visual: clip },
    effects: [{ type: 'play', requestId, clip }],
  };
}

function matches(state: PetSessionState, requestId: number, clip: ClipKind): boolean {
  return state.requestId === requestId && state.visual === clip;
}

function keep(state: PetSessionState): PetSessionReduction {
  return { state, effects: [] };
}
