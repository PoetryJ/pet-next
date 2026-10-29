/**
 * 位移累加在回读之前，并夹进工作区。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { advanceOrigin, type TrackedOrigin } from './track.ts';
import type { WorkArea } from './types.ts';

const area: WorkArea = { x: 10, y: 20, width: 800, height: 600 };
const size = { width: 100, height: 80 };

describe('advanceOrigin', () => {
  test('连续 0.25 DIP 累加到未回读的原点', () => {
    const reported = { x: 100, y: 80 };
    let tracked: TrackedOrigin | null = null;
    const positions: Array<{ x: number; y: number }> = [];
    for (let step = 0; step < 4; step += 1) {
      const next = advanceOrigin(tracked, reported, 0.25, 0.25, size, area);
      tracked = next.tracked;
      positions.push(next.position);
    }
    assert.deepEqual(tracked, { x: 101, y: 81 });
    assert.deepEqual(positions, [
      { x: 100, y: 80 },
      { x: 101, y: 81 },
      { x: 101, y: 81 },
      { x: 101, y: 81 },
    ]);
  });

  test('越界夹到工作区边缘，贴边后继续外推仍停在边缘', () => {
    const first = advanceOrigin(null, { x: 40, y: 50 }, 10_000, 10_000, size, area);
    assert.deepEqual(first.position, { x: 710, y: 540 });
    const stuck = advanceOrigin(first.tracked, { x: 0, y: 0 }, 10, 10, size, area);
    assert.deepEqual(stuck.position, { x: 710, y: 540 });
    const topLeft = advanceOrigin(stuck.tracked, { x: 0, y: 0 }, -10_000, -10_000, size, area);
    assert.deepEqual(topLeft.position, { x: 10, y: 20 });
  });

  test('四舍五入出界时拉回工作区内的整数', () => {
    const fractional: WorkArea = { x: 0.4, y: 0.4, width: 50, height: 40 };
    const placed = advanceOrigin(null, { x: 0.4, y: 0.4 }, -5, -5, { width: 10, height: 10 }, fractional);
    assert.deepEqual(placed.position, { x: 1, y: 1 });
  });
});
