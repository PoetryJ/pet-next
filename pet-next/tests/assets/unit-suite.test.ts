/**
 * 产品测试不能 import 素材流水线，所以纯函数套件在这里当子进程跑。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('素材流水线纯函数套件通过', async () => {
  const dir = path.join(petRoot, 'assets-pipeline');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.test.ts')).sort();
  assert.deepEqual(files, ['assess-quality.test.ts', 'encode-alpha.test.ts', 'frame-metrics.test.ts', 'png-rgba.test.ts']);
  const result = await runNode(['--experimental-strip-types', '--test', '--test-reporter', 'spec', ...files.map((name) => path.join(dir, name))]);
  assert.equal(result.code, 0, result.stderr);
});

function runNode(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: petRoot }, (error, _stdout, stderr) => {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : 0;
      resolve({ code, stderr: String(stderr ?? '') });
    });
  });
}
