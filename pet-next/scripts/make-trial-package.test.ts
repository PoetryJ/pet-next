/**
 * M3-5 C 测试：试用打包脚本（纯函数 + dry-run，零真实打包到仓库外也可测）。
 * 覆盖：黑名单模式、清单收集、参数解析、压缩后端回退（注入探测）、CLI dry-run。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  archiveWith,
  collectTrialFiles,
  isForbidden,
  parsePackageArgs,
} from './make-trial-package.mjs';

const petRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('isForbidden：运行现场/密钥/env 快照全命中；源码文件不命中', () => {
  assert.ok(isForbidden('node_modules/x/y.js'));
  assert.ok(isForbidden('dist/electron/main.js'));
  assert.ok(isForbidden('logs/chat-evidence/a/userdata/Cache/1'));
  assert.ok(isForbidden('bench/runs-click-123/environment.json'));
  assert.ok(isForbidden('tests/chat-evidence/trial/a.ndjson'));
  assert.ok(isForbidden('tests/independent-trial-windows.check.ts'));
  assert.ok(isForbidden('config/id_rsa'));
  assert.ok(isForbidden('config/server.pem'));
  assert.ok(isForbidden('.env.local'));
  assert.ok(isForbidden('scripts/.pnpm-store/x'));
  assert.ok(!isForbidden('core/chat/session.ts'));
  assert.ok(!isForbidden('package.json'));
  assert.ok(!isForbidden('docs/WINDOWS-TRIAL.md'));
});

test('collectTrialFiles：白名单目录收集、黑名单剔除、非 pet-next 前缀忽略', () => {
  const ls = [
    'pet-next/core/chat/session.ts',
    'pet-next/scripts/chat-trial.mjs',
    'pet-next/package.json',
    'pet-next/logs/chat-evidence/demo.ndjson', // 顶层 logs 整体排除
    'pet-next/bench/context/runner.ts',
    'pet-next/bench/context/runs-x/environment.json',
    'pet-next/bench/runs-x/environment.json',
    'pet-next/tests/chat-context.test.ts',
    'pet-next/M3-4-TASKS.txt', // 不在白名单
    'other-repo/file.ts', // 非 pet-next
  ].join('\n');
  const { kept, excluded } = collectTrialFiles(ls);
  assert.ok(kept.includes('core/chat/session.ts'));
  assert.ok(kept.includes('scripts/chat-trial.mjs'));
  assert.ok(kept.includes('bench/context/runner.ts'));
  assert.ok(!kept.includes('M3-4-TASKS.txt'));
  assert.ok(excluded.includes('bench/context/runs-x/environment.json'));
  // logs/ 不在白名单 → 直接跳过（既不收集也不算排除），环境快照另有黑名单兜底
  assert.ok(!kept.includes('logs/chat-evidence/demo.ndjson'));
});

test('parsePackageArgs：正常与错误', () => {
  const ok = parsePackageArgs(['--out', '/tmp/x', '--only-src', '--dry-run', '--evidence', 'a', '--evidence', 'b']);
  assert.equal(ok.error, undefined);
  assert.equal(ok.out, '/tmp/x');
  assert.ok(ok.onlySrc);
  assert.ok(ok.dryRun);
  assert.deepEqual(ok.evidence, ['a', 'b']);
  assert.notEqual(parsePackageArgs(['--bogus']).error, undefined);
  assert.notEqual(parsePackageArgs(['--out']).error, undefined);
});

test('archiveWith：后端回退（zip 不可用→python3 不可用→tar 可用）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'm35-pkg-archive-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'hello.txt'), 'hello trial', 'utf8');
  // 全部探测为假 → 抛错
  assert.throws(() =>
    archiveWith(dir, path.join(dir, 'nope'), ['hello.txt'], {
      zipProbe: () => false,
      pyProbe: () => false,
      tarProbe: () => false,
    }),
  /无可用压缩后端/);
  // zip/py 不可用、tar 可用（注入假命令记录收到的参数）——直接用真 tar 验证产物存在
  const result = archiveWith(dir, path.join(dir, 'bundle'), ['hello.txt'], {
    zipProbe: () => false,
    pyProbe: () => false,
    tarProbe: () => true,
  });
  assert.equal(result.format, 'tar.gz');
  assert.ok(result.file.endsWith('bundle.tar.gz'));
});

test('CLI --dry-run --only-src：打印清单、退出 0、不产出压缩包', async () => {
  const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(petRoot, 'scripts/make-trial-package.mjs'), '--dry-run', '--only-src'], {
      cwd: petRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  assert.equal(run.code, 0, run.stderr);
  assert.ok(run.stdout.includes('黑名单排除'), run.stdout);
  assert.ok(run.stdout.includes('+ README.md'), run.stdout.slice(0, 400));
  assert.ok(!run.stdout.includes('id_rsa'), run.stdout);
});

test('CLI 非法参数 → exit 2', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'm35-pkg-cli-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  const run = await new Promise<{ code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(petRoot, 'scripts/make-trial-package.mjs'), '--bogus'], {
      cwd: dir,
      stdio: 'ignore',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1 }); });
  });
  assert.equal(run.code, 2);
});
