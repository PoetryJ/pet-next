/**
 * 受控事件 reducer。纯函数：不读时钟、不读文件、不写日志。
 *
 * 回放顺序由接收 sequence 决定；墙钟只作描述。
 * 相同 eventId 同载荷重复到达无效果；同 id 不同载荷记冲突且不覆盖。
 * 生成 / 呈现 / 确认 / 工具结算各自独立，任一为真不推出其它。
 *
 * @module pet-next/experiments/memory-consistency/ledger/reduce
 */
import {
  depIdForSubject,
  emptyState,
  eventDigest,
  payloadHash,
  requestKey,
  sessionKey,
  taskKey,
  type MemoryEvent,
  type MemoryState,
  type ReduceOptions,
  type ReduceResult,
  type RequestView,
  type SessionView,
  type TaskCandidate,
  type TaskView,
  type ToolOutcome,
} from '../contracts.ts';
import { invalidateNotes } from './invalidate.ts';
import { isSettlementKind, validateEventShape } from './shape.ts';

/** 单个事件的处理结果。rejected 表示未生效，但仍可能已写入日志。 */
export interface StepOutcome {
  readonly state: MemoryState;
  readonly disposition: 'applied' | 'duplicate' | 'rejected';
  readonly reason?: string;
}

const UUID_LIKE = /^[A-Za-z0-9_.:-]+$/;

function nextVersion(state: MemoryState): number {
  return state.globalVersion + 1;
}

function bumpSubject(
  state: MemoryState,
  subjectKey: string,
): { state: MemoryState; invalidated: readonly string[] } {
  const current = state.subjectVersions[subjectKey] ?? 0;
  const next = current + 1;
  const subjectVersions = { ...state.subjectVersions, [subjectKey]: next };
  const dependents = state.dependents[depIdForSubject(subjectKey)] ?? [];
  const outcome = invalidateNotes(
    { ...state, subjectVersions },
    dependents,
    `subject_superseded:${subjectKey}@v${next}`,
  );
  return {
    state: { ...state, subjectVersions, notes: outcome.notes },
    invalidated: outcome.invalidatedNoteIds,
  };
}

function epochStatus(
  state: MemoryState,
  event: MemoryEvent,
): 'open' | 'closed' | 'jump' {
  const key = sessionKey(event.sessionId, event.sessionEpoch);
  const view = state.sessions[key];
  if (view !== undefined) return view.closed ? 'closed' : 'open';

  let maxEpoch = 0;
  for (const candidate of Object.values(state.sessions)) {
    if (candidate.sessionId === event.sessionId && candidate.sessionEpoch > maxEpoch) {
      maxEpoch = candidate.sessionEpoch;
    }
  }
  if (maxEpoch === 0) return 'open';
  return event.sessionEpoch === maxEpoch + 1 ? 'open' : 'jump';
}

function requestViewFor(state: MemoryState, event: MemoryEvent): RequestView | undefined {
  if (event.requestId === undefined) return undefined;
  return state.requests[requestKey(event.sessionId, event.sessionEpoch, event.requestId)];
}

function withRequest(
  state: MemoryState,
  event: MemoryEvent,
  patch: Partial<RequestView>,
): MemoryState {
  const requestId = event.requestId;
  if (requestId === undefined) return state;
  const key = requestKey(event.sessionId, event.sessionEpoch, requestId);
  const existing = state.requests[key];
  const base: RequestView =
    existing ?? {
      requestKey: key,
      sessionId: event.sessionId,
      sessionEpoch: event.sessionEpoch,
      requestId,
      firstSequence: event.sequence,
      lastSequence: event.sequence,
      generated: false,
      presented: false,
      acknowledged: false,
      cancelled: false,
      failed: false,
      toolOutcome: 'none',
      responseIds: [],
    };
  const next: RequestView = {
    ...base,
    ...patch,
    lastSequence: Math.max(base.lastSequence, event.sequence),
    firstSequence: Math.min(base.firstSequence, event.sequence),
  };
  return { ...state, requests: { ...state.requests, [key]: next } };
}

function reject(state: MemoryState, event: MemoryEvent, reason: string): StepOutcome {
  return { state, disposition: 'rejected', reason };
}

function applyStatement(
  state: MemoryState,
  event: MemoryEvent,
): { state: MemoryState; reason?: string } {
  const scripted = event.payload.scripted;
  if (scripted === undefined || scripted === null) return { state };
  const bumped = bumpSubject(state, scripted.subjectKey);
  return { state: bumped.state };
}

