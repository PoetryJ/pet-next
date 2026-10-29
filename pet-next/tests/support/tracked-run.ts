/**
 * 启动一条命令并持续记下它的进程树，结束时只信号这些 PID。
 * 不负责断言 Electron 业务；调用方在 finally 里 stop。
 * 采样必须发生在父进程退出之前，否则子进程会被 init 收养。
 * Linux 发信号前核对 /proc stat 的 starttime，避免 PID 被复用后误伤。Windows 尚未做同样的核对。
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { pidIsAlive, signalPid, snapshotChildren } from './process-table.ts';
import { descendantPids, killOrder, readStartTicks } from './process-tree.ts';
import { writeRunRecord } from './run-record.ts';

const SAMPLE_INTERVAL_MS = 100;
const REAP_ATTEMPTS = 5;
const REAP_PAUSE_MS = 40;
const SETTLE_WAIT_MS = 2000;
const LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface StartTrackedRunOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly label: string;
  readonly logRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly mirror?: boolean;
  /** 为 false 时记录直接写进 logRoot。一键脚本的用例目录已经带了平台名。 */
  readonly platformSegment?: boolean;
}

export type ReadyWait =
  | { status: 'ready' }
  | { status: 'startup-failure' | 'timeout'; exitCode: number | null; signal: NodeJS.Signals | null; recordDir: string };

export interface ExitWait {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly recordDir: string;
}

export interface TrackedRun {
  readonly pid: number;
  readonly child: ChildProcess;
  stdout(): string;
  stderr(): string;
  trackedPids(): readonly number[];
  stop(): Promise<void>;
  untilReady(options: { timeoutMs: number; ready: (stdout: string, stderr: string) => boolean }): Promise<ReadyWait>;
  untilExit(timeoutMs: number): Promise<ExitWait>;
  writeRecord(): Promise<string>;
}

interface RunState {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  settled: boolean;
  stopped: boolean;
  readonly tracked: Set<number>;
  readonly started: Map<number, number>;
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly directory: string;
  readonly options: StartTrackedRunOptions;
  timer: ReturnType<typeof setInterval> | undefined;
}

/** 启动命令并开始采样它的后代。label 只能是 kebab-case。 */
export function startTrackedRun(options: StartTrackedRunOptions): TrackedRun {
  if (!LABEL.test(options.label)) throw new Error(`label must be kebab-case, got ${options.label}`);
  const platform = options.platform ?? process.platform;
  const child = spawnTracked(options);
  const pid = child.pid;
  if (pid === undefined) {
    child.on('error', () => {
      // 可执行文件不存在时，error 在后续 tick 才发出。接住它，避免未捕获异常。
    });
    throw new Error(`spawn did not return a pid: ${options.executable}`);
  }
  const state = createState(options, platform, pid);
  wireChild(child, state);
  const timer = setInterval(() => collect(state), SAMPLE_INTERVAL_MS);
  timer.unref();
  state.timer = timer;
  collect(state);
  return bindRun(child, state);
}

