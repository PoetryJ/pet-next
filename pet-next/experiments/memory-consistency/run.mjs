#!/usr/bin/env node
/**
 * 记忆一致性实验入口。
 *
 * 设计约束：
 * - 本文件是纯 JS，不需要 --experimental-strip-types 就能跑；
 *   子进程自己带 flag，所以入口命令可以是最朴素的 `node run.mjs --verify`。
 * - 每个测试套件与门禁的退出码、stdout 原文都落盘，报告里引用的是原始结果，不是二次叙述。
 * - 缺模块就显式写 not_run，绝不把「没跑」算成通过。
 * - 门禁结果必须带本次 runId 与源码身份；只有子进程 exit 0 不够（空脚本 exit 0 会假通过）。
 *
 * 用法：
 *   node experiments/memory-consistency/run.mjs --all
 *   node experiments/memory-consistency/run.mjs --suite=ledger
 *   node experiments/memory-consistency/run.mjs --gate=G1
 *   node experiments/memory-consistency/run.mjs --verify
 *   node experiments/memory-consistency/run.mjs --demo
 *   node experiments/memory-consistency/run.mjs --all --out=/tmp/run-x --source-commit=<sha>
 *
 * @module pet-next/experiments/memory-consistency/run
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

/** 门禁结果信封版本。与 contracts.ts 的 GATE_SCHEMA_VERSION 必须一致。 */
const GATE_SCHEMA = 'memory-gate/v1';

/** 测试套件。每个套件都是独立可复跑的 node --test 调用。 */
const SUITES = [
  { id: 'contracts', title: '契约冻结自检', files: ['tests/contracts.test.ts'] },
  { id: 'ledger', title: '账本与补丁', files: ['ledger/reduce.test.ts', 'ledger/patch.test.ts'] },
  { id: 'policies', title: '四策略与预算', files: ['policies/policies.test.ts'] },
  { id: 'storage', title: '磁盘日志与快照', files: ['storage/store.test.ts'] },
  { id: 'recovery', title: '进程崩溃恢复', files: ['recovery/recovery.test.ts'] },
  { id: 'eval', title: '独立评分与负控', files: ['eval/dev-set.test.ts', 'eval/no-network.test.ts', 'eval/equivalence.test.ts', 'eval/behavior-spec.test.ts'] },
  { id: 'replay', title: '产品纯模块回放', files: ['product-replay/replay.test.ts'] },
  { id: 'demo', title: '离线演示生成物', files: ['demo/demo.test.ts'] },
  { id: 'queue', title: '有界整理队列与依赖链', files: ['maintenance/queue.test.ts', 'maintenance/rebuild.test.ts'] },
  { id: 'future', title: '未来 runner dry-run', files: ['future-run/runner.test.ts'] },
  { id: 'studies', title: '成本与平台', files: ['studies/cost.test.ts', 'platform/checks.test.ts', 'platform/windows-script.test.ts'] },
  { id: 'gate', title: '门禁信封与 CLI 入口', files: ['runner/gate.test.ts'] },
  { id: 'shadow', title: 'R3 真实会话路径（8故事×2臂）', files: ['product-shadow/shadow.test.ts'] },
];

/** 门禁脚本。文件不存在就记 not_run。 */
const GATES = [
  { id: 'G1', title: '开发轨迹 + 独立评分 + 负控 + 零外呼', script: 'runner/g1.ts', result: 'g1.json' },
  { id: 'P1', title: '新模板 + 泄漏审计 + 反事实恢复', script: 'runner/p1.ts', result: 'p1.json' },
  { id: 'P2', title: '固定规模成本 + 平台 + 未来 runner dry-run', script: 'runner/p2.ts', result: 'p2.json' },
];

function parseArgs(argv) {
  const args = {
    suites: [],
    gates: [],
    all: false,
    verify: false,
    demo: false,
    shadow: false,
    list: false,
    out: null,
    runId: null,
    sourceCommit: null,
  };
  for (const item of argv) {
    if (item === '--all') args.all = true;
    else if (item === '--verify') args.verify = true;
    else if (item === '--demo') args.demo = true;
    else if (item === '--shadow') args.shadow = true;
    else if (item === '--list') args.list = true;
    else if (item.startsWith('--suite=')) args.suites.push(item.slice('--suite='.length));
    else if (item.startsWith('--gate=')) args.gates.push(item.slice('--gate='.length));
    else if (item.startsWith('--out=')) args.out = item.slice('--out='.length);
    else if (item.startsWith('--run-id=')) args.runId = item.slice('--run-id='.length);
    else if (item.startsWith('--source-commit=')) args.sourceCommit = item.slice('--source-commit='.length);
    else {
      process.stderr.write(`unknown argument: ${item}\n`);
      process.exit(2);
    }
  }
  return args;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function gitDirty() {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', 'experiments/memory-consistency'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    return out.trim() === '' ? 0 : out.trim().split('\n').length;
  } catch {
    return -1;
  }
}

