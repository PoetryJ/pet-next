/**
 * 预览开关默认关闭，点名之后也只留下标记。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePreview, previewUsesAcceptedPath } from '../contracts/preview.ts';
import { markerFor, previewDataset } from './preview-gate.ts';

test('缺省、空串和含糊令牌都保持已验收路径', () => {
  for (const raw of [null, undefined, '', '   ', 'off', '0', 'false', '1', 'on', 'single', 'nope']) {
    const selection = parsePreview(raw);
    assert.equal(previewUsesAcceptedPath(selection), true, String(raw));
    assert.equal(markerFor(selection), null, String(raw));
  }
  assert.equal(previewDataset(''), null);
  assert.equal(previewDataset('?idle=../assets/idle.webm'), null);
});

test('点名的策略记入请求，运行标记仍是 off', () => {
  assert.deepEqual(parsePreview('two-slot'), { playback: 'two-slot', behavior: false });
  assert.deepEqual(parsePreview('two-slot-preheat'), { playback: 'two-slot-preheat', behavior: false });
  assert.deepEqual(parsePreview('behavior'), { playback: 'single', behavior: true });
  assert.deepEqual(parsePreview(' two-slot , behavior '), { playback: 'two-slot', behavior: true });
  assert.equal(parsePreview('two-slot,two-slot-preheat').playback, 'two-slot-preheat');
  assert.deepEqual(previewDataset('?preview=two-slot,behavior'), {
    previewRequested: 'two-slot,behavior',
    previewActive: 'off',
  });
});
