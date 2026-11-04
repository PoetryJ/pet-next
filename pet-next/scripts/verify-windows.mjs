#!/usr/bin/env node
/**
 * M3-6 R1 B：Windows 平台验证统一入口。
 *
 * - 非 Windows：退出码 2（矩阵 win32 保持 not-run；这不是通过）。
 * - Windows：预检 PowerShell 7+（pwsh）；缺失或低于 7 → 退出码 2 并给出复跑说明，
 *   不静默回落到 Windows PowerShell 5（其执行策略拒绝加载脚本，且 UTF-8 中文解析不可靠）。
 * - 仅对本次子进程传 `-ExecutionPolicy Bypass`，不改系统 ExecutionPolicy。
 * - 脚本路径以单个 argv 传入（适配中文与含空格路径），真实退出码原样透传。
 * @module pet-next/scripts/verify-windows
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(petRoot, 'tests/platform/verify-windows.ps1');

if (process.platform !== 'win32') {
  console.error('[verify:windows] 非 Windows：win32 矩阵保持 not-run（这不是通过）。');
  process.exit(2);
}

const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
  encoding: 'utf8',
  timeout: 30_000,
});
const major = Number((probe.stdout ?? '').trim());
if (probe.status !== 0 || !Number.isInteger(major) || major < 7) {
  console.error('[verify:windows] 需要 PowerShell 7+（pwsh），当前不可用或版本过低：未运行即不是通过。');
  console.error('[verify:windows] 安装 PowerShell 7 后复跑：pnpm verify:windows');
  process.exit(2);
}

// 仅本次进程生效；不写系统 ExecutionPolicy。
const run = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
  stdio: 'inherit',
});
if (run.error) {
  console.error(`[verify:windows] 启动失败：${String(run.error)}`);
  process.exit(2);
}
process.exit(run.status ?? 1);
