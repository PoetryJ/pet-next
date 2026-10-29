/**
 * 核对基线和状态机是否符合同一套规则，并写出实验指标。
 * 读取 runner 的日志和两个工厂，不 import runner。
 * @module pet-next/experiments/arbiter/check/run-check
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NORMATIVE_EXAMPLES,
  type ArbiterCheckReport,
  type ArbiterComparison,
  type ArbiterImplementation,
  type ArbiterInput,
  type ArbiterRunLog,
} from '../../../contracts/index.ts';
import { createBaseline } from '../baseline/index.ts';
import { HELDOUT_MIX_SEED, listHeldoutSequences } from '../heldout/sequences.ts';
import { createStateMachine } from '../state-machine/index.ts';
import { firstDivergence, firstMismatch, formatStep, mismatchIndexes, type ComparableStep } from './compare.ts';
import { measureComplexity, type Complexity } from './complexity.ts';
import { expiredExecutions, queuePeak, simulatedWaitMs, starvationCount, type MetricStep } from './metrics.ts';
import { replayOracle } from './oracle.ts';
import { replayFactory, type ReplayFactory, type ReplayResult } from './replay.ts';
import { formatReport, recommend, type ReportNote } from './report.ts';
import { buildProtocolSustainedInputs } from './sustained.ts';

/** 一段要核对的输入。`expected` 为空表示没有手写期望，只跟独立参照比。 */
export interface CheckSequence {
  name: string;
  inputs: readonly ArbiterInput[];
  expected: readonly ComparableStep[] | null;
  /** 为真时，机器耗时抄 runner 日志。held-out 由核对器自己计时。 */
  copyMachineElapsed: boolean;
  /** 写进 held-out 回放日志。规范性例子保持 null。 */
  seed: number | null;
}

/** 一次核对怎么跑。缺省就是命令行的行为。 */
export interface CheckOptions {
  /** `check.json` 和文本报告的目录。缺省为 `experiments/arbiter/out`。 */
  outDir?: string;
  /** runner 日志所在目录。缺省与 `outDir` 相同。 */
  logDir?: string;
  petRoot?: string;
  baseline?: ReplayFactory;
  stateMachine?: ReplayFactory;
  /** 为真时先执行 runner 入口以刷新日志。不 import 它。 */
  refreshLogs?: boolean;
  /** 为真时，规范性例子和持续负载必须有对得上的 runner 日志。 */
  requireRunnerLogs?: boolean;
  sequences?: readonly CheckSequence[];
  silent?: boolean;
}

interface SideAssessment {
  report: ArbiterCheckReport;
  steps: readonly MetricStep[];
  note: ReportNote;
  /** 缺日志、输入对不上或回放抛错。规则数字本身不为 0 时另计。 */
  blocksPass: boolean;
}

const petNextRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** 规范性例子、协议展开的持续负载，以及 held-out。 */
export function defaultSequences(): readonly CheckSequence[] {
  const sequences: CheckSequence[] = NORMATIVE_EXAMPLES.map((example) => ({
    name: example.name,
    inputs: example.inputs,
    expected: example.expected,
    copyMachineElapsed: true,
    seed: null,
  }));
  sequences.push({
    name: 'sustained-high-priority',
    inputs: buildProtocolSustainedInputs(),
    expected: null,
    copyMachineElapsed: true,
    seed: null,
  });
  for (const sequence of listHeldoutSequences()) {
    sequences.push({
      name: sequence.name,
      inputs: sequence.inputs,
      expected: null,
      copyMachineElapsed: false,
      seed: sequence.name === 'heldout-seeded-mix' ? HELDOUT_MIX_SEED : null,
    });
  }
  return sequences;
}

/**
 * 跑完全部序列并写 `check.json`。
 *
 * @param options - 可换工厂、目录，以及是否刷新 runner 日志。
 * @returns `0` 已实现的两边与规则一致；`1` 不一致或日志对不上；`2` 基线仍未实现。
 */
