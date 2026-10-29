/**
 * 一次运行的命令行入口：保存环境、命令、退出码和原始日志，并清掉这次的进程树。
 * Windows 与 Linux 用同一条命令；没跑过的平台不能把缺席写成通过。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeRunRecord } from './run-record.ts';
import { startTrackedRun, type TrackedRun } from './tracked-run.ts';

const PET_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface RecordCliOptions {
  readonly logRoot?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly quiet?: boolean;
  /** 仅命令行入口登记，避免测试里的 SIGINT 监听把测试进程直接退出。 */
  readonly handleSignals?: boolean;
}

export interface RecordCliResult {
  readonly code: number;
  readonly recordDir: string;
  readonly caseRoot: string;
}

/** 跑 argv 里 `--` 之后的命令。没有命令时返回 1，不启动进程。 */
export async function main(argv: readonly string[], options: RecordCliOptions = {}): Promise<RecordCliResult> {
  const command = commandAfterSeparator(argv);
  const executable = command[0];
  if (!executable) return { code: 1, recordDir: '', caseRoot: '' };
  const logRoot = options.logRoot ?? path.join(PET_ROOT, 'logs', 'platform-runs');
  const cwd = options.cwd ?? PET_ROOT;
  const batch = new Date().toISOString().replace(/[:.]/g, '-');
  const caseRoot = path.join(logRoot, process.platform, `${batch}-cases`);
  const env = { ...(options.env ?? process.env), PET_NEXT_RUN_LOG_ROOT: caseRoot };
  let run: TrackedRun;
  try {
    run = startTrackedRun({
      executable,
      args: command.slice(1),
      cwd,
      env,
      label: 'record-platform-run',
      logRoot,
      mirror: options.quiet !== true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return recordSpawnFailure({ executable, args: command.slice(1), cwd, env, logRoot, batch, caseRoot, message, quiet: options.quiet === true });
  }
  return finishRun(run, options, caseRoot);
}

async function finishRun(run: TrackedRun, options: RecordCliOptions, caseRoot: string): Promise<RecordCliResult> {
  const onSignal = () => {
    // 进程信号打断这次运行时，先清树再退出。
    void run.stop().finally(() => {
      process.exit(1);
    });
  };
  if (options.handleSignals === true) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
  try {
    const result = await run.untilExit(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (options.quiet !== true) printSummary(result.exitCode, result.recordDir, caseRoot);
    const code = result.timedOut ? 1 : (result.exitCode ?? 1);
    return { code, recordDir: result.recordDir, caseRoot };
  } finally {
    if (options.handleSignals === true) {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }
}

function printSummary(exitCode: number | null, recordDir: string, caseRoot: string): void {
  console.log(`platform=${process.platform}`);
  console.log(`exit=${exitCode === null ? 'null' : exitCode}`);
  console.log(`record=${recordDir}`);
  console.log(`cases=${caseRoot}`);
}

async function recordSpawnFailure(input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logRoot: string;
  batch: string;
  caseRoot: string;
  message: string;
  quiet: boolean;
}): Promise<RecordCliResult> {
  const directory = path.join(input.logRoot, process.platform, `${input.batch}-record-platform-run-spawn`);
  await writeRunRecord({
    platform: process.platform,
    executable: input.executable,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    exitCode: null,
    stdout: '',
    stderr: `${input.message}\n`,
    directory,
  });
  if (!input.quiet) printSummary(null, directory, input.caseRoot);
  return { code: 1, recordDir: directory, caseRoot: input.caseRoot };
}

function commandAfterSeparator(argv: readonly string[]): readonly string[] {
  const separator = argv.indexOf('--');
  return separator === -1 ? argv : argv.slice(separator + 1);
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), { handleSignals: true })
    .then((result) => {
      process.exit(result.code);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
