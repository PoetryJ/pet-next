/**
 * M3-11 D：基线/候选成本对照（同机同素材同轨迹，交替各 N 轮，默认 5）。
 *
 * 口径纪律（docs/M3-11-DRAG-WRITE-BUDGET.md 第 6/7 节）：
 * - 只报原始值 + 中位数；n=5 不报 P95，也不做显著性检验；
 * - 进程内的第一次启动**单列**（`firstLaunch`），不叫"OS 冷缓存"；
 * - `setPosition` 条数来自主进程 `{event:'bounds'}`，是软件提交，不是物理呈帧；
 * - CPU 用 `/proc/<main pid>/stat` 的 utime+stime（jiffies，USER_HZ=100），只算主进程；
 * - 产物：`runs/<stamp>/raw.ndjson` + `runs/<stamp>/summary.json`。
 *
 * 复跑：
 *   export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
 *   Xvfb :144 -screen 0 1920x1080x24 -nolisten tcp &
 *   DISPLAY=:144 pnpm build
 *   DISPLAY=:144 node --experimental-strip-types tests/drag-write-budget/cost-compare.ts --rounds=5
 * @module pet-next/tests/drag-write-budget/cost-compare
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  delay,
  installPointerSampler,
  latencyEdges,
  median,
  openSession,
  readCpuJiffies,
  realPointerDrag,
  requireDisplay,
  stopApp,
  waitQuietWrites,
  wiringPresent,
  type Arm,
  type Point,
} from './support/app.ts';

const PET_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 固定轨迹：60Hz 常规输入，30 步 × 2px = 60px 右移。 */
const TRAJECTORY = {
  label: 'real-pointer-60hz-30x2px',
  steps: Array.from({ length: 30 }, () => ({ x: 2, y: 0 })) as readonly Point[],
  stepDelayMs: 16,
  settleMs: 40,
};

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return found?.slice(prefix.length);
}

const ROUNDS = Math.max(1, Number(argValue('rounds') ?? '5') || 5);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = path.join(PET_ROOT, 'tests/drag-write-budget/runs', STAMP);

interface LaunchRecord {
  readonly arm: Arm;
  readonly round: number;
  readonly order: number;
  readonly firstLaunch: boolean;
  readonly writes: number;
  readonly from: Point;
  readonly to: Point;
  readonly cpuJiffies: number | null;
  readonly cpuMs: number | null;
  readonly latencyFirst: number;
  readonly latencyLast: number;
  readonly latencyMedian: number;
  readonly latencyMatched: number;
  readonly latencyUnmatched: number;
  readonly quietExtraWrites: number;
  readonly exitCode: number | null;
  readonly exitTimedOut: boolean;
  readonly portClosed: boolean;
  readonly alivePids: number;
  readonly writesAfterQuit: number;
  readonly wallMs: number;
  readonly error?: string;
}

function gitHead(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PET_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function gitDirty(): boolean {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: PET_ROOT, encoding: 'utf8' }).trim().length > 0;
  } catch {
    return true;
  }
}

async function measure(arm: Arm, round: number, order: number, firstLaunch: boolean): Promise<LaunchRecord> {
  const startedAt = Date.now();
  const session = await openSession({ arm, label: `cost-r${round}-${order}-${arm}` });
  try {
    await installPointerSampler(session.app.cdp);
    const pid = session.app.child.pid;
    const cpuBefore = pid === undefined ? null : readCpuJiffies(pid);
    const dragged = await realPointerDrag(session, TRAJECTORY);
    const quiet = await waitQuietWrites(session.app, 200);
    const cpuAfter = pid === undefined ? null : readCpuJiffies(pid);
    const edge = latencyEdges(dragged.lines, dragged.samples);
    const exit = await stopApp(session.app);
    const cpuJiffies = cpuBefore === null || cpuAfter === null ? null : cpuAfter - cpuBefore;
    return {
      arm,
      round,
      order,
      firstLaunch,
      writes: dragged.lines.length,
      from: dragged.base,
      to: dragged.expectedFinal,
      cpuJiffies,
      cpuMs: cpuJiffies === null ? null : cpuJiffies * 10,
      latencyFirst: edge.first,
      latencyLast: edge.last,
      latencyMedian: median([edge.first, edge.last]),
      latencyMatched: edge.moves,
      latencyUnmatched: 0,
      quietExtraWrites: quiet.after - quiet.before,
      exitCode: exit.exitCode,
      exitTimedOut: exit.timedOut,
      portClosed: exit.portClosed,
      alivePids: exit.alivePids.length,
      writesAfterQuit: exit.writesAfterQuit - exit.writesAtQuit,
      wallMs: Date.now() - startedAt,
    };
  } catch (error) {
    const exit = await stopApp(session.app);
    return {
      arm,
      round,
      order,
      firstLaunch,
      writes: 0,
      from: { x: 0, y: 0 },
      to: { x: 0, y: 0 },
      cpuJiffies: null,
      cpuMs: null,
      latencyFirst: Number.NaN,
      latencyLast: Number.NaN,
      latencyMedian: Number.NaN,
      latencyMatched: 0,
      latencyUnmatched: 0,
      quietExtraWrites: 0,
      exitCode: exit.exitCode,
      exitTimedOut: exit.timedOut,
      portClosed: exit.portClosed,
      alivePids: exit.alivePids.length,
      writesAfterQuit: exit.writesAfterQuit - exit.writesAtQuit,
      wallMs: Date.now() - startedAt,
      error: error instanceof Error ? (error.message ?? String(error)) : String(error),
    };
  }
}

