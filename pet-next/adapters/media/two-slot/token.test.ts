/**
 * 世代和槽身份对不上时，回调必须丢掉。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { noticeFailureReason, readFailureReason, tokenIsCurrent } from './token.ts';

describe('tokenIsCurrent', () => {
  const live = { slot: 0 as const, generation: 2 };

  test('世代和槽都符合且未销毁时采纳回调', () => {
    assert.equal(tokenIsCurrent(live, { slot: 0, generation: 2 }, false), true);
  });

  test('世代不符时丢弃回调', () => {
    assert.equal(tokenIsCurrent(live, { slot: 0, generation: 1 }, false), false);
  });

  test('槽身份不符时丢弃回调', () => {
    assert.equal(tokenIsCurrent(live, { slot: 1, generation: 2 }, false), false);
  });

  test('已销毁或没有当前准备时丢弃回调', () => {
    assert.equal(tokenIsCurrent(live, { slot: 0, generation: 2 }, true), false);
    assert.equal(tokenIsCurrent(null, { slot: 0, generation: 2 }, false), false);
  });
});

describe('readFailureReason', () => {
  test('未知错误按资源加载失败，播放拒绝按解码失败报告', () => {
    assert.equal(readFailureReason(Object.assign(new Error('decode'), { reason: 'decode-error' })), 'decode-error');
    assert.equal(readFailureReason(new Error('missing')), 'asset-load');
    assert.equal(noticeFailureReason('timeout'), 'timeout');
    assert.equal(noticeFailureReason('play-rejected'), 'decode-error');
    assert.equal(noticeFailureReason(undefined), 'decode-error');
  });
});
