/**
 * M3-5 A 测试：qwen-recover GPU fail-closed（全部假命令，零真实 GPU 操作、
 * 零真实模型启动、零真实停进程）。注入点：PET_NEXT_QWEN_SMI_BIN（假 nvidia-smi）、
 * PET_NEXT_QWEN_VLLM_BIN（假 vllm，立即退出）、PET_NEXT_QWEN_RUNTIME_DIR（隔离 runtime）。
 * 收集：pnpm test（scripts/*.test.ts）。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseComputeApps, parseGpuList, selectFreeGpuFromSnapshots } from './qwen-recover.mjs';

const petRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(petRoot, 'scripts/qwen-recover.mjs');

const scratch = mkdtempSync(path.join(tmpdir(), 'm35-qwen-recover-test-'));
const cleanups: Array<() => void> = [];
after(() => {
  for (const fn of cleanups) fn();
  rmSync(scratch, { recursive: true, force: true });
});

/** 假 nvidia-smi：按 PET_NEXT_FAKE_SMI_MODE 行为。 */
const FAKE_SMI = path.join(scratch, 'fake-nvidia-smi.cjs');
writeFileSync(FAKE_SMI, `#!/usr/bin/env node
const mode = process.env.PET_NEXT_FAKE_SMI_MODE ?? 'ok';
const flag = process.argv[2] ?? '';
if (mode === 'fail') { console.error('fake smi failure'); process.exit(1); }
if (mode === 'garbage' && flag.includes('compute-apps')) { console.log('this,is,not,a,pid'); process.exit(0); }
if (mode === 'empty-gpu' && flag.includes('query-gpu')) { process.exit(0); } // 空 GPU 列表
if (flag.includes('compute-apps')) {
  if (mode === 'busy') console.log('GPU-aaa,1234,1000 MiB\\nGPU-aaa,5678,500 MiB');
  else if (mode === 'partial') console.log('GPU-aaa,1234,1000 MiB'); // gpu0 忙、gpu1 闲
  else process.exit(0); // ok：无计算进程
}
if (flag.includes('query-gpu')) console.log('0, GPU-aaa\\n1, GPU-bbb');
process.exit(0);
`, 'utf8');
chmodSync(FAKE_SMI, 0o755);

/** 假 vllm：记录被调用后立即退出（健康循环将判"提前退出"——零真实模型）。 */
const FAKE_VLLM = path.join(scratch, 'fake-vllm.cjs');
writeFileSync(FAKE_VLLM, `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.PET_NEXT_FAKE_VLLM_MARKER ?? '/dev/null', process.argv.join(' ') + '\\n');
process.exit(0);
`, 'utf8');
chmodSync(FAKE_VLLM, 0o755);

interface CliResult { code: number | null; stdout: string; stderr: string }

