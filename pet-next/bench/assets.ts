/**
 * 本轮只哈希成品素材。候选换片不进入指纹。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SHIPPED_IDLE, SHIPPED_REACTION } from './protocol.ts';

export interface HashedAsset {
  path: string;
  sha256: string;
}

export const SHIPPED_ASSET_PATHS = [SHIPPED_IDLE, SHIPPED_REACTION] as const;

/** 路径顺序固定。任一文件不同，指纹就不同。 */
export function canonicalAssetSha256(files: readonly HashedAsset[]): string {
  const body = files.map((file) => `${file.path}:${file.sha256}`).join('\n') + '\n';
  return createHash('sha256').update(body).digest('hex');
}

export function assertShippedAssets(paths: readonly string[]): void {
  const expected = SHIPPED_ASSET_PATHS.join('\n');
  if (paths.join('\n') !== expected) {
    throw new Error(`bench assets must be ${expected}`);
  }
}

export async function hashShippedAssets(root: string): Promise<{ files: HashedAsset[]; assetSha256: string }> {
  assertShippedAssets(SHIPPED_ASSET_PATHS);
  const files: HashedAsset[] = [];
  for (const rel of SHIPPED_ASSET_PATHS) {
    const bytes = await readFile(path.join(root, rel));
    files.push({ path: rel, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { files, assetSha256: canonicalAssetSha256(files) };
}
