/**
 * 一键脚本把命令的退出码和原始日志分开记下。没有命令时不启动进程。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { main } from './record-cli.ts';

test('没有命令时返回 1，不写记录', async () => {
  const result = await main(['--'], { quiet: true });
  assert.equal(result.code, 1);
  assert.equal(result.recordDir, '');
});

test('子进程的退出码、环境和空日志分开落盘', { timeout: 15000 }, async () => {
  const logRoot = await mkdtemp(path.join(tmpdir(), 'pet-next-cli-'));
  const result = await main(['--', process.execPath, '-e', 'process.exit(3)'], {
    logRoot,
    cwd: logRoot,
    quiet: true,
    env: { ...process.env, PET_NEXT_EXAMPLE_TOKEN: 'super-secret' },
  });
  assert.equal(result.code, 3);
  assert.equal(await readFile(path.join(result.recordDir, 'exit-code.txt'), 'utf8'), '3\n');
  const environment = await readFile(path.join(result.recordDir, 'environment.json'), 'utf8');
  assert.equal(environment.includes('super-secret'), false);
  assert.equal(JSON.parse(environment).PET_NEXT_EXAMPLE_TOKEN, '[redacted]');
  const command = JSON.parse(await readFile(path.join(result.recordDir, 'command.json'), 'utf8')) as {
    executable: string;
    args: string[];
    platform: string;
  };
  assert.equal(command.executable, process.execPath);
  assert.deepEqual(command.args, ['-e', 'process.exit(3)']);
  assert.equal(command.platform, process.platform);
  assert.equal(await readFile(path.join(result.recordDir, 'stdout.log'), 'utf8'), '');
  await readFile(path.join(result.recordDir, 'stderr.log'));
});

test('命令不存在时不以 0 结束，并且仍然留下记录', { timeout: 15000 }, async () => {
  const logRoot = await mkdtemp(path.join(tmpdir(), 'pet-next-cli-missing-'));
  const result = await main(['--', path.join(logRoot, 'missing-binary')], {
    logRoot,
    cwd: logRoot,
    quiet: true,
    timeoutMs: 3000,
  });
  assert.notEqual(result.code, 0);
  const exitCode = await readFile(path.join(result.recordDir, 'exit-code.txt'), 'utf8');
  assert.notEqual(exitCode, '0\n');
  await readFile(path.join(result.recordDir, 'command.json'), 'utf8');
  await readFile(path.join(result.recordDir, 'stdout.log'));
  await readFile(path.join(result.recordDir, 'stderr.log'));
});
