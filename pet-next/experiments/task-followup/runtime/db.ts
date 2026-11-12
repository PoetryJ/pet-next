/**
 * SQLite 权威存储：事件、任务、提案、effect、回执、注意力、通知、上游聚合 JSON。
 *
 * 单写者模型：所有引擎命令经 `atomic()` 串行执行；引擎命令相关的持久写与
 * effect 入队在同一事务里提交，提交之后 driver 才派发 effect。
 *
 * 崩溃检查点用真实进程退出（exit 42）实现，写入 meta 标记避免重启后无限重崩。
 *
 * @module pet-next/experiments/task-followup/runtime/db
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  AttentionState,
  AttentionStore,
  AttentionView,
  EvidenceRef,
  FollowupEvent,
  FollowupEventKind,
  MemoryStorePort,
  NotificationReceipt,
  NotificationState,
  ToolReceipt,
  WakeJob,
  WakeStatus,
} from '../contracts.ts'
import { EVENT_SCHEMA, canonicalJson } from '../contracts.ts'

export const CRASH_POINTS = ['ingest_persisted', 'pre_dispatch', 'effect_running', 'receipt_persisted'] as const
export type CrashPoint = (typeof CRASH_POINTS)[number]

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS followup_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL,
  source_revision TEXT,
  kind TEXT NOT NULL,
  ticket_id TEXT,
  task_revision INTEGER,
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_followup_source_revision
  ON followup_events(source_id, source_revision) WHERE source_revision IS NOT NULL;

CREATE TABLE IF NOT EXISTS tasks (
  ticket_id TEXT PRIMARY KEY,
  task_revision INTEGER NOT NULL,
  assignment_id TEXT,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  goal_json TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  event_cursor INTEGER NOT NULL DEFAULT 0,
  memory_cursor INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  last_proposal_json TEXT,
  last_answer_json TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  result_json TEXT,
  analysis_json TEXT,
  completion_json TEXT,
  close_reason TEXT,
  diagnostics_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS proposals (
  decision_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  assignment_id TEXT,
  kind TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason_text TEXT NOT NULL,
  decision_key TEXT NOT NULL,
  question TEXT,
  options_json TEXT,
  not_before TEXT,
  deadline TEXT,
  tool_json TEXT,
  evidence_json TEXT NOT NULL,
  implementation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  outcome TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_proposals_ticket ON proposals(ticket_id, created_at);

CREATE TABLE IF NOT EXISTS effects (
  effect_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  assignment_id TEXT,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT,
  args_json TEXT,
  input_ref_json TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_effects_state ON effects(state, created_at);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY,
  effect_id TEXT NOT NULL UNIQUE,
  attempt_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  assignment_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  ok INTEGER NOT NULL,
  output_path TEXT,
  output_sha256 TEXT,
  bytes_written INTEGER NOT NULL,
  bytes_read INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  detail TEXT NOT NULL,
  needs_reconciliation INTEGER NOT NULL,
  input_ref_json TEXT,
  inputs_verified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attentions (
  attention_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  assignment_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  decision_key TEXT NOT NULL,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  answer_option_id TEXT,
  answer_label TEXT,
  not_before TEXT,
  deadline TEXT,
  reason TEXT NOT NULL,
  notified_at TEXT,
  delivered_at TEXT,
  presented_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_attentions_open ON attentions(ticket_id, state);

CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  attention_id TEXT,
  decision_id TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  delivered_at TEXT,
  presented_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_notifications_ticket ON notifications(ticket_id, created_at);

CREATE TABLE IF NOT EXISTS wake_jobs (
  job_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  assignment_id TEXT,
  reason TEXT NOT NULL,
  decision_id TEXT,
  source_id TEXT,
  source_revision TEXT,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_wake_due ON wake_jobs(status, due_at);
CREATE INDEX IF NOT EXISTS ix_wake_ticket ON wake_jobs(ticket_id, status);

CREATE TABLE IF NOT EXISTS memory_events (
  memory_event_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_patches (
  op_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS upstream_docs (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);

CREATE TABLE IF NOT EXISTS command_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  name TEXT NOT NULL,
  detail_json TEXT,
  result_json TEXT
);

CREATE TABLE IF NOT EXISTS driver_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  ticket_id TEXT,
  phase TEXT NOT NULL,
  detail_json TEXT
);
`

export interface EventRow {
  readonly seq: number
  readonly event: FollowupEvent
}

/** 事件表行（去掉 JSON 字段后的原始列）。 */
interface RawEventRow {
  seq: number
  event_id: string
  source_id: string
  source_revision: string | null
  kind: string
  ticket_id: string | null
  task_revision: number | null
  observed_at: string
  payload_json: string
  content_sha256: string
  recorded_at: string
}

