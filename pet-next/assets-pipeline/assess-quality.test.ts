/**
 * 判定函数：背景色字符串不在参数里，缺背景或深色前景未观察都不能通过。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QualityEvidence, QualityFrame } from '../contracts/assets.ts';
import { assessQuality } from './assess-quality.ts';

function frame(frameIndex: number, background: QualityFrame['background'], visible: QualityFrame['darkForegroundVisible']): QualityFrame {
  return { frameIndex, background, imagePath: `frames/${frameIndex}-${background}.png`, darkForegroundVisible: visible };
}

function evidence(patch: Partial<QualityEvidence> & Pick<QualityEvidence, 'sourceHasAlpha' | 'outputHasAlpha'>): QualityEvidence {
  return { frames: patch.frames ?? [], sourceHasAlpha: patch.sourceHasAlpha, outputHasAlpha: patch.outputHasAlpha };
}

test('源没有 alpha：就算对照和输出都像通过，结论仍是 source-lacks-alpha', () => {
  const frames = [frame(0, 'light', true), frame(0, 'dark', true), frame(0, 'checker', true)];
  assert.equal(assessQuality(evidence({ sourceHasAlpha: false, outputHasAlpha: true, frames })), 'source-lacks-alpha');
});

test('没有输出 alpha → fail', () => {
  assert.equal(assessQuality(evidence({ sourceHasAlpha: true, outputHasAlpha: null })), 'fail');
  assert.equal(assessQuality(evidence({ sourceHasAlpha: true, outputHasAlpha: false })), 'fail');
});

test('缺一张背景，或深色前景不是 true → fail', () => {
  const light = frame(0, 'light', true);
  const dark = frame(0, 'dark', true);
  assert.equal(assessQuality(evidence({ sourceHasAlpha: true, outputHasAlpha: true, frames: [light, dark] })), 'fail');
  const unobserved = [light, frame(0, 'dark', 'unobserved'), frame(0, 'checker', 'unobserved')];
  assert.equal(assessQuality(evidence({ sourceHasAlpha: true, outputHasAlpha: true, frames: unobserved })), 'fail');
  const hidden = [light, frame(0, 'dark', false), frame(0, 'checker', false)];
  assert.equal(assessQuality(evidence({ sourceHasAlpha: true, outputHasAlpha: true, frames: hidden })), 'fail');
});

test('同一帧三背景且深色前景可见 → pass', () => {
  const frames = [frame(3, 'checker', true), frame(3, 'light', true), frame(3, 'dark', true)];
  assert.equal(assessQuality(evidence({ sourceHasAlpha: true, outputHasAlpha: true, frames })), 'pass');
});
