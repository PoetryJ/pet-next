import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BEHAVIOR_ENABLED, modeOrder, windowBounds } from './protocol.ts';

describe('对照条件', () => {
  test('三种模式的窗口相同，行为关闭，轮换先手', () => {
    assert.equal(BEHAVIOR_ENABLED, false);
    assert.deepEqual(windowBounds('single'), windowBounds('two-slot'));
    assert.deepEqual(windowBounds('two-slot'), windowBounds('two-slot-preheat'));
    assert.deepEqual(modeOrder(1), ['single', 'two-slot', 'two-slot-preheat']);
    assert.deepEqual(modeOrder(2), ['two-slot', 'two-slot-preheat', 'single']);
    assert.deepEqual(modeOrder(3), ['two-slot-preheat', 'single', 'two-slot']);
  });

  test('测量页不引用行为调度', () => {
    const source = readFileSync(fileURLToPath(new URL('./page.ts', import.meta.url)), 'utf8');
    assert.equal(source.includes('core/behavior'), false);
    assert.equal(source.includes('BEHAVIOR_ENABLED'), true);
  });
});
