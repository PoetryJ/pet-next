/**
 * 收集纯单元测试并交给 node:test。
 * 四层入口各管各的，本脚本只收纯单元：
 * - `*.e2e.test.ts` 跳过：要等 `pnpm build` 之后由 `pnpm test:e2e` 跑；
 * - `tests/cleanup.test.ts` 与 `tests/support/**` 跳过：由 `pnpm test:cleanup` 跑
 *   （显式文件列表，Windows cmd 不展开 glob）；
 * - `tests/assets/pipeline.test.ts` 跳过：由 `pnpm test:integration` 跑，
 *   `assets:check` 成功不能替代素材集成测试。
 * 子目录会走进去。`bench/` 还没有测试时不把空 glob 交给运行器。
 */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['core', 'adapters', 'app', 'electron', 'tests', 'experiments', 'bench'];

// 有专属入口的套件（相对 pet-next 根目录），纯单元层不再重复收集。
const dedicatedFiles = new Set([
  path.join('tests', 'cleanup.test.ts'), // pnpm test:cleanup
  path.join('tests', 'assets', 'pipeline.test.ts'), // pnpm test:integration
]);
const dedicatedDirs = [path.join('tests', 'support')]; // pnpm test:cleanup

async function collect(dir, files) {
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
    const relative = path.relative(root, full);
    if (entry.isDirectory()) {
      if (dedicatedDirs.some((dedicated) => relative === dedicated)) continue;
      await collect(full, files);
      continue;
    }
    if (!entry.name.endsWith('.test.ts') || entry.name.endsWith('.e2e.test.ts')) continue;
    if (dedicatedFiles.has(relative)) continue;
    files.push(full);
  }
}

const files = [];
for (const rel of roots) await collect(path.join(root, rel), files);
files.sort();
if (files.length === 0) {
  console.error('没有找到单元测试');
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter', 'spec', ...files], {
    cwd: root,
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}
