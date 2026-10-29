/**
 * 候选素材的交付记录。检查器的质量结论仍在 `assets.ts`。
 * 候选文件不得覆盖已锁定的 `assets/idle.webm`、`assets/reaction.webm`、`assets/placeholder.png`。
 * @module pet-next/contracts/asset-candidate
 */

import type { QualityBackground } from './assets.ts';

/** `alpha-source` 使用带 alpha 的原始材料。`displacement-fallback` 只是在现有透明待机上做位移或缩放。 */
export type AssetCandidateKind = 'alpha-source' | 'displacement-fallback';

export interface AssetCandidatePlate {
  background: QualityBackground;
  /** 对照图路径，相对 `pet-next`。 */
  imagePath: string;
}

export interface AssetCandidateManifest {
  role: 'idle' | 'reaction';
  kind: AssetCandidateKind;
  sourcePath: string;
  sourceSha256: string;
  outputPath: string;
  outputSha256: string;
  /** 浅色、深色、棋盘底三张对照。 */
  plates: readonly AssetCandidatePlate[];
  command: readonly string[];
  /**
   * `displacement-fallback` 时写明这不是修复原视频。
   * `alpha-source` 没有额外限制时为 null。
   */
  limitation: string | null;
}
