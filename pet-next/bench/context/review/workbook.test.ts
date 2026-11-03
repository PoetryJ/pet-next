/**
 * M3-4 D 自测：用 fixture（fake）产物验证评分流程与预算保护（RUBRIC：fake 不得进真实结论）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { runEvaluation } from '../runner.ts';
import { buildWorkbook } from './workbook.ts';

const scratch = mkdtempSync(path.join(tmpdir(), 'm3d4-workbook-test-'));
// workbook 支持注入 runsDir；runner 的 RUNS_DIR 是仓库内常量，此处复用它产 fixture run，跑完清理。
const RUNS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../runs');
const createdRuns: string[] = [];
after(() => {
  for (const runId of createdRuns) rmSync(path.join(RUNS_DIR, runId), { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

test('workbook 吃 fixture 全量产物：账本一致、行数 18、材料含观测点与结构', async () => {
  const runId = `wb-full-${Date.now()}`;
  createdRuns.push(runId);
  await runEvaluation({ mode: 'fixture', runId });
  const workbook = buildWorkbook(runId);
  assert.equal(workbook.cases, 18);
  assert.equal(workbook.attempts, 18);
  assert.equal(workbook.settledOk, 18);
  assert.equal(workbook.ledgerMatches, true, '账本与逐例材料必须一一对应');
  assert.equal(workbook.overBudget, false);
  const sheet = workbook.rows.join('\n');
  assert.ok(sheet.includes('林小满'), '第三问观测点提示必须在表内');
  assert.ok(sheet.includes('豆包'), 'S3 泄漏观测提示必须在表内');
  assert.ok(sheet.includes('system>user>assistant>user>assistant>user'), 'on 臂第三问结构（system+2 轮历史+当前 user 共 6 条）可读呈现');
  assert.ok(sheet.includes('（reset）'), 'S3 reset 轮必须标注');
});

test('workbook 复验预算保护：maxPosts=3 产物 attempts=3 且不越界', async () => {
  const runId = `wb-budget-${Date.now()}`;
  createdRuns.push(runId);
  await runEvaluation({ mode: 'fixture', runId, maxPosts: 3 });
  const workbook = buildWorkbook(runId);
  assert.equal(workbook.attempts, 3);
  assert.equal(workbook.cases, 3);
  assert.equal(workbook.overBudget, false);
});

test('缺产物的 runId 必须报错（不静默给空表）', () => {
  assert.throws(() => buildWorkbook(`no-such-${Date.now()}`), /不完整/);
});
