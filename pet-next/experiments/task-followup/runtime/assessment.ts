/**
 * 事务外异步 assessment 接口（final-demo 集成负责人所有）。
 *
 * 目的：让“记忆 → 模型/候选介入判断 → 动作”能真正改变行为，同时保留既有执行与通知校验。
 * - 宿主在提案时刻冻结一份快照身份（taskRevision / assignmentId / memoryCursor / eventCursor / sourceRefs），
 *   在任何 SQLite 事务之外调用 assess(snapshot, MemoryPacket, signal)。
 * - 回交走 submitAssessment：先对照原快照与当前状态（版本/指派/记忆游标），再把草案转换为
 *   ProposedDecision，交给既有 executeProposal（proposal 校验 → notify 校验 → attention/tool）。
 * - 两层都持久化：guard 前提案（原样草案 + 原始模型输出）与 guard 后结果（每条 decision 的 outcome/validation）。
 * - 失败（超时、解析、provider 错误、中止）记为 failed 并保留错误；不会自动返回成功占位，也不回退到规则代答。
 *
 * 旧 decision/rules.ts、r5/need-rule.ts（P3/N1）与 product-shadow 不在此修改，作为对照基线原样保留；
 * 未配置 assessor 时运行时行为与 8fa3819 完全一致。
 *
 * 能力模块（capability/memory、capability/model、capability/intervention，由能力执行单元独占）
 * 通过实现本文件导出的 AsyncAssessor / MemoryPacketProvider 接入；宿主用 --assessor-module 动态加载。
 *
 * @module pet-next/experiments/task-followup/runtime/assessment
 */

import type { DatabaseSync } from 'node:sqlite'
import type {
  AttentionOption,
  DecisionContext,
  DecisionKind,
  EvidenceRef,
  ProposedDecision,
  ProposalSummary,
  QuietConfig,
  TaskSnapshot,
  ToolRequest,
} from '../contracts.ts'

export const ASSESSMENT_PROTOCOL = 'pet-followup-assessment/v1'

/** 提交时必须与当前任务一致的身份；任何一项变化都使回交作废（stale）。 */
export interface AssessmentIdentity {
  readonly requestId: string
  readonly ticketId: string
  readonly taskRevision: number
  readonly assignmentId: string
  readonly memoryCursor: number
  readonly eventCursor: number
  /** 同一身份下的第几轮（模型选择等待、到期后重新判断时递增）。 */
  readonly round: number
  readonly sourceRefs: readonly EvidenceRef[]
}

/**
 * 记忆包：由 MemoryPacketProvider 生成。body 结构由能力线定义（currentFacts/preferences/commitments/
 * outcomes/evidenceRefs/missing/conflicts/context 等）；宿主只依赖 evidenceRefs 做引用校验。
 */
export interface MemoryPacket {
  readonly protocol: typeof ASSESSMENT_PROTOCOL
  readonly provider: string
  readonly packetId: string
  readonly cursor: number
  readonly asOf: string
  readonly evidenceRefs: readonly EvidenceRef[]
  readonly body: unknown
}

/** 可执行动作模板：来自既有 DecisionPort 的合法动作菜单（含工具参数）；模型可以选、改问法、选择等待/摘要/不做。 */
export interface ActionTemplate {
  readonly actionId: string
  readonly source: 'baseline-rule-menu'
  readonly kind: DecisionKind
  readonly reasonCode: string
  readonly reasonText: string
  readonly question?: string
  readonly options?: readonly AttentionOption[]
  readonly notBefore?: string
  readonly deadline?: string
  readonly toolRequest?: ToolRequest
  readonly evidenceRefs: readonly EvidenceRef[]
}

export interface AssessmentSnapshot {
  readonly protocol: typeof ASSESSMENT_PROTOCOL
  readonly identity: AssessmentIdentity
  readonly now: string
  readonly task: TaskSnapshot
  readonly evidence: readonly EvidenceRef[]
  readonly history: readonly ProposalSummary[]
  readonly openAttention: DecisionContext['openAttention'] | null
  readonly lastAnswer: DecisionContext['lastAnswer'] | null
  readonly attempt: number
  readonly inputReady: boolean
  readonly goalSatisfied: boolean
  readonly quiet: QuietConfig
  readonly actionMenu: readonly ActionTemplate[]
}

/** 介入意图：ask-now / wait / act / digest / none，映射到既有 DecisionKind。 */
export type AssessmentIntent = 'ask_now' | 'wait' | 'act' | 'digest' | 'none'

export interface AssessmentCitation {
  readonly sourceId: string
  readonly quote: string
  readonly start?: number
  readonly end?: number
}

