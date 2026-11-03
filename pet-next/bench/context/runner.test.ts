/**
 * M3-4 C runner 自测（纯 fake，零真实调用、零 Electron；会被 pnpm verify 的 unit 层收集）。
 * 覆盖：18 次全链路两臂语义、续账不重发、预算封顶、live 预检拒绝时不消费额度。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('续账：同一 runId 二次运行不重发（0 次 POST、18 行 skip-replay）', async () => {
  const runId = uniqueRunId('replay');
  const first = await runEvaluation({ mode: 'fixture', runId });
  assert.equal(first.attempts, 18);
  const before = attemptCount(runId);
  const second = await runEvaluation({ mode: 'fixture', runId });
  assert.equal(second.attempts, 0, '续账绝不重发');
  assert.equal(second.skippedReplay, 18);
  assert.equal(attemptCount(runId), before, 'attempt 行数不变（额度未重复消费）');
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