export class FollowupDb implements MemoryStorePort, AttentionStore {
  readonly handle: DatabaseSync
  private depth = 0
  private readonly path: string

  constructor(path: string) {
    this.path = path
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.handle = new DatabaseSync(path)
    this.handle.exec('PRAGMA journal_mode = WAL')
    this.handle.exec('PRAGMA busy_timeout = 5000')
    this.handle.exec('PRAGMA foreign_keys = ON')
    this.handle.exec(SCHEMA)
    this.migrate()
  }

  /**
   * 老库增量迁移：只加列，不改写历史行。
   * 老 effect/receipt 的 input_ref_json 保持 NULL —— 完成检查对它 fail closed，
   * 不补写假身份。
   */
  private migrate(): void {
    const add = (table: string, column: string, ddl: string): void => {
      const columns = this.handle.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
      if (columns.some((row) => row.name === column)) return
      this.handle.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
    }
    add('effects', 'input_ref_json', 'input_ref_json TEXT')
    add('receipts', 'input_ref_json', 'input_ref_json TEXT')
    add('receipts', 'inputs_verified', 'inputs_verified INTEGER NOT NULL DEFAULT 0')
    add('attentions', 'notified_at', 'notified_at TEXT')
    add('attentions', 'delivered_at', 'delivered_at TEXT')
    add('attentions', 'presented_at', 'presented_at TEXT')
    add('notifications', 'state', "state TEXT NOT NULL DEFAULT 'queued'")
    add('notifications', 'delivered_at', 'delivered_at TEXT')
    add('notifications', 'presented_at', 'presented_at TEXT')
    add('tasks', 'continuation_json', 'continuation_json TEXT')
  }

  get file(): string {
    return this.path
  }

  close(): void {
    this.handle.close()
  }