export interface AssessmentDraft {
  readonly intent: AssessmentIntent
  /** 选择动作菜单中的某一项（act/ask_now 时可用）；工具请求只能来自菜单。 */
  readonly actionId?: string
  readonly reasonCode?: string
  readonly reasonText: string
  readonly question?: string
  readonly options?: readonly AttentionOption[]
  /** wait：最晚重新判断时间（必须有；缺 ETA 不允许无限等待）。 */
  readonly notBefore?: string
  readonly deadline?: string
  readonly evidenceRefs?: readonly EvidenceRef[]
  readonly citations?: readonly AssessmentCitation[]
}

export interface AssessmentRaw {
  readonly provider: string
  /** 实际模型标识；未知时写 'unknown'，不得编造。 */
  readonly model: string
  readonly rawOutput: string
  readonly requestPayload?: unknown
  readonly latencyMs?: number
  readonly usage?: unknown
  readonly meta?: unknown
}

export interface AssessmentResponse {
  readonly drafts: readonly AssessmentDraft[]
  readonly raw: AssessmentRaw
  /** User-origin task control compiled from persisted memory, revalidated by the host at submission. */
  readonly taskControl?: { readonly kind: 'cancel'; readonly itemId: string; readonly reason: string }
}

export interface AsyncAssessor {
  readonly id: string
  /** 是否为真实模型/能力判断；基线包装器必须为 false，避免被误报为能力结果。 */
  readonly capability: boolean
  assess(snapshot: AssessmentSnapshot, packet: MemoryPacket, signal: AbortSignal): Promise<AssessmentResponse>
}

export interface MemoryPacketProvider {
  readonly id: string
  build(input: { readonly snapshot: Omit<AssessmentSnapshot, 'actionMenu'>; readonly context: DecisionContext }): MemoryPacket
}

/** 默认记忆包：包装既有 MemoryPort.readRelevant（已知限制：不按 query 检索），只作接口占位，不代表能力。 */
export const legacyMemoryPacketProvider: MemoryPacketProvider = {
  id: 'legacy-readRelevant',
  build({ snapshot, context }) {
    return {
      protocol: ASSESSMENT_PROTOCOL,
      provider: 'legacy-readRelevant',
      packetId: `pkt-${snapshot.identity.requestId}`,
      cursor: snapshot.identity.memoryCursor,
      asOf: snapshot.now,
      evidenceRefs: [...context.evidence],
      body: context.memory,
    }
  },
}

export type AssessmentStatus = 'pending' | 'submitted' | 'stale' | 'failed' | 'abandoned' | 'aborted'

export interface AssessmentGuardResult {
  readonly decisionId: string
  readonly draftIndex: number
  readonly kind: DecisionKind
  readonly guard: 'host' | 'runtime'
  readonly outcome: string
  readonly code: string
  readonly detail: string
}

export interface AssessmentRow {
  readonly request_id: string
  readonly ticket_id: string
  readonly task_revision: number
  readonly assignment_id: string
  readonly memory_cursor: number
  readonly event_cursor: number
  readonly round: number
  readonly assessor: string
  readonly capability: number
  readonly status: AssessmentStatus
  readonly snapshot_json: string
  readonly packet_json: string
  readonly raw_json: string | null
  readonly pre_guard_json: string | null
  readonly post_guard_json: string | null
  readonly error_code: string | null
  readonly error_detail: string | null
  readonly wait_until: string | null
  readonly created_at: string
  readonly completed_at: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS assessments (
  request_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  assignment_id TEXT NOT NULL,
  memory_cursor INTEGER NOT NULL,
  event_cursor INTEGER NOT NULL,
  round INTEGER NOT NULL,
  assessor TEXT NOT NULL,
  capability INTEGER NOT NULL,
  status TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  packet_json TEXT NOT NULL,
  raw_json TEXT,
  pre_guard_json TEXT,
  post_guard_json TEXT,
  error_code TEXT,
  error_detail TEXT,
  wait_until TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_assessments_identity ON assessments(ticket_id, task_revision, assignment_id, memory_cursor, event_cursor, round);
`

/** assessments 表的读写（与 runtime 共用同一个单写者连接，不另开 SQLite 写者）。 */
export class AssessmentStore {
  constructor(private readonly handle: DatabaseSync) {
    this.handle.exec(SCHEMA)
  }

  insert(row: AssessmentRow): void {
    this.handle
      .prepare(
        `INSERT INTO assessments(request_id, ticket_id, task_revision, assignment_id, memory_cursor, event_cursor, round, assessor, capability,
           status, snapshot_json, packet_json, raw_json, pre_guard_json, post_guard_json, error_code, error_detail, wait_until, created_at, completed_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.request_id, row.ticket_id, row.task_revision, row.assignment_id, row.memory_cursor, row.event_cursor, row.round,
        row.assessor, row.capability, row.status, row.snapshot_json, row.packet_json, row.raw_json, row.pre_guard_json,
        row.post_guard_json, row.error_code, row.error_detail, row.wait_until, row.created_at, row.completed_at,
      )
  }

