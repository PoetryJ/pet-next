/**
 * 平台矩阵的记账规则。
 * `passed` 必须有证据；`not-run` 不能算通过。
 * 系统缩放和 `--force-device-scale-factor` 不能写进同一行。
 * @module pet-next/tests/platform/matrix
 */
import { REQUIRED_PLATFORM_FLOWS, type RequiredPlatformFlow } from '../../contracts/coverage.ts';
import {
  REQUIRED_SCALE_CASES,
  type ScaleCaseSpec,
  type ScaleMatrixEntry,
  type ScaleOrigin,
} from '../../contracts/coordinates.ts';
import {
  REQUIRED_PLATFORMS,
  REQUIRED_PROCESS_CASES,
  type PlatformMatrixEntry,
  type PlatformStatus,
} from '../../contracts/process-tracker.ts';

export const WINDOWS_SCRIPT = 'tests/platform/verify-windows.ps1';

export type Verdict = 'passed' | 'failed' | 'incomplete';

export interface FlowRow {
  flow: RequiredPlatformFlow;
  platform: (typeof REQUIRED_PLATFORMS)[number];
  status: PlatformStatus;
  /** `passed` 时为 null。 */
  reason: string | null;
  /** 相对 `pet-next`。`not-run` 时指向一键脚本。 */
  evidencePath: string | null;
}

export interface ScaleRow extends ScaleMatrixEntry {
  id: ScaleCaseSpec['id'];
  origin: ScaleOrigin;
  /** 进程参数里的强制值。系统行和 default 必须是 null。 */
  forcedDeviceScaleFactor: number | null;
  /** Electron 报告的 `scaleSource`。`not-run` 时为 null。 */
  scaleSource: 'os' | 'simulated-chromium-flag' | null;
  /** 页面 `devicePixelRatio`，只记录，不参与换算。 */
  devicePixelRatio: number | null;
}

export interface PlatformReport {
  verdict: Verdict;
  host: NodeJS.Platform;
  generatedAt: string;
  /** 独立于 Electron 的系统 DPI 读数。Linux 这次没有，为 null。 */
  osScale: number | null;
  osScaleSource: string | null;
  flows: FlowRow[];
  processes: PlatformMatrixEntry[];
  scales: ScaleRow[];
}

export interface ScaleObservation {
  id: ScaleCaseSpec['id'];
  host: NodeJS.Platform;
  /** `GetDpiForSystem() / 96`。没有独立读数时为 null，不能用 Electron 的 scaleFactor 代替。 */
  osScale: number | null;
  forcedArg: number | null;
  reportedForced: number | null;
  reportedSource: string | null;
  reportedScale: number | null;
  devicePixelRatio: number | null;
  dragOk: boolean | null;
  evidencePath: string | null;
  error: string | null;
}

/** 浮点读写的同一数值。拖动像素容差不走这里。 */
export function sameScale(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

export function verdictOf(statuses: readonly PlatformStatus[]): Verdict {
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.some((status) => status === 'not-run')) return 'incomplete';
  return 'passed';
}

export function flowRow(
  flow: RequiredPlatformFlow,
  platform: FlowRow['platform'],
  status: PlatformStatus,
  reason: string | null,
  evidencePath: string | null,
): FlowRow {
  if (status === 'passed') return { flow, platform, status, reason: null, evidencePath };
  return { flow, platform, status, reason, evidencePath };
}

/** 没有 Windows 执行器时的流程行。证据是脚本，状态不是通过。 */
export function windowsFlowsNotRun(): FlowRow[] {
  return REQUIRED_PLATFORM_FLOWS.map((flow) =>
    flowRow(flow, 'win32', 'not-run', '没有 Windows 执行器。运行 tests/platform/verify-windows.ps1。', WINDOWS_SCRIPT),
  );
}

/** 没有 Windows 执行器时的进程行。 */
export function windowsProcessesNotRun(): PlatformMatrixEntry[] {
  const command = 'powershell -File tests/platform/verify-windows.ps1';
  return REQUIRED_PROCESS_CASES.map((caseId) => ({
    platform: 'win32' as const,
    caseId,
    status: 'not-run' as const,
    reason: '没有 Windows 执行器。这个脚本还没有在 Windows 上跑过。',
    command,
    exitCode: null,
    evidencePath: WINDOWS_SCRIPT,
  }));
}

export function scaleRowFromObservation(observation: ScaleObservation): ScaleRow {
  const spec = specFor(observation.id);
  const skipped = systemSkipReason(spec, observation);
  if (skipped !== null) return notRunScale(spec, skipped);
  const failure = scaleFailure(spec, observation);
  if (failure !== null) {
    return {
      ...measured(spec, observation),
      status: 'failed',
      reason: failure,
    };
  }
  return {
    ...measured(spec, observation),
    status: 'passed',
    reason: null,
  };
}

