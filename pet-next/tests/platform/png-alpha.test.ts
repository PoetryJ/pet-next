/**
 * PNG alpha 往返：透明像素保持 0，不透明像素保持 255。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeRgbaPng, readPngAlpha, sampleAlpha } from './png-alpha.ts';

test('2x2 RGBA 的四角 alpha 能读回来', () => {
  const rgba = Buffer.from([
    1, 2, 3, 0, 4, 5, 6, 255,
    7, 8, 9, 10, 11, 12, 13, 255,
  ]);
  const image = readPngAlpha(encodeRgbaPng(2, 2, rgba));
  assert.equal(image.width, 2);
  assert.equal(image.height, 2);
  assert.equal(image.colorType, 6);
  assert.deepEqual([...image.alpha], [0, 255, 10, 255]);
  assert.equal(sampleAlpha(image).some((sample) => sample.alpha === 0), true);
});
