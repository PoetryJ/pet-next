/**
 * P1 门禁计算：新模板集、防泄漏审计、反事实与重放等价。
 *
 * P1 未完成必须写 not_run，不能拿开发集成绩冒充。
 *
 * @module pet-next/experiments/memory-consistency/runner/p1
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, type Budget } from '../contracts.ts';
import {
  evaluateDataset,
  loadDevTracks,
  loadExpectations,
  loadTracks,
  DERIVED_TRACKS_DIR,
  NEW_EXPECTATIONS_PATH,
  NEW_TRACKS_DIR,
  DEV_TRACKS_DIR,
} from '../eval/dataset.ts';
import { auditPolicyInputs } from '../eval/leakage.ts';
import {
  behaviorDigest,
  replayThroughStore,
  runTrack,
  type TrackObservation,
} from '../eval/harness.ts';
import type { Check, ExpectationFile } from '../eval/scorer.ts';
import { POLICIES } from '../policies/compile.ts';
import { JsonlStore } from '../storage/store.ts';
import { gateMeta, isMainModule, writeGateReport } from './gate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUDGET: Budget = { utf16Units: 2000, utf8Bytes: 6000 };

/** 反事实：同一对里只改关键事件。这里检查差异存在且不整体翻车。 */
interface PairContrast {
  readonly pairId: string;
  readonly differingChecks: readonly string[];
  readonly behaviorDiffers: boolean;
  readonly invariantsHold: boolean;
  readonly deterministic: boolean;
}

function checkKey(check: Check): string {
  return [check.kind, check.noteId ?? '', check.taskId ?? '', check.requestId ?? '', check.flag ?? '', String(check.patchIndex ?? ''), String(check.index ?? ''), check.subjectKey ?? ''].join('|');
}

function contrastPair(
  pairTracks: readonly ReturnType<typeof loadDevTracks>[number][],
  observations: ReadonlyMap<string, TrackObservation>,
  expectations: ExpectationFile,
): PairContrast {
  const [left, right] = pairTracks;
  if (left === undefined || right === undefined) throw new Error('pair needs two tracks');
  const leftExpect = expectations.assertions[left.trackId];
  const rightExpect = expectations.assertions[right.trackId];
  if (leftExpect === undefined || rightExpect === undefined) throw new Error(`missing expectations for ${left.trackId}`);
  const leftObs = observations.get(left.trackId);
  const rightObs = observations.get(right.trackId);
  if (leftObs === undefined || rightObs === undefined) throw new Error('missing observation');

  const leftChecks = leftExpect.checks.map((check) => ({ key: checkKey(check), check }));
  const rightChecks = new Map(rightExpect.checks.map((check) => [checkKey(check), check]));
  const differing: string[] = [];

  for (const item of leftChecks) {
    const other = rightChecks.get(item.key);
    if (other === undefined) continue;
    if (JSON.stringify(item.check.value) !== JSON.stringify(other.value)) {
      differing.push(item.key);
    }
  }

  return {
    pairId: left.pairId,
    differingChecks: differing,
    // 只比行为，不比名字：同内容换 trackId 不得算差异。
    behaviorDiffers: behaviorDigest([leftObs]) !== behaviorDigest([rightObs]),
    invariantsHold: invariantsHold(leftObs) && invariantsHold(rightObs),
    deterministic: behaviorDigest([leftObs, rightObs]) === behaviorDigest([runTrack(left), runTrack(right)]),
  };
}

/**
 * 与具体翻转无关的不变量：版本计数、序列单调、事件唯一、补丁都有结论。
 * 这些在配对两侧都必须成立——否则「差异」可能只是实现崩了。
 */
function invariantsHold(observation: TrackObservation): boolean {
  const state = observation.state;
  const appliedPatches = observation.patchResults.filter((item) => item.disposition === 'applied').length;
  const ids = state.events.map((event) => event.eventId);
  const unique = new Set(ids).size === ids.length;
  const maxSequence = Math.max(0, ...state.events.map((event) => event.sequence));
  const dispositionsValid = observation.patchResults.every(
    (item) => item.disposition === 'applied' || item.disposition === 'replayed' || item.disposition === 'rejected',
  );
  const appliedConsistent = appliedPatches === Object.keys(state.appliedOps).length;
  return (
    state.globalVersion === state.events.length + appliedPatches &&
    state.lastSequence === maxSequence &&
    unique &&
    dispositionsValid &&
    appliedConsistent
  );
}

/**
 * 重放等价：事件 + 已接受补丁一起写入 store，close 后开新实例恢复，
 * 与直接运行的终态逐字段比较（含笔记、版本、依赖、补丁结论）。
 */
function replayEquivalence(track: ReturnType<typeof loadDevTracks>[number]) {
  const result = replayThroughStore(track);
  return { trackId: track.trackId, equal: result.ok && result.equal, detail: result.error ?? result.detail };
}