/** 返回违规说明。空数组表示矩阵可以照这个状态对外报告。 */
export function auditReport(report: PlatformReport): string[] {
  const problems: string[] = [];
  const statuses: PlatformStatus[] = [];
  auditFlows(report.flows, statuses, problems);
  auditProcesses(report.processes, statuses, problems);
  auditScales(report.scales, report, statuses, problems);
  if (report.verdict !== verdictOf(statuses)) {
    problems.push(`verdict ${report.verdict} 和行状态不一致，应为 ${verdictOf(statuses)}`);
  }
  if (report.host !== 'win32' && report.osScale !== null) {
    problems.push('非 Windows 主机不能填写 osScale，避免把别的数字写成系统缩放');
  }
  return problems;
}

function auditFlows(flows: readonly FlowRow[], statuses: PlatformStatus[], problems: string[]): void {
  for (const platform of REQUIRED_PLATFORMS) {
    for (const flow of REQUIRED_PLATFORM_FLOWS) {
      const rows = flows.filter((row) => row.platform === platform && row.flow === flow);
      if (rows.length !== 1) problems.push(`flow ${platform}/${flow} 有 ${rows.length} 行`);
      for (const row of rows) {
        statuses.push(row.status);
        problems.push(...statusProblems(`flow ${platform}/${flow}`, row.status, row.reason, row.evidencePath, true));
      }
    }
  }
}

function auditProcesses(
  processes: readonly PlatformMatrixEntry[],
  statuses: PlatformStatus[],
  problems: string[],
): void {
  for (const platform of REQUIRED_PLATFORMS) {
    for (const caseId of REQUIRED_PROCESS_CASES) {
      const rows = processes.filter((row) => row.platform === platform && row.caseId === caseId);
      if (rows.length !== 1) problems.push(`process ${platform}/${caseId} 有 ${rows.length} 行`);
      for (const row of rows) {
        statuses.push(row.status);
        problems.push(
          ...statusProblems(`process ${platform}/${caseId}`, row.status, row.reason, row.evidencePath, true),
        );
      }
    }
  }
}

function auditScales(
  scales: readonly ScaleRow[],
  report: PlatformReport,
  statuses: PlatformStatus[],
  problems: string[],
): void {
  for (const spec of REQUIRED_SCALE_CASES) {
    const rows = scales.filter((row) => row.id === spec.id);
    if (rows.length !== 1) problems.push(`scale ${spec.id} 有 ${rows.length} 行`);
    for (const row of rows) {
      statuses.push(row.status);
      if (row.origin !== spec.origin) problems.push(`scale ${spec.id} origin 写成了 ${row.origin}`);
      problems.push(...scaleStatusProblems(row));
      if (row.origin === 'system' && row.status === 'passed' && report.host !== 'win32') {
        problems.push(`scale ${spec.id} 在非 Windows 上被写成通过`);
      }
    }
  }
  const simulated = new Set(scales.filter((row) => row.origin === 'simulated').map((row) => row.evidencePath));
  for (const row of scales) {
    if (row.origin !== 'system' || row.status !== 'passed' || row.evidencePath === null) continue;
    if (simulated.has(row.evidencePath)) problems.push(`scale ${row.id} 复用了模拟缩放的证据 ${row.evidencePath}`);
  }
}

function scaleStatusProblems(row: ScaleRow): string[] {
  const label = `scale ${row.id}`;
  if (row.status === 'not-run') {
    const problems = statusProblems(label, row.status, row.reason, row.evidencePath, false);
    if (row.observedScaleFactor !== null) problems.push(`${label} not-run 仍写了 observedScaleFactor`);
    if (row.evidencePath !== null) problems.push(`${label} not-run 的 evidencePath 必须是 null`);
    if (row.scaleSource !== null || row.forcedDeviceScaleFactor !== null || row.devicePixelRatio !== null) {
      problems.push(`${label} not-run 不能带模拟或实测缩放字段`);
    }
    return problems;
  }
  const problems = statusProblems(label, row.status, row.reason, row.evidencePath, true);
  if (row.status === 'passed' && row.observedScaleFactor === null) problems.push(`${label} passed 没有 observedScaleFactor`);
  if (row.origin === 'simulated' && row.status === 'passed') {
    if (row.scaleSource !== 'simulated-chromium-flag') problems.push(`${label} 通过时 scaleSource 不是模拟`);
    const spec = specFor(row.id);
    if (row.forcedDeviceScaleFactor === null || spec.scaleFactor === null || !sameScale(row.forcedDeviceScaleFactor, spec.scaleFactor)) {
      problems.push(`${label} 的强制缩放和用例不一致`);
    }
    if (row.observedScaleFactor === null || spec.scaleFactor === null || !sameScale(row.observedScaleFactor, spec.scaleFactor)) {
      problems.push(`${label} 的实测 scaleFactor 和用例不一致`);
    }
  }
  if ((row.origin === 'system' || row.origin === 'default') && row.forcedDeviceScaleFactor !== null && row.status === 'passed') {
    problems.push(`${label} 通过时带了 Chromium 强制缩放`);
  }
  if ((row.origin === 'system' || row.origin === 'default') && row.status === 'passed' && row.scaleSource !== 'os') {
    problems.push(`${label} 通过时 scaleSource 不是 os`);
  }
  return problems;
}

