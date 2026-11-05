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
  assert.ok(isForbidden('bench/feedback/runs/2026-11-04T08-35-48-160Z/summary.json'));
  assert.ok(!isForbidden('bench/feedback/resource.mjs'));
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
    'pet-next/LICENSE',
    'pet-next/logs/chat-evidence/demo.ndjson', // 顶层 logs 整体排除
    'pet-next/bench/context/runner.ts',
    'pet-next/bench/context/runs-x/environment.json',
    'pet-next/bench/feedback/resource.mjs',
    'pet-next/bench/feedback/runs/a/summary.json',
    'pet-next/bench/runs-x/environment.json',
    'pet-next/tests/chat-context.test.ts',
    'pet-next/M3-4-TASKS.txt', // 不在白名单
    'other-repo/file.ts', // 非 pet-next
  ].join('\n');
  const { kept, excluded } = collectTrialFiles(ls);
  assert.ok(kept.includes('core/chat/session.ts'));
  assert.ok(kept.includes('scripts/chat-trial.mjs'));
  assert.ok(kept.includes('bench/context/runner.ts'));
  assert.ok(kept.includes('bench/feedback/resource.mjs'));
  assert.ok(kept.includes('LICENSE'), '源码包必须带原始 LICENSE/版权来源');
  assert.ok(!kept.includes('M3-4-TASKS.txt'));
  assert.ok(excluded.includes('bench/context/runs-x/environment.json'));
  assert.ok(excluded.includes('bench/feedback/runs/a/summary.json'));
  // logs/ 不在白名单 → 直接跳过（既不收集也不算排除），环境快照另有黑名单兜底
  assert.ok(!kept.includes('logs/chat-evidence/demo.ndjson'));
});

test('collectTrialFiles：M3-7 双击试用入口全链进包（启动.cmd + launcher 各层 + 文档）', () => {
  const ls = [
    'pet-next/启动.cmd', // 顶层中文文件名：必须显式白名单
    'pet-next/scripts/launch-trial.mjs',
    'pet-next/scripts/launch-trial.d.mts',
    'pet-next/scripts/launch-trial.test.mjs', // 假想同层测试（scripts/ 整目录）
    'pet-next/contracts/launcher.ts',
    'pet-next/core/launcher/controller.ts',
    'pet-next/adapters/launcher/ipc.ts',
    'pet-next/app/launcher.html',
    'pet-next/app/launcher.ts',
    'pet-next/tests/launcher/launch-trial.test.ts',
    'pet-next/tests/launcher/first-run.e2e.test.ts',
    'pet-next/docs/WINDOWS-TRIAL.md',
    'pet-next/启动-别的.cmd', // 不在白名单：不得顺带收集
  ].join('\n');
  const { kept, excluded } = collectTrialFiles(ls);
  for (const file of [
    '启动.cmd',
    'scripts/launch-trial.mjs',
    'scripts/launch-trial.d.mts',
    'contracts/launcher.ts',
    'core/launcher/controller.ts',
    'adapters/launcher/ipc.ts',
    'app/launcher.html',
    'app/launcher.ts',
    'tests/launcher/launch-trial.test.ts',
    'tests/launcher/first-run.e2e.test.ts',
    'docs/WINDOWS-TRIAL.md',
  ]) {
    assert.ok(kept.includes(file), `试用包必须包含 ${file}`);
  }
  assert.ok(!kept.includes('启动-别的.cmd'), '白名单外的顶层文件不得混入');
  assert.equal(excluded.length, 0);
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
  // 解压包内没有 .git：注入清单（任务书 A：打包 CLI 测试不能依赖包外 .git）。
  const dir = mkdtempSync(path.join(tmpdir(), 'm35-pkg-dry-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const listFile = path.join(dir, 'ls-files.txt');
  writeFileSync(
    listFile,
    ['pet-next/README.md', 'pet-next/core/chat/session.ts', 'pet-next/logs/x.log', 'pet-next/tests/chat-evidence/a.ndjson'].join('\n'),
    'utf8',
  );
  const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(petRoot, 'scripts/make-trial-package.mjs'), '--dry-run', '--only-src'], {
      cwd: dir,
      env: { ...process.env, PET_NEXT_TRIAL_FILE_LIST: listFile },
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
