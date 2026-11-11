/**
 * MemoryPort 实现：把权威跟进事件投影成 R3.1 记忆，再从记忆读回带版本的事实。
 *
 * 复用边界：
 * - 直接 import R3.1 的纯模块（reduce/stepEvent/applyPatch），不复制、不改写规则；
 * - 原始事件 → MemoryEvent 的映射是本项目新增的适配，明确标注 scripted；
 * - 小规模全量重放，不声称性能优势；
 * - 证据校验只回答“这条来源是否仍对应当前记忆版本”，任务版本与 assignment
 *   仍由 runtime 校验。
 *
 * @module pet-next/experiments/task-followup/memory-bridge
 */
import {
  EVENT_SCHEMA_VERSION,
  PATCH_SCHEMA_VERSION,
  canonicalJson,
  emptyState,
} from '../../memory-consistency/contracts.ts'
import type { MemoryEvent, MemoryPatch, MemoryState, NoteDraft } from '../../memory-consistency/contracts.ts'
import { applyPatch, recomputeDependencies, stepEvent } from '../../memory-consistency/ledger/index.ts'
import type {
  ArtifactPayload,
  EvidenceRef,
  EvidenceVerdict,
  FactAuthority,
  FollowupEvent,
  MemoryFact,
  MemoryIngestInput,
  MemoryIngestResult,
  MemoryPort,
  MemoryReading,
  MemoryStorePort,
  TaskSnapshot,
} from '../contracts.ts'

const SESSION_ID = 'pet-followup'
const SESSION_EPOCH = 1

export interface MemoryBridgeOptions {
  readonly store: MemoryStorePort
  readonly listEventRows: () => readonly { readonly seq: number; readonly event: FollowupEvent }[]
  /** 关闭笔记派生时只保留原始事件投影（用于消融）。 */
  readonly deriveNotes?: boolean
}

interface MappedEvent {
  readonly memoryEvent: MemoryEvent
  readonly noteText: string
}

export class R31MemoryBridge implements MemoryPort {
  private readonly store: MemoryStorePort
  private readonly listEventRows: () => readonly { readonly seq: number; readonly event: FollowupEvent }[]
  private readonly deriveNotes: boolean
  private stateCache: MemoryState | undefined

  constructor(options: MemoryBridgeOptions) {
    this.store = options.store
    this.listEventRows = options.listEventRows
    this.deriveNotes = options.deriveNotes ?? true
  }

  ingest(input: MemoryIngestInput): MemoryIngestResult {
    const mapped = this.map(input.event, input.eventCursor, input.label)
    const existing = this.store.readMemoryEvents().find((row) => row.memoryEventId === mapped.memoryEvent.eventId)
    if (existing) {
      const state = this.state()
      const note = state.notes[this.noteId(mapped.memoryEvent.eventId)]
      return {
        memoryEventId: mapped.memoryEvent.eventId,
        cursor: this.cursor(),
        noteIds: note ? [note.noteId] : [],
        noteVersions: note ? { [note.noteId]: note.version } : {},
      }
    }
    this.store.appendMemoryEvent({
      memoryEventId: mapped.memoryEvent.eventId,
      sequence: input.eventCursor,
      json: canonicalJson(mapped.memoryEvent),
    })
    let state = this.state()
    const step = stepEvent(state, mapped.memoryEvent)
    state = step.state
    let noteIds: string[] = []
    let noteVersions: Record<string, number> = {}
    if (this.deriveNotes) {
      const patch = this.buildPatch(state, mapped.memoryEvent, input.eventCursor, input.label, mapped.noteText)
      const outcome = applyPatch(state, patch)
      if (outcome.disposition === 'applied') {
        this.store.appendMemoryPatch({ opId: patch.opId, sequence: input.eventCursor, json: canonicalJson(patch) })
        state = outcome.state
        noteIds = [patch.notesToUpsert[0]!.noteId]
        noteVersions = { [patch.notesToUpsert[0]!.noteId]: outcome.state.notes[patch.notesToUpsert[0]!.noteId]!.version }
      } else if (outcome.disposition === 'replayed') {
        const note = state.notes[this.noteId(mapped.memoryEvent.eventId)]
        if (note) {
          noteIds = [note.noteId]
          noteVersions = { [note.noteId]: note.version }
        }
      }
    }
    this.stateCache = state
    return { memoryEventId: mapped.memoryEvent.eventId, cursor: this.cursor(), noteIds, noteVersions }
  }