function spawnTracked(options: StartTrackedRunOptions): ChildProcess {
  return spawn(options.executable, [...options.args], {
    cwd: options.cwd,
    env: definedEnv(options.env),
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function createState(options: StartTrackedRunOptions, platform: NodeJS.Platform, pid: number): RunState {
  const startedAt = new Date();
  return {
    stdout: '',
    stderr: '',
    exitCode: null,
    exitSignal: null,
    settled: false,
    stopped: false,
    tracked: new Set<number>([pid]),
    started: new Map<number, number>(),
    pid,
    platform,
    directory: recordDirectory({
      logRoot: options.logRoot,
      platform,
      label: options.label,
      pid,
      startedAt,
      platformSegment: options.platformSegment !== false,
    }),
    options,
    timer: undefined,
  };
}

function wireChild(child: ChildProcess, state: RunState): void {
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => appendOutput(state, 'stdout', chunk));
  child.stderr?.on('data', (chunk: string) => appendOutput(state, 'stderr', chunk));
  child.once('exit', (code, signal) => {
    state.exitCode = code;
    state.exitSignal = signal;
  });
  child.once('close', () => {
    state.settled = true;
  });
  child.once('error', () => {
    state.settled = true;
  });
}

function appendOutput(state: RunState, stream: 'stdout' | 'stderr', chunk: string): void {
  if (stream === 'stdout') state.stdout += chunk;
  else state.stderr += chunk;
  if (!state.options.mirror) return;
  if (stream === 'stdout') process.stdout.write(chunk);
  else process.stderr.write(chunk);
}

function bindRun(child: ChildProcess, state: RunState): TrackedRun {
  return {
    pid: state.pid,
    child,
    stdout: () => state.stdout,
    stderr: () => state.stderr,
    trackedPids: () => [...state.tracked],
    stop: () => stop(state),
    untilReady: (readyOptions) => untilReady(state, readyOptions),
    untilExit: (timeoutMs) => untilExit(state, timeoutMs),
    writeRecord: () => persist(state),
  };
}

function collect(state: RunState): void {
  remember(state, state.pid);
  try {
    const directChildren = snapshotChildren(state.platform);
    for (const descendant of descendantPids(state.pid, directChildren)) remember(state, descendant);
  } catch {
    // 采样失败时保留已经看到的 PID，结束阶段仍会尝试信号它们。
  }
}

function remember(state: RunState, pid: number): void {
  state.tracked.add(pid);
  if (state.platform !== 'linux' || state.started.has(pid)) return;
  const ticks = linuxStartTicks(pid);
  if (ticks !== undefined) state.started.set(pid, ticks);
}

async function stop(state: RunState): Promise<void> {
  if (state.stopped) return;
  state.stopped = true;
  if (state.timer !== undefined) clearInterval(state.timer);
  await reap(state);
  await waitUntil(() => state.settled, SETTLE_WAIT_MS);
}

async function reap(state: RunState): Promise<void> {
  for (let attempt = 0; attempt < REAP_ATTEMPTS; attempt += 1) {
    collect(state);
    const alive = killOrder(state.pid, [...state.tracked]).filter((pid) => maySignal(state, pid));
    if (alive.length === 0) return;
    for (const pid of alive) {
      try {
        signalPid(pid, pid === state.pid, state.platform);
      } catch {
        // 这一轮不能信号的 PID 留到下一轮；不能因此放过同树的其它进程。
      }
    }
    await delay(REAP_PAUSE_MS);
  }
}

function maySignal(state: RunState, pid: number): boolean {
  if (!pidIsAlive(pid)) return false;
  if (state.platform !== 'linux') return true;
  return state.started.get(pid) === linuxStartTicks(pid) && state.started.has(pid);
}

async function untilReady(
  state: RunState,
  readyOptions: { timeoutMs: number; ready: (stdout: string, stderr: string) => boolean },
): Promise<ReadyWait> {
  const deadline = Date.now() + readyOptions.timeoutMs;
  while (Date.now() < deadline) {
    collect(state);
    if (readyOptions.ready(state.stdout, state.stderr)) return { status: 'ready' };
    if (state.settled) break;
    await delay(20);
  }
  if (readyOptions.ready(state.stdout, state.stderr)) return { status: 'ready' };
  const status = state.settled ? 'startup-failure' : 'timeout';
  await stop(state);
  const recordDir = await persist(state);
  return { status, exitCode: state.exitCode, signal: state.exitSignal, recordDir };
}

async function untilExit(state: RunState, timeoutMs: number): Promise<ExitWait> {
  const deadline = Date.now() + timeoutMs;
  while (!state.settled && Date.now() < deadline) {
    collect(state);
    await delay(20);
  }
  const timedOut = !state.settled;
  await stop(state);
  const recordDir = await persist(state);
  return { exitCode: state.exitCode, signal: state.exitSignal, timedOut, recordDir };
}

function persist(state: RunState): Promise<string> {
  return writeRunRecord({
    platform: state.platform,
    executable: state.options.executable,
    args: state.options.args,
    cwd: state.options.cwd,
    env: state.options.env,
    exitCode: state.exitCode,
    stdout: state.stdout,
    stderr: state.stderr,
    directory: state.directory,
  });
}

function linuxStartTicks(pid: number): number | undefined {
  try {
    return readStartTicks(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return undefined;
  }
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) defined[key] = value;
  }
  return defined;
}

function recordDirectory(input: {
  logRoot: string;
  platform: NodeJS.Platform;
  label: string;
  pid: number;
  startedAt: Date;
  platformSegment: boolean;
}): string {
  const stamp = input.startedAt.toISOString().replace(/[:.]/g, '-');
  const leaf = `${stamp}-${input.label}-${input.pid}`;
  if (!input.platformSegment) return path.join(input.logRoot, leaf);
  return path.join(input.logRoot, input.platform, leaf);
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function waitUntil(done: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await delay(20);
}
