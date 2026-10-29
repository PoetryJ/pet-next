/**
 * 由探针和对照帧给出结论。参数里没有背景色字符串。
 */
import { REQUIRED_BACKGROUNDS, type QualityEvidence, type QualityFrame, type QualityVerdict } from '../contracts/assets.ts';

/** 源没有 alpha 时直接返回，不看输出、对照帧或别的字符串。 */
export function assessQuality(evidence: QualityEvidence): QualityVerdict {
  if (!evidence.sourceHasAlpha) return 'source-lacks-alpha';
  if (evidence.outputHasAlpha !== true) return 'fail';
  if (hasVisibleDarkTrio(evidence.frames)) return 'pass';
  return 'fail';
}

function hasVisibleDarkTrio(frames: readonly QualityFrame[]): boolean {
  const indexes = new Set(frames.map((frame) => frame.frameIndex));
  for (const frameIndex of indexes) {
    if (trioShowsDarkForeground(frames, frameIndex)) return true;
  }
  return false;
}

function trioShowsDarkForeground(frames: readonly QualityFrame[], frameIndex: number): boolean {
  const group = frames.filter((frame) => frame.frameIndex === frameIndex);
  const backgrounds = new Set(group.map((frame) => frame.background));
  const complete = REQUIRED_BACKGROUNDS.every((name) => backgrounds.has(name));
  const dark = group.find((frame) => frame.background === 'dark');
  return complete && dark?.darkForegroundVisible === true;
}