  /** 全量重建：清空投影后按顺序重放事件与补丁。 */
  rebuild(): number {
    this.store.clearProjection()
    this.stateCache = undefined
    let state = emptyState()
    const patches = new Map<number, MemoryPatch[]>()
    let cursor = 0
    for (const row of this.listEventRows()) {
      const mapped = this.map(row.event, row.seq, labelOf(row.event))
      this.store.appendMemoryEvent({ memoryEventId: mapped.memoryEvent.eventId, sequence: row.seq, json: canonicalJson(mapped.memoryEvent) })
      const step = stepEvent(state, mapped.memoryEvent)
      state = step.state
      cursor = row.seq
      if (!this.deriveNotes) continue
      const patch = this.buildPatch(state, mapped.memoryEvent, row.seq, labelOf(row.event), mapped.noteText)
      const outcome = applyPatch(state, patch)
      if (outcome.disposition === 'applied') {
        this.store.appendMemoryPatch({ opId: patch.opId, sequence: row.seq, json: canonicalJson(patch) })
        state = outcome.state
        const list = patches.get(row.seq) ?? []
        list.push(patch)
        patches.set(row.seq, list)
      }
    }
    this.stateCache = state
    return cursor
  }

  readRelevant(ticket: TaskSnapshot, query: string): MemoryReading {
    const state = this.state()
    const facts: MemoryFact[] = []
    const diagnostics: string[] = []
    for (const event of state.events) {
      if (event.sequence > ticket.eventCursor) continue
      const subject = event.payload.scripted?.subjectKey
      if (event.taskId !== ticket.ticketId && !(subject ?? '').startsWith(`task:${ticket.ticketId}`)) continue
      const authority = authorityOf(event)
      if (!authority) continue
      const noteIds = Object.values(state.notes)
        .filter((note) => note.sourceEventIds.includes(event.eventId))
        .map((note) => note.noteId)
      const noteVersions: Record<string, number> = {}
      for (const noteId of noteIds) noteVersions[noteId] = state.notes[noteId]!.version
      facts.push({
        memoryEventId: event.eventId,
        kind: event.kind,
        authority,
        text: event.payload.text ?? event.payload.detail ?? event.payload.scripted?.valueText ?? event.kind,
        taskRevision: event.taskRevision ?? null,
        sourceId: sourceOf(event.payload.detail),
        sourceRevision: revisionOf(event.payload.detail),
        sha256: shaOf(event.payload.reason),
        eventId: event.eventId,
        eventCursor: event.sequence,
        noteIds,
        noteVersions,
      })
    }
    if (facts.length === 0) diagnostics.push('memory_empty')
    if (query.trim().length === 0) diagnostics.push('empty_query')
    return { cursor: this.cursor(), facts, notes: Object.values(state.notes).map((note) => ({
      noteId: note.noteId,
      text: note.text,
      version: note.version,
      status: note.status,
    })), diagnostics }
  }

  validate(refs: readonly EvidenceRef[]): EvidenceVerdict {
    if (refs.length === 0) return { ok: true, code: 'ok', detail: 'no evidence required', refs }
    const state = this.state()
    for (const ref of refs) {
      if (ref.memoryEventIds.length === 0) {
        return { ok: false, code: 'unknown_event', detail: `evidence ${ref.sourceId} has no memory event`, refs: [ref] }
      }
      for (const memoryEventId of ref.memoryEventIds) {
        const index = state.eventIndex[memoryEventId]
        if (index === undefined) {
          return { ok: false, code: 'unknown_event', detail: `memory event missing: ${memoryEventId}`, refs: [ref] }
        }
        const event = state.events[index]!
        if (shaOf(event.payload.reason) !== ref.sha256) {
          return {
            ok: false,
            code: 'sha_mismatch',
            detail: `evidence sha ${ref.sha256.slice(0, 12)} != recorded ${shaOf(event.payload.reason)?.slice(0, 12)}`,
            refs: [ref],
          }
        }
        if (sourceOf(event.payload.detail) !== ref.sourceId) {
          return { ok: false, code: 'unknown_event', detail: `source mismatch: ${event.payload.detail}`, refs: [ref] }
        }
      }
      for (const noteId of ref.noteIds) {
        const note = state.notes[noteId]
        if (!note) return { ok: false, code: 'unknown_event', detail: `note missing: ${noteId}`, refs: [ref] }
        if (note.status !== 'active') return { ok: false, code: 'note_stale', detail: `note ${noteId} is ${note.status}`, refs: [ref] }
        const expected = ref.noteVersions[noteId]
        if (expected !== undefined && expected !== note.version) {
          return { ok: false, code: 'note_stale', detail: `note ${noteId} v${note.version} != v${expected}`, refs: [ref] }
        }
      }
    }
    return { ok: true, code: 'ok', detail: `${refs.length} evidence refs match memory state`, refs }
  }

