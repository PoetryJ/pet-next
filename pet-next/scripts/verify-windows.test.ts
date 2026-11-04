/**
 * M3-6 R1 B：verify:windows 入口契约。
 * 非 Windows 必须 exit 2 且明确 not-run（不是通过）；Windows 上真实矩阵由 pwsh7 入口执行。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(petRoot, 'scripts/verify-windows.mjs');

test('非 Windows：verify:windows 入口 exit 2 且标 not-run', () => {
  if (process.platform === 'win32') return;
  const run = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /not-run|非 Windows/);
});

test('入口以脚本路径单参数传递（含空格/中文时不拼字符串）', () => {
  const source = spawnSync(process.execPath, ['-e', `console.log(require('node:fs').readFileSync(${JSON.stringify(entry)}, 'utf8'))`], {
    encoding: 'utf8',
  }).stdout;
  assert.ok(source.includes("'-File', script"), '脚本路径必须作为独立 argv，便于含空格/中文路径');
  assert.ok(source.includes("'-ExecutionPolicy', 'Bypass'"), '仅本次进程策略');
});
