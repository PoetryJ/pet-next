/**
 * 平台实测入口。Linux 上直接跑；Windows 由 verify-windows.ps1 调用。
 * 退出码 0 只表示没有失败行。`incomplete` 里的 not-run 不是通过。
 * @module pet-next/tests/platform/run-platform
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { REQUIRED_PLATFORM_FLOWS, REQUIRED_PROCESS_CASES, REQUIRED_SCALE_CASES } from '../../contracts/index.ts';
import { runElectronFlows } from './electron-run.ts';
import {
  auditReport,
  flowRow,
  scaleRowFromObservation,
  verdictOf,
  windowsFlowsNotRun,
  windowsProcessesNotRun,
  type FlowRow,
  type PlatformReport,
  type ScaleObservation,
} from './matrix.ts';
import { runLinuxProcessCases } from './process-cases.ts';
import { petRoot } from './session.ts';

const MATRIX = process.env.PET_NEXT_PLATFORM_MATRIX ?? 'tests/platform/evidence/matrix.json';

async function main(): Promise<number> {
  const host = process.platform;
  const os = readOsScale(host);
  const executedHere = host === 'linux' || host === 'win32';
  const processes = executedHere ? await runLinuxProcessCases() : [];
  const electron = executedHere ? await runElectronFlows(host, os.osScale) : null;
  const flows = [
    ...(electron?.flows ?? []),
    ...(host === 'win32' ? linuxFlowsNotRun() : windowsFlowsNotRun()),
    ...(host === 'linux' || host === 'win32' ? [] : windowsFlowsNotRun()),
  ];
  const processRows = [
    ...processes,
    ...(host === 'win32' ? linuxProcessesNotRun() : windowsProcessesNotRun()),
  ];
  const scales = scaleRows(electron?.defaultScale ?? null, electron?.simulated ?? [], host, os.osScale);
  const report: PlatformReport = {
    verdict: 'incomplete',
    host,
    generatedAt: new Date().toISOString(),
    osScale: os.osScale,
    osScaleSource: os.source,
    flows,
    processes: processRows,
    scales,
  };
  report.verdict = verdictOf([
    ...report.flows.map((row) => row.status),
    ...report.processes.map((row) => row.status),
    ...report.scales.map((row) => row.status),
  ]);
  const target = path.join(petRoot(), MATRIX);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
  printReport(report, MATRIX);
  const problems = auditReport(report);
  for (const problem of problems) console.error(`audit: ${problem}`);
  if (problems.length > 0 || report.verdict === 'failed') return 1;
  return 0;
}

function scaleRows(
  baseline: ScaleObservation | null,
  simulated: readonly ScaleObservation[],
  host: NodeJS.Platform,
  osScale: number | null,
): PlatformReport['scales'] {
  const byId = new Map<ScaleObservation['id'], ScaleObservation>();
  if (baseline) byId.set(baseline.id, baseline);
  for (const row of simulated) byId.set(row.id, row);
  if (baseline) {
    for (const id of ['system-100', 'system-125', 'system-150'] as const) {
      byId.set(id, { ...baseline, id, forcedArg: null });
    }
  }
  return REQUIRED_SCALE_CASES.map((spec) => {
    const found = byId.get(spec.id);
    if (!found) {
      return scaleRowFromObservation({
        id: spec.id,
        host,
        osScale,
        forcedArg: null,
        reportedForced: null,
        reportedSource: null,
        reportedScale: null,
        devicePixelRatio: null,
        dragOk: null,
        evidencePath: null,
        error: '这次主机没有跑 Electron',
      });
    }
    return scaleRowFromObservation(found);
  });
}

function linuxFlowsNotRun(): FlowRow[] {
  return REQUIRED_PLATFORM_FLOWS.map((flow) =>
    flowRow(flow, 'linux', 'not-run', '这次在 Windows 上执行，没有同时跑 Linux。', 'tests/platform/run-platform.ts'),
  );
}

function linuxProcessesNotRun(): PlatformReport['processes'] {
  return REQUIRED_PROCESS_CASES.map((caseId) => ({
    platform: 'linux' as const,
    caseId,
    status: 'not-run' as const,
    reason: '这次在 Windows 上执行，没有同时跑 Linux。',
    command: 'node --experimental-strip-types tests/platform/run-platform.ts',
    exitCode: null,
    evidencePath: 'tests/platform/run-platform.ts',
  }));
}

function readOsScale(host: NodeJS.Platform): { osScale: number | null; source: string | null } {
  if (host !== 'win32') return { osScale: null, source: null };
  const text = process.env.PET_NEXT_OS_SCALE;
  const source = process.env.PET_NEXT_OS_SCALE_SOURCE ?? null;
  if (!text) return { osScale: null, source };
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return { osScale: null, source };
  return { osScale: value, source };
}

function printReport(report: PlatformReport, matrixPath: string): void {
  console.log(`verdict: ${report.verdict}`);
  console.log(`matrix: ${matrixPath}`);
  for (const row of report.flows) {
    console.log(`${row.status}\tflow\t${row.platform}/${row.flow}\t${row.evidencePath ?? '-'}\t${row.reason ?? ''}`);
  }
  for (const row of report.processes) {
    console.log(`${row.status}\tprocess\t${row.platform}/${row.caseId}\t${row.evidencePath}\t${row.reason ?? ''}`);
  }
  for (const row of report.scales) {
    console.log(
      `${row.status}\tscale\t${row.id}\t${row.origin}\tobserved=${row.observedScaleFactor ?? 'null'}\t${row.evidencePath ?? '-'}\t${row.reason ?? ''}`,
    );
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exitCode = 1;
    },
  );
}