export async function runCheck(options: CheckOptions = {}): Promise<number> {
  const outDir = options.outDir ?? defaultOutDir();
  const logDir = options.logDir ?? outDir;
  const petRoot = options.petRoot ?? petNextRoot;
  const refreshLogs = options.refreshLogs !== false;
  const requireRunnerLogs = options.requireRunnerLogs ?? refreshLogs;
  const silent = options.silent === true;
  const sequences = options.sequences ?? defaultSequences();
  await mkdir(outDir, { recursive: true });
  const selfCheck = oracleSelfCheck();
  if (selfCheck !== null) {
    emit(silent, 'stderr', selfCheck);
    return 1;
  }

  const baselineFactory = options.baseline ?? createBaseline;
  const baselineProbe = replayFactory(baselineFactory, []);
  if (baselineProbe.unimplemented) {
    emit(silent, 'stderr', 'baseline 尚未实现。这个退出码不是规则通过。');
    return 2;
  }

  let runnerExitCode: number | null = null;
  if (refreshLogs) {
    const spawned = await spawnRunner(petRoot);
    runnerExitCode = spawned.code;
    await writeFile(path.join(outDir, 'runner-spawn.txt'), `exit ${spawned.code ?? 'null'}\n${spawned.stdout}\n${spawned.stderr}`, 'utf8');
    if (spawned.code === 2) {
      emit(silent, 'stderr', 'baseline 尚未实现。这个退出码不是规则通过。');
      return 2;
    }
  }

  const stateFactory = options.stateMachine ?? createStateMachine;
  const stateProbe = replayFactory(stateFactory, []);
  const stateMachineStatus = stateProbe.unimplemented ? 'not-implemented' : stateProbe.error === null ? 'ran' : 'error';
  const comparisons: ArbiterComparison[] = [];
  const notes: ReportNote[] = [];
  let failed = false;

  for (const sequence of sequences) {
    const oracleSteps = replayOracle(sequence.inputs).map((step, index) => ({
      nowMs: sequence.inputs[index]?.nowMs ?? 0,
      decisions: step.decisions,
      queueLength: step.queueLength,
    }));
    const baseline = await assessSide(logDir, 'baseline', baselineFactory, sequence, oracleSteps, requireRunnerLogs);
    const stateMachine =
      stateMachineStatus === 'ran'
        ? await assessSide(logDir, 'state-machine', stateFactory, sequence, oracleSteps, requireRunnerLogs)
        : unimplementedReport(sequence, stateMachineStatus, stateProbe.error);
    const firstDivergenceIndex = stateMachineStatus === 'ran' ? firstDivergence(baseline.steps, stateMachine.steps) : null;
    comparisons.push({
      fixture: sequence.name,
      baseline: baseline.report,
      stateMachine: stateMachine.report,
      firstDivergenceIndex,
    });
    notes.push(baseline.note, stateMachine.note);
    if (sideFailed(baseline) || (stateMachineStatus === 'ran' && sideFailed(stateMachine)) || stateMachine.blocksPass) failed = true;
    if (firstDivergenceIndex !== null) failed = true;
  }

  const baselineComplexity = await measureComplexity(path.join(petRoot, 'experiments/arbiter/baseline'));
  const stateComplexity = stateMachineStatus === 'ran' ? await measureComplexity(path.join(petRoot, 'experiments/arbiter/state-machine')) : null;
  const recommendation = recommend(comparisons, baselineComplexity, stateComplexity, stateMachineStatus);
  const outFile = path.join(outDir, 'check.json');
  await writeFile(outFile, `${JSON.stringify(comparisons, null, 2)}\n`, 'utf8');
  const text = formatReport({
    comparisons,
    notes,
    baseline: relativize(baselineComplexity, petRoot),
    stateMachine: stateComplexity === null ? null : relativize(stateComplexity, petRoot),
    stateMachineStatus,
    runnerExitCode,
    logDir,
    heldoutDir: path.join(logDir, 'heldout'),
    outFile,
    recommendation,
  });
  await writeFile(path.join(outDir, 'check-report.txt'), text, 'utf8');
  emit(silent, failed ? 'stderr' : 'stdout', text.trimEnd());
  if (stateMachineStatus === 'error') return 1;
  if (stateMachineStatus === 'not-implemented') return failed ? 1 : 0;
  return failed ? 1 : 0;
}

/** runner 默认写出、核对器也写报告的目录。 */
export function defaultOutDir(): string {
  return fileURLToPath(new URL('../out/', import.meta.url));
}

function oracleSelfCheck(): string | null {
  for (const example of NORMATIVE_EXAMPLES) {
    const actual = replayOracle(example.inputs);
    const index = firstMismatch(actual, [example.expected]);
    if (index === null) continue;
    return `独立参照与规范性例子 ${example.name} 在输入下标 ${index} 不一致。参照 ${formatStep(actual[index])}。期望 ${formatStep(example.expected[index])}。停止评判两套实现。`;
  }
  return null;
}

