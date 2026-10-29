import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertShippedAssets, canonicalAssetSha256, hashShippedAssets, SHIPPED_ASSET_PATHS } from './assets.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('素材指纹', () => {
  test('只接受成品待机和反应，候选文件不能混进来', () => {
    assert.deepEqual(SHIPPED_ASSET_PATHS, ['assets/idle.webm', 'assets/reaction.webm']);
    assert.throws(() => assertShippedAssets(['assets/idle.webm', 'assets-pipeline/out/candidate.webm']));
  });

  test('成品字节保持已记录的哈希，任一字节变化指纹就变', async () => {
    const hashed = await hashShippedAssets(root);
    assert.equal(hashed.files[0]?.sha256, '6ebca6b20bcce978f5a52f8333212784b3a642d0b8803c630a455439ebb7df1a');
    assert.equal(hashed.files[1]?.sha256, '9d73e16ca8d9abcfff96a41d9e98f632a241691ddf81b59538b16a6e77049861');
    const changed = canonicalAssetSha256([
      hashed.files[0]!,
      { path: hashed.files[1]!.path, sha256: 'f'.repeat(64) },
    ]);
    assert.notEqual(changed, hashed.assetSha256);
    const idle = readFileSync(path.join(root, 'assets/idle.webm'));
    assert.equal(idle.length > 0, true);
  });
});
