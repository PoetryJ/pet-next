/**
 * 收集单元测试并交给 node:test。
 * 跳过 `*.e2e.test.ts`：那些文件要等 `pnpm build` 之后由 `pnpm test:e2e` 跑。
 * 子目录会走进去。`bench/` 还没有测试时不把空 glob 交给运行器。
 */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['core', 'adapters', 'app', 'tests', 'experiments', 'bench'];

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
    if (entry.isDirectory()) {
      await collect(full, files);
      continue;
    }
    if (!entry.name.endsWith('.test.ts') || entry.name.endsWith('.e2e.test.ts')) continue;
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