async function assessSide(
  logDir: string,
  implementation: ArbiterImplementation,
  factory: ReplayFactory,
  sequence: CheckSequence,
  oracleSteps: readonly MetricStep[],
  requireRunnerLogs: boolean,
): Promise<SideAssessment> {
  const replay = replayFactory(factory, sequence.inputs);
  const log = await loadLog(logDir, implementation, sequence, requireRunnerLogs);
  const machineElapsedMs = log.elapsedMs ?? replay.machineElapsedMs;
  const machineElapsedSource = log.elapsedMs === null ? 'checker' : 'log';
  const references: (readonly ComparableStep[] | null)[] = [oracleSteps, sequence.expected, log.steps];
  const ruleIndexes = new Set(mismatchIndexes(replay.steps, references));
  for (const index of expiredStartIndexes(sequence.inputs, replay.steps)) ruleIndexes.add(index);
  if (replay.error !== null && !replay.unimplemented) ruleIndexes.add(Math.min(replay.steps.length, Math.max(sequence.inputs.length - 1, 0)));
  const ordered = [...ruleIndexes].sort((left, right) => left - right);
  let firstFailureIndex = ordered[0] ?? null;
  if (firstFailureIndex === null && log.problem !== null) firstFailureIndex = inputIndexFrom(log.problem);
  const report: ArbiterCheckReport = {
    fixture: sequence.name,
    implementation,
    ruleViolations: ordered.length,
    expiredExecutions: expiredExecutions(sequence.inputs, replay.steps),
    simulatedWaitMs: simulatedWaitMs(sequence.inputs, replay.steps),
    machineElapsedMs,
    starvationCount: starvationCount(sequence.inputs, replay.steps),
    queuePeak: queuePeak(replay.steps),
    firstFailureIndex,
  };
  const lines = failureLines(implementation, sequence, replay, oracleSteps, log, ordered);
  if (!sequence.copyMachineElapsed) {
    await writeReplayLog(path.join(logDir, 'heldout'), implementation, sequence, replay, machineElapsedMs);
  }
  return {
    report,
    steps: replay.steps,
    note: { fixture: sequence.name, implementation, machineElapsedSource, lines },
    blocksPass: log.problem !== null || (replay.error !== null && !replay.unimplemented),
  };
}

function sideFailed(side: SideAssessment): boolean {
  return side.blocksPass || side.report.ruleViolations > 0 || side.report.expiredExecutions > 0 || side.report.firstFailureIndex !== null;
}

function inputIndexFrom(problem: string): number {
  const matched = /下标 (\d+)/.exec(problem);
  if (matched?.[1] === undefined) return 0;
  return Number(matched[1]);
}

function unimplementedReport(sequence: CheckSequence, status: 'not-implemented' | 'error', message: string | null): SideAssessment {
  const report: ArbiterCheckReport = {
    fixture: sequence.name,
    implementation: 'state-machine',
    ruleViolations: status === 'error' ? Math.max(sequence.inputs.length, 1) : 0,
    expiredExecutions: 0,
    simulatedWaitMs: 0,
    machineElapsedMs: 0,
    starvationCount: 0,
    queuePeak: 0,
    firstFailureIndex: status === 'error' ? 0 : null,
  };
  const line = status === 'not-implemented' ? 'state-machine 尚未实现，本侧不参与规则对照。' : `state-machine 无法启动：${message ?? '未知错误'}`;
  return {
    report,
    steps: [],
    note: { fixture: sequence.name, implementation: 'state-machine', machineElapsedSource: 'checker', lines: [line] },
    blocksPass: status === 'error',
  };
}

interface LoadedLog {
  steps: readonly ComparableStep[] | null;
  elapsedMs: number | null;
  problem: string | null;
}

