/**
 * 工作区夹紧和移动/退出宿主。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clampPosition } from './clamp.ts';
import { createWindowController } from './controller.ts';
import type { WindowBounds, WindowHost, WorkArea } from './types.ts';

const area: WorkArea = { x: 10, y: 20, width: 800, height: 600 };

describe('clampPosition', () => {
  test('工作区内部保持原位，越界夹到边缘', () => {
    assert.deepEqual(clampPosition({ x: 40, y: 50 }, { width: 100, height: 80 }, area), { x: 40, y: 50 });
    assert.deepEqual(clampPosition({ x: 900, y: 700 }, { width: 100, height: 80 }, area), { x: 710, y: 540 });
    assert.deepEqual(clampPosition({ x: -5, y: 0 }, { width: 100, height: 80 }, area), { x: 10, y: 20 });
  });

  test('窗口大于工作区时钉在原点', () => {
    assert.deepEqual(clampPosition({ x: 100, y: 100 }, { width: 900, height: 700 }, area), { x: 10, y: 20 });
  });
});

describe('createWindowController', () => {
  test('moveBy 夹紧后取整，quit 只调用宿主退出', () => {
    let bounds: WindowBounds = { x: 40, y: 50, width: 100, height: 80 };
    const moves: Array<{ x: number; y: number }> = [];
    let quits = 0;
    const host: WindowHost = {
      getBounds: () => bounds,
      setPosition(x, y) {
        bounds = { ...bounds, x, y };
        moves.push({ x, y });
      },
      workAreaFor: () => area,
      quit() {
        quits += 1;
      },
    };
    const controller = createWindowController(host);
    controller.moveBy(5.2, -4.4);
    assert.deepEqual(moves, [{ x: 45, y: 46 }]);
    controller.moveBy(-1000, 5000);
    assert.deepEqual(bounds, { x: 10, y: 540, width: 100, height: 80 });
    controller.moveBy(Number.NaN, 1);
    assert.equal(moves.length, 2);
    controller.quit();
    assert.equal(quits, 1);
  });
});