interface ArmSummary {
  readonly arm: Arm;
  readonly launches: number;
  readonly writes: readonly number[];
  readonly writesMedian: number;
  readonly cpuMs: readonly (number | null)[];
  readonly cpuMsMedian: number;
  readonly latencyFirst: readonly number[];
  readonly latencyLast: readonly number[];
  readonly latencyMedian: readonly number[];
  readonly latencyMedianOfMedians: number;
  readonly residue: { readonly alivePids: number; readonly portOpen: number; readonly extraWrites: number };
}

function summarise(arm: Arm, records: readonly LaunchRecord[]): ArmSummary {
  const writes = records.map((item) => item.writes);
  const cpu = records.map((item) => item.cpuMs);
  const numeric = (values: readonly number[]): number[] => values.filter((value) => Number.isFinite(value));
  return {
    arm,
    launches: records.length,
    writes,
    writesMedian: median(writes),
    cpuMs: cpu,
    cpuMsMedian: median(numeric(cpu.filter((value): value is number => value !== null))),
    latencyFirst: records.map((item) => item.latencyFirst),
    latencyLast: records.map((item) => item.latencyLast),
    latencyMedian: records.map((item) => item.latencyMedian),
    latencyMedianOfMedians: median(numeric(records.map((item) => item.latencyMedian))),
    residue: {
      alivePids: records.reduce((total, item) => total + item.alivePids, 0),
      portOpen: records.filter((item) => !item.portClosed).length,
      extraWrites: records.reduce((total, item) => total + item.quietExtraWrites + item.writesAfterQuit, 0),
    },
  };
}

function verdictOf(off: ArmSummary, on: ArmSummary): { code: string; note: string } {
  const reduction = off.writesMedian === 0 ? Number.NaN : 1 - on.writesMedian / off.writesMedian;
  const cpuDelta = on.cpuMsMedian - off.cpuMsMedian;
  const latencyDelta = on.latencyMedianOfMedians - off.latencyMedianOfMedians;
  if (!Number.isFinite(reduction) || reduction < 0.05) {
    return {
      code: 'no-real-write-reduction',
      note: `真实 60Hz 轨迹下写入没有可重复减少（中位 ${off.writesMedian} → ${on.writesMedian}）。按阶段门，不建议为这个开关转正。`,
    };
  }
  if (Number.isFinite(cpuDelta) && cpuDelta < 0 && latencyDelta <= 0) {
    return {
      code: 'candidate',
      note: `写入中位 ${off.writesMedian} → ${on.writesMedian}（减少 ${(reduction * 100).toFixed(1)}%），CPU 中位差 ${cpuDelta.toFixed(0)}ms，提交时延中位差 ${latencyDelta.toFixed(1)}ms；仅作"下一步候选"建议，正式启用由负责人定。`,
    };
  }
  return {
    code: 'reduction-without-reproducible-benefit',
    note: `写入减少 ${(reduction * 100).toFixed(1)}%，但 CPU 中位差 ${cpuDelta.toFixed(0)}ms、提交时延中位差 ${latencyDelta.toFixed(1)}ms 未显示可复现收益（差值在波动内也算这类）。按阶段门不建议转正。`,
  };
}

