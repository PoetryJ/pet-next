/**
 * 三种预览模式、两个槽的选择，以及资源复用和请求复用的差别。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  assertTwoSlots,
  blocksPlaybackRequest,
  canReusePreparedSource,
  selectPlaySlot,
  selectPreheatSlot,
  twoSlotModeForPreview,
} from './select-slot.ts';

const reaction = { requestId: 'play-2', url: 'react.webm', once: true, clip: 'reaction' as const };

describe('twoSlotModeForPreview', () => {
  test('single 不启用双槽，另外两个模式原样返回', () => {
    assert.equal(twoSlotModeForPreview('single'), null);
    assert.equal(twoSlotModeForPreview('two-slot'), 'two-slot');
    assert.equal(twoSlotModeForPreview('two-slot-preheat'), 'two-slot-preheat');
  });
});

describe('selectPlaySlot', () => {
  test('有画面时只准备另一槽，没有画面时优先复用已装入同一地址的槽', () => {
    assert.equal(selectPlaySlot(0, [null, null], reaction), 1);
    assert.equal(selectPlaySlot(1, ['react.webm', null], reaction), 0);
    assert.equal(selectPlaySlot(null, [null, 'react.webm'], reaction), 1);
    assert.equal(selectPlaySlot(null, [null, null], reaction), 0);
  });
});

describe('selectPreheatSlot', () => {
  test('预热不占用正在准备播放的槽', () => {
    assert.equal(selectPreheatSlot(0, [false, false]), 1);
    assert.equal(selectPreheatSlot(0, [false, true]), null);
    assert.equal(selectPreheatSlot(null, [true, false]), 1);
  });
});

describe('canReusePreparedSource', () => {
  test('同一地址且请求编号不同可以复用资源，同一请求编号必须重新加载', () => {
    const resident = { url: 'react.webm', requestId: 'pre-1' };
    assert.equal(canReusePreparedSource(resident, reaction, null), 'resident');
    assert.equal(
      canReusePreparedSource(resident, { ...reaction, requestId: 'pre-1' }, null),
      'load',
    );
    assert.equal(
      canReusePreparedSource(null, reaction, { url: 'react.webm', requestId: 'pre-1', kind: 'preheat' }),
      'inflight',
    );
    assert.equal(
      canReusePreparedSource(null, reaction, { url: 'react.webm', requestId: 'pre-1', kind: 'play' }),
      'load',
    );
  });
});

describe('blocksPlaybackRequest', () => {
  test('预热编号不能当作播放请求，槽数不是两个就拒绝', () => {
    assert.equal(blocksPlaybackRequest(['pre-1'], 'pre-1'), true);
    assert.equal(blocksPlaybackRequest(['pre-1'], 'play-2'), false);
    assert.throws(() => assertTwoSlots(3), /2 media slots/);
    assert.doesNotThrow(() => assertTwoSlots(2));
  });
});
