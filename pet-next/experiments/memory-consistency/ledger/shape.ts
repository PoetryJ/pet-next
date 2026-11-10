/**
 * 事件形状守卫。只做「这条原始事件能不能进入权威状态」的结构检查，
 * 不解释语义，也不看笔记。
 *
 * @module pet-next/experiments/memory-consistency/ledger/shape
 */
import {
  EVENT_KINDS,
  EVENT_SCHEMA_VERSION,
  requiredIdsPresent,
  type EventKind,
  type EventPayload,
  type MemoryEvent,
} from '../contracts.ts';

/** 形状检查结果：null 表示合法，否则是稳定原因码。 */
export type ShapeProblem = string | null;

const SOURCES = new Set(['user', 'runtime', 'model']);
const CHANNELS = new Set(['ui', 'api', 'unknown']);
const ACKS = new Set(['seen', 'dismissed']);
const OUTCOMES = new Set(['ok', 'error', 'unknown']);
const CHANGES = new Set(['created', 'revised', 'cancelled', 'completed']);
const AUTHORITIES = new Set(['explicit', 'scripted-candidate']);
const KINDS = new Set<string>(EVENT_KINDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 校验事件形状与 kind 必需字段。
 * 同一事件重复到达时形状必须一致，否则算冲突而不是幂等。
 */
export function validateEventShape(event: unknown): ShapeProblem {
  if (!isRecord(event)) return 'not_object';
  const candidate = event as unknown as MemoryEvent;
  if (candidate.schemaVersion !== EVENT_SCHEMA_VERSION) return 'schema_mismatch';
  if (!isNonEmptyString(candidate.eventId)) return 'event_id_missing';
  if (!isNonEmptyString(candidate.sessionId)) return 'session_id_missing';
  if (!Number.isInteger(candidate.sessionEpoch) || candidate.sessionEpoch < 1) return 'epoch_invalid';
  if (!Number.isInteger(candidate.sequence) || candidate.sequence < 1) return 'sequence_invalid';
  if (!isNonEmptyString(candidate.occurredAt) || !isNonEmptyString(candidate.observedAt)) return 'time_missing';
  if (!SOURCES.has(candidate.source)) return 'source_invalid';
  if (typeof candidate.kind !== 'string' || !KINDS.has(candidate.kind)) return 'kind_invalid';
  if (!isRecord(candidate.payload)) return 'payload_invalid';
  if (!requiredIdsPresent(candidate)) return 'identity_missing';

  const payload = candidate.payload as EventPayload;
  switch (candidate.kind) {
    case 'user.statement':
      if (!isNonEmptyString(payload.text)) return 'text_missing';
      if (payload.scripted !== undefined && payload.scripted !== null) {
        const scripted = payload.scripted;
        if (!isRecord(scripted)) return 'scripted_invalid';
        if (!isNonEmptyString(scripted.subjectKey)) return 'scripted_subject_missing';
        if (!isNonEmptyString(scripted.valueText)) return 'scripted_value_missing';
        if (!['preference', 'task', 'fact'].includes(scripted.kindHint)) return 'scripted_hint_invalid';
      }
      return null;
    case 'response.generated':
      if (!isNonEmptyString(payload.text)) return 'text_missing';
      return null;
    case 'response.presented':
      if (!CHANNELS.has(payload.channel ?? '')) return 'channel_invalid';
      return null;
    case 'user.acknowledged':
      if (!ACKS.has(payload.ack ?? '')) return 'ack_invalid';
      return null;
    case 'tool.result':
      if (!isNonEmptyString(payload.toolName)) return 'tool_name_missing';
      if (!OUTCOMES.has(payload.outcome ?? '')) return 'outcome_invalid';
      return null;
    case 'task.changed':
      if (!Number.isInteger(candidate.taskRevision) || (candidate.taskRevision ?? 0) < 1) return 'revision_invalid';
      if (!CHANGES.has(payload.change ?? '')) return 'change_invalid';
      if (!AUTHORITIES.has(payload.authority ?? '')) return 'authority_invalid';
      return null;
    case 'request.cancelled':
    case 'request.failed':
      return null;
    case 'session.reset':
      return null;
    default:
      return 'kind_invalid';
  }
}

/** 供策略层使用：把不可信字符串规整成稳定原因码。 */
export function reasonCode(problem: ShapeProblem): string {
  return problem ?? 'ok';
}

/** kind 是否属于「结清已有请求」类：允许在已关闭代际里到达。 */
export function isSettlementKind(kind: EventKind): boolean {
  return (
    kind === 'response.presented' ||
    kind === 'user.acknowledged' ||
    kind === 'tool.result' ||
    kind === 'request.cancelled' ||
    kind === 'request.failed'
  );
}
