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
  const off = { short: false, behaviorCadence: null, benchObserve: false };
  assert.deepEqual(parsePreview('two-slot'), { playback: 'two-slot', behavior: false, candidate: false, ...off });
  assert.deepEqual(parsePreview('two-slot-preheat'), { playback: 'two-slot-preheat', behavior: false, candidate: false, ...off });
  assert.deepEqual(parsePreview('behavior'), { playback: 'single', behavior: true, candidate: false, ...off, behaviorCadence: 'daily' });
  assert.deepEqual(parsePreview('candidate'), { playback: 'single', behavior: false, candidate: true, ...off });
  assert.deepEqual(parsePreview(' two-slot , behavior '), {
    playback: 'two-slot',
    behavior: true,
    candidate: false,
    ...off,
    behaviorCadence: 'daily',
  });
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

test('短片、演示节奏与 bench 观测令牌', () => {
  assert.deepEqual(parsePreview('short'), {
    playback: 'single',
    behavior: false,
    candidate: false,
    short: true,
    behaviorCadence: null,
    benchObserve: false,
  });
  assert.deepEqual(parsePreview('behavior-demo'), {
    playback: 'single',
    behavior: true,
    candidate: false,
    short: false,
    behaviorCadence: 'demo',
    benchObserve: false,
  });
  assert.deepEqual(parsePreview('bench-observe'), {
    playback: 'single',
    behavior: false,
    candidate: false,
    short: false,
    behaviorCadence: null,
    benchObserve: true,
  });
  // 后出现的节奏令牌覆盖前面的；short 与 candidate 可并列。
  assert.equal(parsePreview('behavior,behavior-demo').behaviorCadence, 'demo');
  assert.equal(parsePreview('behavior-demo,behavior').behaviorCadence, 'daily');
  const both = parsePreview('candidate,short');
  assert.equal(both.candidate, true);
  assert.equal(both.short, true);
  assert.equal(previewUsesAcceptedPath(parsePreview('short')), false);
  assert.equal(previewUsesAcceptedPath(parsePreview('bench-observe')), false);
});
