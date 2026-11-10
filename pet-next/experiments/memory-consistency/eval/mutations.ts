/**
 * 六种错误实现（负控）。每个都是「看似合理的 bug」，不是随机破坏。
 *
 * 判定方式：同一批冻结轨迹用错误实现重跑，期望它至少被指定反例检出；
 * 同时报告它顺带打破了哪些轨迹，避免「什么都失败」的假检出。
 *
 * @module pet-next/experiments/memory-consistency/eval/mutations
 */
import { requestKey, type MemoryState, type TaskView } from '../contracts.ts';
import type { Mutation } from './harness.ts';

/** 把某个请求视图的字段改掉，其余保持不变。 */
function patchRequest(
  state: MemoryState,
  key: string,
  change: (view: NonNullable<MemoryState['requests'][string]>) => NonNullable<MemoryState['requests'][string]>,
): MemoryState {
  const view = state.requests[key];
  if (view === undefined) return state;
  return { ...state, requests: { ...state.requests, [key]: change(view) } };
}

/** 六种负控。顺序稳定，报告按 id 排序。 */
export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'M1-generated-as-presented',
    title: '把「生成成功」当成「已呈现」',
    expectedCaughtBy: ['B1-v2'],
    afterStep(state, event) {
      if (event.kind !== 'response.generated' || event.requestId === undefined) return state;
      const key = requestKey(event.sessionId, event.sessionEpoch, event.requestId);
      return patchRequest(state, key, (view) => ({ ...view, presented: true }));
    },
  },
  {
    id: 'M2-presented-as-acknowledged',
    title: '把「软件呈现」当成「用户已确认」',
    expectedCaughtBy: ['B2-v1'],
    afterStep(state, event) {
      if (event.kind !== 'response.presented' || event.requestId === undefined) return state;
      const key = requestKey(event.sessionId, event.sessionEpoch, event.requestId);
      return patchRequest(state, key, (view) => ({ ...view, acknowledged: true }));
    },
  },
  {
    id: 'M3-request-cancel-as-task-cancel',
    title: '把单次请求取消当成长期任务撤销',
    expectedCaughtBy: ['A6-v1'],
    afterStep(state, event) {
      if (event.kind !== 'request.cancelled') return state;
      const tasks: Record<string, TaskView> = {};
      for (const [key, task] of Object.entries(state.tasks)) {
        tasks[key] = { ...task, change: 'cancelled' };
      }
      return { ...state, tasks };
    },
  },
  {
    id: 'M4-task-identity-collapse',
    title: '任务不按 taskId 分身份，按会话归并（跨任务污染）',
    expectedCaughtBy: ['A5-v1'],
    afterStep(state, event) {
      if (event.kind !== 'task.changed') return state;
      const tasks: Record<string, TaskView> = {};
      for (const task of Object.values(state.tasks)) {
        tasks[`sess|${task.sessionId}`] = { ...task };
      }
      return { ...state, tasks };
    },
  },
  {
    id: 'M5-optimistic-stale-write',
    title: '依赖校验失败仍落盘（旧补丁覆盖新状态）',
    expectedCaughtBy: ['D1-v1', 'D2-v1', 'D3-v2'],
    forceApplyOnReject: true,
  },
  {
    id: 'M6-duplicate-reapply',
    title: '重复到达的事件再次生效（不做幂等）',
    expectedCaughtBy: ['B4-v1'],
    transformEvent(event, state) {
      if (state.eventIndex[event.eventId] === undefined) return event;
      return { ...event, eventId: `${event.eventId}.dup` };
    },
  },
];

/** 按 id 取负控，找不到直接抛，避免静默跑空。 */
export function mutationById(id: string): Mutation {
  const found = MUTATIONS.find((mutation) => mutation.id === id);
  if (found === undefined) throw new Error(`unknown mutation: ${id}`);
  return found;
}