async function loadLog(logDir: string, implementation: ArbiterImplementation, sequence: CheckSequence, requireRunnerLogs: boolean): Promise<LoadedLog> {
  if (!sequence.copyMachineElapsed) return { steps: null, elapsedMs: null, problem: null };
  const file = path.join(logDir, implementation, `${sequence.name}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch (error) {
    if (!isEnoent(error) && !(error instanceof SyntaxError)) throw error;
    if (!requireRunnerLogs) return { steps: null, elapsedMs: null, problem: null };
    return { steps: null, elapsedMs: null, problem: `缺少 runner 日志 ${file}` };
  }
  if (!isRunLog(parsed)) return { steps: null, elapsedMs: null, problem: `runner 日志 ${file} 不符合 ArbiterRunLog` };
  const inputIndex = firstInputMismatch(parsed.delivered, sequence.inputs);
  if (inputIndex !== null) {
    return { steps: null, elapsedMs: null, problem: `runner 日志输入从下标 ${inputIndex} 起与协议输入不一致` };
  }
  return {
    steps: parsed.steps.map((step) => ({ decisions: step.decisions, queueLength: step.queueLength })),
    elapsedMs: parsed.machineElapsedMs,
    problem: null,
  };
}

function failureLines(
  implementation: ArbiterImplementation,
  sequence: CheckSequence,
  replay: ReplayResult,
  oracleSteps: readonly MetricStep[],
  log: LoadedLog,
  indexes: readonly number[],
): string[] {
  const lines: string[] = [];
  if (log.problem !== null) lines.push(log.problem);
  if (replay.error !== null) lines.push(`回放抛错：${replay.error}`);
  const index = indexes[0];
  if (index === undefined) return lines;
  lines.push(
    `${implementation} 在输入下标 ${index} 与参照不一致。参照 ${formatStep(oracleSteps[index])}。实际 ${formatStep(replay.steps[index])}。`,
  );
  if (indexes.length > 1) lines.push(`同序列还有 ${indexes.length - 1} 步不一致。`);
  return lines;
}

async function writeReplayLog(
  dir: string,
  implementation: ArbiterImplementation,
  sequence: CheckSequence,
  replay: ReplayResult,
  machineElapsedMs: number,
): Promise<void> {
  const log: ArbiterRunLog = {
    implementation,
    fixture: sequence.name,
    seed: sequence.seed,
    delivered: sequence.inputs,
    steps: replay.steps.map((step, index) => {
      const input = sequence.inputs[index];
      if (input === undefined) throw new Error(`回放步骤 ${index} 没有对应输入`);
      return { input, decisions: step.decisions, queueLength: step.queueLength };
    }),
    machineElapsedMs,
  };
  const folder = path.join(dir, implementation);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `${sequence.name}.json`), `${JSON.stringify(log, null, 2)}\n`, 'utf8');
}

function expiredStartIndexes(inputs: readonly ArbiterInput[], steps: readonly MetricStep[]): number[] {
  const events = new Map<string, ArbiterInput & { type: 'deliver' }>();
  for (const input of inputs) {
    if (input.type === 'deliver' && !events.has(input.event.id)) events.set(input.event.id, input);
  }
  const indexes: number[] = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step === undefined) continue;
    for (const decision of step.decisions) {
      if (decision.reason !== 'started' || decision.eventId === null) continue;
      const input = events.get(decision.eventId);
      if (input === undefined) continue;
      if (input.event.expiresAtMs <= step.nowMs || input.event.timeMs >= input.event.expiresAtMs) indexes.push(index);
    }
  }
  return indexes;
}

function firstInputMismatch(logged: readonly ArbiterInput[], expected: readonly ArbiterInput[]): number | null {
  const length = Math.max(logged.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    const left = logged[index];
    const right = expected[index];
    if (left === undefined || right === undefined || !sameInput(left, right)) return index;
  }
  return null;
}

function sameInput(left: ArbiterInput, right: ArbiterInput): boolean {
  if (left.type !== right.type || left.nowMs !== right.nowMs) return false;
  if (left.type === 'complete' && right.type === 'complete') return left.actionId === right.actionId;
  if (left.type === 'deliver' && right.type === 'deliver') {
    return (
      left.event.id === right.event.id &&
      left.event.source === right.event.source &&
      left.event.seq === right.event.seq &&
      left.event.timeMs === right.event.timeMs &&
      left.event.expiresAtMs === right.event.expiresAtMs
    );
  }
  return false;
}

function isRunLog(value: unknown): value is ArbiterRunLog {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.delivered) && Array.isArray(record.steps) && typeof record.machineElapsedMs === 'number';
}

function spawnRunner(petRoot: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', 'experiments/arbiter/runner/main.ts'], {
      cwd: petRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function relativize(complexity: Complexity, petRoot: string): Complexity {
  return {
    ...complexity,
    files: complexity.files.map((file) => ({ ...file, path: path.relative(petRoot, file.path) })),
  };
}

function emit(silent: boolean, stream: 'stdout' | 'stderr', text: string): void {
  if (silent || text === '') return;
  if (stream === 'stdout') console.log(text);
  else console.error(text);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
