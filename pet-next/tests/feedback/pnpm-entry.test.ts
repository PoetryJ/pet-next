/**
 * M3-7 A：pnpm 入口解析回归（对应 WINDOWS-R1-REVIEW 两处入口缺陷）。
 * 覆盖：解析优先级、Windows 无 CLI 文件显式报错、中文+空格路径真实 spawn、子进程 exit7 透传、失败无残留。
 * @module pet-next/tests/feedback/pnpm-entry.test
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolvePnpmEntry } from './pnpm-entry.ts';

const petRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
}

test('PET_NEXT_PNPM_CLI 优先，且 command 是当前 Node 可执行文件', () => {
  const entry = resolvePnpmEntry(petRoot, {
    env: { PET_NEXT_PNPM_CLI: '/opt/pnpm/bin/pnpm.cjs' },
    exists: (file) => file === '/opt/pnpm/bin/pnpm.cjs',
    execPath: '/usr/bin/node',
    platform: 'win32',
  });
  assert.deepEqual(entry, { command: '/usr/bin/node', args: ['/opt/pnpm/bin/pnpm.cjs'] });
});

test('PET_NEXT_PNPM_CLI 指向不存在文件时显式报错，不产生子进程', () => {
  assert.throws(
    () =>
      resolvePnpmEntry(petRoot, {
        env: { PET_NEXT_PNPM_CLI: '/missing/pnpm.cjs' },
        exists: () => false,
        platform: 'linux',
      }),
    /PET_NEXT_PNPM_CLI 指向的文件不存在/,
  );
});

test('项目内 tools/ 与 node_modules/ 候选按顺序命中', () => {
  const toolsCli = path.join(petRoot, 'tools/node_modules/pnpm/bin/pnpm.cjs');
  const entry = resolvePnpmEntry(petRoot, {
    env: {},
    exists: (file) => file === toolsCli,
    execPath: '/usr/bin/node',
    platform: 'linux',
  });
  assert.deepEqual(entry, { command: '/usr/bin/node', args: [toolsCli] });
});

test('由 Node 前缀推导全局 pnpm CLI（Unix 布局）', () => {
  const cli = '/opt/node/lib/node_modules/pnpm/bin/pnpm.cjs';
  const entry = resolvePnpmEntry('/app', {
    env: {},
    exists: (file) => file === cli,
    execPath: '/opt/node/bin/node',
    platform: 'linux',
  });
  assert.deepEqual(entry, { command: '/opt/node/bin/node', args: [cli] });
});

test('Windows 无任何 CLI 文件时明确报错（绝不回退 spawn pnpm/.cmd）', () => {
  assert.throws(
    () => resolvePnpmEntry(petRoot, { env: {}, exists: () => false, platform: 'win32', execPath: 'C:\\node\\node.exe' }),
    /Windows 下找不到 pnpm CLI 文件/,
  );
});

test('非 Windows 无 CLI 文件时保留 spawn pnpm 原行为', () => {
  const entry = resolvePnpmEntry(petRoot, { env: {}, exists: () => false, platform: 'linux' });
  assert.deepEqual(entry, { command: 'pnpm', args: [] });
});

test('中文+空格路径下真实 spawn 子进程，exit 7 透传', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pnpm-entry-'));
  const dir = path.join(base, '中文 空格 目录');
  const cli = path.join(dir, 'fake-pnpm.cjs');
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      cli,
      "process.exit(Number(process.env.FAKE_PNPM_EXIT ?? '0'));\n",
      'utf8',
    );
    const entry = resolvePnpmEntry(petRoot, {
      env: { PET_NEXT_PNPM_CLI: cli },
      exists: existsSync,
      platform: process.platform,
      execPath: process.execPath,
    });
    assert.equal(entry.command, process.execPath);
    assert.deepEqual(entry.args, [cli]);
    const code = await run(entry.command, entry.args, { ...process.env, FAKE_PNPM_EXIT: '7' });
    assert.equal(code, 7);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('找不到 CLI 文件时解析阶段即失败（无子进程可遗留）', () => {
  // 解析阶段抛错意味着调用方拿不到 command/args，不会产生子进程。
  assert.throws(
    () => resolvePnpmEntry(petRoot, { env: { PET_NEXT_PNPM_CLI: '/nope/pnpm.cjs' }, exists: () => false }),
    /不存在/,
  );
});