/** 负控：只存事件的实现必须被判不等，否则重放检查就是空的。 */
function eventOnlyNegativeControl(track: ReturnType<typeof loadDevTracks>[number]): { trackId: string; detected: boolean; detail: string } {
  const observation = runTrack(track);
  const dir = mkdtempSync(join(tmpdir(), 'p1-negative-'));
  try {
    const opened = JsonlStore.open(dir);
    if (!opened.ok) return { trackId: track.trackId, detected: false, detail: opened.detail };
    for (const event of observation.state.events) opened.value.append(event);
    const restored = opened.value.getState();
    opened.value.close();
    const detected = canonicalJson(restored) !== canonicalJson(observation.state);
    return {
      trackId: track.trackId,
      detected,
      detail: `notes direct=${Object.keys(observation.state.notes).length} restored=${Object.keys(restored.notes).length}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function computeP1() {
  const newTracks = loadTracks(NEW_TRACKS_DIR);
  const newExpectations = loadExpectations(NEW_EXPECTATIONS_PATH);
  const newResult = evaluateDataset(newTracks, newExpectations);

  const devTracks = loadDevTracks(DEV_TRACKS_DIR);
  const devExpectations = loadExpectations();
  const devResult = evaluateDataset(devTracks, devExpectations);
  const observations = new Map(devResult.observations.map((item) => [item.trackId, item]));

  const byPair = new Map<string, typeof devTracks>();
  for (const track of devTracks) {
    const list = byPair.get(track.pairId) ?? [];
    list.push(track);
    byPair.set(track.pairId, list);
  }
  const contrasts = [...byPair.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, pair]) => contrastPair(pair, observations, devExpectations));

  const replayChecks = devTracks.map((track) => replayEquivalence(track));
  const negativeControls = ['A1-v1', 'A1-v2', 'A5-v1']
    .map((trackId) => devTracks.find((track) => track.trackId === trackId))
    .filter((track): track is NonNullable<typeof track> => track !== undefined)
    .map((track) => eventOnlyNegativeControl(track));

  const leakAudit = auditPolicyInputs(
    [...devTracks.slice(0, 8), ...newTracks.slice(0, 8), ...loadTracks(DERIVED_TRACKS_DIR)],
    POLICIES,
    BUDGET,
  );

  const newFailed = newResult.score.failed;
  const contrastsValid = contrasts.every((item) => item.behaviorDiffers && item.invariantsHold && item.deterministic);
  const replayValid = replayChecks.every((item) => item.equal);
  const negativeValid = negativeControls.every((item) => item.detected);
  const leakClean = leakAudit.findings.length === 0;
  const coverage = leakAudit.coverage;
  const leakCoverageValid =
    coverage !== undefined &&
    coverage.inputsWithActiveNotes > 0 &&
    coverage.inputsWithInvalidatedNotes > 0 &&
    coverage.inputsWithDerivedNotes > 0 &&
    coverage.outputsWithSourceIds > 0;

  return {
    gate: 'P1',
    newTemplates: {
      tracks: newResult.score.tracks,
      checks: newResult.score.checks,
      passed: newResult.score.passed,
      failed: newFailed,
      failedTracks: newResult.score.trackFailures.map((item) => item.trackId),
      missingExpectations: newResult.score.missingExpectations,
      testSamples: newSetSize(newTracks.map((track) => track.pairId)),
      note: '新模板验证不是不可见语义能力测试；同一批轨迹在开发期被看过即算暴露。',
    },
    leakage: {
      tracks: leakAudit.tracks,
      samples: leakAudit.samples,
      findings: leakAudit.findings,
      coverage,
      budget: BUDGET,
      note: '状态来自带补丁的执行轨迹；coverage 全为 0 时说明审计没看到笔记，不能算通过。',
    },
    counterfactual: {
      pairs: contrasts.length,
      allPairsHaveDifference: contrasts.every((item) => item.behaviorDiffers),
      allPairsKeepInvariant: contrasts.every((item) => item.invariantsHold),
      deterministic: contrasts.every((item) => item.deterministic),
      details: contrasts,
    },
    replay: { checks: replayChecks, allEqual: replayValid, negativeControls, allNegativeDetected: negativeValid 
    },
    passed_gate:
      newFailed === 0 &&
      newResult.score.missingExpectations.length === 0 &&
      contrastsValid &&
      replayValid &&
      negativeValid &&
      leakClean &&
      leakCoverageValid,
  };
}

function newSetSize(values: readonly string[]): number {
  return new Set(values).size;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex >= 0 ? process.argv[outIndex + 1] : join(HERE, '..', 'out');
  if (outDir === undefined) throw new Error('--out needs a value');
  const report = computeP1();
  writeGateReport(outDir, 'p1.json', 'P1', report as unknown as Record<string, unknown>, gateMeta());
  process.stdout.write(
    `${report.passed_gate ? 'PASS' : 'FAIL'} P1 new=${report.newTemplates.tracks}/${report.newTemplates.checks} leak=${report.leakage.findings.length} replay=${report.replay.allEqual}\n`,
  );
  process.exit(report.passed_gate ? 0 : 1);
}
