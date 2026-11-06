/**
 * M3-8 阶段2（post）层：合流后的 launcher 7 例、关键取消/重试/退出 3 轮隔离、
 * 资源对照复核、Windows 项判定。只读产品源码与证据，不改 A/B/C 实现。
 */
import { cp, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { childEnv, parseCounts, runChild } from './lib.mjs';

/** 用例名与证据目录，必须与 tests/launcher/first-run.e2e.test.ts 的 test() 文案 / caseName 对齐。 */
export const ROUND_CASES = [
  { key: 'cancel', pattern: '探测中关窗', caseDir: 'probe-cancel-exit', expect: 'exit0；owned_pids_alive_after=[]；debug_port 关闭；POST=0' },
  { key: 'retry', pattern: '连接失败', caseDir: 'probe-fail-retry', expect: 'exit0；改到实际 fakePort 后再次 probe 成功；旧隧道退出；POST=0' },
  { key: 'exit', pattern: '直接关 launcher 窗口', caseDir: 'cancel-clean-exit', expect: 'exit0；无残留进程/端口；哨兵存活；POST=0' },
];
export const ROUND_COUNT = 3;

export async function runLauncherLayer(ctx) {
  const child = await runChild({
    cmd: process.execPath,
    argv: [
      '--experimental-strip-types',
      '--test',
      '--test-concurrency=1',
      '--test-reporter',
      'spec',
      'tests/launcher/first-run.e2e.test.ts',
    ],
    cwd: ctx.appRoot,
    env: childEnv(ctx.display, { PET_NEXT_LAUNCHER_E2E: '1' }),
    logPath: ctx.logPath,
    timeoutMs: ctx.timeoutMs,
  });
  const text = await readFile(ctx.logPath, 'utf8');
  const { counts, blocks } = parseCounts(text);
  return {
    exitCode: child.exitCode,
    counts,
    status: child.exitCode === 0 ? 'pass' : 'fail',
    notes: [
      'PET_NEXT_LAUNCHER_E2E=1 显式开启',
      `display ${ctx.display}（PET_NEXT_E2E_DISPLAY 同值）`,
      `汇总块 ${blocks}，耗时 ${Math.round(child.durationMs / 1000)}s`,
    ],
    logJson: { counts, blocks, durationMs: child.durationMs, timedOut: child.timedOut },
  };
}

async function readIfExists(file) {
  if (!existsSync(file)) return null;
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** 关键三例 × 3 轮：每轮一个独立进程 + 独立日志 + 独立证据快照。 */
export async function runRoundsLayer(ctx) {
  const pattern = ROUND_CASES.map((item) => item.pattern).join('|');
  const rounds = [];
  for (let index = 1; index <= ROUND_COUNT; index += 1) {
    const logPath = path.join(ctx.logDir, `rounds-r${index}-${ctx.stamp}.log`);
    const child = await runChild({
      cmd: process.execPath,
      argv: [
        '--experimental-strip-types',
        '--test',
        '--test-concurrency=1',
        '--test-reporter',
        'spec',
        `--test-name-pattern=${pattern}`,
        'tests/launcher/first-run.e2e.test.ts',
      ],
      cwd: ctx.appRoot,
      env: childEnv(ctx.display, { PET_NEXT_LAUNCHER_E2E: '1' }),
      logPath,
      timeoutMs: ctx.timeoutMs,
    });
    const text = await readFile(logPath, 'utf8');
    const { counts } = parseCounts(text);
    const cases = [];
    for (const item of ROUND_CASES) {
      const source = path.join(ctx.appRoot, 'tests/chat-evidence/launcher', item.caseDir);
      const target = path.join(ctx.evidenceDir, 'rounds', `round-${index}`, item.caseDir);
      let copied = false;
      if (existsSync(source)) {
        await cp(source, target, { recursive: true, force: true });
        copied = true;
      }
      cases.push({
        key: item.key,
        caseDir: item.caseDir,
        evidenceCopied: copied,
        exitTxt: await readIfExists(path.join(target, 'exit.txt')),
        expect: item.expect,
      });
    }
    rounds.push({
      round: index,
      log: path.relative(ctx.appRoot, logPath),
      exitCode: child.exitCode,
      timedOut: child.timedOut,
      durationMs: child.durationMs,
      counts,
      cases,
    });
  }
  const failed = rounds.filter((round) => round.exitCode !== 0);
  const totals = { tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0 };
  for (const round of rounds) {
    for (const key of Object.keys(totals)) totals[key] += round.counts?.[key] ?? 0;
  }
  return {
    exitCode: failed.length === 0 ? 0 : 1,
    counts: totals,
    status: failed.length === 0 ? 'pass' : 'fail',
    notes: [
      `pattern=${pattern}`,
      `3 轮逐轮：${rounds.map((round) => `R${round.round}=${round.exitCode}`).join(' ')}`,
      '每轮证据已快照到 rounds/round-N/（原始 exit.txt/ndjson）',
    ],
    logJson: { pattern, rounds },
  };
}

/** 资源对照复核：只做可判定项，无法证明的点显式列出（不把推断写成结论）。 */
export async function runResourcesLayer(ctx) {
  const runsRoot = path.join(ctx.appRoot, 'bench/idle-profile/runs');
  if (!existsSync(runsRoot)) {
    return {
      exitCode: null,
      counts: null,
      status: 'not-run',
      notRun: 'bench/idle-profile/runs 不存在：C 的候选实验未合流或未跑',
      notes: [],
    };
  }
  const stamps = (await readdir(runsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const pairs = [];
  for (const stamp of stamps) {
    const arms = {};
    for (const arm of ['baseline', 'candidate']) {
      const dir = path.join(runsRoot, stamp, arm);
      if (!existsSync(dir)) continue;
      arms[arm] = {
        summary: await readIfExists(path.join(dir, 'summary.json')),
        exit: await readIfExists(path.join(dir, 'exit.txt')),
        requests: await readIfExists(path.join(dir, 'requests.ndjson')),
        samples: await readIfExists(path.join(dir, 'samples.json')),
      };
    }
    pairs.push({ stamp, arms });
  }
  const notes = [];
  const problems = [];
  if (pairs.length === 0) {
    return { exitCode: null, counts: null, status: 'not-run', notRun: 'runs 目录为空', notes: [] };
  }
  let parsedPairs = 0;
  for (const pair of pairs) {
    const baseline = pair.arms.baseline;
    const candidate = pair.arms.candidate;
    if (baseline === undefined || candidate === undefined) {
      problems.push(`${pair.stamp}: 只有单臂数据（${Object.keys(pair.arms).join(',')}）`);
      continue;
    }
    let baselineSummary;
    let candidateSummary;
    try {
      baselineSummary = JSON.parse(baseline.summary ?? 'null');
      candidateSummary = JSON.parse(candidate.summary ?? 'null');
    } catch {
      problems.push(`${pair.stamp}: summary.json 不是合法 JSON`);
      continue;
    }
    parsedPairs += 1;
    const postCount = (text) => (text ?? '').split('\n').filter((line) => line.trim() !== '').length;
    const baselineRequests = postCount(baseline.requests);
    const candidateRequests = postCount(candidate.requests);
    if (baselineRequests > 0 || candidateRequests > 0) {
      problems.push(`${pair.stamp}: 待机出现请求（baseline=${baselineRequests}, candidate=${candidateRequests}）`);
    }
    const keys = (object) => (object === null || typeof object !== 'object' ? [] : Object.keys(object));
    notes.push(
      `${pair.stamp}: summary keys baseline=[${keys(baselineSummary).join(',')}] candidate=[${keys(candidateSummary).join(',')}]`,
    );
    const seconds = [baselineSummary?.seconds, candidateSummary?.seconds];
    if (seconds.every((value) => typeof value === 'number') && seconds[0] !== seconds[1]) {
      problems.push(`${pair.stamp}: 两臂采样秒数不等（${seconds.join(' vs ')}）`);
    }
    const hosts = [baselineSummary?.hostname, candidateSummary?.hostname];
    if (hosts.every((value) => typeof value === 'string') && hosts[0] !== hosts[1]) {
      problems.push(`${pair.stamp}: 两臂 hostname 不同（${hosts.join(' vs ')}）`);
    }
  }
  const unverifiable = [
    '账本只能读 C 落盘的 summary/requests/samples，无法证明两臂确在同机同素材交替；只能核对字段与顺序。',
    '不能证明采样期间无其它 GUI/bench 并发（单核争用只能看时间戳重叠，无法排除）。',
    'RSS 为进程 RSS 求和口径时，不能当作桌宠自身开销。',
  ];
  if (parsedPairs < pairs.length) notes.push(`可解析对 ${parsedPairs}/${pairs.length}`);
  return {
    exitCode: problems.length === 0 ? 0 : 1,
    counts: null,
    status: problems.length === 0 ? 'pass' : 'fail',
    notes: [...notes, ...problems, '无法验证：', ...unverifiable.map((item) => `  - ${item}`)],
    logJson: { runsRoot, pairCount: pairs.length, parsedPairs, problems, unverifiable, pairs: pairs.map((pair) => ({ stamp: pair.stamp, arms: Object.keys(pair.arms) })) },
  };
}

/** Windows 项：无 Windows 即 not-run；只给命令与预期，不宣称通过。 */
export async function runWindowsLayer(_ctx) {
  const commands = [
    {
      case: 'cmd-entry.test.ts 真实 .cmd 5 例（含 3 个 Windows-only）',
      cmd: 'node --experimental-strip-types --test --test-reporter spec tests/launcher/cmd-entry.test.ts',
      expect: 'exit0；5 pass / 0 skipped（跑前系统代码页未被改）',
    },
    {
      case: '显式 launcher E2E 7 例',
      cmd: 'set PET_NEXT_LAUNCHER_E2E=1 && node --experimental-strip-types --test --test-concurrency=1 "tests/launcher/first-run.e2e.test.ts"',
      expect: 'exit0；7 pass（真实 Electron，快/慢回复各 1 次 fake POST）',
    },
    {
      case: 'Windows 平台公开校验',
      cmd: 'pnpm verify:windows',
      expect: 'exit0；真实系统 125/150 仍 not-run',
    },
    {
      case: '交付解压包（中文+空格路径）',
      cmd: 'pnpm install --frozen-lockfile && pnpm build && pnpm test',
      expect: 'install/build exit0；test 自然结束（数量以本轮实际为准）',
    },
  ];
  const onWindows = process.platform === 'win32';
  const body = {
    platform: process.platform,
    status: onWindows ? 'manual-required' : 'not-run',
    reason: onWindows
      ? '本机为 Windows，但 D 的本轮验收未计划在 Windows 上自动执行；命令与预期见下，需人工执行后回填。'
      : `本机平台 ${process.platform} 无 Windows/pwsh：全部 Windows 项 not-run，不以 Linux/Node 结论替代。`,
    commands,
  };
  return {
    exitCode: null,
    counts: null,
    status: 'not-run',
    notRun: body.reason,
    notes: commands.map((item) => `${item.case} → ${item.cmd}（预期 ${item.expect}）`),
    logJson: body,
  };
}
