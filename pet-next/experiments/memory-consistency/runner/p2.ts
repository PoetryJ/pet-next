/**
 * P2 门禁计算：固定规模成本比较、平台边界、未来 runner dry-run。
 *
 * P2 是条件项：平台不可用即 not_run，不临时折腾远程环境；
 * 成本比较只在维护等价成立后才允许讨论方向。
 *
 * @module pet-next/experiments/memory-consistency/runner/p2
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPlatformChecks } from '../platform/checks.ts';
import { median, runCostStudy, type CostReport, type OpMeasure } from '../studies/cost.ts';
import { cannedProvider, dryRun, loadManifest } from '../future-run/runner.ts';
import { gateMeta, isMainModule, writeGateReport } from './gate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function summarise(measures: readonly OpMeasure[], op: 'full' | 'incremental') {
  const subset = measures.filter((item) => item.op === op);
  return {
    op,
    samples: subset.length,
    medianMs: Math.round(median(subset.map((item) => item.elapsedMs)) * 100) / 100,
    medianEventsVisited: median(subset.map((item) => item.eventsVisited)),
    medianUniqueEventsTouched: median(subset.map((item) => item.uniqueEventsTouched)),
    medianIndexLookups: median(subset.map((item) => item.indexLookups)),
    medianNotesExamined: median(subset.map((item) => item.notesExamined)),
    medianNotesRebuilt: median(subset.map((item) => item.notesRebuilt)),
    medianBytesRead: median(subset.map((item) => item.bytesRead)),
    medianBytesWritten: median(subset.map((item) => item.bytesWritten)),
  };
}

export interface P2Report {
  readonly gate: 'P2';
  readonly cost: {
    readonly mechanism: CostReport['mechanism'];
    readonly scale: readonly {
      readonly size: number;
      readonly buildMs: number;
      readonly peakRssMb: number;
      readonly equivalent: boolean;
      readonly full: ReturnType<typeof summarise>;
      readonly incremental: ReturnType<typeof summarise>;
    }[];
    readonly limits: readonly string[];
    readonly equivalence: boolean;
    /** 性能/可扩展主张：本轮撤回，报告里必须原样写出。 */
    readonly speedClaimAllowed: false;
    readonly speedClaimWithdrawnReason: string;
    readonly host: { readonly node: string; readonly cpuCount: number; readonly loadAverage: readonly number[] };
  };
  readonly platform: ReturnType<typeof runPlatformChecks>;
  readonly futureRun: {
    readonly exitCode: number;
    readonly arms: number;
    readonly samples: number;
    readonly plannedOperations: number;
    readonly reservations: number;
    readonly providerAttempts: number;
    readonly perArmPlanned: Record<string, number>;
    readonly perArmReserved: Record<string, number>;
    readonly globalReserved: number;
    readonly armBudget: number;
    readonly globalBudget: number | null;
    readonly failures: number;
    readonly implicitRetries: number;
  };
  readonly passed_gate: boolean;
}

export function computeP2(): P2Report {
  const cost = runCostStudy();
  const platform = runPlatformChecks();
  const manifest = loadManifest();
  const future = dryRun(manifest, cannedProvider);

  const scale = cost.scale.map((cell) => ({
    size: cell.size,
    buildMs: cell.buildMs,
    peakRssMb: cell.peakRssMb,
    equivalent: cell.equivalent,
    full: summarise(cell.measures, 'full'),
    incremental: summarise(cell.measures, 'incremental'),
  }));

  return {
    gate: 'P2',
    cost: {
      mechanism: cost.mechanism,
      scale,
      limits: cost.limits,
      equivalence: cost.equivalence,
      speedClaimAllowed: false,
      speedClaimWithdrawnReason: cost.speedClaimWithdrawnReason,
      host: { node: cost.node, cpuCount: cost.cpuCount, loadAverage: cost.loadAverage },
    },
    platform,
    futureRun: {
      exitCode: future.exitCode,
      arms: future.arms,
      samples: future.samples,
      plannedOperations: future.plannedOperations,
      reservations: future.reservations.length,
      providerAttempts: future.providerAttempts,
      perArmPlanned: { ...future.perArmPlanned },
      perArmReserved: { ...future.perArmReserved },
      globalReserved: future.globalReserved,
      armBudget: future.armBudget,
      globalBudget: future.globalBudget,
      failures: future.failures,
      implicitRetries: future.implicitRetries,
    },
    passed_gate:
      cost.equivalence &&
      cost.mechanism.equivalent &&
      scale.every((cell) => cell.equivalent) &&
      platform.passed &&
      future.exitCode === 0 &&
      future.implicitRetries === 0 &&
      future.providerAttempts === future.attempts.length &&
      future.reservations.length === future.plannedOperations,
  };
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex >= 0 ? process.argv[outIndex + 1] : join(HERE, '..', 'out');
  if (outDir === undefined) throw new Error('--out needs a value');
  const report = computeP2();
  writeGateReport(outDir, 'p2.json', 'P2', report as unknown as Record<string, unknown>, gateMeta());
  process.stdout.write(
    `${report.passed_gate ? 'PASS' : 'FAIL'} P2 mechanism=${report.cost.mechanism.equivalent} platform=${report.platform.passed} future=plan${report.futureRun.plannedOperations}/attempts${report.futureRun.providerAttempts}/exit${report.futureRun.exitCode}\n`,
  );
  process.exit(report.passed_gate ? 0 : 1);
}
