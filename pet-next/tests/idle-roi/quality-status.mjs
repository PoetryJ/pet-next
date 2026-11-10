#!/usr/bin/env node
/**
 * 画质门的机器接口（给 D 的执行入口用）。
 *
 * 只读 `tests/idle-roi/out/quality-report.json`，不做任何测量、不推断、不给默认值：
 * 报告说 pass 才 pass。退出码：
 *   0 = 通过（且 sha 与期望一致）
 *   1 = 不通过（门失败 / sha 不符）
 *   2 = 未评测（not-run：素材没准备好，等同不放行）
 *   3 = 报告缺失或不可解析
 *
 * 用法：
 *   node tests/idle-roi/quality-status.mjs --status-only
 *   node tests/idle-roi/quality-status.mjs --json --variant=f3c3 --expect-sha=<64hex>
 *   node tests/idle-roi/quality-status.mjs --json --require=f3c3,yuva-selfcontrol
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPORT = path.join(HERE, 'out', 'quality-report.json');
const SHA = /^[0-9a-f]{64}$/;

function parseArgs(argv) {
  const options = { statusOnly: false, json: false, variant: null, require: [], expectSha: null, report: DEFAULT_REPORT };
  for (const arg of argv) {
    if (arg === '--status-only') options.statusOnly = true;
    else if (arg === '--json') options.json = true;
    else if (arg.startsWith('--variant=')) options.variant = arg.slice('--variant='.length);
    else if (arg.startsWith('--require=')) options.require = arg.slice('--require='.length).split(',').filter((item) => item.length > 0);
    else if (arg.startsWith('--expect-sha=')) options.expectSha = arg.slice('--expect-sha='.length).toLowerCase();
    else if (arg.startsWith('--report=')) options.report = path.resolve(arg.slice('--report='.length));
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('用法: quality-status.mjs [--status-only] [--json] [--variant=<category>] [--require=a,b] [--expect-sha=<hex>] [--report=<path>]\n');
      process.exit(0);
    } else {
      process.stderr.write(`未知参数 ${arg}\n`);
      process.exit(3);
    }
  }
  return options;
}

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const options = parseArgs(process.argv.slice(2));
if (!existsSync(options.report)) fail(3, `报告不存在：${options.report}（先跑 tests/idle-roi/quality.test.ts）`);
let report;
try {
  report = JSON.parse(readFileSync(options.report, 'utf8'));
} catch (error) {
  fail(3, `报告不可解析：${error instanceof Error ? error.message : String(error)}`);
}
if (report === null || typeof report !== 'object' || typeof report.status !== 'string') fail(3, '报告缺 status 字段');

const variants = Array.isArray(report.variants) ? report.variants : [];
const summary = variants.map((variant) => ({
  category: variant.category,
  status: variant.status,
  pass: variant.status === 'evaluated' && variant.localStatus?.pass === true,
  failed: variant.localStatus?.failed ?? [],
  sha256: variant.arms?.sha256 ?? null,
  armsDir: variant.armsDir ?? null,
}));

const problems = [];
if (report.status !== 'passed') problems.push(`报告 status=${report.status}（${report.verdict?.decidedBy ?? '无结论'}）`);
if (report.verdict?.pass !== true) problems.push('verdict.pass 不是 true');
if (report.performance?.allowed !== true) problems.push(`performance.allowed 不是 true（${report.performance?.reason ?? '无原因'}）`);

const targets = options.variant !== null ? [options.variant] : options.require;
for (const category of targets) {
  const entry = summary.find((item) => item.category === category);
  if (!entry) problems.push(`报告里没有类别 ${category}`);
  else if (!entry.pass) problems.push(`类别 ${category} 未通过（status=${entry.status}，failed=${entry.failed.join(',') || '-'}）`);
}
if (options.expectSha !== null) {
  if (!SHA.test(options.expectSha)) problems.push(`--expect-sha 不是 64 位小写 hex：${options.expectSha}`);
  const candidates = options.variant === null ? summary : summary.filter((item) => item.category === options.variant);
  const matched = candidates.some((item) => item.sha256 && [item.sha256.O, item.sha256.F, item.sha256.C].includes(options.expectSha));
  if (!matched) problems.push(`报告的素材 sha 里没有 ${options.expectSha}`);
}

const status = problems.length === 0 ? report.status : report.status === 'not-run' ? 'not-run' : 'failed';
if (options.statusOnly) {
  process.stdout.write(`${status}\n`);
} else if (options.json) {
  process.stdout.write(
    `${JSON.stringify(
      {
        status,
        pass: status === 'passed',
        subject: report.subject ?? null,
        decidedBy: report.verdict?.decidedBy ?? null,
        failed: report.verdict?.failed ?? [],
        historicalFailed: report.verdict?.historicalFailed ?? [],
        performance: report.performance ?? null,
        evaluationCode: report.evaluationCode ?? null,
        variants: summary,
        problems,
      },
      null,
      2,
    )}\n`,
  );
} else {
  process.stdout.write(`画质门 ${status}\n`);
  if (report.verdict?.decidedBy) process.stdout.write(`结论：${report.verdict.decidedBy}\n`);
  for (const item of summary) {
    const sha = item.sha256 === null ? '-' : `O=${item.sha256.O.slice(0, 8)} F=${item.sha256.F.slice(0, 8)} C=${item.sha256.C.slice(0, 8)}`;
    process.stdout.write(`  ${item.pass ? 'pass' : 'FAIL'} ${item.category} (${item.status}) ${sha} ${item.failed.join(',')}\n`);
  }
  for (const problem of problems) process.stdout.write(`  阻断：${problem}\n`);
}

process.exit(status === 'passed' ? 0 : status === 'not-run' ? 2 : 1);
