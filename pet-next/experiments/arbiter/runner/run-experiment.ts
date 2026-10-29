/**
 * 跑基线和状态机，写出原始日志，并按协议给出退出码。
 * 不启动桌宠。状态机尚未实现时记 `not-implemented`，不因此失败。
 */
import type {
  Arbiter,
  ArbiterFactory,
  ArbiterImplementation,
  ArbiterInput,
  ArbiterRunLog,
  ArbiterStep,
} from '../../../contracts/arbiter.ts';
import { createBaseline } from '../baseline/index.ts';
import { listArbiterFixtures, type ArbiterFixture } from '../fixtures/catalog.ts';
import { createStateMachine } from '../state-machine/index.ts';
import { explainDivergence, explainExpectedMismatch, firstDivergence, firstExpectedMismatch } from './compare.ts';
import { runFixture } from './run-fixture.ts';
import { defaultOutDir, removeUnimplementedStatus, writeRunLog, writeUnimplementedStatus } from './write-log.ts';

interface ExperimentDriver {
  initialState(): unknown;
  step(state: never, input: ArbiterInput): ArbiterStep<unknown>;
}

/** 一次实验怎么跑。缺省工厂和输出目录就是命令行的行为。 */
export interface ExperimentOptions {
  /** 日志根目录。缺省为 `experiments/arbiter/out`。 */
  outDir?: string;
  baseline?: () => ExperimentDriver;
  stateMachine?: () => ExperimentDriver;
  /** 为真时不写 stdout / stderr。退出码仍然返回。 */
  silent?: boolean;
}

interface Opened {
  kind: 'ok' | 'unimplemented' | 'error';
  arbiter?: Arbiter<unknown>;
  message?: string;
}

interface Executed {
  kind: 'ok' | 'error';
  logs: readonly ArbiterRunLog[];
  message: string;
  unimplemented: boolean;
}

/**
 * 执行全部夹具。
 *
 * @param options - 可替换工厂和输出目录。导入本模块不会调用它。
 * @returns `0` 基线符合例子；`1` 不一致、抛错或持续负载分叉；`2` 基线仍未实现。
 */
export async function runExperiment(options: ExperimentOptions = {}): Promise<number> {
  const outDir = options.outDir ?? defaultOutDir();
  const silent = options.silent === true;
  const fixtures = listArbiterFixtures();
  const baseline = openArbiter(adapt(options.baseline ?? createBaseline));
  if (baseline.kind === 'unimplemented') {
    emit(silent, 'stderr', 'baseline 尚未实现。这个退出码不是桌宠失败。');
    return 2;
  }
  if (baseline.kind === 'error' || baseline.arbiter === undefined) {
    emit(silent, 'stderr', baseline.message ?? 'baseline 无法启动');
    return 1;
  }
  const baselineRun = await execute(outDir, 'baseline', baseline.arbiter, fixtures);
  if (baselineRun.kind === 'error') {
    emit(silent, 'stderr', baselineRun.message);
    return 1;
  }
  const candidate = await runCandidate(outDir, adapt(options.stateMachine ?? createStateMachine), fixtures, baselineRun.logs);
  const problems = [...expectedProblems(baselineRun.logs, fixtures, 'baseline'), ...candidate.problems];
  if (problems.length > 0) {
    for (const line of problems) emit(silent, 'stderr', line);
    return 1;
  }
  emit(silent, 'stdout', summary(outDir, candidate.status));
  return 0;
}

async function runCandidate(
  outDir: string,
  factory: ArbiterFactory<unknown>,
  fixtures: readonly ArbiterFixture[],
  baselineLogs: readonly ArbiterRunLog[],
): Promise<{ problems: readonly string[]; status: 'not-implemented' | 'ran' }> {
  const opened = openArbiter(factory);
  if (opened.kind === 'unimplemented') {
    await writeUnimplementedStatus(outDir);
    return { problems: [], status: 'not-implemented' };
  }
  if (opened.kind === 'error' || opened.arbiter === undefined) {
    return { problems: [opened.message ?? 'state-machine 无法启动'], status: 'ran' };
  }
  const ran = await execute(outDir, 'state-machine', opened.arbiter, fixtures);
  if (ran.kind === 'error' && ran.unimplemented) {
    await writeUnimplementedStatus(outDir);
    return { problems: [], status: 'not-implemented' };
  }
  if (ran.kind === 'error') return { problems: [ran.message], status: 'ran' };
  await removeUnimplementedStatus(outDir);
  return {
    problems: [...expectedProblems(ran.logs, fixtures, 'state-machine'), ...divergenceProblems(baselineLogs, ran.logs, fixtures)],
    status: 'ran',
  };
}

