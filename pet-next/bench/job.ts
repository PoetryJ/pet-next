/**
 * 一次 Electron 进程要跑的对照任务。正常样本和压力样本都用这个形状。
 */
import type { BenchMode } from './protocol.ts';

export interface BenchJob {
  mode: BenchMode;
  round: number;
  /** 文档级首次播放的次数。每次重新加载页面。 */
  firstCount: number;
  /** 同一页里完整播完一次之后的重复次数。 */
  repeatCount: number;
  dwellMs: number;
  idleCpuMs: number;
  /** 0 是正常环境。大于 0 只表示人工慢加载。 */
  stressDelayMs: number;
  assetSha256: string;
  idleUrl: string;
  reactionUrl: string;
  /** 原始记录根目录。证据路径相对这里。 */
  runRoot: string;
  /** 这一模式这一轮的输出目录。 */
  outDir: string;
}
