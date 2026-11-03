/**
 * M3-4 D：人工复核工作簿——把 C 的 runs/<runId>/ 产物汇成盲看材料（不自动判卷）。
 * 用法：node --experimental-strip-types bench/context/review/workbook.ts --run <runId>
 * 产物：bench/context/runs/<runId>/review-sheet.md（逐例材料 + 账本一致性核对 + 观测点关键词提示）
 * 原则：RUBRIC.md——关键词命中只是提示；判定由人读原文完成；本工具不改任何样本。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLAN, SCENARIOS } from '../fixtures.ts';

const PET_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNS_DIR = path.join(PET_ROOT, 'bench/context/runs');

interface CaseRecord {
  seq: number;
  case: string;
  arm: 'off' | 'on';
  round: number;
  userText: string;
  resetBeforeRound: boolean;
  historyInjected: number;
  request: { url: string; bytes: number; body: { messages?: Array<{ role: string; content: string }> } };
  result: { status: string; text?: string; code?: string };
  meta: { http?: number; latencyMs?: number; usage?: unknown; usageUnknown?: boolean; truncated?: boolean; error?: string } | null;
  fullLatencyMs: number;
  at: string;
}

export interface WorkbookCheck {
  runId: string;
  cases: number;
  attempts: number;
  settledOk: number;
  settledNonOk: number;
  ledgerMatches: boolean;
  overBudget: boolean;
  rows: string[];
  sheetPath: string | null;
}

export function buildWorkbook(runId: string, runsDir = RUNS_DIR): WorkbookCheck {
  const runDir = path.join(runsDir, runId);
  const casesPath = path.join(runDir, 'cases.ndjson');
  const ledgerPath = path.join(runDir, 'ledger.ndjson');
  if (!existsSync(casesPath) || !existsSync(ledgerPath)) {
    throw new Error(`run 目录不完整（缺 cases/ledger）：${runDir}`);
  }
  const cases = readFileSync(casesPath, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as CaseRecord);
  const ledgerLines = readFileSync(ledgerPath, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as { kind: string; seq: number; status?: string });
  const attempts = ledgerLines.filter((line) => line.kind === 'attempt');
  const settled = ledgerLines.filter((line) => line.kind === 'settled');
  const settledOk = settled.filter((line) => line.status === 'ok').length;

  const rows: string[] = [];
  rows.push(`# M3-4 对照复核工作簿 run=${runId}`);
  rows.push('');
  rows.push(`- cases：${cases.length}；账本 attempt：${attempts.length}（上限 18）；settled ok：${settledOk} / 非 ok：${settled.length - settledOk}`);
  rows.push(`- 账本 seq 与 cases 一一对应：${attempts.every((line, index) => cases[index]?.seq === line.seq) && cases.length === attempts.length ? '一致' : '不一致（人工核对）'}`);
  rows.push('');
  rows.push('| seq | 场景 | 臂 | 轮 | 用户文本 | 回复（原文） | 关键词提示 | messages 结构 | usage | fullLatencyMs | bytes |');
  rows.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const record of cases) {
    const scenario = SCENARIOS.find((item) => item.id === record.case);
    const roles = (record.request.body.messages ?? []).map((message) => message.role).join('>');
    const text = (record.result.text ?? `[${record.result.status}:${record.result.code ?? ''}]`).replace(/\|/g, '/').replace(/\n/g, ' ');
    const probe = record.round === 3 && scenario ? (record.arm === 'on' && !record.resetBeforeRound ? scenario.probe.expectKeywordsOnArmUsedContext.join('/') : scenario.probe.mustNotAppearWhenNoContext.join('/')) : '-';
    const usage = record.meta?.usage === undefined || record.meta?.usage === 'unknown' ? 'unknown' : JSON.stringify(record.meta.usage);
    const truncated = record.meta?.truncated === true ? '⚠截断' : '';
    rows.push(`| ${record.seq} | ${record.case} | ${record.arm} | ${record.round}${record.resetBeforeRound ? '（reset）' : ''} | ${record.userText} | ${text}${truncated} | ${probe} | ${roles}（注入${record.historyInjected}轮） | ${usage} | ${record.fullLatencyMs} | ${record.request.bytes} |`);
  }
  rows.push('');
  rows.push('## 盲看法（RUBRIC.md）：先盖住“臂”列读回复判合理性，再对照方向性。');
  rows.push('');
  const planNote = PLAN.map((group) => `${group.case}-${group.arm}`).join(' → ');
  rows.push(`计划（冻结）：${planNote}`);
  return {
    runId,
    cases: cases.length,
    attempts: attempts.length,
    settledOk,
    settledNonOk: settled.length - settledOk,
    ledgerMatches: attempts.every((line, index) => cases[index]?.seq === line.seq) && cases.length === attempts.length,
    overBudget: attempts.length > 18,
    rows,
    sheetPath: null,
  };
}

async function main(): Promise<void> {
  const runIndex = process.argv.indexOf('--run');
  const runId = runIndex >= 0 ? (process.argv[runIndex + 1] ?? '') : '';
  if (runId === '') throw new Error('用法：workbook.ts --run <runId>');
  const workbook = buildWorkbook(runId);
  const sheetPath = path.join(RUNS_DIR, runId, 'review-sheet.md');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(sheetPath, `${workbook.rows.join('\n')}\n`);
  console.log(`[workbook] cases=${workbook.cases} attempts=${workbook.attempts} settledOk=${workbook.settledOk} overBudget=${String(workbook.overBudget)}`);
  console.log(`[workbook] 已生成 ${sheetPath}`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
