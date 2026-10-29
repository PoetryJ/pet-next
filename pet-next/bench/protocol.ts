/**
 * 三种模式共用的窗口、停留和样本规模。
 * 模式只选择播放实现；这些数不随模式改变。行为调度不参与。
 */
import { BENCH_MODES, BENCH_ROUND_COUNT, BENCH_SAMPLE_COUNT, type BenchMode } from '../contracts/bench.ts';

export { BENCH_MODES, BENCH_ROUND_COUNT, BENCH_SAMPLE_COUNT };
export type { BenchMode };

/** 本轮对照不打开自主行为。 */
export const BEHAVIOR_ENABLED = false;

export const WINDOW_WIDTH = 320;
export const WINDOW_HEIGHT = 240;
export const WINDOW_X = 80;
export const WINDOW_Y = 80;

/** 点击前，待机画面已经出现之后的固定停留。 */
export const DWELL_MS = 500;

/** 闲置 CPU 的采样窗。 */
export const IDLE_CPU_MS = 2000;

export const LOAD_TIMEOUT_MS = 8000;

export const TRIAL_TIMEOUT_MS = 8000;

/** 人工慢加载只给压力测试。正常样本的 delay 必须是 0。 */
export const STRESS_DELAY_MS = 400;

/** 短于加载延迟，用来观察准备未完成时的切换。 */
export const STRESS_DWELL_MS = 100;

export const STRESS_SAMPLE_COUNT = 5;

export const SHIPPED_IDLE = 'assets/idle.webm';
export const SHIPPED_REACTION = 'assets/reaction.webm';

export const GRID_W = 160;
export const GRID_H = 90;

/** 采样点里不透明像素少于此数，视为没有画面。 */
export const EMPTY_OPAQUE = 30;

export const OPAQUE_ALPHA = 16;

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 三种模式返回同一组窗口边界。 */
export function windowBounds(_mode: BenchMode): WindowBounds {
  return { x: WINDOW_X, y: WINDOW_Y, width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
}

/**
 * 每轮轮换谁先跑，避免固定顺序把缓存或发热算进某一个模式。
 * 第 1 轮从单槽开始。
 */
export function modeOrder(round: number): BenchMode[] {
  const shift = (round - 1) % BENCH_MODES.length;
  return [...BENCH_MODES.slice(shift), ...BENCH_MODES.slice(0, shift)];
}