function statusProblems(
  label: string,
  status: PlatformStatus,
  reason: string | null,
  evidencePath: string | null,
  evidenceRequiredWhenNotRun: boolean,
): string[] {
  const problems: string[] = [];
  if (!portable(evidencePath)) problems.push(`${label} 证据路径不是相对路径`);
  if (status === 'passed') {
    if (reason !== null) problems.push(`${label} passed 的 reason 必须是 null`);
    if (evidencePath === null || evidencePath.length === 0) problems.push(`${label} passed 没有证据`);
  } else if (reason === null || reason.length === 0) {
    problems.push(`${label} ${status} 没有原因`);
  }
  if (status === 'not-run' && evidenceRequiredWhenNotRun && (evidencePath === null || evidencePath.length === 0)) {
    problems.push(`${label} not-run 没有指向脚本或日志`);
  }
  if (status === 'failed' && (evidencePath === null || evidencePath.length === 0)) {
    problems.push(`${label} failed 没有证据`);
  }
  return problems;
}

function systemSkipReason(spec: ScaleCaseSpec, observation: ScaleObservation): string | null {
  if (spec.origin !== 'system' || spec.scaleFactor === null) return null;
  if (observation.host !== 'win32') {
    return '没有 Windows 显示缩放执行器。default 行的实测 scaleFactor 不能填到系统缩放行。';
  }
  if (observation.osScale === null) {
    return '没有读到 GetDpiForSystem，不能把 Electron 的 scaleFactor 当成系统缩放。';
  }
  if (!sameScale(observation.osScale, spec.scaleFactor)) {
    return `系统 DPI 对应 ${observation.osScale}，不是 ${spec.scaleFactor}。`;
  }
  return null;
}

function scaleFailure(spec: ScaleCaseSpec, observation: ScaleObservation): string | null {
  if (observation.error) return observation.error;
  if (spec.origin === 'simulated') {
    if (spec.scaleFactor === null || observation.forcedArg === null || !sameScale(observation.forcedArg, spec.scaleFactor)) {
      return '模拟行必须带对应的 --force-device-scale-factor';
    }
    if (observation.reportedSource !== 'simulated-chromium-flag') return `scaleSource 是 ${observation.reportedSource ?? 'null'}`;
    if (observation.reportedForced === null || !sameScale(observation.reportedForced, spec.scaleFactor)) {
      return 'Electron 没有报出同一个强制缩放';
    }
    if (observation.reportedScale === null || !sameScale(observation.reportedScale, spec.scaleFactor)) {
      return `scaleFactor ${observation.reportedScale} 不等于 ${spec.scaleFactor}`;
    }
  } else {
    if (observation.forcedArg !== null || observation.reportedForced !== null) return '系统缩放和 default 不能带 Chromium 强制缩放';
    if (observation.reportedSource !== 'os') return `scaleSource 是 ${observation.reportedSource ?? 'null'}，不是 os`;
    if (spec.origin === 'system' && spec.scaleFactor !== null) {
      if (observation.reportedScale === null || !sameScale(observation.reportedScale, spec.scaleFactor)) {
        return `Electron scaleFactor ${observation.reportedScale} 和系统 DPI 不一致`;
      }
    }
  }
  if (observation.reportedScale === null || !(observation.reportedScale > 0)) return '没有实测 scaleFactor';
  if (observation.dragOk !== true) return '拖动没有跟上指针';
  if (observation.evidencePath === null || observation.evidencePath.length === 0) return '没有证据路径';
  return null;
}

function measured(spec: ScaleCaseSpec, observation: ScaleObservation): ScaleRow {
  return {
    id: spec.id,
    origin: spec.origin,
    status: 'failed',
    reason: null,
    observedScaleFactor: observation.reportedScale,
    evidencePath: observation.evidencePath,
    forcedDeviceScaleFactor: observation.reportedForced,
    scaleSource: observation.reportedSource === 'os' || observation.reportedSource === 'simulated-chromium-flag'
      ? observation.reportedSource
      : null,
    devicePixelRatio: observation.devicePixelRatio,
  };
}

function notRunScale(spec: ScaleCaseSpec, reason: string): ScaleRow {
  return {
    id: spec.id,
    origin: spec.origin,
    status: 'not-run',
    reason,
    observedScaleFactor: null,
    evidencePath: null,
    forcedDeviceScaleFactor: null,
    scaleSource: null,
    devicePixelRatio: null,
  };
}

function specFor(id: ScaleCaseSpec['id']): ScaleCaseSpec {
  const spec = REQUIRED_SCALE_CASES.find((item) => item.id === id);
  if (!spec) throw new Error(`unknown scale case ${id}`);
  return spec;
}

function portable(evidencePath: string | null): boolean {
  if (evidencePath === null) return true;
  if (evidencePath.startsWith('/') || /^[A-Za-z]:/.test(evidencePath)) return false;
  return !evidencePath.split(/[\\/]/).includes('..');
}
