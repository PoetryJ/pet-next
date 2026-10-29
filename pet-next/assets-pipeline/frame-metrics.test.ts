/**
 * 裁剪矩形、深色前景和“删黑”观察。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evenCrop,
  lostNearBlackAlpha,
  observeDarkForeground,
  summarizeFrames,
  type RgbaFrame,
} from './frame-metrics.ts';

function frame(width: number, height: number, paint: (x: number, y: number) => readonly [number, number, number, number]): RgbaFrame {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue, alpha] = paint(x, y);
      const offset = (y * width + x) * 4;
      rgba[offset] = red;
      rgba[offset + 1] = green;
      rgba[offset + 2] = blue;
      rgba[offset + 3] = alpha;
    }
  }
  return { width, height, rgba };
}

function square(x: number, y: number): boolean {
  return x >= 8 && x < 24 && y >= 8 && y < 24;
}

test('同时有不透明和透明像素才算可用 alpha', () => {
  const opaque = frame(4, 4, () => [0, 0, 0, 255]);
  const mixed = frame(4, 4, (x) => (x < 2 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
  assert.equal(summarizeFrames([opaque]).usableAlpha, false);
  assert.equal(summarizeFrames([mixed]).usableAlpha, true);
  assert.equal(summarizeFrames([mixed]).maxAlpha, 255);
});

test('偶数裁剪留在画面内', () => {
  const crop = evenCrop({ x: 213, y: 63, width: 213, height: 267 }, 640, 360, 2);
  assert.equal(crop.x % 2, 0);
  assert.equal(crop.y % 2, 0);
  assert.equal(crop.width % 2, 0);
  assert.equal(crop.height % 2, 0);
  assert.ok(crop.x >= 210 && crop.x <= 213);
  assert.ok(crop.x + crop.width <= 640);
  assert.ok(crop.y + crop.height <= 360);
  const odd = evenCrop({ x: 0, y: 0, width: 15, height: 15 }, 15, 15, 0);
  assert.equal(odd.width % 2, 0);
  assert.equal(odd.height % 2, 0);
  assert.ok(odd.width <= 15 && odd.height <= 15);
});

test('深色不透明块在深色底上仍算可见；只有亮色时是 unobserved', () => {
  const dark = frame(32, 32, (x, y) => (square(x, y) ? [0, 0, 0, 255] : [0, 0, 0, 0]));
  const bright = frame(32, 32, (x, y) => (square(x, y) ? [240, 240, 240, 255] : [0, 0, 0, 0]));
  assert.equal(observeDarkForeground(dark), true);
  assert.equal(observeDarkForeground(bright), 'unobserved');
});

test('近黑不透明像素丢掉 alpha 时判定为删黑', () => {
  const source = frame(32, 32, (x, y) => (square(x, y) ? [0, 0, 0, 255] : [0, 0, 0, 0]));
  const kept = frame(32, 32, (x, y) => (square(x, y) ? [0, 0, 0, 255] : [0, 0, 0, 0]));
  const keyed = frame(32, 32, () => [0, 0, 0, 0]);
  const crop = { x: 0, y: 0, width: 32, height: 32 };
  assert.equal(lostNearBlackAlpha(source, kept, crop), false);
  assert.equal(lostNearBlackAlpha(source, keyed, crop), true);
});