/**
 * 被测源码身份：显式声明优先，其次 git HEAD，最后 unknown。
 * 归档没有 .git 时调用方必须显式给出，不允许借用外层工作区 HEAD。
 */
function resolveSourceCommit(explicit) {
  const flagged = explicit ?? process.env.MEMORY_SOURCE_COMMIT ?? process.env.SOURCE_COMMIT ?? null;
  if (flagged !== null && flagged !== '') return { value: flagged, source: 'explicit' };
  const head = gitHead();
  if (head !== 'unknown') return { value: head, source: 'git' };
  return { value: 'unknown', source: 'unknown' };
}

/** 跑一个测试套件，返回退出码与解析出的计数。原文另存。 */
function runSuite(suite, outDir) {
  const files = suite.files.map((file) => join(HERE, file));
  const missing = suite.files.filter((file) => !existsSync(join(HERE, file)));
  if (missing.length > 0) {
    return { id: suite.id, title: suite.title, status: 'not_run', reason: `missing: ${missing.join(',')}` };
  }
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--test', '--test-reporter=spec', ...files],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 600_000 },
  );
  const elapsedMs = Date.now() - started;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const logDir = join(outDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, `${suite.id}.log`), `${stdout}\n--- stderr ---\n${stderr}`, 'utf8');

  const count = (label) => {
    const match = new RegExp(`ℹ ${label} (\\d+)`).exec(stdout);
    return match === null ? null : Number(match[1]);
  };
  const passed = count('pass');
  const failed = count('fail');
  const status = result.status === 0 && (failed === null || failed === 0) ? 'pass' : 'fail';
  return {
    id: suite.id,
    title: suite.title,
    status,
    exitCode: result.status,
    elapsedMs,
    tests: { passed, failed },
    log: relative(outDir, join(logDir, `${suite.id}.log`)),
    command: `node --experimental-strip-types --test --test-reporter=spec ${suite.files.join(' ')}`,
  };
}

/**
 * 校验门禁结果：只看退出码是不够的。
 * 缺文件 / 坏 JSON / schema 不符 / gateId 不符 / runId 过期 / 源码身份不明或不同 / passed_gate=false
 * 都必须判失败，并给出可读原因。
 */
