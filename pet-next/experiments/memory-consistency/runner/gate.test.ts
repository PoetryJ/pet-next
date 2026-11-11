/**
 * 门禁入口与结果信封的回归测试。
 *
 * 覆盖 REVIEW F3d 的三类假通过：
 * - 空脚本 exit 0；
 * - 结果文件里是上一次的 runId；
 * - passed_gate=false 但进程 exit 0。
 * 另外覆盖含空格/中文路径与 Windows 风格 argv 的 CLI 判定。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { GATE_SCHEMA_VERSION } from '../contracts.ts';
import { fileUrlForPath, gateMeta, isMainModule, writeGateReport } from './gate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT = join(HERE, '..');

describe('CLI 入口判定', () => {
  test('宿主自建路径与 URL 能识别为入口（跨平台）', () => {
    // 用宿主 API 同时造路径和 URL，避免手拼 file:// 在 Windows 上带盘符失配。
    const file = join(tmpdir(), 'repo', 'pet-next', 'runner', 'g1.ts');
    assert.equal(isMainModule(file, pathToFileURL(file).href), true);
  });

  test('含空格与中文的路径也识别为入口（旧实现会因百分号编码失配）', () => {
    const file = join(tmpdir(), '记忆 实验', 'memory-consistency', 'runner', 'g1.ts');
    const moduleUrl = pathToFileURL(file).href;
    assert.equal(isMainModule(file, moduleUrl), true);
    // 旧写法对照：直接拼 file:// 一定失配。
    assert.notEqual(`file://${file}`, moduleUrl);
  });

  test('纯转换契约：Windows 字面路径在任意宿主都能归一化', () => {
    // 这是「纯转换」，不依赖宿主 pathToFileURL；真正的入口判定另测。
    const file = 'C:\\repo\\pet-next\\experiments\\memory-consistency\\runner\\g1.ts';
    assert.equal(fileUrlForPath(file), 'C:/repo/pet-next/experiments/memory-consistency/runner/g1.ts');
    assert.equal(isMainModule(file, 'file:///C:/repo/pet-next/experiments/memory-consistency/runner/g1.ts'), true);
  });

  test('不是入口时返回 false，且空 argv 不抛错', () => {
    assert.equal(isMainModule(undefined, 'file:///x.ts'), false);
    assert.equal(isMainModule('', 'file:///x.ts'), false);
    assert.equal(isMainModule('/a/b.ts', 'file:///c/d.ts'), false);
  });
});

describe('门禁信封', () => {
  test('缺省身份是 unknown，调用方必须能据此拒绝', () => {
    const meta = gateMeta({});
    assert.equal(meta.runId, 'unknown');
    assert.equal(meta.sourceCommit, 'unknown');
  });

  test('写出的信封带 schema/gateId/runId/sourceCommit 与 passed_gate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-envelope-'));
    try {
      const envelope = writeGateReport(
        dir,
        'g1.json',
        'G1',
        { gate: 'G1', passed_gate: false },
        { runId: 'run-1', sourceCommit: 'abc123', startedAt: '2026-01-01T00:00:00.000Z' },
      );
      assert.equal(envelope.schemaVersion, GATE_SCHEMA_VERSION);
      assert.equal(envelope.gateId, 'G1');
      assert.equal(envelope.runId, 'run-1');
      assert.equal(envelope.sourceCommit, 'abc123');
      assert.equal(envelope.passed_gate, false);
      const parsed = JSON.parse(readFileSync(join(dir, 'g1.json'), 'utf8'));
      assert.equal(parsed.envelope.runId, 'run-1');
      assert.equal(parsed.passed_gate, false, '报告本体仍在信封外层');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('run.mjs 不接受假通过', () => {
  // 沙箱路径带空格与中文：CLI 入口判定与子进程启动都在这种路径下真实执行。
  const sandbox = mkdtempSync(join(tmpdir(), 'gate run 记忆-'));

  const makeSandbox = (g1Source: string): string => {
    const root = join(sandbox, `case-${Math.random().toString(36).slice(2, 8)}`);
    const dir = join(root, 'experiments', 'memory-consistency');
    mkdirSync(join(dir, 'runner'), { recursive: true });
    cpSync(join(EXPERIMENT, 'run.mjs'), join(dir, 'run.mjs'));
    cpSync(join(EXPERIMENT, 'runner', 'gate.ts'), join(dir, 'runner', 'gate.ts'));
    cpSync(join(EXPERIMENT, 'contracts.ts'), join(dir, 'contracts.ts'));
    writeFileSync(join(dir, 'runner', 'g1.ts'), g1Source, 'utf8');
    return dir;
  };

  const runGate = (dir: string, outDir: string, extra: string[] = []): { code: number; stdout: string } => {
    try {
      const stdout = execFileSync(process.execPath, [join(dir, 'run.mjs'), '--gate=G1', `--out=${outDir}`, ...extra], {
        cwd: join(dir, '..', '..'),
        encoding: 'utf8',
        timeout: 120_000,
      });
      return { code: 0, stdout };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      return { code: failure.status ?? 1, stdout: String(failure.stdout ?? '') };
    }
  };

  test('空脚本 exit 0 判失败（result_missing）', () => {
    const dir = makeSandbox('process.exit(0);\n');
    const out = join(sandbox, 'out-empty');
    mkdirSync(out, { recursive: true });
    const result = runGate(dir, out, ['--source-commit=deadbeef']);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /result_missing/);
    rmSync(join(dir, '..', '..'), { recursive: true, force: true });
  });

  test('上一次 runId 的结果判失败（stale_run_id）', () => {
    const stub = `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const out = process.argv[process.argv.indexOf('--out') + 1];
writeFileSync(join(out, 'g1.json'), JSON.stringify({ envelope: { schemaVersion: 'memory-gate/v1', gateId: 'G1', runId: 'previous-run', sourceCommit: 'deadbeef', startedAt: 'x', finishedAt: 'x', passed_gate: true } }));
process.exit(0);
`;
    const dir = makeSandbox(stub);
    const out = join(sandbox, 'out-stale');
    mkdirSync(out, { recursive: true });
    const result = runGate(dir, out, ['--source-commit=deadbeef']);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /stale_run_id/);
    rmSync(join(dir, '..', '..'), { recursive: true, force: true });
  });

  test('passed_gate=false 但 exit 0 判失败', () => {
    const stub = `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const out = process.argv[process.argv.indexOf('--out') + 1];
writeFileSync(join(out, 'g1.json'), JSON.stringify({ envelope: { schemaVersion: 'memory-gate/v1', gateId: 'G1', runId: process.env.MEMORY_RUN_ID, sourceCommit: process.env.MEMORY_SOURCE_COMMIT, startedAt: 'x', finishedAt: 'x', passed_gate: false } }));
process.exit(0);
`;
    const dir = makeSandbox(stub);
    const out = join(sandbox, 'out-false');
    mkdirSync(out, { recursive: true });
    const result = runGate(dir, out, ['--source-commit=deadbeef']);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /passed_gate_false/);
    rmSync(join(dir, '..', '..'), { recursive: true, force: true });
  });

  test('正控路径本身含空格与中文（不是纯字面断言）', () => {
    assert.match(sandbox, /记忆/);
    assert.match(sandbox, / /);
  });

  test('正确信封才通过（runId 由 run.mjs 生成并核对）', () => {
    const stub = `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const out = process.argv[process.argv.indexOf('--out') + 1];
const envelope = { schemaVersion: 'memory-gate/v1', gateId: 'G1', runId: process.env.MEMORY_RUN_ID, sourceCommit: process.env.MEMORY_SOURCE_COMMIT, startedAt: process.env.MEMORY_GATE_STARTED_AT, finishedAt: new Date().toISOString(), passed_gate: true };
writeFileSync(join(out, 'g1.json'), JSON.stringify({ envelope, gate: 'G1', observationDigest: 'd' + Math.random(), passed_gate: true }));
process.exit(0);
`;
    const dir = makeSandbox(stub);
    const out = join(sandbox, 'out-good');
    mkdirSync(out, { recursive: true });
    const result = runGate(dir, out, ['--source-commit=deadbeef']);
    assert.equal(result.code, 0, result.stdout);
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    assert.equal(summary.sourceCommit, 'deadbeef');
    assert.equal(summary.sourceCommitSource, 'explicit');
    assert.equal(summary.gates[0].status, 'pass');
    assert.equal(summary.gates[0].verification.ok, true);
    assert.equal(summary.freshDir, true);
    rmSync(join(dir, '..', '..'), { recursive: true, force: true });
  });
});