async function main(): Promise<void> {
  const wiring = wiringPresent();
  let display = '';
  let displayError = '';
  try {
    display = requireDisplay();
  } catch (error) {
    displayError = error instanceof Error ? error.message : String(error);
  }

  mkdirSync(RUN_DIR, { recursive: true });
  const rawPath = path.join(RUN_DIR, 'raw.ndjson');
  writeFileSync(rawPath, '');

  if (!wiring.present || displayError !== '') {
    const summary = {
      status: 'blocked',
      generatedAt: new Date().toISOString(),
      head: gitHead(),
      dirty: gitDirty(),
      rounds: ROUNDS,
      trajectory: TRAJECTORY,
      blocked: {
        wiring: wiring.present ? null : wiring.reason,
        display: displayError === '' ? null : displayError,
      },
      note: '未产生任何测量：先落地公共接线并 pnpm build，再在 Xvfb 显示号下复跑。',
    };
    writeFileSync(path.join(RUN_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify({ event: 'cost-compare-blocked', ...summary.blocked, runDir: RUN_DIR }));
    process.exitCode = 2;
    return;
  }

  const records: LaunchRecord[] = [];
  const record = (item: LaunchRecord): void => {
    records.push(item);
    appendFileSync(rawPath, `${JSON.stringify(item)}\n`);
    console.log(JSON.stringify({ event: 'cost-run', ...item }));
  };

  // 进程内首启单列：不参与配对统计，也不叫"OS 冷缓存"。
  const firstLaunch = await measure('off', 0, 0, true);
  appendFileSync(rawPath, `${JSON.stringify({ ...firstLaunch, firstLaunch: true })}\n`);
  console.log(JSON.stringify({ event: 'cost-first-launch', ...firstLaunch }));

  for (let round = 1; round <= ROUNDS; round += 1) {
    // 交替顺序抵消漂移：奇偶轮反序。
    const order: Arm[] = round % 2 === 1 ? ['off', 'on'] : ['on', 'off'];
    for (const [index, arm] of order.entries()) {
      const measured = await measure(arm, round, index, false);
      record(measured);
      if (measured.error !== undefined) console.log(JSON.stringify({ event: 'cost-run-error', arm, round, error: measured.error }));
      await delay(150);
    }
  }

  const paired = records.filter((item) => !item.firstLaunch);
  const offSummaries = summarise('off', paired.filter((item) => item.arm === 'off'));
  const onSummaries = summarise('on', paired.filter((item) => item.arm === 'on'));
  const verdict = verdictOf(offSummaries, onSummaries);
  const pairs = Array.from({ length: ROUNDS }, (_, index) => {
    const round = index + 1;
    const off = paired.find((item) => item.arm === 'off' && item.round === round);
    const on = paired.find((item) => item.arm === 'on' && item.round === round);
    return {
      round,
      offWrites: off?.writes ?? null,
      onWrites: on?.writes ?? null,
      offCpuMs: off?.cpuMs ?? null,
      onCpuMs: on?.cpuMs ?? null,
      offLatencyMedian: off?.latencyMedian ?? null,
      onLatencyMedian: on?.latencyMedian ?? null,
      offFinal: off?.to ?? null,
      onFinal: on?.to ?? null,
      finalMatch:
        off?.to !== undefined && on?.to !== undefined ? off.to.x === on.to.x && off.to.y === on.to.y : null,
    };
  });

  const summary = {
    status: 'ok',
    generatedAt: new Date().toISOString(),
    head: gitHead(),
    dirty: gitDirty(),
    platform: process.platform,
    display,
    rounds: ROUNDS,
    plan: { budgetMs: 8, note: '8ms 是计划排队预算，不是 OS 硬保证' },
    trajectory: TRAJECTORY,
    firstLaunch: {
      note: '进程内第一次启动，单列；不叫 OS 冷缓存，也不进配对统计',
      ...firstLaunch,
    },
    arms: { off: offSummaries, on: onSummaries },
    paired: pairs,
    pairsFinalMatch: pairs.every((item) => item.finalMatch === true),
    verdict,
    notRun: [
      'Windows 真实鼠标拖动（本机无 Windows）：not-run',
      '物理呈帧 / 屏幕上的实际帧：not-run（只测 setPosition 软件提交）',
      'n=5 的 P95 与统计显著性：不报（样本量不足，报了会误导）',
    ],
  };
  writeFileSync(path.join(RUN_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ event: 'cost-compare-summary', runDir: RUN_DIR, verdict: verdict.code, off: offSummaries, on: onSummaries }));
  console.log(JSON.stringify({ event: 'cost-compare-verdict', ...verdict }));
}

await main();
