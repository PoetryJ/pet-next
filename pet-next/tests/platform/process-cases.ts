/**
 * 把四条进程清理跑成平台矩阵行。
 * 只信号这次夹具的树；旁边名为 electron 的进程必须还在。
 * @module pet-next/tests/platform/process-cases
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PlatformMatrixEntry } from '../../contracts/process-tracker.ts';
import { pidIsAlive, signalPid } from '../support/process-table.ts';
import { startTrackedRun, type TrackedRun } from '../support/tracked-run.ts';
import { writeNotes } from './checks.ts';
import { petRoot, relativeToPet } from './session.ts';

const fixturePath = fileURLToPath(new URL('../fixtures/cleanup-child.mjs', import.meta.url));

export interface Decoy {
  pid: number;
  close(): Promise<void>;
}

export async function runLinuxProcessCases(): Promise<PlatformMatrixEntry[]> {
  return [
    await runCase('spawn-failure', 'fail', (outcome) => outcome.kind === 'startup-failure' && outcome.exitCode === 2),
    await runCase('timeout', 'hang', (outcome) => outcome.kind === 'timeout' && outcome.exitCode !== 0),
    await runCase('clean-exit', 'exit', (outcome) => outcome.kind === 'exit' && outcome.exitCode === 0),
    await runCase('foreign-pid-survives', 'exit', (outcome) => outcome.kind === 'exit' && outcome.decoyAlive && !outcome.decoyTracked),
  ];
}

export async function openDecoy(): Promise<Decoy> {
  if (process.platform === 'win32') return openWindowsDecoy();
  return openPosixDecoy();
}

async function runCase(
  caseId: PlatformMatrixEntry['caseId'],
  mode: string,
  accept: (outcome: CaseOutcome) => boolean,
): Promise<PlatformMatrixEntry> {
  const command = JSON.stringify([process.execPath, fixturePath, mode]);
  const decoy = await openDecoy();
  const run = startCase(mode);
  try {
    const outcome = await finishCase(run, mode, decoy);
    const evidencePath = relativeToPet(outcome.recordDir);
    await writeNotes(outcome.recordDir, outcome);
    const ok = accept(outcome) && outcome.treeGone && outcome.decoyAlive && !outcome.decoyTracked;
    return {
      platform: process.platform === 'win32' ? 'win32' : 'linux',
      caseId,
      status: ok ? 'passed' : 'failed',
      reason: ok ? null : outcome.detail,
      command,
      exitCode: outcome.exitCode,
      evidencePath,
    };
  } catch (error) {
    const recordDir = await run.writeRecord().catch(() => '');
    return {
      platform: process.platform === 'win32' ? 'win32' : 'linux',
      caseId,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      command,
      exitCode: null,
      evidencePath: recordDir ? relativeToPet(recordDir) : 'tests/platform/process-cases.ts',
    };
  } finally {
    await run.stop();
    await decoy.close();
  }
}

interface CaseOutcome {
  kind: 'startup-failure' | 'timeout' | 'exit';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  recordDir: string;
  treeGone: boolean;
  decoyAlive: boolean;
  decoyTracked: boolean;
  detail: string;
}

async function finishCase(run: TrackedRun, mode: string, decoy: Decoy): Promise<CaseOutcome> {
  if (mode === 'hang') {
    const timed = await run.untilReady({ timeoutMs: 700, ready: () => false });
    if (timed.status === 'ready') throw new Error('hang fixture became ready');
    return outcome(run, decoy, 'timeout', timed.exitCode, timed.signal, timed.recordDir);
  }
  const ready = await run.untilReady({ timeoutMs: 4000, ready: (stdout) => stdout.includes('READY') });
  if (ready.status !== 'ready') {
    return outcome(run, decoy, 'startup-failure', ready.exitCode, ready.signal, ready.recordDir);
  }
  const exited = await run.untilExit(4000);
  return outcome(run, decoy, 'exit', exited.exitCode, exited.signal, exited.recordDir);
}

function outcome(
  run: TrackedRun,
  decoy: Decoy,
  kind: CaseOutcome['kind'],
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  recordDir: string,
): CaseOutcome {
  const childPid = childPidFrom(run.stdout());
  const treeGone = childPid !== null && !pidIsAlive(childPid) && !pidIsAlive(run.pid);
  const decoyAlive = pidIsAlive(decoy.pid);
  const decoyTracked = run.trackedPids().includes(decoy.pid);
  const detail = `kind=${kind} exit=${exitCode} signal=${signal} treeGone=${treeGone} decoyAlive=${decoyAlive} decoyTracked=${decoyTracked}`;
  return { kind, exitCode, signal, recordDir, treeGone, decoyAlive, decoyTracked, detail };
}

function startCase(mode: string): TrackedRun {
  return startTrackedRun({
    executable: process.execPath,
    args: [fixturePath, mode],
    cwd: path.dirname(fixturePath),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      LANG: process.env.LANG ?? 'C',
      PET_NEXT_CLEANUP: mode,
    },
    label: `platform-${mode === 'fail' ? 'fail' : mode}`,
    logRoot: path.join(petRoot(), 'logs', 'platform-runs'),
  });
}

function childPidFrom(stdout: string): number | null {
  const match = /CHILD (\d+)/.exec(stdout);
  return match?.[1] ? Number(match[1]) : null;
}

async function openPosixDecoy(): Promise<Decoy> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-next-decoy-'));
  const executable = path.join(dir, 'electron');
  await writeFile(executable, '#!/bin/sh\nwhile true; do sleep 30; done\n');
  await chmod(executable, 0o755);
  const run = startTrackedRun({
    executable,
    args: [],
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    label: 'platform-decoy',
    logRoot: path.join(petRoot(), 'logs', 'platform-runs'),
  });
  return {
    pid: run.pid,
    close: async () => {
      await run.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function openWindowsDecoy(): Decoy {
  const run = startTrackedRun({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: petRoot(),
    env: process.env,
    label: 'platform-decoy',
    logRoot: path.join(petRoot(), 'logs', 'platform-runs'),
  });
  return {
    pid: run.pid,
    close: async () => {
      await run.stop();
      if (pidIsAlive(run.pid)) signalPid(run.pid, true);
    },
  };
}
