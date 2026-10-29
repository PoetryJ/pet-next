/**
 * 组装检查报告。探针没读成时直接 fail，避免被判成源没有 alpha。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AssetProcessReport, QualityEvidence, SourceMediaProbe } from '../contracts/assets.ts';
import { assessQuality } from './assess-quality.ts';
import { MediaToolError } from './media-tool.ts';
import type { VideoProbe } from './read-media.ts';

export interface FileHash {
  readonly sha256: string;
  readonly byteLength: number;
}

/** 读文件并计算 sha256。文件不存在时返回 null。 */
export async function hashFile(file: string): Promise<FileHash | null> {
  try {
    const bytes = await readFile(file);
    return { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
  } catch {
    return null;
  }
}

/** 把探针和哈希收成报告里的源或输出。 */
export function toProbe(relativePath: string, hashed: FileHash, video: VideoProbe | undefined, hasAlpha: boolean): SourceMediaProbe {
  return {
    path: relativePath,
    sha256: hashed.sha256,
    byteLength: hashed.byteLength,
    hasAlpha,
    pixFmt: video?.pixFmt ?? null,
    alphaMode: video?.alphaMode ?? null,
  };
}

/** 结论只来自 {@link assessQuality}。通过时不留 limitation。 */
export function assessed(
  source: SourceMediaProbe,
  command: readonly string[],
  output: SourceMediaProbe | null,
  evidence: QualityEvidence,
  backgroundColorString: string | null,
  limitation: string,
): AssetProcessReport {
  const verdict = assessQuality(evidence);
  return {
    source,
    command,
    output,
    verdict,
    evidence,
    backgroundColorString,
    limitation: verdict === 'pass' ? null : limitation,
  };
}

/**
 * 帧还没读成。判定函数会把 `sourceHasAlpha: false` 写成 source-lacks-alpha，这里固定为 fail。
 */
export function unread(
  sourceRelative: string,
  backgroundColorString: string | null,
  command: readonly string[],
  limitation: string,
  hashed?: FileHash,
  video?: VideoProbe,
): AssetProcessReport {
  const source = toProbe(sourceRelative, hashed ?? { sha256: '', byteLength: 0 }, video, false);
  const evidence = { sourceHasAlpha: false, outputHasAlpha: null, frames: [] } as const;
  return { source, command, output: null, verdict: 'fail', evidence, backgroundColorString, limitation };
}

/** 容器标了 alpha 但平面没有不透明前景时，写明不能靠删黑补。 */
export function noAlphaText(video: VideoProbe, maxAlpha: number): string {
  if (video.alphaMode) {
    return `容器 alpha_mode=${video.alphaMode}，但抽样帧 alpha 最大为 ${maxAlpha}，没有同时存在的不透明前景和透明区域。这不算源有 alpha，也不会用删除近黑像素把颜色补成透明。`;
  }
  return '源视频没有可用的 alpha 平面（需要同时存在不透明像素和透明像素）。流水线停在这里，不用删除近黑像素，也不引入抠像。';
}

/** 深色前景没保住时的说明。通过路径不会用到这段。 */
export function failText(deleted: boolean, visible: boolean | 'unobserved'): string {
  if (deleted) return '近黑且原本不透明的像素在输出里失去了 alpha。这是删除黑色制造透明，判定为失败。';
  if (visible === 'unobserved') return '选定帧上看不到足够的不透明深色前景。不能判通过，也不会改用删除近黑像素来补透明。';
  if (visible === false) return '深色前景合成到深色底之后不再可见。';
  return '没有同时具备浅色、深色、棋盘三张对照。';
}

/** 工具错误的短文案。 */
export function toolMessage(error: unknown): string {
  if (error instanceof MediaToolError) return error.message;
  return '素材检查失败';
}