async function execute(
  outDir: string,
  implementation: ArbiterImplementation,
  arbiter: Arbiter<unknown>,
  fixtures: readonly ArbiterFixture[],
): Promise<Executed> {
  const logs: ArbiterRunLog[] = [];
  try {
    for (const fixture of fixtures) {
      const log = runFixture(implementation, arbiter, fixture);
      logs.push(log);
      await writeRunLog(outDir, log);
    }
  } catch (error) {
    return { kind: 'error', logs, message: messageOf(error), unimplemented: isUnimplemented(error) };
  }
  return { kind: 'ok', logs, message: '', unimplemented: false };
}

function expectedProblems(
  logs: readonly ArbiterRunLog[],
  fixtures: readonly ArbiterFixture[],
  implementation: ArbiterImplementation,
): string[] {
  const lines: string[] = [];
  for (const fixture of fixtures) {
    if (fixture.expected === null) continue;
    const log = logs.find((item) => item.fixture === fixture.name);
    if (log === undefined) {
      lines.push(`${implementation} 没有写出夹具 ${fixture.name} 的日志。`);
      continue;
    }
    const index = firstExpectedMismatch(log, fixture.expected);
    if (index === null) continue;
    lines.push(explainExpectedMismatch(implementation, fixture.name, index, fixture.expected, log));
  }
  return lines;
}

function divergenceProblems(
  baselineLogs: readonly ArbiterRunLog[],
  otherLogs: readonly ArbiterRunLog[],
  fixtures: readonly ArbiterFixture[],
): string[] {
  const lines: string[] = [];
  for (const fixture of fixtures) {
    if (fixture.expected !== null) continue;
    const left = baselineLogs.find((item) => item.fixture === fixture.name);
    const right = otherLogs.find((item) => item.fixture === fixture.name);
    if (left === undefined || right === undefined) {
      lines.push(`无法比较夹具 ${fixture.name}：缺少一边的日志。`);
      continue;
    }
    const index = firstDivergence(left, right);
    if (index === null) continue;
    lines.push(explainDivergence(fixture.name, index));
  }
  return lines;
}

function openArbiter(factory: ArbiterFactory<unknown>): Opened {
  try {
    const arbiter = factory();
    arbiter.initialState();
    return { kind: 'ok', arbiter };
  } catch (error) {
    if (isUnimplemented(error)) return { kind: 'unimplemented' };
    return { kind: 'error', message: messageOf(error) };
  }
}

function adapt(factory: () => ExperimentDriver): ArbiterFactory<unknown> {
  return () => {
    const driver = factory();
    return {
      initialState() {
        return driver.initialState();
      },
      step(state: unknown, input: ArbiterInput) {
        // 这里只回放同一个 driver 刚返回的状态，形状对 runner 不透明。
        return driver.step(state as never, input);
      },
    };
  };
}

function summary(outDir: string, status: 'not-implemented' | 'ran'): string {
  const baselineDir = `${outDir.replace(/\/$/, '')}/baseline/`;
  if (status === 'not-implemented') {
    return [
      'baseline 已跑完规范性例子和持续负载，决策与 NORMATIVE_EXAMPLES 一致。',
      `state-machine 尚未实现，已写入 ${outDir.replace(/\/$/, '')}/state-machine/status.json。`,
      `原始日志：${baselineDir}`,
    ].join('\n');
  }
  return ['baseline 与 state-machine 已跑完规范性例子和持续负载，决策一致。', `原始日志：${baselineDir}`].join('\n');
}

function emit(silent: boolean, stream: 'stdout' | 'stderr', text: string): void {
  if (silent || text === '') return;
  if (stream === 'stdout') console.log(text);
  else console.error(text);
}

function isUnimplemented(error: unknown): boolean {
  return error instanceof Error && error.message.includes('尚未实现');
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
