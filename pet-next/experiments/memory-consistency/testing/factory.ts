/**
 * 测试用事件工厂。只构造「已经是原始观察」的事件，不构造笔记、不打标签。
 * 生产代码不 import 本文件。
 *
 * @module pet-next/experiments/memory-consistency/testing/factory
 */
import {
  EVENT_SCHEMA_VERSION,
  type EventKind,
  type EventPayload,
  type EventSource,
  type MemoryEvent,
} from '../contracts.ts';

const BASE_TIME = Date.UTC(2026, 10, 10, 12, 0, 0);

export interface EventSpec {
  readonly eventId: string;
  readonly sequence: number;
  readonly kind: EventKind;
  readonly payload: EventPayload;
  readonly sessionId?: string;
  readonly sessionEpoch?: number;
  readonly source?: EventSource;
  readonly requestId?: string;
  readonly responseId?: string;
  readonly taskId?: string;
  readonly taskRevision?: number;
  readonly occurredOffsetMs?: number;
}

/** 构造一条形状合法的事件。时间由 offset 推导，保证同一 seed 下可复现。 */
export function event(spec: EventSpec): MemoryEvent {
  const offset = spec.occurredOffsetMs ?? spec.sequence * 1000;
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: spec.eventId,
    sessionId: spec.sessionId ?? 'sess-1',
    sessionEpoch: spec.sessionEpoch ?? 1,
    sequence: spec.sequence,
    occurredAt: new Date(BASE_TIME + offset).toISOString(),
    observedAt: new Date(BASE_TIME + offset + 5).toISOString(),
    source: spec.source ?? 'user',
    kind: spec.kind,
    ...(spec.requestId === undefined ? {} : { requestId: spec.requestId }),
    ...(spec.responseId === undefined ? {} : { responseId: spec.responseId }),
    ...(spec.taskId === undefined ? {} : { taskId: spec.taskId }),
    ...(spec.taskRevision === undefined ? {} : { taskRevision: spec.taskRevision }),
    payload: spec.payload,
  };
}

/** 用户陈述 + 显式标注的脚本抽取（不是模型理解）。 */
export function statement(
  seq: number,
  eventId: string,
  text: string,
  subjectKey?: string,
  valueText?: string,
): MemoryEvent {
  return event({
    eventId,
    sequence: seq,
    kind: 'user.statement',
    payload: {
      text,
      ...(subjectKey === undefined
        ? {}
        : {
            scripted: {
              subjectKey,
              valueText: valueText ?? text,
              kindHint: subjectKey.startsWith('task:') ? 'task' : 'preference',
            },
          }),
    },
  });
}

/** 生成成功入史。 */
export function generated(seq: number, eventId: string, requestId: string, responseId: string, text = '好的。'): MemoryEvent {
  return event({
    eventId,
    sequence: seq,
    kind: 'response.generated',
    source: 'model',
    requestId,
    responseId,
    payload: { text },
  });
}

/** 软件呈现。channel=unknown 表示无法确认呈现通道。 */
export function presented(
  seq: number,
  eventId: string,
  requestId: string,
  responseId: string,
  channel: 'ui' | 'api' | 'unknown' = 'ui',
): MemoryEvent {
  return event({
    eventId,
    sequence: seq,
    kind: 'response.presented',
    source: 'runtime',
    requestId,
    responseId,
    payload: { channel },
  });
}

/** 用户确认看到。 */
export function acknowledged(
  seq: number,
  eventId: string,
  requestId: string,
  responseId: string,
  ack: 'seen' | 'dismissed' = 'seen',
): MemoryEvent {
  return event({
    eventId,
    sequence: seq,
    kind: 'user.acknowledged',
    requestId,
    responseId,
    payload: { ack },
  });
}

/** 工具结算。 */
export function toolResult(
  seq: number,
  eventId: string,
  requestId: string,
  outcome: 'ok' | 'error' | 'unknown',
  toolName = 'write_file',
): MemoryEvent {
  return event({
    eventId,
    sequence: seq,
    kind: 'tool.result',
    source: 'runtime',
    requestId,
    payload: { toolName, outcome },
  });
}

/** 任务状态变化。 */
export function taskChanged(
  seq: number,
  eventId: string,
  taskId: string,
  revision: number,
  change: 'created' | 'revised' | 'cancelled' | 'completed',
  authority: 'explicit' | 'scripted-candidate' = 'explicit',
  subjectKey?: string,
): MemoryEvent {
  return event({
    eventId,
    sequence: seq,
    kind: 'task.changed',
    source: 'runtime',
    taskId,
    taskRevision: revision,
    payload: {
      change,
      authority,
      ...(subjectKey === undefined ? {} : { subjectKey }),
    },
  });
}

/** 单次请求取消。 */
export function requestCancelled(seq: number, eventId: string, requestId: string): MemoryEvent {
  return event({
    eventId,
    sequence: seq,
    kind: 'request.cancelled',
    requestId,
    payload: { reason: 'user_cancel' },
  });
}

/** 单次请求失败。 */
export function requestFailed(seq: number, eventId: string, requestId: string, reason = 'timeout'): MemoryEvent {
  return event({
    eventId,
    sequence: seq,
    kind: 'request.failed',
    requestId,
    payload: { reason },
  });
}

/** 会话代际结束。 */
export function sessionReset(seq: number, eventId: string, sessionEpoch = 1): MemoryEvent {
  return event({
    eventId,
    sequence: seq,
    kind: 'session.reset',
    sessionEpoch,
    payload: { reason: 'user_new_session' },
  });
}
