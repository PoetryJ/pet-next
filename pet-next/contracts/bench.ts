/**
 * 三种播放模式的对照记录。测量实现放在 `bench/`。
 * 这里只固定样本形状。本文件不跑 Electron，也不给出收益结论。
 * @module pet-next/contracts/bench
 */

import type { PlaybackMode } from './preview.ts';

/** 每种模式、每一轮至少这么多样本。人工慢加载不计入这批样本。 */
export const BENCH_SAMPLE_COUNT = 30;

/** 同样条件重复的轮数。轮与轮分开保存。 */
export const BENCH_ROUND_COUNT = 3;

export const BENCH_MODES = ['single', 'two-slot', 'two-slot-preheat'] as const satisfies readonly PlaybackMode[];

export type BenchMode = (typeof BENCH_MODES)[number];

export type BenchPlay = 'first' | 'repeat';

/** 一条原始样本。`play()` 兑现和首帧分开记，不能互相填空。 */
export interface BenchSample {
  mode: BenchMode;
  /** 从 1 到 {@link BENCH_ROUND_COUNT}。 */
  round: number;
  /** 从 1 到至少 {@link BENCH_SAMPLE_COUNT}。 */
  index: number;
  play: BenchPlay;
  clickToFirstFrameMs: number | null;
  playResolvedMs: number | null;
  blankMs: number | null;
  loadCount: number;
  memoryBytes: number | null;
  idleCpuPercent: number | null;
  /** 本轮对照使用的素材哈希。三种模式必须相同。 */
  assetSha256: string;
  /** 空白核对用的截图或录像。没有则为 null，不能据此声称没有空白。 */
  evidencePath: string | null;
}

export type BenchRecommendation = 'keep' | 'stop' | 'unmeasured';

export interface BenchSummary {
  mode: BenchMode;
  clickToFirstFrameP50Ms: number | null;
  clickToFirstFrameP95Ms: number | null;
  /**
   * 收益不超过各轮波动时为 `stop`。
   * 还没有完整原始记录时为 `unmeasured`。集成不把 `unmeasured` 写成提升。
   */
  recommendation: BenchRecommendation;
}
