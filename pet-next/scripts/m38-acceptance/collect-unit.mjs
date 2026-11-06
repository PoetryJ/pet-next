/**
 * 复刻 scripts/unit-tests.mjs 的"纯单元"收集规则，只返回文件清单，不执行测试。
 *
 * 用途：M3-8 验收需要在"同一批文件"上做串行复跑（--test-concurrency=1）并与官方
 * `pnpm test` 的数量对照。scripts/unit-tests.mjs 自身会在 import 时直接跑测试、无法复用其
 * 收集函数，因此这里独立复刻规则；若官方收集规则变化，本文件必须同步（验收清单 R-UNIT 项）。
 *
 * 规则（与 scripts/unit-tests.mjs 逐条对应）：
 * - 根：core / adapters / app / electron / scripts / tests / experiments / bench
 * - 跳过 node_modules、dist、out
 * - 只收 *.test.ts，跳过 *.e2e.test.ts
 * - 跳过 tests/cleanup.test.ts、tests/assets/pipeline.test.ts（各有专属入口）
 * - 跳过 tests/support/**（由 pnpm test:cleanup 跑）
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const roots = ['core', 'adapters', 'app', 'electron', 'scripts', 'tests', 'experiments', 'bench'];
const dedicatedFiles = new Set([
  path.join('tests', 'cleanup.test.ts'),
  path.join('tests', 'assets', 'pipeline.test.ts'),
]);
const dedicatedDirs = [path.join('tests', 'support')];

async function collect(dir, appRoot, files) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue;
    const full = path.join(dir, entry.name);
    const relative = path.relative(appRoot, full);
    if (entry.isDirectory()) {
      if (dedicatedDirs.some((dedicated) => relative === dedicated)) continue;
      await collect(full, appRoot, files);
      continue;
    }
    if (!entry.name.endsWith('.test.ts') || entry.name.endsWith('.e2e.test.ts')) continue;
    if (dedicatedFiles.has(relative)) continue;
    files.push(full);
  }
}

/** @returns {Promise<string[]>} 绝对路径，已排序（与官方收集一致） */
export async function collectUnitFiles(appRoot) {
  const files = [];
  for (const rel of roots) await collect(path.join(appRoot, rel), appRoot, files);
  files.sort();
  return files;
}
