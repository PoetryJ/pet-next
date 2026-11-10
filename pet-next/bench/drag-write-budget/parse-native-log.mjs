#!/usr/bin/env node
/**
 * M3-11 A：解析 **Windows 物理鼠标**那一条 not-run 命令产出的日志。
 *
 *   node bench/drag-write-budget/parse-native-log.mjs <drag-native-win32.log> [--json]
 *
 * 日志里每行形如：
 *   13:56:02.123 [electron] {"event":"bounds","bounds":{...},"requested":{...},"physical":{...}}
 * 或
 *   2026-11-10T13:56:02.123Z {"event":"bounds",...}
 *
 * 只认 main 自己打印的 bounds 行，时间取日志行前缀（**stdout 到达时刻**，不是 main 内时间戳）；
 * 输出与 Linux 侧同一套指标：相邻间隔中位、<8ms 成对比例、相同坐标重复写、8ms 预算纸面投影。
 *
 * 这个脚本只做解析/统计，不产生也不模拟输入。
 * @module pet-next/bench/drag-write-budget/parse-native-log
 */
import { readFileSync } from 'node:fs';
import { analyzeWrites, collectWrites, extractJson, projectBudget, round } from './lib/analysis.mjs';

const rawArgs = process.argv.slice(2);
const asJson = rawArgs.includes('--json');
const file = rawArgs.find((item) => !item.startsWith('--'));
if (file === undefined) {
  console.error('用法：node bench/drag-write-budget/parse-native-log.mjs <log> [--json]');
  process.exit(2);
}

const TIME_PREFIX = /^(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s+/;
const ISO_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z?)\s+/;
const BUDGET_MS = 8;

/** 行前缀 → 单调毫秒；识别跨午夜的日志。 */
function makeClock() {
  let previous = null;
  let dayOffset = 0;
  return (text) => {
    let ms;
    const clock = TIME_PREFIX.exec(text);
    if (clock !== null) {
      ms = Number(clock[1]) * 3600000 + Number(clock[2]) * 60000 + Number(clock[3]) * 1000 + Number(clock[4]);
    } else {
      const iso = ISO_PREFIX.exec(text);
      if (iso === null) return null;
      const parsed = Date.parse(iso[1]);
      if (!Number.isFinite(parsed)) return null;
      ms = parsed;
    }
    if (previous !== null && ms < previous - 3600000) dayOffset += 86400000;
    previous = ms + dayOffset;
    return previous;
  };
}

const clock = makeClock();
const records = [];
let lines = 0;
let boundsLines = 0;
let untimedBounds = 0;
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  lines += 1;
  const payload = extractJson(line);
  if (payload === null || payload.event !== 'bounds') continue;
  boundsLines += 1;
  const at = clock(line);
  if (at === null) {
    untimedBounds += 1;
    continue;
  }
  records.push({ at, line, chunkSeq: 0 });
}

if (boundsLines === 0) {
  console.error('日志里没有 {"event":"bounds"} 行：确认 PET_NEXT_TEST=1，且用的是带时间戳前缀的那条采集命令。');
  process.exit(1);
}
if (untimedBounds === boundsLines) {
  console.error('bounds 行全都没有时间戳前缀：请用 README 里带 {0:HH:mm:ss.fff} 前缀的采集命令。');
  process.exit(1);
}

const { writes } = collectWrites(records);
const analysis = analyzeWrites(writes, { windowMs: BUDGET_MS });
const projection = projectBudget(writes.map((write) => write.at), BUDGET_MS);
const report = {
  file,
  layer: 'native（Windows 物理鼠标；本命令只解析日志，不合成输入）',
  lines,
  boundsLines,
  untimedBounds,
  writes: analysis.count,
  writeSpanMs: analysis.spanMs,
  writeRateHz: analysis.rateHz,
  intervalMs: analysis.intervalMs,
  sameWindow8ms: { pairCount: analysis.sameWindow.pairCount, ratioOfWrites: analysis.sameWindow.ratioOfWrites },
  maxWritesPer8msBucket: analysis.bucketCounts.maxPerBucket,
  duplicateRequested: analysis.duplicateRequested.count,
  distinctCoordinates: analysis.duplicateRequested.distinctCoordinates,
  projection8ms: projection,
  note: '时间取日志行前缀（stdout 到达时刻），不是 main 内时间戳；本机采集精度受 PowerShell 管道影响。',
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`file=${file}`);
  console.log(`writes=${report.writes} spanMs=${report.writeSpanMs} rateHz=${report.writeRateHz}`);
  console.log(
    `intervalMs: med=${report.intervalMs.medianMs} min=${report.intervalMs.minMs} max=${report.intervalMs.maxMs} (n=${report.intervalMs.count})`,
  );
  console.log(
    `pairs<${BUDGET_MS}ms=${report.sameWindow8ms.pairCount} ratio=${report.sameWindow8ms.ratioOfWrites} maxPerBucket=${report.maxWritesPer8msBucket}`,
  );
  console.log(`duplicateRequested=${report.duplicateRequested} distinct=${report.distinctCoordinates}`);
  console.log(`proj8=${projection.projectedWrites} reduction=${round(projection.reduction, 4)}`);
  console.log(`untimedBounds=${untimedBounds}`);
}
