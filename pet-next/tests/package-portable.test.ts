/**
 * M3-10 C：便携包清单/过滤单测（不启动 Windows、不下载 Electron）。
 * @module pet-next/tests/package-portable
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// @ts-expect-error 构建脚本是无类型 .mjs
import { RUNTIME_DIRS, isForbiddenStagingPath, stageRuntime } from '../scripts/package-portable.mjs';

test('禁止项：开发目录/测试/证据/密钥/source map 一律不得进入运行包', () => {
  const forbidden = [
    'node_modules/electron/index.js',
    'dist/tests/e2e.js',
    'dist/bench/run.js',
    'dist/app/page.test.js',
    'dist/app/page.js.map',
    'chat-evidence/x.json',
    'experiments/arbiter/main.js',
    'assets-pipeline/cli.js',
    '.git/config',
    '.env',
    '.env.local',
    'keys/id_rsa',
    'cert.pem',
    'cert.key',
    'known_hosts',
  ];
  for (const rel of forbidden) assert.equal(isForbiddenStagingPath(rel), true, rel);
  const allowed = ['dist/app/page.js', 'dist/electron/main.js', 'dist/assets/idle.webm', 'LICENSE', 'package.json'];
  for (const rel of allowed) assert.equal(isForbiddenStagingPath(rel), false, rel);
});

test('运行时白名单是固定的六个 dist 目录', () => {
  assert.deepEqual([...RUNTIME_DIRS], ['adapters', 'core', 'contracts', 'electron', 'app', 'assets']);
});

test('stageRuntime 只复制白名单内的运行文件，跳过测试与 map', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'm310-stage-'));
  const dist = path.join(root, 'dist');
  const stage = path.join(root, 'stage');
  try {
    for (const dir of RUNTIME_DIRS) mkdirSync(path.join(dist, dir), { recursive: true });
    writeFileSync(path.join(dist, 'electron/main.js'), 'export {};\n');
    writeFileSync(path.join(dist, 'electron/main.js.map'), '{}\n');
    writeFileSync(path.join(dist, 'app/page.js'), 'export {};\n');
    writeFileSync(path.join(dist, 'app/page.test.js'), 'export {};\n');
    writeFileSync(path.join(dist, 'assets/idle.webm'), 'x');
    mkdirSync(stage, { recursive: true });

    const copied = await stageRuntime(stage, dist);
    assert.ok(copied.includes('dist/electron/main.js'));
    assert.ok(copied.includes('dist/app/page.js'));
    assert.ok(copied.includes('dist/assets/idle.webm'));
    assert.equal(copied.some((item: string) => item.endsWith('.map')), false);
    assert.equal(copied.some((item: string) => item.includes('.test.')), false);

    const stagedElectron = await readdir(path.join(stage, 'dist/electron'));
    assert.deepEqual(stagedElectron, ['main.js']);
    assert.equal(existsSync(path.join(stage, 'dist/app/page.test.js')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
