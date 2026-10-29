/**
 * DOM screen 点进入窗口 DIP 时保持原值。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { domScreenPointToDip } from './pointer-point.ts';

describe('domScreenPointToDip', () => {
  test('125% 下 48 物理像素对应的 38.4 DIP 原样返回', () => {
    const physical = 48;
    const scaleFactor = 1.25;
    const dip = physical / scaleFactor;
    assert.equal(dip, 38.4);
    assert.deepEqual(domScreenPointToDip({ x: dip, y: -dip }), { x: 38.4, y: -38.4 });
  });

  test('150% 与默认缩放的 screen 增量同样原样进入 DIP', () => {
    assert.deepEqual(domScreenPointToDip({ x: 32, y: 16 }), { x: 32, y: 16 });
    assert.deepEqual(domScreenPointToDip({ x: 48.761904, y: 0 }), { x: 48.761904, y: 0 });
  });
});
