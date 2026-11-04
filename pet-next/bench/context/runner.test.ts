/**
 * M3-4 C runner 自测（纯 fake，零真实调用、零 Electron；会被 pnpm verify 的 unit 层收集）。
 * 覆盖：18 次全链路两臂语义、续账不重发、预算封顶、live 预检拒绝时不消费额度。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { BUDGET_POSTS, RUNS_DIR, runEvaluation } from './runner.ts';
import type { CaseRecord } from './runner.ts';

const scratch = mkdtempSync(path.join(tmpdir(), 'm3d4-runner-test-'));
// RUNS_DIR 是常量路径——测试通过注入 runId 落在临时目录做不到，改为真实 runs/ 下唯一测试 id，结束清理。
const testRunIds: string[] = [];
after(() => {
  for (const runId of testRunIds) rmSync(path.join(RUNS_DIR, runId), { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

/** 目录内全部文件的相对路径 → (mtimeMs, sha256) 快照，用于断言"零覆盖"。 */
function dirFingerprint(runId: string): Map<string, string> {
  const root = path.join(RUNS_DIR, runId);
  const map = new Map<string, string>();
  for (const name of readdirSync(root).sort()) {
    const full = path.join(root, name);
    if (statSync(full).isFile()) {
      map.set(name, `${statSync(full).mtimeMs}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
  }
  return map;
}

function uniqueRunId(label: string): string {
  const runId = `selftest-${label}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  testRunIds.push(runId);
  return runId;
}

function readCases(runId: string): CaseRecord[] {
  return readFileSync(path.join(RUNS_DIR, runId, 'cases.ndjson'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CaseRecord);
}

function attemptCount(runId: string): number {
  return readFileSync(path.join(RUNS_DIR, runId, 'ledger.ndjson'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('"kind":"attempt"')).length;
}

test('fixture 全链路：18 次两臂，on 臂第三问带历史、off 臂单轮、S3 两臂 reset 后均单轮', async () => {
  const runId = uniqueRunId('full');
  const summary = await runEvaluation({ mode: 'fixture', runId });
  assert.equal(summary.attempts, 18, '恰好 18 次 POST');
  assert.equal(summary.settled.ok, 18, 'fake 全 ok');
  assert.equal(attemptCount(runId), 18, '账本恰好 18 行 attempt');
  const cases = readCases(runId);
  assert.equal(cases.length, 18);

  const s1onR3 = cases.find((c) => c.case === 'S1' && c.arm === 'on' && c.round === 3);
  const s1offR3 = cases.find((c) => c.case === 'S1' && c.arm === 'off' && c.round === 3);
  assert.ok(s1onR3 !== undefined);
  assert.ok(s1offR3 !== undefined);
  assert.ok((s1onR3.result.text ?? '').includes('林小满'), 'on 臂（历史注入）第三问应命中姓名');
  assert.ok(!(s1offR3.result.text ?? '').includes('林小满'), 'off 臂单轮不应知道姓名');
  assert.equal(s1onR3.historyInjected, 2, 'on 臂第三问注入前两轮');
  assert.equal(s1offR3.historyInjected, 0);

  const s2onR3 = cases.find((c) => c.case === 'S2' && c.arm === 'on' && c.round === 3);
  assert.ok((s2onR3?.result.text ?? '').includes('橙'), 'on 臂纠正生效');
  const s2offR3 = cases.find((c) => c.case === 'S2' && c.arm === 'off' && c.round === 3);
  assert.ok(!(s2offR3?.result.text ?? '').includes('橙'), 'off 臂无从得知纠正');

  for (const arm of ['off', 'on'] as const) {
    const s3r3 = cases.find((c) => c.case === 'S3' && c.arm === arm && c.round === 3);
    assert.ok(s3r3?.resetBeforeRound === true, `S3 ${arm} 臂第三问前必须 reset`);
    const messages = (s3r3?.request.body as { messages: unknown[] }).messages;
    assert.equal(messages.length, 2, `S3 ${arm} 臂 reset 后请求必须回单轮`);
    assert.ok(!(s3r3?.result.text ?? '').includes('豆包'), `S3 ${arm} 臂 reset 后不得记得宠物名`);
  }
  // 请求体增长记录（on 臂非 reset 场景逐轮增长）
  const s1onBytes = cases.filter((c) => c.case === 'S1' && c.arm === 'on').map((c) => c.request.bytes);
  assert.ok(s1onBytes[2] > s1onBytes[1] && s1onBytes[1] > s1onBytes[0], `on 臂请求字节逐轮增长：${s1onBytes.join(' → ')}`);
});

test('M3-5 完整 run 重入：只读复核（零新增 POST、既有文件 hash 与 mtime 不变）', async () => {
  const runId = uniqueRunId('replay');
  const first = await runEvaluation({ mode: 'fixture', runId });
  assert.equal(first.attempts, 18);
  const before = attemptCount(runId);
  const fingerprintBefore = dirFingerprint(runId);
  const second = await runEvaluation({ mode: 'fixture', runId });
  assert.equal(second.attempts, first.attempts, '读回原 summary');
  assert.equal(second.settled.ok, first.settled.ok);
  assert.equal(attemptCount(runId), before, '账本 attempt 行数不变');
  assert.deepEqual(dirFingerprint(runId), fingerprintBefore, '任何既有文件不得被覆盖（mtime 也不变）');
});

test('M3-5 中断 run 重入：非零拒绝（不静默续跑、不覆盖、不另开 run）', async () => {
  const runId = uniqueRunId('partial');
  // 用 maxPosts=3 先生成一个"额度上限 3 的完整 run"，再以默认上限 18 重入——
  // 该 run settled=3 < 18 且账本一致，构成"中断 run"。
  await runEvaluation({ mode: 'fixture', runId, maxPosts: 3 });
  const fingerprintBefore = dirFingerprint(runId);
  await assert.rejects(
    () => runEvaluation({ mode: 'fixture', runId }),
    /不完整（attempt 3 \/ settled 3，上限 18）——拒绝续跑/,
  );
  assert.deepEqual(dirFingerprint(runId), fingerprintBefore, '拒绝路径不得改写任何文件');
});

test('M3-5 坏账本：行不可解析 → 非零拒绝且文件不变', async () => {
  const runId = uniqueRunId('badledger');
  await runEvaluation({ mode: 'fixture', runId, maxPosts: 3 });
  const ledgerPath = path.join(RUNS_DIR, runId, 'ledger.ndjson');
  const lines = readFileSync(ledgerPath, 'utf8').split('\n');
  writeFileSync(ledgerPath, `${lines.slice(0, 2).join('\n')}\n{broken\n`, 'utf8');
  const fingerprintBefore = dirFingerprint(runId);
  await assert.rejects(() => runEvaluation({ mode: 'fixture', runId }), /不可解析——fail-closed 拒绝/);
  assert.deepEqual(dirFingerprint(runId), fingerprintBefore);
});

test('M3-5 账本与 summary 计数不一致 → 非零拒绝', async () => {
  const runId = uniqueRunId('mismatch');
  await runEvaluation({ mode: 'fixture', runId, maxPosts: 3 });
  const summaryPath = path.join(RUNS_DIR, runId, 'summary.json');
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as { attempts: number };
  summary.attempts = 99;
  writeFileSync(summaryPath, JSON.stringify(summary), 'utf8');
  await assert.rejects(() => runEvaluation({ mode: 'fixture', runId }), /summary\.attempts=99 ≠ 账本 attempt 数 3/);
});

test('预算封顶：maxPosts 耗尽即停，不超发', async () => {
  const runId = uniqueRunId('budget');
  const summary = await runEvaluation({ mode: 'fixture', runId, maxPosts: 3 });
  assert.equal(summary.attempts, 3, '发满 3 次即停');
  assert.equal(attemptCount(runId), 3, '账本恰好 3 行 attempt');
  const ledger = readFileSync(path.join(RUNS_DIR, runId, 'ledger.ndjson'), 'utf8');
  assert.ok(ledger.includes('额度 3 已用尽'), '必须有额度用尽的 run-end 记录');
});

test('live 预检失败：拒绝执行且不消费额度（账本文件不存在）', async () => {
  const runId = uniqueRunId('precheck');
  const probeFetch: typeof fetch = () =>
    Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'other-model' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(
    () => runEvaluation({ mode: 'live', runId, probeFetch, fetchImpl: probeFetch }),
    /不含 qwen3\.8-27b/,
  );
  assert.equal(existsSync(path.join(RUNS_DIR, runId, 'ledger.ndjson')), false, '预检失败不得留下任何 attempt');
});

test('冻结值：BUDGET_POSTS 必须是 18（验收授权值）', () => {
  assert.equal(BUDGET_POSTS, 18);
});
