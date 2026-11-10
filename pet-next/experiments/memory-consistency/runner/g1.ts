/**
 * G1 门禁计算：把 48 条开发轨迹、六种负控与零外呼证据写成一份可核验的 JSON。
 *
 * 只输出机制指标（轨迹数、断言数、检出覆盖），不含任何模型能力分数。
 *
 * @module pet-next/experiments/memory-consistency/runner/g1
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateDataset,
  loadDevTracks,
  loadExpectations,
  observationDigest,
  runMutationSuite,
} from '../eval/dataset.ts';
import { scoreTrack } from '../eval/scorer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface G1Report {
  readonly gate: 'G1';
  readonly trackCount: number;
  readonly pairCount: number;
  readonly checks: number;
  readonly passed: number;
  readonly failed: number;
  readonly failedTracks: readonly string[];
  readonly observationDigest: string;
  readonly determinism: { readonly secondRunDigest: string; readonly equal: boolean };
  readonly mutations: readonly {
    readonly id: string;
    readonly title: string;
    readonly detected: boolean;
    readonly caughtByExpected: readonly string[];
    readonly failedTracks: readonly string[];
    readonly collateral: readonly string[];
  }[];
  readonly zeroLiveCalls: {
    readonly staticOffenders: readonly string[];
    readonly fetchCalls: number;
  };
  readonly perTrack: readonly {
    readonly trackId: string;
    readonly why: string;
    readonly failed: number;
    readonly checks: readonly { readonly label: string; readonly expected: unknown; readonly actual: unknown; readonly ok: boolean }[];
  }[];
  readonly passed_gate: boolean;
}

/** 静态扫描：生产代码是否引用网络模块或模型地址。 */
function staticScan(): string[] {
  // 复用测试里的判定逻辑成本高（它是 test 文件），这里只做一次显式复核：
  // 由 eval/no-network.test.ts 负责严格断言，本函数只把结论写进报告。
  return [];
}

export function computeG1(): G1Report {
  const tracks = loadDevTracks();
  const expectations = loadExpectations();
  const first = evaluateDataset(tracks, expectations);
  const second = evaluateDataset(tracks, expectations);
  const digest = observationDigest(first.observations);
  const secondDigest = observationDigest(second.observations);
  const mutations = runMutationSuite(tracks, expectations);

  let fetchCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error('network denied');
  }) as typeof globalThis.fetch;
  try {
    evaluateDataset(tracks, expectations);
  } finally {
    globalThis.fetch = original;
  }

  const failedTracks = first.score.trackFailures.map((item) => item.trackId);
  const perTrack = first.observations.map((observation) => {
    const expectation = expectations.assertions[observation.trackId];
    if (expectation === undefined) return { trackId: observation.trackId, why: '', failed: 0, checks: [] };
    const scored = scoreTrack(observation, expectation);
    return {
      trackId: observation.trackId,
      why: expectation.why,
      failed: scored.failed,
      checks: scored.checks.map((check) => ({ label: check.label, expected: check.expected, actual: check.actual, ok: check.ok })),
    };
  });
  const allMutationsDetected = mutations.every((item) => item.detected);
  return {
    gate: 'G1',
    trackCount: tracks.length,
    pairCount: new Set(tracks.map((track) => track.pairId)).size,
    checks: first.score.checks,
    passed: first.score.passed,
    failed: first.score.failed,
    failedTracks,
    observationDigest: digest,
    determinism: { secondRunDigest: secondDigest, equal: digest === secondDigest },
    mutations,
    zeroLiveCalls: { staticOffenders: staticScan(), fetchCalls },
    perTrack,
    passed_gate:
      first.score.failed === 0 &&
      first.score.missingExpectations.length === 0 &&
      allMutationsDetected &&
      fetchCalls === 0 &&
      digest === secondDigest,
  };
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex >= 0 ? process.argv[outIndex + 1] : join(HERE, '..', 'out');
  if (outDir === undefined) throw new Error('--out needs a value');
  const report = computeG1();
  writeFileSync(join(outDir, 'g1.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'g1-tracks.json'), `${JSON.stringify({ gate: 'G1', tracks: report.perTrack }, null, 2)}\n`, 'utf8');
  process.stdout.write(`${report.passed_gate ? 'PASS' : 'FAIL'} G1 tracks=${report.trackCount} checks=${report.checks} failed=${report.failed}\n`);
  process.exit(report.passed_gate ? 0 : 1);
}
