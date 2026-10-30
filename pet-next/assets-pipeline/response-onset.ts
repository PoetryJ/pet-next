/**
 * "明确回应"的客观判定：只看逐帧像素变化，不看截图、不看时间轴标注。
 *
 * 规则（与 assets-pipeline/short-clip.ts 的截取规则完全一致，可复核）：
 * - 运动量 D(i) = 第 i-1 帧到第 i 帧发生可见变化的像素数（任一 RGB 通道差 > 24）。
 * - 明确回应帧：D(i) ≥ 5% 画幅，且其后 24 帧窗口内至少 12 帧达到半阈值的最早一帧。
 *   入场小动作（幅度够但持续不了）不会命中。
 * - 自然收尾：回应之后首次出现连续 8 帧运动量 < 1000 的前一帧。
 *
 * 单独成模块的原因：bench 需要计算"素材内回应时刻"来做点击→首明确回应的换算，
 * 而 short-clip.ts 顶层会执行 main()，不能被 import。
 * @module pet-next/assets-pipeline/response-onset
 */

/** 单通道差超过该值算像素在动。 */
export const MOTION_CHANNEL_DELTA = 24;

/** 明确回应 = 单帧运动像素占比阈值。 */
export const BURST_AREA_RATIO = 0.05;

/** 判定回应窗口（帧）：窗口内至少这么多数量的帧达到半阈值。 */
export const RESPONSE_WINDOW = 24;

export const RESPONSE_WINDOW_MIN_HITS = 12;

/** 回应窗口内判定"在动"的半阈值倍数。 */
export const RESPONSE_HALF_BURST = 2;

/** 自然收尾：连续这么多个帧都低于该运动量，视为回应结束。 */
export const SETTLE_QUIET_RUN = 8;

export const SETTLE_MOTION_MAX = 1000;

export interface RgbaLike {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

/** 帧间运动曲线：D(i) = 第 i-1 帧到第 i 帧发生可见变化的像素数。第 0 帧记为 0。 */
export function frameMotionCurve(frames: readonly RgbaLike[]): number[] {
  const curve: number[] = [0];
  for (let index = 1; index < frames.length; index += 1) {
    const prev = frames[index - 1]!.rgba;
    const next = frames[index]!.rgba;
    let changed = 0;
    for (let at = 0; at < prev.length; at += 4) {
      if (
        Math.abs(prev[at]! - next[at]!) > MOTION_CHANNEL_DELTA ||
        Math.abs(prev[at + 1]! - next[at + 1]!) > MOTION_CHANNEL_DELTA ||
        Math.abs(prev[at + 2]! - next[at + 2]!) > MOTION_CHANNEL_DELTA
      ) {
        changed += 1;
      }
    }
    curve.push(changed);
  }
  return curve;
}

/**
 * 最早明确回应帧：第一个 D(i) ≥ burstThreshold 且其后 RESPONSE_WINDOW 帧窗口内
 * 至少 RESPONSE_WINDOW_MIN_HITS 帧达到 burstThreshold/RESPONSE_HALF_BURST 的帧。
 * 找不到返回 -1。
 */
export function findEarliestResponse(motion: readonly number[], burstThreshold: number): number {
  const half = burstThreshold / RESPONSE_HALF_BURST;
  for (let index = 1; index < motion.length; index += 1) {
    if (motion[index]! < burstThreshold) continue;
    const windowEnd = Math.min(motion.length, index + RESPONSE_WINDOW);
    let hits = 0;
    for (let at = index; at < windowEnd; at += 1) {
      if (motion[at]! >= half) hits += 1;
    }
    if (hits >= RESPONSE_WINDOW_MIN_HITS) return index;
  }
  return -1;
}

/** 自然收尾帧：回应起点之后，首次出现连续 SETTLE_QUIET_RUN 帧低运动的前一帧。 */
export function findNaturalEnd(motion: readonly number[], earliestResponse: number): number {
  for (let index = earliestResponse + 1; index + SETTLE_QUIET_RUN <= motion.length; index += 1) {
    let quiet = true;
    for (let step = 0; step < SETTLE_QUIET_RUN; step += 1) {
      if (motion[index + step]! >= SETTLE_MOTION_MAX) {
        quiet = false;
        break;
      }
    }
    if (quiet) return index - 1;
  }
  return motion.length - 1;
}

/** 这段素材从第 0 帧起，到出现明确回应需要多久（毫秒）。找不到回应返回 null。 */
export function responseOnsetMs(frames: readonly RgbaLike[], fps: number): number | null {
  if (frames.length === 0 || fps <= 0) return null;
  const pixels = frames[0]!.width * frames[0]!.height;
  const threshold = Math.round(BURST_AREA_RATIO * pixels);
  const motion = frameMotionCurve(frames);
  const index = findEarliestResponse(motion, threshold);
  if (index < 0) return null;
  return (index / fps) * 1000;
}
