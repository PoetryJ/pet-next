/**
 * D5 平台边界自检。Windows 一律 not_run，不用 Linux 结果冒充。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runPlatformChecks } from './checks.ts';

const report = runPlatformChecks();
const byId = new Map(report.checks.map((check) => [check.id, check]));

describe('平台边界', () => {
  test('中文与空格路径能完成写入、关闭、重开与读取', () => {
    assert.equal(byId.get('path-cn-space')?.status, 'pass', byId.get('path-cn-space')?.detail);
  });

  test('坏日志被拒并给出可定位错误码', () => {
    assert.equal(byId.get('corrupt-log')?.status, 'pass', byId.get('corrupt-log')?.detail);
  });

  test('关闭后写入不会静默成功', () => {
    assert.equal(byId.get('closed-store')?.status, 'pass', byId.get('closed-store')?.detail);
  });

  test('清单指向缺失快照时恢复失败而不是当空库', () => {
    assert.equal(byId.get('orphan-snapshot')?.status, 'pass', byId.get('orphan-snapshot')?.detail);
  });

  test('中文键补丁能提交', () => {
    assert.equal(byId.get('patch-cn-path')?.status, 'pass', byId.get('patch-cn-path')?.detail);
  });

  test('只读目录在 root/Windows 下标 not_proven，不假装通过', () => {
    const check = byId.get('readonly-dir');
    assert.ok(check !== undefined);
    assert.ok(check.status === 'pass' || check.status === 'not_proven');
    if (report.uid === 0 || process.platform === 'win32') assert.equal(check.status, 'not_proven');
    if (process.platform === 'win32') assert.match(check.detail, /Windows|POSIX/);
  });

  test('可控 I/O 失败沿 store 传播（跨平台，不依赖 chmod）', () => {
    const check = byId.get('controlled-io-failure');
    assert.ok(check !== undefined);
    assert.equal(check.status, 'pass', check.detail);
    assert.match(check.detail, /io_error/);
  });

  test('权限能力按实际平台报告', () => {
    if (process.platform === 'win32') assert.equal(report.scope.permissionCapability, 'no-posix-mode');
    else if (report.uid === 0) assert.equal(report.scope.permissionCapability, 'root-bypasses-mode');
    else assert.equal(report.scope.permissionCapability, 'posix-mode-enforced');
    assert.equal(report.scope.platform, `${process.platform} ${process.arch}`);
  });

  test('Windows 状态绑定实际平台：本机非 Windows 时 not_run 并说明待补验', () => {
    if (process.platform === 'win32') {
      assert.equal(report.windows.status, 'measured');
      assert.match(report.windows.reason, /Windows/);
    } else {
      assert.equal(report.windows.status, 'not_run');
      assert.match(report.windows.reason, /待 Codex|无 Windows/);
    }
    assert.match(report.windows.command, /windows-r1.ps1|powershell/i);
  });
});
