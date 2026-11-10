/**
 * 独立评分器。只读「期望断言」与「观测」，不 import reducer 的内部状态形状做判据。
 *
 * 断言值来自 eval/expected/*.json（在跑通流水线之前写死）。
 * 评分器不修正期望，也不把未覆盖的断言算成通过。
 *
 * @module pet-next/experiments/memory-consistency/eval/scorer
 */
import { requestKey, sessionKey, taskKey, type MemoryState } from '../contracts.ts';
import type { TrackObservation } from './harness.ts';

/** 一条断言。字段按 kind 取用，缺字段按「断言本身不合法」计失败。 */
export interface Check {
  readonly kind: string;
  readonly noteId?: string;
  readonly taskId?: string;
  readonly requestId?: string;
  readonly epoch?: number;
  readonly flag?: 'generated' | 'presented' | 'acknowledged' | 'cancelled' | 'failed';
  readonly patchIndex?: number;
  readonly index?: number;
  readonly subjectKey?: string;
  readonly value?: unknown;
}

/** 单条断言的求值结果。 */
export interface CheckResult {
  readonly ok: boolean;
  readonly kind: string;
  readonly label: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/** 一条轨迹的全部断言结果。 */
export interface TrackScore {
  readonly trackId: string;
  readonly why: string;
  readonly checks: readonly CheckResult[];
  readonly failed: number;
}

/** 整个数据集的结果。 */
export interface DatasetScore {
  readonly tracks: number;
  readonly checks: number;
  readonly passed: number;
  readonly failed: number;
  readonly trackFailures: readonly TrackScore[];
  readonly missingExpectations: readonly string[];
  readonly orphanExpectations: readonly string[];
}

/** 期望文件结构。 */
export interface ExpectationFile {
  readonly schemaVersion: string;
  readonly dataset: string;
  readonly writtenBeforePipelineRun: boolean;
  readonly assertions: Readonly<Record<string, { readonly why: string; readonly checks: readonly Check[] }>>;
}

const SESSION = 'sess-dev';

function noteOf(state: MemoryState, noteId: string) {
  return state.notes[noteId];
}

function evaluate(state: MemoryState, observation: TrackObservation, check: Check): CheckResult {
  const label = describe(check);
  const ok = (actual: unknown): CheckResult => ({
    ok: JSON.stringify(actual) === JSON.stringify(check.value),
    kind: check.kind,
    label,
    expected: check.value,
    actual,
  });

  switch (check.kind) {
    case 'note.status':
      return ok(noteOf(state, check.noteId ?? '')?.status ?? 'absent');
    case 'note.version':
      return ok(noteOf(state, check.noteId ?? '')?.version ?? 'absent');
    case 'note.text':
      return ok(noteOf(state, check.noteId ?? '')?.text ?? 'absent');
    case 'task.change':
      return ok(state.tasks[taskKey(SESSION, check.taskId ?? '')]?.change ?? 'absent');
    case 'task.revision':
      return ok(state.tasks[taskKey(SESSION, check.taskId ?? '')]?.revision ?? 'absent');
    case 'task.candidateCount':
      return ok(state.tasks[taskKey(SESSION, check.taskId ?? '')]?.candidates.length ?? 'absent');
    case 'task.count':
      return ok(Object.keys(state.tasks).length);
    case 'req.flag': {
      const view = state.requests[requestKey(SESSION, check.epoch ?? 1, check.requestId ?? '')];
      const flag = check.flag ?? 'generated';
      return ok(view === undefined ? 'absent' : view[flag]);
    }
    case 'req.toolOutcome': {
      const view = state.requests[requestKey(SESSION, check.epoch ?? 1, check.requestId ?? '')];
      return ok(view?.toolOutcome ?? 'absent');
    }
    case 'req.responseCount': {
      const view = state.requests[requestKey(SESSION, check.epoch ?? 1, check.requestId ?? '')];
      return ok(view?.responseIds.length ?? 'absent');
    }
    case 'req.count':
      return ok(Object.keys(state.requests).length);
    case 'session.closed':
      return ok(state.sessions[sessionKey(SESSION, check.epoch ?? 1)]?.closed ?? 'absent');
    case 'subject.version':
      return ok(state.subjectVersions[check.subjectKey ?? ''] ?? 'absent');
    case 'subject.absent':
      return ok(check.subjectKey !== undefined && state.subjectVersions[check.subjectKey] === undefined ? 'absent' : 'present');
    case 'event.count':
      return ok(state.events.length);
    case 'conflict.count':
      return ok(state.conflicts.length);
    case 'patch.disposition':
      return ok(observation.patchResults[check.patchIndex ?? 0]?.disposition ?? 'absent');
    case 'patch.code':
      return ok(observation.patchResults[check.patchIndex ?? 0]?.code ?? 'absent');
    case 'rejectedEvent.reason':
      return ok(observation.rejectedEvents[check.index ?? 0]?.reason ?? 'absent');
    case 'rejectedEvent.reasonPrefix': {
      const reason = observation.rejectedEvents[check.index ?? 0]?.reason;
      const expected = String(check.value ?? '');
      return {
        ok: reason !== undefined && reason.startsWith(expected),
        kind: check.kind,
        label,
        expected: `${expected}*`,
        actual: reason ?? 'absent',
      };
    }
    default:
      return { ok: false, kind: check.kind, label, expected: check.value, actual: 'unknown_check_kind' };
  }
}

function describe(check: Check): string {
  const parts = [check.kind];
  if (check.noteId !== undefined) parts.push(`note=${check.noteId}`);
  if (check.taskId !== undefined) parts.push(`task=${check.taskId}`);
  if (check.requestId !== undefined) parts.push(`req=${check.requestId}@${check.epoch ?? 1}`);
  if (check.flag !== undefined) parts.push(`flag=${check.flag}`);
  if (check.patchIndex !== undefined) parts.push(`patch#${check.patchIndex}`);
  if (check.index !== undefined) parts.push(`rejected#${check.index}`);
  if (check.subjectKey !== undefined) parts.push(`subject=${check.subjectKey}`);
  return parts.join(' ');
}

/** 对一条轨迹求值。 */
export function scoreTrack(
  observation: TrackObservation,
  expectation: { readonly why: string; readonly checks: readonly Check[] },
): TrackScore {
  const checks = expectation.checks.map((check) => evaluate(observation.state, observation, check));
  return {
    trackId: observation.trackId,
    why: expectation.why,
    checks,
    failed: checks.filter((result) => !result.ok).length,
  };
}

/**
 * 对整个数据集求值。期望集与观测集必须一一对应：
 * 缺期望或多余期望都要显式报出来，不能只看通过率。
 */
export function scoreDataset(
  observations: readonly TrackObservation[],
  expectations: ExpectationFile,
): DatasetScore {
  const observed = new Map(observations.map((item) => [item.trackId, item]));
  const expectedIds = Object.keys(expectations.assertions);
  const missingExpectations = observations
    .map((item) => item.trackId)
    .filter((trackId) => expectations.assertions[trackId] === undefined);
  const orphanExpectations = expectedIds.filter((trackId) => !observed.has(trackId));

  const trackFailures: TrackScore[] = [];
  let checks = 0;
  let failed = 0;
  for (const observation of observations) {
    const expectation = expectations.assertions[observation.trackId];
    if (expectation === undefined) continue;
    const score = scoreTrack(observation, expectation);
    checks += score.checks.length;
    failed += score.failed;
    if (score.failed > 0) trackFailures.push(score);
  }

  return {
    tracks: observations.length,
    checks,
    passed: checks - failed,
    failed,
    trackFailures,
    missingExpectations,
    orphanExpectations,
  };
}