  cursor(): number {
    const rows = this.store.readMemoryEvents()
    return rows.length ? rows[rows.length - 1]!.sequence : 0
  }

  private state(): MemoryState {
    if (this.stateCache) return this.stateCache
    let state = emptyState()
    const patches = this.store.readMemoryPatches()
    const bySequence = new Map<number, MemoryPatch[]>()
    for (const row of patches) {
      const list = bySequence.get(row.sequence) ?? []
      list.push(JSON.parse(row.json) as MemoryPatch)
      bySequence.set(row.sequence, list)
    }
    for (const row of this.store.readMemoryEvents()) {
      const event = JSON.parse(row.json) as MemoryEvent
      const step = stepEvent(state, event)
      state = step.state
      for (const patch of bySequence.get(row.sequence) ?? []) {
        const outcome = applyPatch(state, patch)
        state = outcome.state
      }
    }
    this.stateCache = state
    return state
  }

  private noteId(memoryEventId: string): string {
    return `note:${memoryEventId}`
  }

  private buildPatch(state: MemoryState, event: MemoryEvent, sequence: number, label: string, noteText: string): MemoryPatch {
    const subjectKey = event.payload.scripted?.subjectKey
    const draft: NoteDraft = {
      noteId: this.noteId(event.eventId),
      text: `${label}${noteText ? `｜${noteText}` : ''}`.slice(0, 240),
      sourceEventIds: [event.eventId],
      parentNoteIds: [],
      dependencyVersions: {},
      generator: 'scripted',
      ...(subjectKey ? { subjectKey } : {}),
    }
    const recomputed = recomputeDependencies(state, draft)
    return {
      schemaVersion: PATCH_SCHEMA_VERSION,
      opId: `patch:${sequence}:${event.eventId}`,
      snapshotVersion: state.globalVersion,
      dependencyVersions: recomputed.dependencies,
      notesToUpsert: [{ ...draft, dependencyVersions: recomputed.dependencies }],
      notesToInvalidate: [],
      producer: 'incremental',
    }
  }

