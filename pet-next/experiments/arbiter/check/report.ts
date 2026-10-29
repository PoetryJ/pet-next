/**
 * 把核对结果写成可读文本。数字是实验记录，不是桌宠的线上收益。
 */
import type { ArbiterComparison } from '../../../contracts/arbiter.ts';
import type { Complexity } from './complexity.ts';

/** 文本报告还需要的旁注。这些字段不进 `check.json`。 */
export interface ReportNote {
  fixture: string;
  implementation: string;
  /** `log` 表示抄 runner；`checker` 表示核对器自己包住 `step` 的耗时。 */
  machineElapsedSource: 'log' | 'checker';
  lines: readonly string[];
}

/** 写给人看的核对说明。 */
export interface ReportInput {
  comparisons: readonly ArbiterComparison[];
  notes: readonly ReportNote[];
  baseline: Complexity;
  stateMachine: Complexity | null;
  stateMachineStatus: 'ran' | 'not-implemented' | 'error';
  runnerExitCode: number | null;
  logDir: string;
  heldoutDir: string;
  outFile: string;
  recommendation: string;
}

/** 多行文本，末尾带换行。 */
export function formatReport(input: ReportInput): string {
  const lines = [
    '仲裁核对是实验记录，不是桌宠的线上收益，也不改默认行为。',
    `生成平台：${process.platform}。这次命令只覆盖该平台。`,
    `check.json：${input.outFile}`,
    `runner 日志目录：${input.logDir}`,
    `held-out 回放日志：${input.heldoutDir}`,
    `runner 退出码：${input.runnerExitCode === null ? '未调用' : String(input.runnerExitCode)}`,
    `state-machine：${input.stateMachineStatus}`,
    '',
    '模拟等待（simulatedWaitMs）按事件时间到开始、过期或重复的 nowMs 累加。',
    '机器耗时（machineElapsedMs）只包住 step。两列分开，不能相加当成用户等待。',
    '',
    header(),
    ...input.comparisons.flatMap((comparison) => formatComparison(comparison, input.notes)),
    '',
    '实现复杂度按非测试 TypeScript 的换行数计算，与 wc -l 相同。',
    formatComplexity('baseline', input.baseline),
  ];
  if (input.stateMachine === null) lines.push('state-machine：未统计（没有跑起来）。');
  else lines.push(formatComplexity('state-machine', input.stateMachine));
  lines.push('', input.recommendation, '');
  return `${lines.join('\n')}\n`;
}

/**
 * 两边都通过时，建议行数更少且没有新依赖的那一个。
 * 建议不是把该实现接进默认桌宠。
 */
export function recommend(
  comparisons: readonly ArbiterComparison[],
  baseline: Complexity,
  stateMachine: Complexity | null,
  stateMachineStatus: ReportInput['stateMachineStatus'],
): string {
  if (stateMachine === null || stateMachineStatus !== 'ran') {
    return '状态机没有跑完，不能在两边之间做推荐。是否进入产品仍由负责人决定。';
  }
  const failed = comparisons.some(
    (comparison) =>
      comparison.firstDivergenceIndex !== null ||
      comparison.baseline.ruleViolations > 0 ||
      comparison.stateMachine.ruleViolations > 0 ||
      comparison.baseline.expiredExecutions > 0 ||
      comparison.stateMachine.expiredExecutions > 0 ||
      comparison.baseline.firstFailureIndex !== null ||
      comparison.stateMachine.firstFailureIndex !== null,
  );
  if (failed) {
    return '至少有一条规则违反、过期执行或分叉。建议先返工不一致的实现，不要把它接进默认桌宠。';
  }
  if (baseline.thirdPartyImports.length > 0 || stateMachine.thirdPartyImports.length > 0) {
    return '有实现引入了第三方模块。协议要求不新增依赖；在去掉依赖之前不建议进入产品。';
  }
  if (baseline.lines < stateMachine.lines) {
    return `两边都满足规范性例子、持续负载和 held-out，规则违反与过期执行都是 0。基线 ${baseline.lines} 行，状态机 ${stateMachine.lines} 行，都没有新依赖。建议优先考虑基线。这只是实验建议，不改默认桌宠。`;
  }
  if (stateMachine.lines < baseline.lines) {
    return `两边都满足规范性例子、持续负载和 held-out，规则违反与过期执行都是 0。状态机 ${stateMachine.lines} 行，基线 ${baseline.lines} 行，都没有新依赖。建议优先考虑状态机。这只是实验建议，不改默认桌宠。`;
  }
  return `两边都满足已核对的输入，行数同为 ${baseline.lines}，都没有新依赖。实验记录分不出更简的一边。不建议据此替换默认桌宠。`;
}

function header(): string {
  return [
    pad('fixture', 28),
    pad('impl', 14),
    pad('viol', 6),
    pad('expExec', 8),
    pad('simWait', 10),
    pad('machineMs', 16),
    pad('starve', 7),
    pad('peak', 6),
    pad('failAt', 8),
    pad('diverge', 8),
    pad('timeSrc', 8),
  ].join(' ');
}

function formatComparison(comparison: ArbiterComparison, notes: readonly ReportNote[]): string[] {
  return [
    formatSide(comparison, 'baseline', comparison.baseline, notes),
    formatSide(comparison, 'state-machine', comparison.stateMachine, notes),
  ];
}

function formatSide(
  comparison: ArbiterComparison,
  implementation: 'baseline' | 'state-machine',
  report: ArbiterComparison['baseline'],
  notes: readonly ReportNote[],
): string {
  const note = notes.find((item) => item.fixture === comparison.fixture && item.implementation === implementation);
  const cells = [
    pad(comparison.fixture, 28),
    pad(implementation, 14),
    pad(String(report.ruleViolations), 6),
    pad(String(report.expiredExecutions), 8),
    pad(String(report.simulatedWaitMs), 10),
    pad(formatElapsed(report.machineElapsedMs), 16),
    pad(String(report.starvationCount), 7),
    pad(String(report.queuePeak), 6),
    pad(formatIndex(report.firstFailureIndex), 8),
    pad(formatIndex(comparison.firstDivergenceIndex), 8),
    pad(note?.machineElapsedSource ?? '-', 8),
  ];
  const extra = note?.lines.filter((line) => line !== '') ?? [];
  if (extra.length === 0) return cells.join(' ');
  return `${cells.join(' ')}\n${extra.map((line) => `  ${line}`).join('\n')}`;
}

function formatComplexity(name: string, complexity: Complexity): string {
  const imports = complexity.thirdPartyImports.length === 0 ? '无第三方导入' : `第三方导入 ${complexity.thirdPartyImports.join(', ')}`;
  const files = complexity.files.map((file) => `${file.lines} ${file.path}`).join('；');
  return `${name}：${complexity.lines} 行（${imports}）。${files}`;
}

function formatElapsed(value: number): string {
  if (!Number.isFinite(value)) return 'nan';
  return value.toFixed(6);
}

function formatIndex(value: number | null): string {
  return value === null ? '-' : String(value);
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value;
  return value + ' '.repeat(width - value.length);
}