  /** 串行事务；嵌套调用直接复用外层事务。 */
  atomic<T>(work: () => T): T {
    if (this.depth > 0) {
      this.depth += 1
      try {
        return work()
      } finally {
        this.depth -= 1
      }
    }
    this.handle.exec('BEGIN IMMEDIATE')
    this.depth = 1
    try {
      const result = work()
      this.handle.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.handle.exec('ROLLBACK')
      } catch {
        // 回滚失败时保留原始错误。
      }
      throw error
    } finally {
      this.depth = 0
    }
  }

  get inTransaction(): boolean {
    return this.depth > 0
  }

  metaGet(key: string): string | undefined {
    const row = this.handle.prepare('SELECT v FROM meta WHERE k = ?').get(key) as { v: string } | undefined
    return row?.v
  }

  metaSet(key: string, value: string): void {
    this.handle.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, value)
  }

  log(name: string, at: string, detail?: unknown, result?: unknown): void {
    this.handle
      .prepare('INSERT INTO command_log(at, name, detail_json, result_json) VALUES(?, ?, ?, ?)')
      .run(at, name, detail === undefined ? null : canonicalJson(detail), result === undefined ? null : canonicalJson(result))
  }

  driverLog(at: string, ticketId: string | null, phase: string, detail: unknown): void {
    this.handle
      .prepare('INSERT INTO driver_log(at, ticket_id, phase, detail_json) VALUES(?, ?, ?, ?)')
      .run(at, ticketId, phase, canonicalJson(detail))
  }

  /** 真实进程退出，模拟“入站持久后/派发前/回执后”的崩溃。 */
  maybeCrash(point: CrashPoint): void {
    if (process.env.PET_FOLLOWUP_CRASH_AT !== point) return
    const key = `crash:${point}`
    if (this.metaGet(key) === 'done') return
    if (this.inTransaction) throw new Error('crash point must be outside a transaction')
    this.metaSet(key, 'done')
    process.stderr.write(`[crash-injected] ${point}\n`)
    process.exit(42)
  }

  // ---- 权威事件 ----

  insertEvent(event: FollowupEvent, recordedAt: string): { seq: number; disposition: 'appended' | 'duplicate' } {
    const existing = this.handle.prepare('SELECT seq, content_sha256 FROM followup_events WHERE event_id = ?').get(event.eventId) as
      | { seq: number; content_sha256: string }
      | undefined
    if (existing) {
      if (existing.content_sha256 !== event.contentSha256) {
        throw new Error(`event conflict: ${event.eventId} same id different content`)
      }
      return { seq: existing.seq, disposition: 'duplicate' }
    }
    const info = this.handle
      .prepare(
        `INSERT INTO followup_events(event_id, source_id, source_revision, kind, ticket_id, task_revision, observed_at, payload_json, content_sha256, recorded_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.sourceId,
        event.sourceRevision,
        event.kind,
        event.ticketId,
        event.taskRevision,
        event.observedAt,
        canonicalJson(event.payload),
        event.contentSha256,
        recordedAt,
      )
    return { seq: Number(info.lastInsertRowid), disposition: 'appended' }
  }

  lastEventSeq(): number {
    const row = this.handle.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM followup_events').get() as { seq: number }
    return Number(row.seq)
  }

  getEventRow(seq: number): EventRow | undefined {
    const row = this.handle.prepare('SELECT * FROM followup_events WHERE seq = ?').get(seq) as RawEventRow | undefined
    return row ? { seq: row.seq, event: rowToEvent(row) } : undefined
  }

  getEvent(eventId: string): FollowupEvent | undefined {
    const row = this.handle.prepare('SELECT * FROM followup_events WHERE event_id = ?').get(eventId) as RawEventRow | undefined
    return row ? rowToEvent(row) : undefined
  }

  listEvents(ticketId?: string): FollowupEvent[] {
    const rows = (
      ticketId === undefined
        ? this.handle.prepare('SELECT * FROM followup_events ORDER BY seq').all()
        : this.handle.prepare('SELECT * FROM followup_events WHERE ticket_id = ? ORDER BY seq').all(ticketId)
    ) as unknown as RawEventRow[]
    return rows.map(rowToEvent)
  }

  /** 带序号的权威事件行；记忆桥重建时使用。 */
  listEventRowEntries(ticketId?: string): { seq: number; event: FollowupEvent }[] {
    const rows = (
      ticketId === undefined
        ? this.handle.prepare('SELECT * FROM followup_events ORDER BY seq').all()
        : this.handle.prepare('SELECT * FROM followup_events WHERE ticket_id = ? ORDER BY seq').all(ticketId)
    ) as unknown as RawEventRow[]
    return rows.map((row) => ({ seq: Number(row.seq), event: rowToEvent(row) }))
  }

  findArtifact(sourceId: string, sourceRevision: string): EventRow | undefined {
    const row = this.handle
      .prepare("SELECT * FROM followup_events WHERE source_id = ? AND source_revision = ? AND kind = 'artifact.observed'")
      .get(sourceId, sourceRevision) as RawEventRow | undefined
    return row ? { seq: row.seq, event: rowToEvent(row) } : undefined
  }

  // ---- 任务 ----

  getTaskRow(ticketId: string): TaskRow | undefined {
    return this.handle.prepare('SELECT * FROM tasks WHERE ticket_id = ?').get(ticketId) as TaskRow | undefined
  }

  listTaskRows(): TaskRow[] {
    return this.handle.prepare('SELECT * FROM tasks ORDER BY created_at, ticket_id').all() as unknown as TaskRow[]
  }

  saveTaskRow(row: TaskRow): void {
    this.handle
      .prepare(
        `INSERT INTO tasks(ticket_id, task_revision, assignment_id, title, goal, goal_json, stage, status, created_at, updated_at,
           event_cursor, memory_cursor, evidence_json, last_proposal_json, last_answer_json, continuation_json, attempt,
           result_json, analysis_json, completion_json, close_reason, diagnostics_json)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ticket_id) DO UPDATE SET
           task_revision = excluded.task_revision, assignment_id = excluded.assignment_id, title = excluded.title,
           goal = excluded.goal, goal_json = excluded.goal_json, stage = excluded.stage, status = excluded.status,
           updated_at = excluded.updated_at, event_cursor = excluded.event_cursor, memory_cursor = excluded.memory_cursor,
           evidence_json = excluded.evidence_json, last_proposal_json = excluded.last_proposal_json,
           last_answer_json = excluded.last_answer_json, continuation_json = excluded.continuation_json,
           attempt = excluded.attempt, result_json = excluded.result_json,
           analysis_json = excluded.analysis_json, completion_json = excluded.completion_json,
           close_reason = excluded.close_reason, diagnostics_json = excluded.diagnostics_json`,
      )
      .run(
        row.ticket_id,
        row.task_revision,
        row.assignment_id,
        row.title,
        row.goal,
        row.goal_json,
        row.stage,
        row.status,
        row.created_at,
        row.updated_at,
        row.event_cursor,
        row.memory_cursor,
        row.evidence_json,
        row.last_proposal_json,
        row.last_answer_json,
        row.continuation_json,
        row.attempt,
        row.result_json,
        row.analysis_json,
        row.completion_json,
        row.close_reason,
        row.diagnostics_json,
      )
  }

  // ---- 提案 ----

  saveProposal(row: ProposalRow): void {
    this.handle
      .prepare(
        `INSERT INTO proposals(decision_id, ticket_id, task_revision, assignment_id, kind, reason_code, reason_text, decision_key,
           question, options_json, not_before, deadline, tool_json, evidence_json, implementation, created_at, validation_json, outcome)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(decision_id) DO UPDATE SET validation_json = excluded.validation_json, outcome = excluded.outcome,
           kind = excluded.kind, reason_code = excluded.reason_code, reason_text = excluded.reason_text`,
      )
      .run(
        row.decision_id,
        row.ticket_id,
        row.task_revision,
        row.assignment_id,
        row.kind,
        row.reason_code,
        row.reason_text,
        row.decision_key,
        row.question,
        row.options_json,
        row.not_before,
        row.deadline,
        row.tool_json,
        row.evidence_json,
        row.implementation,
        row.created_at,
        row.validation_json,
        row.outcome,
      )
  }

  listProposals(ticketId: string): ProposalRow[] {
    return this.handle
      .prepare('SELECT * FROM proposals WHERE ticket_id = ? ORDER BY created_at, decision_id')
      .all(ticketId) as unknown as ProposalRow[]
  }

  listAllProposals(): ProposalRow[] {
    return this.handle.prepare('SELECT * FROM proposals ORDER BY created_at, decision_id').all() as unknown as ProposalRow[]
  }

  getProposal(decisionId: string): ProposalRow | undefined {
    return this.handle.prepare('SELECT * FROM proposals WHERE decision_id = ?').get(decisionId) as ProposalRow | undefined
  }

  // ---- effect / receipt ----

  saveEffect(row: EffectRow): void {
    this.handle
      .prepare(
        `INSERT INTO effects(effect_id, ticket_id, task_revision, assignment_id, attempt_id, kind, tool, args_json, input_ref_json,
           state, created_at, started_at, finished_at, detail)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(effect_id) DO UPDATE SET state = excluded.state, started_at = excluded.started_at,
           finished_at = excluded.finished_at, detail = excluded.detail,
           input_ref_json = COALESCE(effects.input_ref_json, excluded.input_ref_json)`,
      )
      .run(
        row.effect_id,
        row.ticket_id,
        row.task_revision,
        row.assignment_id,
        row.attempt_id,
        row.kind,
        row.tool,
        row.args_json,
        row.input_ref_json,
        row.state,
        row.created_at,
        row.started_at,
        row.finished_at,
        row.detail,
      )
  }

  getEffect(effectId: string): EffectRow | undefined {
    return this.handle.prepare('SELECT * FROM effects WHERE effect_id = ?').get(effectId) as EffectRow | undefined
  }

  listEffects(state?: string): EffectRow[] {
    return (
      state === undefined
        ? this.handle.prepare('SELECT * FROM effects ORDER BY created_at, effect_id').all()
        : this.handle.prepare('SELECT * FROM effects WHERE state = ? ORDER BY created_at, effect_id').all(state)
    ) as unknown as EffectRow[]
  }

  countEffects(ticketId: string, kind: string): number {
    const row = this.handle.prepare('SELECT COUNT(*) AS n FROM effects WHERE ticket_id = ? AND kind = ?').get(ticketId, kind) as { n: number }
    return Number(row.n)
  }

  saveReceipt(receipt: ToolReceipt): void {
    this.handle
      .prepare(
        `INSERT INTO receipts(receipt_id, effect_id, attempt_id, ticket_id, task_revision, assignment_id, tool, ok, output_path,
           output_sha256, bytes_written, bytes_read, started_at, finished_at, detail, needs_reconciliation,
           input_ref_json, inputs_verified)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.receiptId,
        receipt.effectId,
        receipt.attemptId,
        receipt.ticketId,
        receipt.taskRevision,
        receipt.assignmentId,
        receipt.tool,
        receipt.ok ? 1 : 0,
        receipt.outputPath,
        receipt.outputSha256,
        receipt.bytesWritten,
        receipt.bytesRead,
        receipt.startedAt,
        receipt.finishedAt,
        receipt.detail,
        receipt.needsReconciliation ? 1 : 0,
        receipt.inputRef ? canonicalJson(receipt.inputRef) : null,
        receipt.inputsVerified ? 1 : 0,
      )
  }

  getReceipt(receiptId: string): ToolReceipt | undefined {
    const row = this.handle.prepare('SELECT * FROM receipts WHERE receipt_id = ?').get(receiptId) as RawReceiptRow | undefined
    return row ? rowToReceipt(row) : undefined
  }

  getReceiptByEffect(effectId: string): ToolReceipt | undefined {
    const row = this.handle.prepare('SELECT * FROM receipts WHERE effect_id = ?').get(effectId) as RawReceiptRow | undefined
    return row ? rowToReceipt(row) : undefined
  }

  listReceipts(ticketId: string): ToolReceipt[] {
    const rows = this.handle.prepare('SELECT * FROM receipts WHERE ticket_id = ? ORDER BY finished_at').all(ticketId) as unknown as RawReceiptRow[]
    return rows.map(rowToReceipt)
  }

  // ---- 注意力 / 通知（AttentionStore） ----

  insertAttention(view: AttentionView, reason: string): void {
    this.handle
      .prepare(
        `INSERT INTO attentions(attention_id, ticket_id, task_revision, assignment_id, decision_id, decision_key, question,
           options_json, evidence_json, state, created_at, not_before, deadline, reason, notified_at, delivered_at, presented_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        view.attentionId,
        view.ticketId,
        view.taskRevision,
        view.assignmentId,
        view.decisionId,
        view.decisionKey,
        view.question,
        canonicalJson(view.options),
        canonicalJson(view.evidenceRefs),
        view.state,
        view.createdAt,
        view.notBefore ?? null,
        view.deadline ?? null,
        reason,
        view.notifiedAt ?? null,
        view.deliveredAt ?? null,
        view.presentedAt ?? null,
      )
  }

  updateAttention(
    attentionId: string,
    patch: {
      state?: AttentionState
      answeredAt?: string
      answerOptionId?: string
      answerLabel?: string
      notifiedAt?: string
      deliveredAt?: string
      presentedAt?: string
    },
  ): void {
    const row = this.handle.prepare('SELECT * FROM attentions WHERE attention_id = ?').get(attentionId) as RawAttentionRow | undefined
    if (!row) return
    this.handle
      .prepare(
        `UPDATE attentions SET state = ?, answered_at = ?, answer_option_id = ?, answer_label = ?,
           notified_at = ?, delivered_at = ?, presented_at = ? WHERE attention_id = ?`,
      )
      .run(
        patch.state ?? row.state,
        patch.answeredAt ?? row.answered_at,
        patch.answerOptionId ?? row.answer_option_id,
        patch.answerLabel ?? row.answer_label,
        patch.notifiedAt ?? row.notified_at,
        patch.deliveredAt ?? row.delivered_at,
        patch.presentedAt ?? row.presented_at,
        attentionId,
      )
  }

  getAttention(attentionId: string): AttentionView | undefined {
    const row = this.handle.prepare('SELECT * FROM attentions WHERE attention_id = ?').get(attentionId) as RawAttentionRow | undefined
    return row ? rowToAttention(row) : undefined
  }

  listAttentions(ticketId?: string): AttentionView[] {
    const rows = (
      ticketId === undefined
        ? this.handle.prepare('SELECT * FROM attentions ORDER BY created_at, attention_id').all()
        : this.handle.prepare('SELECT * FROM attentions WHERE ticket_id = ? ORDER BY created_at, attention_id').all(ticketId)
    ) as unknown as RawAttentionRow[]
    return rows.map(rowToAttention)
  }

  insertNotification(row: {
    notificationId: string
    ticketId: string
    attentionId: string | null
    decisionId: string | null
    text: string
    createdAt: string
    state: NotificationState
  }): void {
    this.handle
      .prepare(
        'INSERT INTO notifications(notification_id, ticket_id, attention_id, decision_id, text, created_at, state) VALUES(?, ?, ?, ?, ?, ?, ?)',
      )
      .run(row.notificationId, row.ticketId, row.attentionId, row.decisionId, row.text, row.createdAt, row.state)
  }

  markNotification(notificationId: string, patch: { state: NotificationState; at: string }): void {
    const row = this.handle.prepare('SELECT * FROM notifications WHERE notification_id = ?').get(notificationId) as
      | RawNotificationRow
      | undefined
    if (!row) return
    const deliveredAt =
      patch.state === 'delivered' || patch.state === 'presented' ? (row.delivered_at ?? patch.at) : row.delivered_at
    const presentedAt = patch.state === 'presented' ? (row.presented_at ?? patch.at) : row.presented_at
    this.handle
      .prepare('UPDATE notifications SET state = ?, delivered_at = ?, presented_at = ? WHERE notification_id = ?')
      .run(patch.state, deliveredAt, presentedAt, notificationId)
  }

  getNotification(notificationId: string): NotificationReceipt | undefined {
    const row = this.handle.prepare('SELECT * FROM notifications WHERE notification_id = ?').get(notificationId) as
      | RawNotificationRow
      | undefined
    return row ? rowToNotification(row) : undefined
  }

  listNotificationReceipts(ticketId?: string): NotificationReceipt[] {
    const rows = (
      ticketId === undefined
        ? this.handle.prepare('SELECT * FROM notifications ORDER BY created_at, notification_id').all()
        : this.handle.prepare('SELECT * FROM notifications WHERE ticket_id = ? ORDER BY created_at, notification_id').all(ticketId)
    ) as unknown as RawNotificationRow[]
    return rows.map(rowToNotification)
  }

  // ------------------------------------------------------------ R5 持久唤醒

  getWakeJob(jobId: string): WakeJob | null {
    const row = this.handle.prepare('SELECT * FROM wake_jobs WHERE job_id = ?').get(jobId) as unknown as RawWakeRow | undefined
    return row ? rowToWakeJob(row) : null
  }

  listWakeJobs(filter?: { readonly ticketId?: string; readonly status?: WakeStatus }): WakeJob[] {
    const clauses: string[] = []
    const values: string[] = []
    if (filter?.ticketId !== undefined) {
      clauses.push('ticket_id = ?')
      values.push(filter.ticketId)
    }
    if (filter?.status !== undefined) {
      clauses.push('status = ?')
      values.push(filter.status)
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.handle
      .prepare(`SELECT * FROM wake_jobs${where} ORDER BY due_at, job_id`)
      .all(...values) as unknown as RawWakeRow[]
    return rows.map(rowToWakeJob)
  }

  /** 同一逻辑等待只保留一条：ticket + reason + decision_id（空串归一）。 */
  findWakeJob(ticketId: string, reason: string, decisionId: string | null): WakeJob | null {
    const row = this.handle
      .prepare(
        "SELECT * FROM wake_jobs WHERE ticket_id = ? AND reason = ? AND COALESCE(decision_id, '') = ? AND status IN ('scheduled','claimed') ORDER BY due_at LIMIT 1",
      )
      .get(ticketId, reason, decisionId ?? '') as unknown as RawWakeRow | undefined
    return row ? rowToWakeJob(row) : null
  }

  /** 最近一条任意状态的 job（用于判断上次何时触发过）。 */
  latestWakeJob(ticketId: string, reason: string, decisionId: string | null): WakeJob | null {
    const row = this.handle
      .prepare(
        "SELECT * FROM wake_jobs WHERE ticket_id = ? AND reason = ? AND COALESCE(decision_id, '') = ? ORDER BY updated_at DESC, job_id DESC LIMIT 1",
      )
      .get(ticketId, reason, decisionId ?? '') as unknown as RawWakeRow | undefined
    return row ? rowToWakeJob(row) : null
  }

  saveWakeJob(job: WakeJob): void {
    this.handle
      .prepare(
        `INSERT INTO wake_jobs (job_id, ticket_id, task_revision, assignment_id, reason, decision_id, source_id, source_revision, due_at, status, attempts, created_at, updated_at, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           ticket_id = excluded.ticket_id, task_revision = excluded.task_revision, assignment_id = excluded.assignment_id,
           reason = excluded.reason, decision_id = excluded.decision_id, source_id = excluded.source_id,
           source_revision = excluded.source_revision, due_at = excluded.due_at, status = excluded.status,
           attempts = excluded.attempts, updated_at = excluded.updated_at, detail = excluded.detail`,
      )
      .run(
        job.jobId,
        job.ticketId,
        job.taskRevision,
        job.assignmentId,
        job.reason,
        job.decisionId,
        job.sourceId,
        job.sourceRevision,
        job.dueAt,
        job.status,
        job.attempts,
        job.createdAt,
        job.updatedAt,
        job.detail,
      )
  }

  deleteWakeJob(jobId: string): void {
    this.handle.prepare('DELETE FROM wake_jobs WHERE job_id = ?').run(jobId)
  }

  /** 原子领取：只有 scheduled 且已到期才能变成 claimed；重复领取返回 false。 */
  claimWakeJob(jobId: string, now: string): boolean {
    const result = this.handle
      .prepare("UPDATE wake_jobs SET status = 'claimed', attempts = attempts + 1, updated_at = ? WHERE job_id = ? AND status = 'scheduled' AND due_at <= ?")
      .run(now, jobId, now)
    return Number(result.changes) === 1
  }

  updateWakeStatus(jobId: string, status: WakeStatus, now: string, detail: string | null): void {
    this.handle.prepare('UPDATE wake_jobs SET status = ?, updated_at = ?, detail = ? WHERE job_id = ?').run(status, now, detail, jobId)
  }

  nextWakeAt(): string | null {
    const row = this.handle.prepare("SELECT MIN(due_at) AS due FROM wake_jobs WHERE status = 'scheduled'").get() as unknown as { due: string | null } | undefined
    return row?.due ?? null
  }

  /** 兼容旧调用方：只读文本视图。可见性状态请用 listNotificationReceipts。 */
  listNotifications(ticketId?: string): NotificationReceipt[] {
    return this.listNotificationReceipts(ticketId)
  }

  countNotificationsSince(ticketId: string, sinceIso: string): number {
    const row = this.handle
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE ticket_id = ? AND created_at >= ?')
      .get(ticketId, sinceIso) as { n: number }
    return Number(row.n)
  }

  hasNotificationForAttention(attentionId: string): boolean {
    const row = this.handle.prepare('SELECT 1 AS present FROM notifications WHERE attention_id = ? LIMIT 1').get(attentionId) as
      | { present: number }
      | undefined
    return Boolean(row)
  }

  hasDeliveredNotificationForAttention(attentionId: string): boolean {
    const row = this.handle
      .prepare("SELECT 1 AS present FROM notifications WHERE attention_id = ? AND state IN ('delivered','presented') LIMIT 1")
      .get(attentionId) as { present: number } | undefined
    return Boolean(row)
  }

  queuedNotifications(): NotificationReceipt[] {
    const rows = this.handle
      .prepare("SELECT * FROM notifications WHERE state = 'queued' ORDER BY created_at, notification_id")
      .all() as unknown as RawNotificationRow[]
    return rows.map(rowToNotification)
  }

  lastNotificationAt(ticketId: string): string | null {
    const row = this.handle.prepare('SELECT MAX(created_at) AS at FROM notifications WHERE ticket_id = ?').get(ticketId) as {
      at: string | null
    }
    return row.at
  }

  // ---- 记忆投影（MemoryStorePort） ----

  appendMemoryEvent(row: { memoryEventId: string; sequence: number; json: string }): void {
    this.handle
      .prepare('INSERT INTO memory_events(memory_event_id, sequence, json) VALUES(?, ?, ?) ON CONFLICT(memory_event_id) DO NOTHING')
      .run(row.memoryEventId, row.sequence, row.json)
  }

  appendMemoryPatch(row: { opId: string; sequence: number; json: string }): void {
    this.handle
      .prepare('INSERT INTO memory_patches(op_id, sequence, json) VALUES(?, ?, ?) ON CONFLICT(op_id) DO NOTHING')
      .run(row.opId, row.sequence, row.json)
  }

  readMemoryEvents(): { memoryEventId: string; sequence: number; json: string }[] {
    const rows = this.handle.prepare('SELECT * FROM memory_events ORDER BY sequence').all() as unknown as {
      memory_event_id: string
      sequence: number
      json: string
    }[]
    return rows.map((row) => ({ memoryEventId: row.memory_event_id, sequence: row.sequence, json: row.json }))
  }

  readMemoryPatches(): { opId: string; sequence: number; json: string }[] {
    const rows = this.handle.prepare('SELECT * FROM memory_patches ORDER BY sequence').all() as unknown as {
      op_id: string
      sequence: number
      json: string
    }[]
    return rows.map((row) => ({ opId: row.op_id, sequence: row.sequence, json: row.json }))
  }

  clearProjection(): void {
    this.handle.exec('DELETE FROM memory_events')
    this.handle.exec('DELETE FROM memory_patches')
  }

  // ---- 上游聚合 ----

  saveDoc(kind: string, key: string, json: string): void {
    this.handle
      .prepare('INSERT INTO upstream_docs(kind, key, json) VALUES(?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET json = excluded.json')
      .run(kind, key, json)
  }

  getDoc(kind: string, key: string): string | undefined {
    const row = this.handle.prepare('SELECT json FROM upstream_docs WHERE kind = ? AND key = ?').get(kind, key) as { json: string } | undefined
    return row?.json
  }

  listDocs(kind: string): string[] {
    const rows = this.handle.prepare('SELECT json FROM upstream_docs WHERE kind = ? ORDER BY key').all(kind) as unknown as { json: string }[]
    return rows.map((row) => row.json)
  }
}

export interface TaskRow {
  ticket_id: string
  task_revision: number
  assignment_id: string | null
  title: string
  goal: string
  goal_json: string
  stage: string
  status: string
  created_at: string
  updated_at: string
  event_cursor: number
  memory_cursor: number
  evidence_json: string
  last_proposal_json: string | null
  last_answer_json: string | null
  continuation_json: string | null
  attempt: number
  result_json: string | null
  analysis_json: string | null
  completion_json: string | null
  close_reason: string | null
  diagnostics_json: string
}

export interface ProposalRow {
  decision_id: string
  ticket_id: string
  task_revision: number
  assignment_id: string | null
  kind: string
  reason_code: string
  reason_text: string
  decision_key: string
  question: string | null
  options_json: string | null
  not_before: string | null
  deadline: string | null
  tool_json: string | null
  evidence_json: string
  implementation: string
  created_at: string
  validation_json: string
  outcome: string
}

export interface EffectRow {
  effect_id: string
  ticket_id: string
  task_revision: number
  assignment_id: string | null
  attempt_id: string
  kind: string
  tool: string | null
  args_json: string | null
  input_ref_json: string | null
  state: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  detail: string | null
}

interface RawReceiptRow {
  receipt_id: string
  effect_id: string
  attempt_id: string
  ticket_id: string
  task_revision: number
  assignment_id: string
  tool: string
  ok: number
  output_path: string | null
  output_sha256: string | null
  bytes_written: number
  bytes_read: number
  started_at: string
  finished_at: string
  detail: string
  needs_reconciliation: number
  input_ref_json: string | null
  inputs_verified: number
}

interface RawAttentionRow {
  attention_id: string
  ticket_id: string
  task_revision: number
  assignment_id: string
  decision_id: string
  decision_key: string
  question: string
  options_json: string
  evidence_json: string
  state: string
  created_at: string
  answered_at: string | null
  answer_option_id: string | null
  answer_label: string | null
  not_before: string | null
  deadline: string | null
  reason: string
  notified_at: string | null
  delivered_at: string | null
  presented_at: string | null
}

interface RawNotificationRow {
  notification_id: string
  ticket_id: string
  attention_id: string | null
  decision_id: string | null
  text: string
  created_at: string
  state: string
  delivered_at: string | null
  presented_at: string | null
}

function rowToEvent(row: RawEventRow): FollowupEvent {
  return {
    schema: EVENT_SCHEMA,
    eventId: row.event_id,
    sourceId: row.source_id,
    sourceRevision: row.source_revision,
    observedAt: row.observed_at,
    ticketId: row.ticket_id,
    taskRevision: row.task_revision,
    kind: row.kind as FollowupEventKind,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    contentSha256: row.content_sha256,
  }
}

function rowToReceipt(row: RawReceiptRow): ToolReceipt {
  return {
    receiptId: row.receipt_id,
    effectId: row.effect_id,
    attemptId: row.attempt_id,
    ticketId: row.ticket_id,
    taskRevision: row.task_revision,
    assignmentId: row.assignment_id,
    tool: row.tool as ToolReceipt['tool'],
    ok: row.ok === 1,
    outputPath: row.output_path,
    outputSha256: row.output_sha256,
    bytesWritten: row.bytes_written,
    bytesRead: row.bytes_read,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    detail: row.detail,
    needsReconciliation: row.needs_reconciliation === 1,
    inputRef: row.input_ref_json ? (JSON.parse(row.input_ref_json) as ToolReceipt['inputRef']) : null,
    inputsVerified: row.inputs_verified === 1,
  }
}

interface RawWakeRow {
  job_id: string
  ticket_id: string
  task_revision: number
  assignment_id: string | null
  reason: string
  decision_id: string | null
  source_id: string | null
  source_revision: string | null
  due_at: string
  status: string
  attempts: number
  created_at: string
  updated_at: string
  detail: string | null
}

function rowToWakeJob(row: RawWakeRow): WakeJob {
  return {
    jobId: row.job_id,
    ticketId: row.ticket_id,
    taskRevision: row.task_revision,
    assignmentId: row.assignment_id,
    reason: row.reason as WakeJob['reason'],
    decisionId: row.decision_id,
    sourceId: row.source_id,
    sourceRevision: row.source_revision,
    dueAt: row.due_at,
    status: row.status as WakeStatus,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    detail: row.detail,
  }
}

function rowToNotification(row: RawNotificationRow): NotificationReceipt {
  const state = (row.state ?? 'queued') as NotificationState
  return {
    notificationId: row.notification_id,
    ticketId: row.ticket_id,
    attentionId: row.attention_id,
    decisionId: row.decision_id,
    text: row.text,
    state,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    presentedAt: row.presented_at,
  }
}

function rowToAttention(row: RawAttentionRow): AttentionView {
  return {
    attentionId: row.attention_id,
    ticketId: row.ticket_id,
    taskRevision: row.task_revision,
    assignmentId: row.assignment_id,
    decisionId: row.decision_id,
    decisionKey: row.decision_key,
    question: row.question,
    options: JSON.parse(row.options_json) as AttentionView['options'],
    evidenceRefs: JSON.parse(row.evidence_json) as EvidenceRef[],
    state: row.state as AttentionState,
    createdAt: row.created_at,
    ...(row.answered_at ? { answeredAt: row.answered_at } : {}),
    ...(row.answer_option_id && row.answer_label
      ? { answer: { optionId: row.answer_option_id, label: row.answer_label } }
      : {}),
    ...(row.not_before ? { notBefore: row.not_before } : {}),
    ...(row.deadline ? { deadline: row.deadline } : {}),
    ...(row.notified_at ? { notifiedAt: row.notified_at } : {}),
    ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
    ...(row.presented_at ? { presentedAt: row.presented_at } : {}),
  }
}