function applyTaskChange(
  state: MemoryState,
  event: MemoryEvent,
): { state: MemoryState; reason?: string } {
  const taskId = event.taskId;
  const revision = event.taskRevision;
  const change = event.payload.change;
  const authority = event.payload.authority;
  if (taskId === undefined || revision === undefined || change === undefined || authority === undefined) {
    return { state, reason: 'task_fields_missing' };
  }
  const key = taskKey(event.sessionId, taskId);
  const existing = state.tasks[key];

  if (authority === 'scripted-candidate') {
    // 候选不能凭自然语言或金标变成权威撤销，只进 candidates。
    const candidate: TaskCandidate = {
      eventId: event.eventId,
      sequence: event.sequence,
      change,
      reason: 'natural_language_candidate',
    };
    const base: TaskView =
      existing ?? {
        taskKey: key,
        taskId,
        sessionId: event.sessionId,
        revision: 0,
        change: 'created',
        authority: 'scripted-candidate',
        lastEventId: event.eventId,
        lastSequence: event.sequence,
        candidates: [],
      };
    const next: TaskView = { ...base, candidates: [...base.candidates, candidate] };
    return { state: { ...state, tasks: { ...state.tasks, [key]: next } } };
  }

  if (existing !== undefined && revision <= existing.revision) {
    return { state, reason: `stale_task_revision:${revision}<=${existing.revision}` };
  }

  const subjectKey = event.payload.subjectKey ?? `task:${taskId}`;
  const next: TaskView = {
    taskKey: key,
    taskId,
    sessionId: event.sessionId,
    revision,
    change,
    authority: 'explicit',
    lastEventId: event.eventId,
    lastSequence: event.sequence,
    subjectKey,
    candidates: existing?.candidates ?? [],
  };
  const bumped = bumpSubject(
    { ...state, tasks: { ...state.tasks, [key]: next } },
    subjectKey,
  );
  return { state: bumped.state };
}

function applyToolResult(
  state: MemoryState,
  event: MemoryEvent,
): { state: MemoryState; reason?: string } {
  const outcome = event.payload.outcome;
  if (outcome === undefined) return { state, reason: 'outcome_missing' };
  const current = requestViewFor(state, event);
  if (current !== undefined && current.toolOutcome !== 'none' && current.toolOutcome !== outcome) {
    // 同一请求的工具结算不能从 ok 翻成 error，反之亦然。
    return { state, reason: `tool_outcome_conflict:${current.toolOutcome}!=${outcome}` };
  }
  return { state: withRequest(state, event, { toolOutcome: outcome as ToolOutcome }) };
}

function applyGenerated(
  state: MemoryState,
  event: MemoryEvent,
): { state: MemoryState; reason?: string } {
  const current = requestViewFor(state, event);
  const responseIds =
    event.responseId !== undefined && !(current?.responseIds ?? []).includes(event.responseId)
      ? [...(current?.responseIds ?? []), event.responseId]
      : (current?.responseIds ?? []);
  return { state: withRequest(state, event, { generated: true, responseIds }) };
}

function applyPresented(
  state: MemoryState,
  event: MemoryEvent,
): { state: MemoryState; reason?: string } {
  const current = requestViewFor(state, event);
  const responseIds =
    event.responseId !== undefined && !(current?.responseIds ?? []).includes(event.responseId)
      ? [...(current?.responseIds ?? []), event.responseId]
      : (current?.responseIds ?? []);
  // 呈现只说明软件把它放到了某个通道，不证明用户读到。
  return { state: withRequest(state, event, { presented: true, responseIds }) };
}

function applyAcknowledged(
  state: MemoryState,
  event: MemoryEvent,
): { state: MemoryState; reason?: string } {
  // 确认只证明用户看到/关闭了这条回答，不改工具结果，也不改任务状态。
  const current = requestViewFor(state, event);
  if (current === undefined) {
    return { state, reason: 'ack_unknown_request' };
  }
  if (event.responseId !== undefined && !current.responseIds.includes(event.responseId)) {
    // 不能借用别条回答的确认来证明这条被读过。
    return { state, reason: 'ack_unknown_response' };
  }
  return { state: withRequest(state, event, { acknowledged: true }) };
}