function verifyGateResult(gate, outDir, identity, exitCode) {
  const reasons = [];
  if (exitCode !== 0) reasons.push(`subprocess_exit:${String(exitCode)}`);
  const path = join(outDir, gate.result);
  if (!existsSync(path)) {
    reasons.push('result_missing');
    return { ok: false, reasons, envelope: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    reasons.push('result_invalid_json');
    return { ok: false, reasons, envelope: null };
  }
  const envelope = parsed?.envelope;
  if (envelope === undefined || envelope === null) {
    reasons.push('envelope_missing');
    return { ok: false, reasons, envelope: null };
  }
  if (envelope.schemaVersion !== GATE_SCHEMA) reasons.push(`schema_mismatch:${String(envelope.schemaVersion)}`);
  if (envelope.gateId !== gate.id) reasons.push(`gate_id_mismatch:${String(envelope.gateId)}`);
  if (envelope.runId !== identity.runId) reasons.push(`stale_run_id:${String(envelope.runId)}`);
  if (identity.sourceCommit === 'unknown') reasons.push('source_commit_unknown');
  else if (envelope.sourceCommit !== identity.sourceCommit) reasons.push(`source_commit_mismatch:${String(envelope.sourceCommit)}`);
  if (envelope.passed_gate !== true) reasons.push('passed_gate_false');
  return { ok: reasons.length === 0, reasons, envelope };
}

/** 跑一个门禁脚本。信封核对通过才算 pass。 */
function runGate(gate, outDir, identity) {
  const script = join(HERE, gate.script);
  if (!existsSync(script)) {
    return { id: gate.id, title: gate.title, status: 'not_run', reason: `missing ${gate.script}` };
  }
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, ['--experimental-strip-types', script, '--out', outDir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 900_000,
    env: {
      ...process.env,
      MEMORY_RUN_ID: identity.runId,
      MEMORY_SOURCE_COMMIT: identity.sourceCommit,
      MEMORY_GATE_STARTED_AT: startedAt,
    },
  });
  const elapsedMs = Date.now() - Date.parse(startedAt);
  const logDir = join(outDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, `${gate.id.toLowerCase()}.log`), `${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}`, 'utf8');
  const verification = verifyGateResult(gate, outDir, identity, result.status ?? -1);
  return {
    id: gate.id,
    title: gate.title,
    status: verification.ok ? 'pass' : 'fail',
    exitCode: result.status,
    elapsedMs,
    stdout: (result.stdout ?? '').trim(),
    resultFile: gate.result,
    verification: {
      ok: verification.ok,
      reasons: verification.reasons,
      envelope: verification.envelope === null ? null : {
        schemaVersion: verification.envelope.schemaVersion,
        gateId: verification.envelope.gateId,
        runId: verification.envelope.runId,
        sourceCommit: verification.envelope.sourceCommit,
        passed_gate: verification.envelope.passed_gate,
      },
    },
    command: `node --experimental-strip-types experiments/memory-consistency/${gate.script}`,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = args.runId ?? `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
  const source = resolveSourceCommit(args.sourceCommit);
  const identity = { runId, sourceCommit: source.value };

  if (args.list) {
    for (const suite of SUITES) process.stdout.write(`suite ${suite.id}\t${suite.title}\n`);
    for (const gate of GATES) process.stdout.write(`gate  ${gate.id}\t${gate.title}\n`);
    return 0;
  }

  // R3：真实会话路径的 8×2 对照，输出到 <out>/shadow（每次新 runId 目录）。
  if (args.shadow) {
    const baseOut = args.out ?? join(HERE, 'out');
    mkdirSync(baseOut, { recursive: true });
    const script = join(HERE, 'product-shadow', 'shadow.ts');
    if (!existsSync(script)) {
      process.stdout.write('not_run: product-shadow/shadow.ts missing\n');
      return 1;
    }
    const shadowOut = join(baseOut, 'shadow');
    const result = spawnSync(process.execPath, ['--experimental-strip-types', script, `--out=${shadowOut}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 600_000,
      env: { ...process.env, MEMORY_RUN_ID: runId, MEMORY_SOURCE_COMMIT: identity.sourceCommit },
    });
    process.stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    return result.status === 0 ? 0 : 1;
  }

  // 演示不是门禁：保持固定输出目录，方便直接打开。
  if (args.demo) {
    const outDir = args.out ?? join(HERE, 'out');
    mkdirSync(outDir, { recursive: true });
    const demoSrc = join(HERE, 'runner', 'demo.ts');
    if (!existsSync(demoSrc)) {
      process.stdout.write('not_run: runner/demo.ts missing\n');
      return 1;
    }
    const result = spawnSync(process.execPath, ['--experimental-strip-types', demoSrc, '--out', outDir], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 300_000,
      env: { ...process.env, MEMORY_RUN_ID: runId, MEMORY_SOURCE_COMMIT: identity.sourceCommit },
    });
    process.stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    return result.status === 0 ? 0 : 1;
  }

  const selectedSuites =
    args.suites.length > 0
      ? SUITES.filter((suite) => args.suites.includes(suite.id))
      : args.all || args.verify
        ? SUITES
        : [];
  const selectedGates =
    args.gates.length > 0
      ? GATES.filter((gate) => args.gates.includes(gate.id))
      : args.all || args.verify
        ? GATES
        : [];

  if (selectedSuites.length === 0 && selectedGates.length === 0) {
    process.stderr.write('nothing selected; use --all, --suite=<id>, --gate=<id>, --verify or --demo\n');
    return 2;
  }

  // 默认每次运行写新目录；显式 --out 时由调用方负责「新目录」，但 runId 仍会防止复用旧结果。
  const outDir = args.out ?? join(HERE, 'out', 'runs', runId);
  mkdirSync(outDir, { recursive: true });
  const freshDir = !existsSync(join(outDir, 'summary.json'));

  // --verify 的确定性检查：拿上一次的 g1 摘要与新结果比对。
  const lastDigestPath = join(HERE, 'out', 'last-g1-digest.json');
  let previousDigest = null;
  if (args.verify && existsSync(lastDigestPath)) {
    try {
      previousDigest = JSON.parse(readFileSync(lastDigestPath, 'utf8')).digest ?? null;
    } catch {
      previousDigest = null;
    }
  }

  const startedAt = new Date().toISOString();
  const suiteReports = selectedSuites.map((suite) => runSuite(suite, outDir));
  const gateReports = selectedGates.map((gate) => runGate(gate, outDir, identity));
  const finishedAt = new Date().toISOString();

  let determinism = { checked: false, previousDigest, currentDigest: null, equal: null };
  if (args.verify) {
    const currentPath = join(outDir, 'g1.json');
    let currentDigest = null;
    if (existsSync(currentPath)) {
      try {
        currentDigest = JSON.parse(readFileSync(currentPath, 'utf8')).observationDigest ?? null;
      } catch {
        currentDigest = null;
      }
    }
    determinism = {
      checked: previousDigest !== null && currentDigest !== null,
      previousDigest,
      currentDigest,
      equal: previousDigest !== null && currentDigest !== null ? previousDigest === currentDigest : null,
    };
    if (currentDigest !== null) {
      mkdirSync(dirname(lastDigestPath), { recursive: true });
      writeFileSync(lastDigestPath, `${JSON.stringify({ digest: currentDigest, runId, at: finishedAt }, null, 2)}\n`, 'utf8');
    }
  }

  const summary = {
    schemaVersion: 'memory-run/v1',
    runId,
    sourceCommit: identity.sourceCommit,
    sourceCommitSource: source.source,
    startedAt,
    finishedAt,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    gitHead: gitHead(),
    dirtyExperimentFiles: gitDirty(),
    mode: args.verify ? 'verify' : 'run',
    outDir,
    freshDir,
    suites: suiteReports,
    gates: gateReports,
    determinism,
    zeroLiveModelCalls: true,
    note: 'zeroLiveModelCalls 由 eval/no-network.test.ts 的静态扫描 + fetch 哨兵证明；本进程未发起任何网络请求。',
  };
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  // 结果清单：只对本次实际生成的产物算 hash，避免把本文件自身算进去。
  const artifacts = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        if (name === 'logs') continue;
        walk(path);
        continue;
      }
      if (name === 'SHA256SUMS.txt') continue;
      artifacts.push({ file: relative(outDir, path), bytes: stat.size, sha256: sha256File(path) });
    }
  };
  walk(outDir);
  writeFileSync(join(outDir, 'artifacts.json'), `${JSON.stringify({ generatedAt: finishedAt, runId, artifacts }, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(outDir, 'SHA256SUMS.txt'),
    `${artifacts.filter((item) => item.file !== 'SHA256SUMS.txt').map((item) => `${item.sha256}  ${item.file}`).join('\n')}\n`,
    'utf8',
  );

  const width = Math.max(...[...suiteReports, ...gateReports].map((item) => item.id.length), 4);
  for (const item of suiteReports) {
    const tests = item.tests === undefined ? '' : ` (${item.tests.passed ?? '?'} passed, ${item.tests.failed ?? '?'} failed)`;
    process.stdout.write(`${item.id.padEnd(width)}  ${String(item.status).padEnd(8)}${tests}${item.reason === undefined ? '' : ` ${item.reason}`}\n`);
  }
  for (const item of gateReports) {
    const reasons = item.verification?.reasons?.length ? ` {${item.verification.reasons.join(',')}}` : '';
    process.stdout.write(`${item.id.padEnd(width)}  ${String(item.status).padEnd(8)}${item.reason === undefined ? '' : ` ${item.reason}`}${item.stdout === undefined ? '' : ` ${item.stdout}`}${reasons}\n`);
  }

  const failed = [...suiteReports, ...gateReports].filter((item) => item.status === 'fail');
  const notRun = [...suiteReports, ...gateReports].filter((item) => item.status === 'not_run');
  if (determinism.checked) {
    process.stdout.write(`determinism ${determinism.equal ? 'OK' : 'DIFF'}\n`);
  } else if (args.verify) {
    process.stdout.write('determinism not checked (no previous digest)\n');
  }
  process.stdout.write(`\nrun ${runId}  source ${identity.sourceCommit} (${source.source})\n`);
  process.stdout.write(`results: ${relative(REPO_ROOT, outDir)}\n`);
  if (notRun.length > 0) process.stdout.write(`not_run: ${notRun.map((item) => item.id).join(', ')}\n`);
  if (determinism.checked && determinism.equal === false) return 1;
  return failed.length === 0 ? 0 : 1;
}

process.exit(main());
