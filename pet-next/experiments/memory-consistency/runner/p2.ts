/**
 * P2 门禁计算：固定规模成本比较、平台边界、未来 runner dry-run。
 *
 * P2 是条件项：平台不可用即 not_run，不临时折腾远程环境；
 * 成本比较只在维护等价成立后才允许讨论方向。
 *
 * @module pet-next/experiments/memory-consistency/runner/p2
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPlatformChecks } from '../platform/checks.ts';
import { median, runCostStudy, type CostReport, type OpMeasure } from '../studies/cost.ts';
import { cannedProvider, dryRun, loadManifest } from '../future-run/runner.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function summarise(measures: readonly OpMeasure[], op: 'full' | 'incremental') {
  const subset = measures.filter((item) => item.op === op);
  return {
    op,
    samples: subset.length,
    medianMs: Math.round(median(subset.map((item) => item.elapsedMs)) * 100) / 100,
    medianEventsScanned: median(subset.map((item) => item.eventsScanned)),
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
    readonly speedClaimAllowed: boolean;
    readonly host: { readonly node: string; readonly cpuCount: number; readonly loadAverage: readonly number[] };
  };
  readonly platform: ReturnType<typeof runPlatformChecks>;
  readonly futureRun: {
    readonly exitCode: number;
    readonly arms: number;
    readonly samples: number;
    readonly calls: number;
    readonly callsByKind: Record<string, number>;
    readonly reservedUtf16: number;
    readonly budgetUtf16: number;
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
      speedClaimAllowed: cost.speedClaimAllowed,
      host: { node: cost.node, cpuCount: cost.cpuCount, loadAverage: cost.loadAverage },
    },
    platform,
    futureRun: {
      exitCode: future.exitCode,
      arms: future.arms,
      samples: future.samples,
      calls: future.calls,
      callsByKind: { ...future.callsByKind },
      reservedUtf16: future.reservedUtf16,
      budgetUtf16: future.budgetUtf16,
      failures: future.failures,
      implicitRetries: future.implicitRetries,
    },
    passed_gate:
      cost.speedClaimAllowed &&
      cost.mechanism.equivalent &&
      scale.every((cell) => cell.equivalent) &&
      platform.passed &&
      future.exitCode === 0 &&
      future.implicitRetries === 0,
  };
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex >= 0 ? process.argv[outIndex + 1] : join(HERE, '..', 'out');
  if (outDir === undefined) throw new Error('--out needs a value');
  const report = computeP2();
  writeFileSync(join(outDir, 'p2.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `${report.passed_gate ? 'PASS' : 'FAIL'} P2 mechanism=${report.cost.mechanism.equivalent} platform=${report.platform.passed} future=${report.futureRun.calls}calls/${report.futureRun.exitCode}\n`,
  );
  process.exit(report.passed_gate ? 0 : 1);
}