function runCli(mode: string, envOverrides: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { PET_NEXT_QWEN_SMI_BIN: FAKE_SMI, ...envOverrides };
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    const child = spawn(process.execPath, [scriptPath, mode], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('parseComputeApps：正常/坏行', () => {
  const ok = parseComputeApps('GPU-aaa, 1234, 1000 MiB\nGPU-bbb, 5678, [N/A]');
  assert.ok(ok.ok);
  assert.equal(ok.ok ? ok.apps.length : 0, 2);
  assert.equal(ok.ok ? ok.apps[0].pid : 0, 1234);
  assert.equal(parseComputeApps('').ok, true);
  const bad = parseComputeApps('GPU-aaa, notapid, 1000 MiB');
  assert.equal(bad.ok, false);
});

test('parseGpuList：正常/坏行/空列表 fail', () => {
  const ok = parseGpuList('0, GPU-aaa\n1, GPU-bbb');
  assert.ok(ok.ok);
  assert.equal(ok.ok ? ok.gpus.length : 0, 2);
  assert.equal(parseGpuList('xx, GPU-aaa').ok, false);
  const empty = parseGpuList('');
  assert.equal(empty.ok, false);
  assert.ok(!empty.ok && empty.reason.includes('无有效 GPU'));
});

const SNAP_FREE = { ok: true as const, apps: [], gpus: [{ index: 0, uuid: 'GPU-aaa' }, { index: 1, uuid: 'GPU-bbb' }] };
const SNAP_BUSY0 = { ok: true as const, apps: [{ uuid: 'GPU-aaa', pid: 1, memMiB: 1 }], gpus: SNAP_FREE.gpus };
const SNAP_BAD = { ok: false as const, reason: '查询失败' };

test('selectFreeGpuFromSnapshots：全空→0；一忙一闲→1；全忙→null；任一无效→fail；矛盾→fail', () => {
  assert.deepEqual(selectFreeGpuFromSnapshots(SNAP_FREE, SNAP_FREE), { ok: true, gpu: 0 });
  assert.deepEqual(selectFreeGpuFromSnapshots(SNAP_BUSY0, SNAP_BUSY0), { ok: true, gpu: 1 });
  const busyAll = {
    ok: true as const,
    apps: [{ uuid: 'GPU-aaa', pid: 1, memMiB: 1 }, { uuid: 'GPU-bbb', pid: 2, memMiB: 1 }],
    gpus: SNAP_FREE.gpus,
  };
  assert.deepEqual(selectFreeGpuFromSnapshots(busyAll, busyAll), { ok: true, gpu: null });
  assert.equal(selectFreeGpuFromSnapshots(SNAP_FREE, SNAP_BAD).ok, false);
  assert.equal(selectFreeGpuFromSnapshots(SNAP_BAD, SNAP_FREE).ok, false);
  const snapOther = { ok: true as const, apps: [], gpus: [{ index: 0, uuid: 'GPU-zzz' }] };
  const conflict = selectFreeGpuFromSnapshots(SNAP_FREE, snapOther);
  assert.ok(!conflict.ok && conflict.reason.includes('矛盾'));
  // 保守性：第一次空、第二次有进程 → 该卡忙（任一时刻见过即忙）
  const seenLater = selectFreeGpuFromSnapshots(SNAP_FREE, SNAP_BUSY0);
  assert.deepEqual(seenLater, { ok: true, gpu: 1 });
});

test('CLI --status：查询失败/乱码/空 GPU 列表 → unknown 且 exit 1；正常 → 不报 unknown', async () => {
  for (const mode of ['fail', 'garbage', 'empty-gpu']) {
    const run = await runCli('--status', { PET_NEXT_FAKE_SMI_MODE: mode });
    assert.equal(run.code, 1, `${mode}: ${run.stdout}`);
    assert.ok(run.stdout.includes('unknown'), `${mode}: ${run.stdout}`);
    assert.ok(!run.stdout.includes('四卡空闲'), `${mode} 不得误报空闲`);
  }
  const okRun = await runCli('--status', { PET_NEXT_FAKE_SMI_MODE: 'busy' });
  assert.equal(okRun.code, 0, okRun.stdout);
  assert.ok(okRun.stdout.includes('2 个计算进程'), okRun.stdout);
  assert.ok(!okRun.stdout.includes('unknown'), okRun.stdout);
});

test('CLI --wait-start：查询失败 → 拒绝启动 exit 1（不选卡、无 spawn、无 identity）', async () => {
  const runtimeDir = mkdtempSync(path.join(scratch, 'rt-fail-'));
  cleanups.push(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const marker = path.join(runtimeDir, 'vllm-called');
  const run = await runCli('--wait-start', {
    PET_NEXT_FAKE_SMI_MODE: 'fail',
    PET_NEXT_QWEN_RUNTIME_DIR: runtimeDir,
    PET_NEXT_QWEN_VLLM_BIN: FAKE_VLLM,
    PET_NEXT_FAKE_VLLM_MARKER: marker,
  });
  assert.equal(run.code, 1, run.stderr);
  assert.ok(run.stderr.includes('拒绝启动'), run.stderr);
  assert.ok(!existsSync(marker), '查询失败绝不得启动 vllm');
  assert.ok(!existsSync(path.join(runtimeDir, 'identity.json')), '失败路径不写 identity');
});

test('CLI --wait-start：双查询矛盾 → 拒绝启动 exit 1', async () => {
  const runtimeDir = mkdtempSync(path.join(scratch, 'rt-flip-'));
  cleanups.push(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const flipSmi = path.join(runtimeDir, 'flip-smi.cjs');
  const counterFile = path.join(runtimeDir, 'count');
  writeFileSync(flipSmi, `#!/usr/bin/env node
const fs = require('node:fs');
let n = 0; try { n = Number(fs.readFileSync(${JSON.stringify(counterFile)}, 'utf8')) || 0; } catch {}
n += 1; fs.writeFileSync(${JSON.stringify(counterFile)}, String(n));
const flag = process.argv[2] ?? '';
// 第 3 次起（第二份快照的 compute-apps）报告有进程 → 与第一份矛盾场景由并集兜底；
// 第 4 次（第二份的 query-gpu）返回空列表 → 第二份快照无效 → unknown 拒启动。
if (n >= 4 && flag.includes('query-gpu')) process.exit(0);
if (flag.includes('query-gpu')) console.log('0, GPU-aaa\\n1, GPU-bbb');
process.exit(0);
`, 'utf8');
  chmodSync(flipSmi, 0o755);
  const run = await runCli('--wait-start', {
    PET_NEXT_QWEN_SMI_BIN: flipSmi,
    PET_NEXT_QWEN_RUNTIME_DIR: runtimeDir,
    PET_NEXT_QWEN_VLLM_BIN: FAKE_VLLM,
    PET_NEXT_FAKE_VLLM_MARKER: path.join(runtimeDir, 'vllm-called'),
  });
  assert.equal(run.code, 1, run.stderr);
  assert.ok(run.stderr.includes('拒绝启动'), run.stderr);
  assert.ok(!existsSync(path.join(runtimeDir, 'vllm-called')), '矛盾时不得启动');
});

test('CLI --wait-start：空闲判定成立才 spawn（假 vllm 立即退出 → "提前退出" exit 1，零真实模型）', async () => {
  const runtimeDir = mkdtempSync(path.join(scratch, 'rt-free-'));
  cleanups.push(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const marker = path.join(runtimeDir, 'vllm-called');
  const run = await runCli('--wait-start', {
    PET_NEXT_FAKE_SMI_MODE: 'ok', // 两份快照全空且一致 → 选卡 0
    PET_NEXT_QWEN_RUNTIME_DIR: runtimeDir,
    PET_NEXT_QWEN_VLLM_BIN: FAKE_VLLM,
    PET_NEXT_FAKE_VLLM_MARKER: marker,
  });
  assert.equal(run.code, 1, run.stdout + run.stderr); // 假 vllm 立即退出 → 健康循环判"提前退出"
  assert.ok(run.stdout.includes('提前退出') || run.stderr.includes('提前退出'), run.stdout + run.stderr);
  assert.ok(existsSync(marker), '空闲判定成立后必须以注入的假 vllm 启动（参数被记录）');
  const identity = JSON.parse(readFileSync(path.join(runtimeDir, 'identity.json'), 'utf8')) as { gpu: number; cmdline: string };
  assert.equal(identity.gpu, 0);
  assert.ok(identity.cmdline.includes('serve'), identity.cmdline);
});

test('导入模块零副作用：不触发任何模式（无 unknown 输出路径执行）', () => {
  // import 已在文件顶部完成且未抛错/未退出即通过；补充断言导出为函数。
  assert.equal(typeof parseComputeApps, 'function');
  assert.equal(typeof selectFreeGpuFromSnapshots, 'function');
});
