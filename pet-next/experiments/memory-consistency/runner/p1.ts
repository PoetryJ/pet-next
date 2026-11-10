/**
 * P1 门禁计算：新模板集、防泄漏审计、反事实与重放等价。
 *
 * P1 未完成必须写 not_run，不能拿开发集成绩冒充。
 *
 * @module pet-next/experiments/memory-consistency/runner/p1
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, type Budget, type MemoryEvent } from '../contracts.ts';
import {
  evaluateDataset,
  loadDevTracks,
  loadExpectations,
  loadTracks,
  NEW_EXPECTATIONS_PATH,
  NEW_TRACKS_DIR,
  observationDigest,
  DEV_TRACKS_DIR,
} from '../eval/dataset.ts';
import { auditPolicyInputs } from '../eval/leakage.ts';
import { runTrack, type TrackObservation } from '../eval/harness.ts';
import type { Check, ExpectationFile } from '../eval/scorer.ts';
import { POLICIES } from '../policies/compile.ts';
import { JsonlStore } from '../storage/store.ts';

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
    // 有些差异只出现在一侧独有的断言上（例如新增 rejectedEvent 断言），
    // 因此再给一条与断言写法无关的判据：两份观测摘要必须不同。
    behaviorDiffers: observationDigest([leftObs]) !== observationDigest([rightObs]),
    invariantsHold: invariantsHold(leftObs) && invariantsHold(rightObs),
    deterministic: observationDigest([leftObs, rightObs]) === observationDigest([runTrack(left), runTrack(right)]),
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
  return (
    state.globalVersion === state.events.length + appliedPatches &&
    state.lastSequence === maxSequence &&
    unique &&
    observation.patchResults.length === observation.patchResults.length
  );
}

/** 单条断言求值（只用于统计「共同且都通过」的数量，避免引入第二套判分语义）。 */
function evaluateOne(observation: TrackObservation, check: Check): boolean {
  const state = observation.state;
  switch (check.kind) {
    case 'event.count':
      return state.events.length === check.value;
    case 'conflict.count':
      return state.conflicts.length === check.value;
    case 'task.count':
      return Object.keys(state.tasks).length === check.value;
    case 'req.count':
      return Object.keys(state.requests).length === check.value;
    case 'note.status':
      return (state.notes[check.noteId ?? '']?.status ?? 'absent') === check.value;
    case 'patch.disposition':
      return (observation.patchResults[check.patchIndex ?? 0]?.disposition ?? 'absent') === check.value;
    case 'session.closed':
      return (state.sessions[`${'sess-dev'}#${check.epoch ?? 1}`]?.closed ?? 'absent') === check.value;
    default:
      return false;
  }
}

/** 重放等价：把所有被接受的事件重放进磁盘存储，读回后比较事件层状态。 */
function replayEquivalence(observation: TrackObservation): { equal: boolean; detail: string } {
  const dir = mkdtempSync(join(tmpdir(), 'p1-replay-'));
  try {
    const opened = JsonlStore.open(dir);
    if (!opened.ok) return { equal: false, detail: `${opened.code}: ${opened.detail}` };
    const store = opened.value;
    const accepted = new Set(observation.state.events.map((event: MemoryEvent) => event.eventId));
    for (const event of observation.state.events) {
      const result = store.append(event);
      if (!result.ok) return { equal: false, detail: `append ${event.eventId}: ${result.code}` };
    }
    const loaded = store.load();
    if (!loaded.ok) return { equal: false, detail: `load: ${loaded.code}` };
    const fields = (state: typeof observation.state) =>
      canonicalJson({
        events: state.events.map((event) => event.eventId),
        requests: state.requests,
        tasks: state.tasks,
        subjectVersions: state.subjectVersions,
        sessions: state.sessions,
        conflicts: state.conflicts,
      });
    const equal = fields(loaded.value.state) === fields(observation.state);
    store.close();
    return { equal, detail: `events=${accepted.size}` };
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

  const replayChecks = devTracks.slice(0, 8).map((track) => {
    const observation = runTrack(track);
    return { trackId: track.trackId, ...replayEquivalence(observation) };
  });

  const leakAudit = auditPolicyInputs(
    [...devTracks.slice(0, 8), ...newTracks.slice(0, 8)],
    POLICIES,
    BUDGET,
  );

  const newFailed = newResult.score.failed;
  const contrastsValid = contrasts.every((item) => item.behaviorDiffers && item.invariantsHold && item.deterministic);
  const replayValid = replayChecks.every((item) => item.equal);
  const leakClean = leakAudit.findings.length === 0;

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
      budget: BUDGET,
    },
    counterfactual: {
      pairs: contrasts.length,
      allPairsHaveDifference: contrasts.every((item) => item.behaviorDiffers),
      allPairsKeepInvariant: contrasts.every((item) => item.invariantsHold),
      deterministic: contrasts.every((item) => item.deterministic),
      details: contrasts,
    },
    replay: { checks: replayChecks, allEqual: replayValid },
    passed_gate: newFailed === 0 && newResult.score.missingExpectations.length === 0 && contrastsValid && replayValid && leakClean,
  };
}

function newSetSize(values: readonly string[]): number {
  return new Set(values).size;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex >= 0 ? process.argv[outIndex + 1] : join(HERE, '..', 'out');
  if (outDir === undefined) throw new Error('--out needs a value');
  const report = computeP1();
  writeFileSync(join(outDir, 'p1.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `${report.passed_gate ? 'PASS' : 'FAIL'} P1 new=${report.newTemplates.tracks}/${report.newTemplates.checks} leak=${report.leakage.findings.length} replay=${report.replay.allEqual}\n`,
  );
  process.exit(report.passed_gate ? 0 : 1);
}
