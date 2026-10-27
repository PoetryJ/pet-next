/**
 * 状态出口的行为契约：存进去的是同一份引用，读出来就是它；清空后回到 null。
 *
 * 这里不测形状校验——`PollState` 由 shared/state 的解析负责，本模块只做保管。
 */
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getStateSnapshot, resetStateSnapshot, setStateSnapshot } from './state-service.ts';
import type { PollState } from '../shared/state.ts';

/** 造一份最小可用的状态：一个分段叶子 + 一只宠物的一个叶子。 */
function sample(counter: number): PollState {
  return {
    counter,
    pets: { main: { say: { counter: counter + 1, data: { text: 'hi', seq: counter } } } },
    sections: {
      balance: { counter: 0, data: null },
      config: { counter: 0, data: null },
      menu: { counter: 0, data: null },
      notify: { counter: 0, data: null },
      workStatus: { counter: 0, data: null },
    },
  } as unknown as PollState;
}

describe('state-service —— 最近一拍的保管', () => {
  beforeEach(() => {
    resetStateSnapshot();
  });

  test('首拍之前读到的是空：没有状态时不假装有', () => {
    assert.equal(getStateSnapshot(), null);
  });

  test('存进来什么就读到什么：返回的是同一份引用，不做拷贝', () => {
    const state = sample(100);
    setStateSnapshot(state);
    assert.equal(getStateSnapshot(), state);
  });

  test('新的一拍整包替换：读到的永远是最近一次写入', () => {
    setStateSnapshot(sample(100));
    const next = sample(200);
    setStateSnapshot(next);
    assert.equal(getStateSnapshot()?.counter, 200);
    assert.equal(getStateSnapshot(), next);
  });

  test('清空后回到空：reset 之后不会读到上一拍的残留', () => {
    setStateSnapshot(sample(100));
    resetStateSnapshot();
    assert.equal(getStateSnapshot(), null);
  });
});
