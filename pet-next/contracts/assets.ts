/**
 * 透明素材处理的输入、输出和质量结论。检查器在 `assets-pipeline`。
 * 候选交付形状在 `asset-candidate.ts`。不替换已锁定的三份成品。默认启动不引用本模块。
 * 判定函数只看探针和对照帧。背景色字符串留在报告里，不进入判定参数。
 * @module pet-next/contracts/assets
 */

/** 同一帧必须各有一张对照。 */
export const REQUIRED_BACKGROUNDS = ['light', 'dark', 'checker'] as const;

export type QualityBackground = (typeof REQUIRED_BACKGROUNDS)[number];

export type QualityVerdict = 'pass' | 'fail' | 'source-lacks-alpha';

export interface SourceMediaProbe {
  /** 相对 `pet-next` 的路径。 */
  path: string;
  sha256: string;
  byteLength: number;
  hasAlpha: boolean;
  /** ffprobe 的 `pix_fmt`。读不到时为 null。 */
  pixFmt: string | null;
  /** 容器或流里的 alpha 模式。没有时为 null。 */
  alphaMode: string | null;
}

export interface QualityFrame {
  /** 源和输出共用的帧序号。 */
  frameIndex: number;
  background: QualityBackground;
  /** 对照图路径，相对 `pet-next`。 */
  imagePath: string;
  /** 该帧深色前景是否仍可见。没有观察时不得写成通过。 */
  darkForegroundVisible: boolean | 'unobserved';
}

/** {@link AssessQuality} 的全部输入。 */
export interface QualityEvidence {
  sourceHasAlpha: boolean;
  /** 没有输出文件时为 null。 */
  outputHasAlpha: boolean | null;
  frames: readonly QualityFrame[];
}

export interface AssetProcessReport {
  source: SourceMediaProbe;
  /** 实际执行的 argv，保留为数组。 */
  command: readonly string[];
  output: SourceMediaProbe | null;
  verdict: QualityVerdict;
  evidence: QualityEvidence;
  /**
   * 只写入日志，例如窗口 `getBackgroundColor()` 的字符串。
   * {@link AssessQuality} 的参数里没有这一项。
   */
  backgroundColorString: string | null;
  /** `pass` 时为 null。源没有 alpha 或工具缺失时写原因。 */
  limitation: string | null;
}

/** 由证据给出结论。实现放在素材流水线。 */
export type AssessQuality = (evidence: QualityEvidence) => QualityVerdict;