  private map(event: FollowupEvent, sequence: number, label: string): MappedEvent {
    const taskId = event.ticketId ?? undefined
    const taskRevision = event.taskRevision ?? undefined
    const base = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: event.eventId,
      sessionId: SESSION_ID,
      sessionEpoch: SESSION_EPOCH,
      sequence,
      occurredAt: event.observedAt,
      observedAt: event.observedAt,
      source: event.kind.startsWith('user.') ? ('user' as const) : ('runtime' as const),
    }
    switch (event.kind) {
      case 'user.delegated': {
        const goal = String(event.payload.goal ?? event.payload.title ?? '')
        return {
          noteText: event.payload.goal ? String(event.payload.goal) : '',
          memoryEvent: {
            ...base,
            kind: 'user.statement',
            taskId,
            taskRevision,
            payload: {
              text: goal,
              detail: `${event.sourceId}#${event.sourceRevision ?? ''}`,
              reason: `sha256:${event.contentSha256}`,
              scripted: { subjectKey: `task:${event.ticketId}:goal`, valueText: goal, kindHint: 'task' },
            },
          },
        }
      }
      case 'user.changed':
      case 'user.cancelled': {
        const text = String(event.payload.goal ?? event.payload.reason ?? event.kind)
        return {
          noteText: text,
          memoryEvent: {
            ...base,
            kind: 'task.changed',
            taskId,
            taskRevision,
            payload: {
              text,
              change: event.kind === 'user.changed' ? 'revised' : 'cancelled',
              authority: 'explicit',
              subjectKey: event.kind === 'user.changed' ? `task:${event.ticketId}:goal` : `task:${event.ticketId}:status`,
              detail: `${event.sourceId}#${event.sourceRevision ?? ''}`,
              reason: `sha256:${event.contentSha256}`,
            },
          },
        }
      }
      case 'user.answered': {
        const text = String(event.payload.label ?? event.payload.optionId ?? 'answered')
        return {
          noteText: text,
          memoryEvent: {
            ...base,
            kind: 'user.statement',
            taskId,
            taskRevision,
            payload: {
              text,
              detail: `${event.sourceId}#${event.sourceRevision ?? ''}`,
              reason: `sha256:${event.contentSha256}`,
              scripted: { subjectKey: `task:${event.ticketId}:answer:${String(event.payload.attentionId ?? 'na')}`, valueText: text, kindHint: 'task' },
            },
          },
        }
      }
      case 'artifact.observed': {
        const payload = event.payload as unknown as ArtifactPayload
        return {
          noteText: `${payload.runId} r${payload.revision} ${payload.status} sha=${payload.artifactSha.slice(0, 12)}`,
          memoryEvent: {
            ...base,
            kind: 'tool.result',
            requestId: event.eventId,
            taskId,
            taskRevision,
            payload: {
              text: `观察结果 ${payload.runId} r${payload.revision}`,
              toolName: 'inspect_artifact',
              outcome: 'ok',
              detail: `${event.sourceId}#${event.sourceRevision ?? ''}`,
              reason: `sha256:${payload.resultFileSha}`,
            },
          },
        }
      }
      case 'tool.receipt': {
        const ok = event.payload.ok !== false && event.payload.completion !== true
        const sha = String(event.payload.outputSha256 ?? event.payload.artifactSha ?? event.contentSha256)
        return {
          noteText: `${String(event.payload.tool ?? 'receipt')} ${ok ? 'ok' : 'failed'} sha=${sha.slice(0, 12)}`,
          memoryEvent: {
            ...base,
            kind: 'tool.result',
            requestId: event.eventId,
            taskId,
            taskRevision,
            payload: {
              text: `${String(event.payload.tool ?? 'tool')} ${ok ? 'ok' : 'failed'}`,
              toolName: String(event.payload.tool ?? 'inspect_artifact'),
              outcome: ok ? 'ok' : 'error',
              detail: `${event.sourceId}#${event.sourceRevision ?? ''}`,
              reason: `sha256:${sha}`,
            },
          },
        }
      }
      default: {
        return {
          noteText: '',
          memoryEvent: {
            ...base,
            kind: 'user.statement',
            taskId,
            taskRevision,
            payload: {
              text: label,
              detail: `${event.sourceId}#${event.sourceRevision ?? ''}`,
              reason: `sha256:${event.contentSha256}`,
            },
          },
        }
      }
    }
  }
}

function authorityOf(event: MemoryEvent): FactAuthority | null {
  if (event.kind === 'user.statement') return 'user_said'
  if (event.kind === 'task.changed') return 'commitment'
  if (event.kind === 'tool.result' && event.payload.outcome === 'ok') return 'tool_verified'
  return null
}

function labelOf(event: FollowupEvent): string {
  switch (event.kind) {
    case 'user.delegated':
      return '用户委托'
    case 'user.changed':
      return '用户更正'
    case 'user.cancelled':
      return '用户取消'
    case 'user.answered':
      return '用户回答'
    case 'artifact.observed':
      return '观察到实验结果'
    case 'tool.receipt':
      return '工具回执'
    default:
      return '时钟推进'
  }
}

function shaOf(reason: string | undefined): string | null {
  return reason?.startsWith('sha256:') ? reason.slice('sha256:'.length) : null
}

function sourceOf(detail: string | undefined): string {
  return detail?.split('#')[0] ?? ''
}

function revisionOf(detail: string | undefined): string | null {
  const parts = detail?.split('#') ?? []
  return parts.length > 1 ? parts[1] ?? null : null
}
