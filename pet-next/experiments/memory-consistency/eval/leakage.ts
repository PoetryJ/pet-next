/**
 * 防泄漏审计：检查「策略实际收到的输入」而不是 meta 里的声明。
 *
 * 三道检查：
 * 1) 标签哨兵：策略可见文本里不得出现 trackId / pairId / 类别 / keyCondition / 期望字段名。
 * 2) 未来事件：策略在时刻 k 只能看到 sequence <= k 的事件，引用的 source id 也必须都在其中。
 * 3) 序列化输入本身（canonicalJson）不得夹带标签字段。
 *
 * @module pet-next/experiments/memory-consistency/eval/leakage
 */
import { canonicalJson, type Budget, type MemoryPolicy } from '../contracts.ts';
import { reduce } from '../ledger/reduce.ts';
import type { TrackFile } from './harness.ts';

/** 一条泄漏发现。空数组代表通过。 */
export interface LeakFinding {
  readonly trackId: string;
  readonly check: 'label_sentinel' | 'future_event' | 'serialized_input';
  readonly detail: string;
}

export interface LeakAuditReport {
  readonly tracks: number;
  readonly samples: number;
  readonly findings: readonly LeakFinding[];
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

  for (const track of tracks) {
    const labels = [track.trackId, track.pairId, track.keyCondition];
    const maxSequence = Math.max(0, ...track.events.map((event) => event.sequence));
    for (let openUntil = 1; openUntil <= maxSequence; openUntil += step) {
      const state = reduce(track.events, { openUntilSequence: openUntil }).state;
      const serialized = canonicalJson({ events: state.events, notes: state.notes });
      for (const policy of policies) {
        samples += 1;
        const context = policy.compile({
          state,
          events: state.events,
          query: { text: '当前进展？' },
          budget,
        });
        for (const sentinel of [...labels, ...SENTINELS]) {
          if (sentinel === '') continue;
          if (context.text.includes(sentinel)) {
            findings.push({
              trackId: track.trackId,
              check: 'label_sentinel',
              detail: `${policy.id}@${openUntil} leaked "${sentinel}"`,
            });
          }
          if (serialized.includes(sentinel)) {
            findings.push({
              trackId: track.trackId,
              check: 'serialized_input',
              detail: `input@${openUntil} contains "${sentinel}"`,
            });
          }
        }
        for (const sourceId of context.sourceIds) {
          const index = state.eventIndex[sourceId];
          if (index === undefined) {
            findings.push({
              trackId: track.trackId,
              check: 'future_event',
              detail: `${policy.id}@${openUntil} cited unknown event ${sourceId}`,
            });
            continue;
          }
          const event = state.events[index];
          if (event !== undefined && event.sequence > openUntil) {
            findings.push({
              trackId: track.trackId,
              check: 'future_event',
              detail: `${policy.id}@${openUntil} cited future event ${sourceId}@seq${event.sequence}`,
            });
          }
        }
      }
    }
  }

  return { tracks: tracks.length, samples, findings };
}
