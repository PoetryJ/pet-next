/**
 * 防泄漏审计：检查「策略实际收到的输入」而不是 meta 里的声明。
 *
 * 三道检查：
 * 1) 标签哨兵：策略可见文本里不得出现 trackId / pairId / 类别 / keyCondition / 期望字段名。
 * 2) 未来事件：策略在时刻 k 只能看到 sequence <= k 的事件，引用的 source id 也必须都在其中。
 * 3) 整个 PolicyInput（canonicalJson）不得夹带标签字段。
 *
 * 修复点（R1）：状态必须来自带补丁的执行轨迹，而不是只 reduce 事件。
 * 否则 152 次采样里所有 notes 都是空的，"没泄漏" 只是因为压根没有笔记可泄漏。
 *
 * @module pet-next/experiments/memory-consistency/eval/leakage
 */
import { canonicalJson, type Budget, type MemoryPolicy } from '../contracts.ts';
import { applyPatch } from '../ledger/patch.ts';
import { fullRebuild } from '../maintenance/rebuild.ts';
import { traceTrack, type TrackFile } from './harness.ts';

/** 一条泄漏发现。空数组代表通过。 */
export interface LeakFinding {
  readonly trackId: string;
  readonly check: 'label_sentinel' | 'future_event' | 'serialized_input';
  readonly detail: string;
}

/** 单类/单策略的覆盖度。 */
export interface ScopedCoverage {
  readonly tracks: number;
  readonly samples: number;
  readonly inputsWithActiveNotes: number;
  readonly inputsWithInvalidatedNotes: number;
  readonly inputsWithNotes: number;
  readonly outputsWithSourceIds: number;
}

/** 审计覆盖度：非零才说明真的看到了笔记。 */
export interface LeakCoverage extends ScopedCoverage {
  readonly inputsWithDerivedNotes: number;
  readonly inputsWithRequests: number;
  readonly byClass: Readonly<Record<string, ScopedCoverage>>;
  readonly byPolicy: Readonly<Record<string, ScopedCoverage>>;
  readonly requiredClasses: readonly string[];
  readonly missingClasses: readonly string[];
}

/** 四类行为 + 派生依赖必须都被真实覆盖。 */
export const REQUIRED_LEAK_CLASSES = [
  'state-update',
  'generation-presentation',
  'tool-result',
  'stale-patch',
  'dependency-graph',
] as const;

function emptyScoped(): { tracks: number; samples: number; inputsWithActiveNotes: number; inputsWithInvalidatedNotes: number; inputsWithNotes: number; outputsWithSourceIds: number } {
  return { tracks: 0, samples: 0, inputsWithActiveNotes: 0, inputsWithInvalidatedNotes: 0, inputsWithNotes: 0, outputsWithSourceIds: 0 };
}

export interface LeakAuditReport {
  readonly tracks: number;
  readonly samples: number;
  readonly findings: readonly LeakFinding[];
  readonly coverage?: LeakCoverage;
}

const SENTINELS = ['pairId', 'keyCondition', 'expected', 'assertions', 'state-update', 'generation-presentation', 'tool-result', 'stale-patch'];

/**
 * 逐轨迹、逐时刻检查四种策略的输入与输出。
 * step 控制采样密度：默认每个事件边界都查一次。
 */