/** 处理一条事件。调用方负责保证事件已按 sequence 排序。 */
export function stepEvent(state: MemoryState, event: MemoryEvent): StepOutcome {
  const problem = validateEventShape(event);
  if (problem !== null) return reject(state, event, `shape:${problem}`);
  if (!UUID_LIKE.test(event.eventId)) return reject(state, event, 'shape:event_id_charset');

  const existingIndex = state.eventIndex[event.eventId];
  if (existingIndex !== undefined) {
    const existing = state.events[existingIndex];
    if (existing !== undefined && payloadHash(existing) === payloadHash(event)) {
      return { state, disposition: 'duplicate' };
    }
    const conflict = {
      eventId: event.eventId,
      firstSequence: existing?.sequence ?? 0,
      secondSequence: event.sequence,
      digestFirst: existing === undefined ? '' : eventDigest(existing),
      digestSecond: eventDigest(event),
    };
    return {
      state: { ...state, conflicts: [...state.conflicts, conflict] },
      disposition: 'rejected',
      reason: 'event_id_conflict',
    };
  }

  const epoch = epochStatus(state, event);
  if (epoch === 'jump') return reject(state, event, 'epoch_jump');
  if (epoch === 'closed' && !isSettlementKind(event.kind)) {
    // 已关闭代际只允许结清在途请求，不接受新陈述/新任务事实。
    return reject(state, event, 'epoch_closed');
  }

  let next: MemoryState = state;
  let reason: string | undefined;
  switch (event.kind) {
    case 'user.statement': {
      const applied = applyStatement(next, event);
      next = applied.state;
      reason = applied.reason;
      break;
    }
    case 'task.changed': {
      const applied = applyTaskChange(next, event);
      next = applied.state;
      reason = applied.reason;
      break;
    }
    case 'tool.result': {
      const applied = applyToolResult(next, event);
      next = applied.state;
      reason = applied.reason;
      break;
    }
    case 'response.generated': {
      const applied = applyGenerated(next, event);
      next = applied.state;
      reason = applied.reason;
      break;
    }
    case 'response.presented': {
      const applied = applyPresented(next, event);
      next = applied.state;
      reason = applied.reason;
      break;
    }
    case 'user.acknowledged': {
      const applied = applyAcknowledged(next, event);
      next = applied.state;
      reason = applied.reason;
      break;
    }
    case 'request.cancelled': {
      // 单次请求取消；不碰任务，也不删跨会话偏好。
      next = withRequest(next, event, { cancelled: true, cancelEventId: event.eventId });
      break;
    }
    case 'request.failed': {
      next = withRequest(next, event, {
        failed: true,
        failReason: event.payload.reason ?? 'unspecified',
      });
      break;
    }
    case 'session.reset': {
      const key = sessionKey(event.sessionId, event.sessionEpoch);
      const base: SessionView =
        state.sessions[key] ?? {
          sessionId: event.sessionId,
          sessionEpoch: event.sessionEpoch,
          closed: false,
          eventCount: 0,
        };
      next = {
        ...next,
        sessions: {
          ...next.sessions,
          [key]: {
            ...base,
            closed: true,
            resetByEventId: event.eventId,
            resetSequence: event.sequence,
          },
        },
      };
      break;
    }
    default:
      return reject(state, event, 'kind_unhandled');
  }

  if (reason !== undefined) return reject(state, event, reason);

  // 会话计数与事件索引只在生效时推进。
  const sessionK = sessionKey(event.sessionId, event.sessionEpoch);
  const sessionBase: SessionView =
    next.sessions[sessionK] ?? {
      sessionId: event.sessionId,
      sessionEpoch: event.sessionEpoch,
      closed: false,
      eventCount: 0,
    };
  const events = [...next.events, event];
  const eventIndex = { ...next.eventIndex, [event.eventId]: events.length - 1 };
  const sessions = {
    ...next.sessions,
    [sessionK]: { ...sessionBase, eventCount: sessionBase.eventCount + 1 },
  };

  return {
    state: {
      ...next,
      events,
      eventIndex,
      sessions,
      lastSequence: Math.max(next.lastSequence, event.sequence),
      globalVersion: nextVersion(state),
    },
    disposition: 'applied',
  };
}

/** 稳定排序：先 sequence，再 observedAt，再 eventId。同一 sequence 不靠墙钟覆盖。 */
export function orderEvents(events: readonly MemoryEvent[]): readonly MemoryEvent[] {
  return [...events].sort((a, b) => {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    if (a.observedAt !== b.observedAt) return a.observedAt < b.observedAt ? -1 : 1;
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
  });
}

/**
 * 纯 reduce。openUntilSequence 用来实现「只开放到当时」的评测视角，
 * 不能让整理器看到后续更正。
 */
export function reduce(events: readonly MemoryEvent[], options: ReduceOptions = {}): ReduceResult {
  const openUntil = options.openUntilSequence ?? Number.POSITIVE_INFINITY;
  const ordered = orderEvents(events.filter((event) => event.sequence <= openUntil));
  let state = emptyState();
  const rejected: { eventId: string; reason: string }[] = [];

  for (const event of ordered) {
    const outcome = stepEvent(state, event);
    state = outcome.state;
    if (outcome.disposition === 'rejected') {
      rejected.push({ eventId: event.eventId, reason: outcome.reason ?? 'rejected' });
    }
  }

  return { state, rejectedEvents: rejected };
}
