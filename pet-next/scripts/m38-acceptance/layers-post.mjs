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
  const entries = (await readdir(runsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  // 兼容两种落盘布局：runs/<pair>/{baseline,candidate}/ 与 runs/<pair>-{b,c}/<arm>/。
  const grouped = new Map();
  const addArm = (key, arm, dir) => {
    if (!grouped.has(key)) grouped.set(key, {});
    grouped.get(key)[arm] = dir;
  };
  for (const name of entries) {
    const dir = path.join(runsRoot, name);
    const inner = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((item) => item === 'baseline' || item === 'candidate');
    // 先按 -b/-c 后缀配对（C 的布局是 runs/<pair>-b/baseline/），再退回"目录内直接含两臂"。
    const suffix = name.endsWith('-b') ? 'baseline' : name.endsWith('-c') ? 'candidate' : null;
    if (suffix !== null) {
      const armDir = inner.includes(suffix) ? path.join(dir, suffix) : inner.length === 1 ? path.join(dir, inner[0]) : dir;
      addArm(name.slice(0, -2), suffix, armDir);
      continue;
    }
    if (inner.length > 0) {
      for (const arm of inner) addArm(name, arm, path.join(dir, arm));
    }
  }
  const readArm = async (dir) => ({
    dir: path.relative(ctx.appRoot, dir),
    summary: await readIfExists(path.join(dir, 'summary.json')),
    exit: await readIfExists(path.join(dir, 'exit.txt')),
    requests: await readIfExists(path.join(dir, 'requests.ndjson')),
    samples: await readIfExists(path.join(dir, 'samples.json')),
  });
  const pairs = [];
  for (const [stamp, arms] of [...grouped.entries()].sort()) {
    const resolved = {};
    for (const [arm, dir] of Object.entries(arms)) resolved[arm] = await readArm(dir);
    pairs.push({ stamp, arms: resolved });
  }
  const notes = [];
  const problems = [];
  if (pairs.length === 0) {
    return { exitCode: null, counts: null, status: 'not-run', notRun: 'runs 目录为空', notes: [] };
  }
  let parsedPairs = 0;
  const totals = (summary) => {
    const roles = summary?.roles ?? {};
    const cpuSeconds = Object.values(roles).reduce((sum, role) => sum + (role?.cpuSeconds ?? 0), 0);
    const rssSumP50Mb = Object.values(roles).reduce((sum, role) => sum + (role?.rssSumP50Mb ?? 0), 0);
    return { cpuSeconds, rssSumP50Mb };
  };
  for (const pair of pairs) {
    const baseline = pair.arms.baseline;
    const candidate = pair.arms.candidate;
    if (baseline === undefined || candidate === undefined) {
      // 单臂目录（如 harness 校验用 mainpid-fix）只提示，不算失败。
      notes.push(`${pair.stamp}: 只有单臂数据（${Object.keys(pair.arms).join(',')}），按补充数据记录`);
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
    if (baselineSummary === null || candidateSummary === null) {
      problems.push(`${pair.stamp}: 缺 summary.json`);
      continue;
    }
    parsedPairs += 1;
    const postCount = (text) => (text ?? '').split('\n').filter((line) => line.trim() !== '').length;
    const baselineRequests = postCount(baseline.requests);
    const candidateRequests = postCount(candidate.requests);
    if (baselineRequests > 0 || candidateRequests > 0) {
      problems.push(`${pair.stamp}: 待机出现请求（baseline=${baselineRequests}, candidate=${candidateRequests}）`);
    }
    // 同机同素材同口径：这些字段两臂必须一致，否则"配对"不成立。
    const same = (label, pick) => {
      const values = [pick(baselineSummary), pick(candidateSummary)];
      if (values[0] !== values[1]) problems.push(`${pair.stamp}: 两臂 ${label} 不同（${values.join(' vs ')}）`);
    };
    same('采样秒数', (s) => s?.seconds);
    same('host', (s) => s?.host);
    same('head', (s) => s?.head);
    same('display', (s) => s?.display);
    same('sampleCount', (s) => s?.sampleCount);
    same('assets.idleSha256', (s) => s?.assets?.idleSha256);
    same('assets.reactionSha256', (s) => s?.assets?.reactionSha256);
    same('state', (s) => s?.state);
    // 原型必须"默认关闭 + 只在 candidate 臂注入"。
    const baseInjected = baselineSummary?.candidateInjected;
    const candInjected = candidateSummary?.candidateInjected;
    const defaultOff = candidateSummary?.candidateDefaultOff;
    if (baseInjected !== false) problems.push(`${pair.stamp}: baseline 臂注入了原型（candidateInjected=${String(baseInjected)}）`);
    if (candInjected !== true) problems.push(`${pair.stamp}: candidate 臂未注入原型（candidateInjected=${String(candInjected)}）`);
    if (defaultOff !== true) problems.push(`${pair.stamp}: 原型默认关闭未被记录（candidateDefaultOff=${String(defaultOff)}）`);
    // 待机零请求：posts 必须为 0 且闸门 pass；两臂都不得有失败。
    for (const [arm, summary] of [['baseline', baselineSummary], ['candidate', candidateSummary]]) {
      if ((summary?.posts ?? summary?.post ?? 0) !== 0) problems.push(`${pair.stamp}/${arm}: posts=${String(summary?.posts ?? summary?.post)}（应为 0）`);
      if ((summary?.failures ?? []).length > 0) problems.push(`${pair.stamp}/${arm}: failures=${JSON.stringify(summary.failures)}`);
    }
    const base = totals(baselineSummary);
    const cand = totals(candidateSummary);
    const baseFps = baselineSummary?.framesPerSec;
    const candFps = candidateSummary?.framesPerSec;
    notes.push(
      `${pair.stamp}: hidden=${String(baselineSummary?.state)} fps ${String(baseFps)}→${String(candFps)}，`
      + `CPU ${base.cpuSeconds.toFixed(2)}→${cand.cpuSeconds.toFixed(2)} s/min，`
      + `RSS 求和 P50 ${base.rssSumP50Mb.toFixed(1)}→${cand.rssSumP50Mb.toFixed(1)} MB，POST ${String(baselineRequests)}/${String(candidateRequests)}`,
    );
    // 判据：hidden 态 baseline 仍在出帧、candidate 必须 0 帧；visible 对照两臂都应出帧。
    if (baselineSummary?.state === 'hidden') {
      if (!(typeof baseFps === 'number' && baseFps > 1)) problems.push(`${pair.stamp}: baseline 隐藏态帧率异常（${String(baseFps)}）`);
      if (!(candFps === 0)) problems.push(`${pair.stamp}: candidate 隐藏态仍在出帧（${String(candFps)}）`);
      if (!(cand.cpuSeconds < base.cpuSeconds)) problems.push(`${pair.stamp}: candidate CPU 未下降（${cand.cpuSeconds.toFixed(2)} vs ${base.cpuSeconds.toFixed(2)}）`);
    }
    if (baselineSummary?.state === 'visible') {
      if (!(typeof baseFps === 'number' && baseFps > 1) || !(typeof candFps === 'number' && candFps > 1)) {
        problems.push(`${pair.stamp}: visible 对照两臂帧率异常（${String(baseFps)} vs ${String(candFps)}）`);
      }
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
