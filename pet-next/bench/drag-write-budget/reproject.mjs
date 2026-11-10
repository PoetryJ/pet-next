#!/usr/bin/env node
/**
 * M3-11 A：不要重跑 Electron，直接从已落盘的 bounds.ndjson 重算两件事。
 *
 *   node bench/drag-write-budget/reproject.mjs [--stamp=<name>]
 *
 * 1) 相邻写入间隔 < 8ms 的对（= 同一 8ms 窗口内多次写入）；
 * 2) 冻结契约 8ms 规则的**纸面投影**：把这一轮真实发生的写入时刻按“首写即时 / 距上次 <8ms
 *    只留 pending / 定时器到点写一次 / 结束 flush”重放，看能省掉多少写入。
 *
 * 只读、不改 runs/ 下任何文件；用于复核 README 表格里 proj8 那一列。
 * @module pet-next/bench/drag-write-budget/reproject
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeWrites, collectWrites, projectBudget } from './lib/analysis.mjs';

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const runsDir = path.join(benchDir, 'runs');
const rawArgs = process.argv.slice(2);
const value = (name, fallback) => {
  const hit = rawArgs.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const stamp = value('stamp', '');
const BUDGET_MS = 8;

const stamps = stamp !== ''
  ? [stamp]
  : readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(runsDir, entry.name, 'bounds.ndjson')))
      .map((entry) => entry.name)
      .sort();

const header = ['run', 'writes', 'intervalMedianMs', 'pairs<8ms', 'ratio', 'proj8', 'projReduction'];
console.log(`| ${header.join(' | ')} |`);
console.log(`|${'---|'.repeat(header.length)}`);
for (const name of stamps) {
  const file = path.join(runsDir, name, 'bounds.ndjson');
  if (!existsSync(file)) {
    console.error(`跳过 ${name}：没有 bounds.ndjson`);
    continue;
  }
  const records = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => ({ at: JSON.parse(line).at, line, chunkSeq: 0 }));
  const { writes } = collectWrites(records);
  const analysis = analyzeWrites(writes, { windowMs: BUDGET_MS });
  const projection = projectBudget(writes.map((write) => write.at), BUDGET_MS);
  console.log(
    `| ${name} | ${analysis.count} | ${analysis.intervalMs.medianMs} | ${analysis.sameWindow.pairCount} | ` +
      `${analysis.sameWindow.ratioOfWrites} | ${projection.projectedWrites} | ${projection.reduction} |`,
  );
}
