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

test('点名的策略记入请求，运行标记与已接线的令牌相同', () => {
  assert.deepEqual(parsePreview('two-slot'), { playback: 'two-slot', behavior: false, candidate: false });
  assert.deepEqual(parsePreview('two-slot-preheat'), { playback: 'two-slot-preheat', behavior: false, candidate: false });
  assert.deepEqual(parsePreview('behavior'), { playback: 'single', behavior: true, candidate: false });
  assert.deepEqual(parsePreview('candidate'), { playback: 'single', behavior: false, candidate: true });
  assert.deepEqual(parsePreview(' two-slot , behavior '), { playback: 'two-slot', behavior: true, candidate: false });
  assert.equal(parsePreview('two-slot,two-slot-preheat').playback, 'two-slot-preheat');
  assert.equal(parsePreview('candidate,behavior,two-slot').candidate, true);
  assert.deepEqual(previewDataset('?preview=two-slot,behavior'), {
    previewRequested: 'two-slot,behavior',
    previewActive: 'two-slot,behavior',
  });
  assert.deepEqual(previewDataset('?preview=behavior,candidate'), {
    previewRequested: 'behavior,candidate',
    previewActive: 'behavior,candidate',
  });
});