export function auditPolicyInputs(
  tracks: readonly TrackFile[],
  policies: readonly MemoryPolicy[],
  budget: Budget,
  step = 1,
): LeakAuditReport {
  const findings: LeakFinding[] = [];
  let samples = 0;
  const byClass: Record<string, ReturnType<typeof emptyScoped>> = {};
  const byPolicy: Record<string, ReturnType<typeof emptyScoped>> = {};
  for (const policy of policies) byPolicy[policy.id] = emptyScoped();
  const coverage = {
    tracks: 0,
    samples: 0,
    inputsWithActiveNotes: 0,
    inputsWithInvalidatedNotes: 0,
    inputsWithDerivedNotes: 0,
    inputsWithNotes: 0,
    inputsWithRequests: 0,
    outputsWithSourceIds: 0,
    totalInputs: 0,
  };

  for (const track of tracks) {
    const labels = [track.trackId, track.pairId, track.keyCondition];
    const trackClass = track.class;
    const scoped = byClass[trackClass] ?? emptyScoped();
    byClass[trackClass] = scoped;
    scoped.tracks += 1;
    coverage.tracks += 1;
    const trace = traceTrack(track);
    const stride = Math.max(1, step);
    let lastSampled = 0;
    for (const traceStep of trace.steps) {
      if (lastSampled !== 0 && traceStep.sequence - lastSampled < stride) continue;
      lastSampled = traceStep.sequence;
      // 每个 trace 边界都查两相：原始状态 + 一轮整理后的状态。
      // 生成/呈现/工具结果这几类轨迹本身没有补丁，只有整理后才会出现笔记；
      // 两相都查既覆盖真实边界，也不会把「没有笔记」说成覆盖。
      const consolidated = applyPatch(
        traceStep.state,
        fullRebuild(traceStep.state, `op-audit-${traceStep.sequence}`).patch,
      ).state;
      const phases: readonly { phase: 'raw' | 'consolidated'; state: typeof traceStep.state }[] = [
        { phase: 'raw', state: traceStep.state },
        { phase: 'consolidated', state: consolidated },
      ];
      for (const { state } of phases) {
      const notes = Object.values(state.notes);
      const hasActive = notes.some((note) => note.status === 'active');
      const hasInvalidated = notes.some((note) => note.status === 'invalidated');
      const hasNotes = notes.length > 0;
      const hasDerived = notes.some((note) => note.parentNoteIds.length > 0);
      const hasRequests = Object.keys(state.requests).length > 0;
      coverage.samples += 1;
      scoped.samples += 1;
      if (hasActive) { coverage.inputsWithActiveNotes += 1; scoped.inputsWithActiveNotes += 1; }
      if (hasInvalidated) { coverage.inputsWithInvalidatedNotes += 1; scoped.inputsWithInvalidatedNotes += 1; }
      if (hasNotes) { coverage.inputsWithNotes += 1; scoped.inputsWithNotes += 1; }
      if (hasDerived) coverage.inputsWithDerivedNotes += 1;
      if (hasRequests) coverage.inputsWithRequests += 1;

      for (const policy of policies) {
        samples += 1;
        coverage.totalInputs += 1;
        const input = { state, events: state.events, query: { text: '当前进展？' }, budget };
        const context = policy.compile(input);
        const policyScoped = byPolicy[policy.id] ?? emptyScoped();
        byPolicy[policy.id] = policyScoped;
        policyScoped.samples += 1;
        if (context.sourceIds.length > 0) {
          coverage.outputsWithSourceIds += 1;
          scoped.outputsWithSourceIds += 1;
          policyScoped.outputsWithSourceIds += 1;
        }
        if (hasNotes) policyScoped.inputsWithNotes += 1;
        if (hasActive) policyScoped.inputsWithActiveNotes += 1;
        if (hasInvalidated) policyScoped.inputsWithInvalidatedNotes += 1;
        const serialized = canonicalJson(input);
        for (const sentinel of [...labels, ...SENTINELS]) {
          if (sentinel === '') continue;
          if (context.text.includes(sentinel)) {
            findings.push({
              trackId: track.trackId,
              check: 'label_sentinel',
              detail: `${policy.id}@${traceStep.sequence} leaked "${sentinel}"`,
            });
          }
          if (serialized.includes(sentinel)) {
            findings.push({
              trackId: track.trackId,
              check: 'serialized_input',
              detail: `${policy.id} input@${traceStep.sequence} contains "${sentinel}"`,
            });
          }
        }
        for (const sourceId of context.sourceIds) {
          const index = state.eventIndex[sourceId];
          if (index === undefined) {
            findings.push({
              trackId: track.trackId,
              check: 'future_event',
              detail: `${policy.id}@${traceStep.sequence} cited unknown event ${sourceId}`,
            });
            continue;
          }
          const event = state.events[index];
          if (event !== undefined && event.sequence > traceStep.sequence) {
            findings.push({
              trackId: track.trackId,
              check: 'future_event',
              detail: `${policy.id}@${traceStep.sequence} cited future event ${sourceId}@seq${event.sequence}`,
            });
          }
        }
      }
      }
    }
  }

  const missingClasses = REQUIRED_LEAK_CLASSES.filter((name) => {
    const scoped = byClass[name];
    return scoped === undefined || scoped.samples === 0 || scoped.inputsWithNotes === 0 || scoped.outputsWithSourceIds === 0;
  });

  return {
    tracks: tracks.length,
    samples,
    findings,
    coverage: {
      ...coverage,
      byClass,
      byPolicy,
      requiredClasses: [...REQUIRED_LEAK_CLASSES],
      missingClasses,
    },
  };
}