  finish(requestId: string, patch: Partial<Pick<AssessmentRow, 'status' | 'raw_json' | 'pre_guard_json' | 'post_guard_json' | 'error_code' | 'error_detail' | 'wait_until' | 'completed_at'>>): void {
    const current = this.get(requestId)
    if (!current) return
    const next = { ...current, ...patch }
    this.handle
      .prepare(
        `UPDATE assessments SET status = ?, raw_json = ?, pre_guard_json = ?, post_guard_json = ?, error_code = ?, error_detail = ?,
           wait_until = ?, completed_at = ? WHERE request_id = ?`,
      )
      .run(next.status, next.raw_json, next.pre_guard_json, next.post_guard_json, next.error_code, next.error_detail, next.wait_until, next.completed_at, requestId)
  }

  get(requestId: string): AssessmentRow | undefined {
    return this.handle.prepare('SELECT * FROM assessments WHERE request_id = ?').get(requestId) as AssessmentRow | undefined
  }

  list(ticketId?: string): AssessmentRow[] {
    return (ticketId
      ? this.handle.prepare('SELECT * FROM assessments WHERE ticket_id = ? ORDER BY created_at, request_id').all(ticketId)
      : this.handle.prepare('SELECT * FROM assessments ORDER BY created_at, request_id').all()) as unknown as AssessmentRow[]
  }

  latestForIdentity(id: Pick<AssessmentIdentity, 'ticketId' | 'taskRevision' | 'assignmentId' | 'memoryCursor' | 'eventCursor'>): AssessmentRow | undefined {
    return this.handle
      .prepare(
        `SELECT * FROM assessments WHERE ticket_id = ? AND task_revision = ? AND assignment_id = ? AND memory_cursor = ? AND event_cursor = ?
         ORDER BY round DESC, created_at DESC LIMIT 1`,
      )
      .get(id.ticketId, id.taskRevision, id.assignmentId, id.memoryCursor, id.eventCursor) as AssessmentRow | undefined
  }

  /** 进程重启：上一进程的 pending 请求已无人等待，标为 abandoned（保留行），由新进程按同身份下一轮重新请求。 */
  abandonPending(at: string): number {
    const rows = this.handle.prepare(`SELECT request_id FROM assessments WHERE status = 'pending'`).all() as { request_id: string }[]
    for (const row of rows) this.finish(row.request_id, { status: 'abandoned', error_code: 'process_restart', error_detail: 'host restarted before submit', completed_at: at })
    return rows.length
  }
}

/** 草案意图 → 既有 DecisionKind。act 只能选菜单动作（continue_local / notify_result / ask_user）。 */
export function intentKind(draft: AssessmentDraft, menu: readonly ActionTemplate[]): DecisionKind | null {
  switch (draft.intent) {
    case 'ask_now':
      return 'ask_user'
    case 'wait':
      return 'defer'
    case 'digest':
    case 'none':
      return 'record_only'
    case 'act': {
      const template = menu.find((item) => item.actionId === draft.actionId)
      return template ? template.kind : null
    }
    default:
      return null
  }
}

export function refKey(ref: EvidenceRef): string {
  return JSON.stringify(ref)
}

/** 把未知 JSON 解析为草案列表；结构不对时抛出带 parse_error 前缀的错误（不得静默成功）。 */
export function parseDrafts(value: unknown): AssessmentDraft[] {
  const list = Array.isArray(value) ? value : (value as { drafts?: unknown })?.drafts
  if (!Array.isArray(list) || list.length === 0) throw new Error('parse_error: drafts must be a non-empty array')
  const intents: readonly AssessmentIntent[] = ['ask_now', 'wait', 'act', 'digest', 'none']
  return list.map((item, index) => {
    const draft = item as AssessmentDraft
    if (!draft || typeof draft !== 'object') throw new Error(`parse_error: draft ${index} is not an object`)
    if (!intents.includes(draft.intent)) throw new Error(`parse_error: draft ${index} intent ${String(draft.intent)}`)
    if (typeof draft.reasonText !== 'string' || !draft.reasonText.trim()) throw new Error(`parse_error: draft ${index} reasonText missing`)
    return draft
  })
}
