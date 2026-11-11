/**
 * R4 持续任务跟进实验的冻结契约 v1。
 *
 * 本文件只放类型、常量、端口形状与确定性纯函数。任何实现（runtime/memory-bridge/
 * decision/attention/tools/eval/demo）都必须通过这里的端口通信；接口变更只能由集成
 * 负责人先改本文件并同步调用方。
 *
 * 边界（来自任务包 CONTRACT.txt）：
 * 1) 上游 SuperAgent core 固定 8c32a9d，15 文件字节不改，只复用纯核心；
 * 2) SQLite 存权威事件，R3.1 记忆由这些事件重建，不承诺跨库原子写；
 * 3) 提案、执行前、通知入队前各做一次版本校验，旧 assignment 报告在调用 Engine.report
 *    之前就被桥接器挡住；
 * 4) 决策规则是 scripted-rule，不读 gold、不按 scenarioId 分支、不调用模型；
 * 5) 时间只经 ClockPort 注入，可回放。
 *
 * @module pet-next/experiments/task-followup/contracts
 */
import { createHash } from 'node:crypto'

/** 入站事件信封版本。 */
export const EVENT_SCHEMA = 'pet-followup-event/v1' as const
/** 结果文件版本（本地 inbox 的 result.json）。 */
export const RESULT_SCHEMA = 'pet-followup-result/v1' as const
/** 状态导出与评估结果版本。 */
export const STATE_SCHEMA = 'pet-followup-state/v1' as const
export const RESULT_BUNDLE_SCHEMA = 'pet-followup-eval/v1' as const

/** 入站事件种类。最少覆盖任务包要求。 */
export type FollowupEventKind =
  | 'user.delegated'
  | 'user.changed'
  | 'user.cancelled'
  | 'user.answered'
  | 'artifact.observed'
  | 'tool.receipt'
  | 'clock.advanced'

export const FOLLOWUP_EVENT_KINDS: readonly FollowupEventKind[] = [
  'user.delegated',
  'user.changed',
  'user.cancelled',
  'user.answered',
  'artifact.observed',
  'tool.receipt',
  'clock.advanced',
]

/**
 * 本地事件信封。contentSha256 由入站路径按 kind/payload/source 身份重算，
 * 调用方自报的值一律不采信；payload 只含判定需要的公开事实，不含 gold、
 * 应选策略、故事 ID 分支或预期得分。
 */
export interface FollowupEvent<P extends Record<string, unknown> = Record<string, unknown>> {
  readonly schema: typeof EVENT_SCHEMA
  readonly eventId: string
  /** 来源稳定键；同 sourceId 的同一 sourceRevision 只生效一次。 */
  readonly sourceId: string
  readonly sourceRevision: string | null
  readonly observedAt: string
  readonly ticketId: string | null
  readonly taskRevision: number | null
  readonly kind: FollowupEventKind
  readonly payload: P
  readonly contentSha256: string
}

/** 实验结果的公开事实。revision 单调，同 runId 的新 revision 才是更正。 */
export interface ArtifactPayload {
  readonly experimentId: string
  readonly runId: string
  /** 同一 runId 的结果修订号；旧 revision 不能覆盖新值。 */
  readonly revision: number
  readonly status: 'succeeded' | 'failed' | 'partial'
  readonly metrics: {
    readonly total: number
    readonly passed: number
    readonly failed: number
    /** 0..1；不足或缺失时按 status 判定，不推断。 */
    readonly score: number | null
  }
  /** 受控工作区内的相对路径。 */
  readonly artifactPath: string | null
  readonly artifactSha: string
  /** result.json 自身内容 SHA；用于同一文件去重与证据绑定。 */
  readonly resultFileSha: string
  /** 可选的公开说明，例如 "11 cases failed on sample set B"。 */
  readonly note?: string
}

/** 证据引用：来源身份 + 内容指纹 + R3.1 记忆节点版本。 */
export interface EvidenceRef {
  readonly sourceId: string
  readonly sourceRevision: string
  readonly sha256: string
  readonly memoryEventIds: readonly string[]
  readonly noteIds: readonly string[]
  readonly noteVersions: Readonly<Record<string, number>>
}

/** 记忆事实的权威类别，对应任务包的三类证据身份。 */
export type FactAuthority = 'user_said' | 'commitment' | 'tool_verified'

export interface MemoryFact {
  readonly memoryEventId: string
  readonly kind: string
  readonly authority: FactAuthority
  readonly text: string
  /** task revision at which the fact was recorded; null for non-task facts. */
  readonly taskRevision: number | null
  readonly sourceId: string
  readonly sourceRevision: string | null
  readonly sha256: string | null
  readonly eventId: string
  readonly eventCursor: number
  readonly noteIds: readonly string[]
  readonly noteVersions: Readonly<Record<string, number>>
}

export interface MemoryReading {
  /** 记忆投影已追上的权威事件序号。 */
  readonly cursor: number
  readonly facts: readonly MemoryFact[]
  readonly notes: readonly { readonly noteId: string; readonly text: string; readonly version: number; readonly status: string }[]
  readonly diagnostics: readonly string[]
}

export type EvidenceCode =
  | 'ok'
  | 'unknown_event'
  | 'stale_revision'
  | 'stale_assignment'
  | 'sha_mismatch'
  | 'cursor_behind'
  | 'note_stale'
  | 'task_cancelled'

export interface EvidenceVerdict {
  readonly ok: boolean
  readonly code: EvidenceCode
  readonly detail: string
  readonly refs: readonly EvidenceRef[]
}

/**
 * MemoryPort：从已持久事件重建/读取 R3.1 状态。
 * 允许小规模全量重放，不编性能优势；复用 R3.1 reduce/applyPatch，不另发明记忆规则。
 */
export interface MemoryPort {
  /** 把一条权威事件投影进记忆；在调用方事务内执行，成功后 cursor 前进。 */
  ingest(input: MemoryIngestInput): MemoryIngestResult
  /** 重建整个投影（恢复/修复用），返回追赶后的 cursor。 */
  rebuild(): number
  readRelevant(ticket: TaskSnapshot, query: string): MemoryReading
  validate(refs: readonly EvidenceRef[]): EvidenceVerdict
  /** 当前已投影到的权威事件序号。 */
  cursor(): number
}

export interface MemoryIngestInput {
  readonly event: FollowupEvent
  readonly eventCursor: number
  readonly ticketId: string
  readonly taskRevision: number
  /** 人类可读的来源标签，例如“用户委托”“inbox/result.json”。 */
  readonly label: string
}

export interface MemoryIngestResult {
  readonly memoryEventId: string
  readonly cursor: number
  readonly noteIds: readonly string[]
  readonly noteVersions: Readonly<Record<string, number>>
}

/** 三种受控工具；没有任意 shell、远程任务或模型接口。 */
export type ToolName = 'inspect_artifact' | 'compare_metrics' | 'write_analysis'

export const TOOL_NAMES: readonly ToolName[] = ['inspect_artifact', 'compare_metrics', 'write_analysis']

export interface ToolRequest {
  readonly tool: ToolName
  readonly args: Readonly<Record<string, string | number | boolean>>
}

export interface ToolReceipt {
  readonly receiptId: string
  readonly effectId: string
  readonly attemptId: string
  readonly ticketId: string
  readonly taskRevision: number
  readonly assignmentId: string
  readonly tool: ToolName
  readonly ok: boolean
  readonly outputPath: string | null
  readonly outputSha256: string | null
  readonly bytesWritten: number
  readonly bytesRead: number
  readonly startedAt: string
  readonly finishedAt: string
  readonly detail: string
  /** 无法确认结果时必须进入人工/显式下一步，不得盲重试。 */
  readonly needsReconciliation: boolean
}

export interface ToolExecution {
  readonly receipt: ToolReceipt
  readonly payload: Readonly<Record<string, unknown>>
}

/** 本地执行端口。实现在 tools/，runtime 只经此接口调用。 */
export interface ToolPort {
  execute(request: ToolRequest, context: ToolContext): ToolExecution
}

export interface ToolContext {
  readonly effectId: string
  readonly attemptId: string
  readonly ticketId: string
  readonly taskRevision: number
  readonly assignmentId: string
  readonly now: string
}

/** 决策种类。 */
export type DecisionKind = 'record_only' | 'continue_local' | 'defer' | 'ask_user' | 'notify_result'

export const DECISION_KINDS: readonly DecisionKind[] = [
  'record_only',
  'continue_local',
  'defer',
  'ask_user',
  'notify_result',
]

export interface AttentionOption {
  readonly id: string
  readonly label: string
}

/**
 * ProposedDecision：一条带版本绑定的提案。
 * decisionKey 用来合并“同一个待用户决定的问题”；toolRequest 只对 continue_local 有意义。
 */
export interface ProposedDecision {
  readonly decisionId: string
  readonly ticketId: string
  readonly taskRevision: number
  readonly assignmentId: string
  readonly evidenceRefs: readonly EvidenceRef[]
  readonly kind: DecisionKind
  readonly reasonCode: string
  readonly reasonText: string
  readonly decisionKey?: string
  readonly question?: string
  readonly options?: readonly AttentionOption[]
  readonly notBefore?: string
  readonly deadline?: string
  readonly toolRequest?: ToolRequest
  /** 规则实现标识；当前固定 scripted-rule。 */
  readonly implementation: 'scripted-rule'
}

export type AttentionState = 'open' | 'answered' | 'superseded' | 'expired' | 'stale_answer'

export interface AttentionView {
  readonly attentionId: string
  readonly ticketId: string
  readonly taskRevision: number
  readonly assignmentId: string
  readonly decisionId: string
  readonly decisionKey: string
  readonly question: string
  readonly options: readonly AttentionOption[]
  readonly evidenceRefs: readonly EvidenceRef[]
  readonly state: AttentionState
  readonly createdAt: string
  readonly answeredAt?: string
  readonly answer?: { readonly optionId: string; readonly label: string }
  readonly notBefore?: string
  readonly deadline?: string
}

export type AnswerResult =
  | { readonly ok: true; readonly attention: AttentionView; readonly answerEventId: string }
  | { readonly ok: false; readonly code: 'unknown_attention' | 'stale_answer' | 'already_answered' | 'invalid_option'; readonly detail: string }

/** AttentionPort：问题必须有当前版本、证据、具体选择与等待原因。 */
export interface AttentionPort {
  /** 同 decisionKey 的 open 问题合并；返回 merged 表示没有新建第二问。 */
  open(proposal: ProposedDecision, now: string, quiet: QuietConfig): { readonly attention: AttentionView; readonly merged: boolean }
  /**
   * 把问题放入可见通知队列。静默/额度/最小间隔在这里统一执行；
   * urgent 只在显式 allowUrgent 时越过静默，默认 false。
   */
  notify(
    attentionId: string,
    now: string,
    quiet: QuietConfig,
    urgent: boolean,
  ): { readonly notified: boolean; readonly reason: string; readonly notificationId?: string }
  answer(input: AnswerInput): AnswerResult
  /** 更正/取消后撤销旧问题（保留记录，不删除）。 */
  supersede(ticketId: string, taskRevision: number, reason: string, now: string): readonly AttentionView[]
  listOpen(ticketId?: string): readonly AttentionView[]
  get(attentionId: string): AttentionView | undefined
}

export interface AnswerInput {
  readonly attentionId: string
  readonly taskRevision: number
  readonly optionId: string
  readonly now: string
  readonly sourceId: string
}

/** 显式配置的静默/额度；不得从行为推断用户永久偏好。 */
export interface QuietConfig {
  /** 本地小时，[fromHour, toHour) 为静默；相等表示无静默。 */
  readonly fromHour: number
  readonly toHour: number
  /** 默认 false：静默期间一律不打扰。 */
  readonly allowUrgent: boolean
  /** 每滚动小时最多主动提醒数。 */
  readonly reminderQuotaPerHour: number
  /** 两次主动打扰最小间隔（毫秒）。 */
  readonly minGapMs: number
  /** 同一 decisionKey 的冷却（毫秒）；P2/P3 共用。 */
  readonly cooldownMs: number
  /** 任务截止时间；用于判断“必要决策”是否紧急。 */
  readonly deadlineHour: number
}

export const DEFAULT_QUIET: QuietConfig = {
  fromHour: 23,
  toHour: 7,
  allowUrgent: false,
  reminderQuotaPerHour: 3,
  minGapMs: 15 * 60_000,
  cooldownMs: 30 * 60_000,
  deadlineHour: 9,
}

/** 规则版本与配置指纹：日志里必须同时记录，避免“调阈值调赢”。 */
export const DECISION_RULE_VERSION = 'followup-rules/v1'
export const POLICY_IDS = ['P0', 'P1', 'P2', 'P3'] as const
export type PolicyId = (typeof POLICY_IDS)[number]

export function configSha(config: unknown): string {
  return sha256Hex(canonicalJson(config))
}

/** 决策端口看到的只读上下文。 */
export interface DecisionContext {
  readonly task: TaskSnapshot
  readonly trigger: FollowupEvent | null
  readonly evidence: readonly EvidenceRef[]
  readonly memory: MemoryReading
  readonly now: string
  readonly quiet: QuietConfig
  /** 该任务已发生的主动打扰（按时间升序）。 */
  readonly history: readonly ProposalSummary[]
  readonly openAttention?: AttentionView
  /** 目标条件是否已由核验产物满足。 */
  readonly goalSatisfied: boolean
  readonly lastAnswer?: { readonly optionId: string; readonly at: string }
  readonly attempt: number
}

export interface ProposalSummary {
  readonly decisionId: string
  readonly kind: DecisionKind
  readonly decisionKey: string
  readonly reasonCode: string
  readonly createdAt: string
  readonly taskRevision: number
  readonly outcome: 'open' | 'executed' | 'invalidated' | 'merged' | 'expired' | 'recorded'
}

/** DecisionPort：透明确定性规则；未来 LLM 可实现同接口，本轮不启用。 */
export interface DecisionPort {
  readonly id: PolicyId
  readonly implementation: 'scripted-rule'
  readonly configSha: string
  propose(context: DecisionContext): readonly ProposedDecision[]
}

export type TaskStage =
  | 'awaiting_result'
  | 'result_received'
  | 'awaiting_decision'
  | 'analyzing'
  | 'completed'
  | 'cancelled'
  | 'memory_behind'
  | 'needs_reconciliation'
  | 'failed'

export type TaskStatus = 'active' | 'completed' | 'cancelled' | 'failed'

/** 目标条件：完成必须同时满足“成功回执”和“当前目标条件”。 */
export interface GoalCondition {
  readonly requireResultArtifact: boolean
  readonly requireAnalysisArtifact: boolean
  /** 分析产物必须由受控工具写入且带上回执。 */
  readonly requireReceipt: boolean
  /** 结果状态为这些值时视为“结果不足”，需要用户选择下一步。 */
  readonly insufficientStatuses: readonly ('succeeded' | 'failed' | 'partial')[]
}

export interface TaskSnapshot {
  readonly ticketId: string
  readonly title: string
  readonly goal: string
  readonly goalCondition: GoalCondition
  readonly taskRevision: number
  readonly assignmentId: string | null
  readonly stage: TaskStage
  readonly status: TaskStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly eventCursor: number
  readonly memoryCursor: number
  readonly evidence: readonly EvidenceRef[]
  readonly openAttention?: AttentionView
  readonly lastProposal?: ProposalSummary
  readonly lastAnswer?: { readonly optionId: string; readonly at: string }
  readonly attempt: number
  readonly result?: {
    readonly runId: string
    readonly revision: number
    readonly status: string
    readonly metrics: ArtifactPayload['metrics']
    readonly artifactPath: string | null
    readonly artifactSha: string
    readonly resultPath: string | null
    readonly resultFileSha: string
    readonly note?: string
  }
  readonly analysis?: {
    readonly artifactPath: string
    readonly artifactSha: string
    readonly receiptId: string
  }
  readonly completion?: {
    readonly at: string
    readonly receiptId: string | null
    readonly artifactSha: string | null
    readonly checkedPaths: readonly string[]
  }
  readonly closeReason?: string
  readonly diagnostics: readonly string[]
}

export const DEFAULT_GOAL: GoalCondition = {
  requireResultArtifact: true,
  requireAnalysisArtifact: false,
  requireReceipt: true,
  insufficientStatuses: ['failed', 'partial'],
}

/** 任务状态导出的信封，demo / eval / 重评命令共用。 */
export interface TaskStateExport {
  readonly schema: typeof STATE_SCHEMA
  readonly generatedAt: string
  readonly ticketId: string
  readonly task: TaskSnapshot
  readonly upstream: {
    readonly ticket: { readonly id: string; readonly title: string; readonly ended?: unknown; readonly attention?: unknown; readonly assignment?: string }
    readonly events: readonly FollowupEvent[]
  }
  readonly decisions: readonly ProposalSummary[]
  readonly receipts: readonly ToolReceipt[]
}

/** 时钟端口：逻辑全部可回放；真实 watch 仍用真实时钟。 */
export interface ClockPort {
  now(): string
  advance(ms: number): string
  readonly kind: 'real' | 'fake'
}

/** 工具/观察事实：由 watch 从真实文件读出，先验 SHA 再转事件。 */
export interface ObservedArtifact {
  readonly sourceId: string
  readonly sourceRevision: string
  readonly path: string
  readonly sha256: string
  readonly payload: ArtifactPayload
  readonly observedAt: string
}

/** 摄取结果。duplicate 表示同 eventId/同来源修订已生效，不得重做。 */
export interface IngestOutcome {
  readonly disposition: 'appended' | 'duplicate' | 'stale_revision' | 'ignored'
  readonly eventId: string
  readonly eventCursor: number
  readonly detail: string
}

/** 完成检查：必须读产物与 SHA，不能信 worker 说“完成”。 */
export interface CompletionCheck {
  readonly ok: boolean
  readonly reasons: readonly string[]
  readonly receiptId: string | null
  readonly artifactPath: string | null
  readonly artifactSha: string | null
  readonly checkedPaths: readonly string[]
}

/**
 * 记忆投影的持久端口（由 runtime 的 SQLite 实现）。
 * memory-bridge 只经此端口写投影，不直接碰 runtime 表结构。
 */
export interface MemoryStorePort {
  appendMemoryEvent(row: { readonly memoryEventId: string; readonly sequence: number; readonly json: string }): void
  appendMemoryPatch(row: { readonly opId: string; readonly sequence: number; readonly json: string }): void
  readMemoryEvents(): readonly { readonly memoryEventId: string; readonly sequence: number; readonly json: string }[]
  readMemoryPatches(): readonly { readonly opId: string; readonly sequence: number; readonly json: string }[]
  clearProjection(): void
}

/** 注意力/通知的持久端口（由 runtime 的 SQLite 实现）。 */
export interface AttentionStore {
  insertAttention(row: AttentionView, reason: string): void
  updateAttention(
    attentionId: string,
    patch: {
      readonly state?: AttentionState
      readonly answeredAt?: string
      readonly answerOptionId?: string
      readonly answerLabel?: string
    },
  ): void
  getAttention(attentionId: string): AttentionView | undefined
  listAttentions(ticketId?: string): readonly AttentionView[]
  insertNotification(row: {
    readonly notificationId: string
    readonly ticketId: string
    readonly attentionId: string | null
    readonly decisionId: string | null
    readonly text: string
    readonly createdAt: string
  }): void
  countNotificationsSince(ticketId: string, sinceIso: string): number
  lastNotificationAt(ticketId: string): string | null
  hasNotificationForAttention(attentionId: string): boolean
}

/** 确定性序列化（键排序），用于摘要与重评。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortValue(item))
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) out[key] = sortValue(record[key])
    return out
  }
  return value
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 事件内容指纹：只含判定需要的事实，不含记录时间与自报 hash。 */
export function eventContentDigest(input: {
  kind: FollowupEventKind
  sourceId: string
  sourceRevision: string | null
  ticketId: string | null
  taskRevision: number | null
  payload: unknown
}): string {
  return sha256Hex(
    canonicalJson({
      kind: input.kind,
      sourceId: input.sourceId,
      sourceRevision: input.sourceRevision,
      ticketId: input.ticketId,
      taskRevision: input.taskRevision,
      payload: input.payload,
    }),
  )
}

/** 内容派生的稳定 id：同输入同 id，便于去重与回放。 */
export function stableId(prefix: string, ...parts: readonly (string | number | null)[]): string {
  return `${prefix}-${sha256Hex(canonicalJson(parts)).slice(0, 24)}`
}

/** 本地时间是否落在显式静默时段。 */
export function isQuietAt(iso: string, quiet: QuietConfig): boolean {
  if (quiet.fromHour === quiet.toHour) return false
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return false
  const hour = date.getHours()
  return quiet.fromHour < quiet.toHour
    ? hour >= quiet.fromHour && hour < quiet.toHour
    : hour >= quiet.fromHour || hour < quiet.toHour
}

/** 静默结束时刻；不在静默中返回原时刻。 */
export function quietEndsAt(iso: string, quiet: QuietConfig): string {
  if (!isQuietAt(iso, quiet)) return iso
  const date = new Date(iso)
  const end = new Date(date)
  end.setHours(quiet.toHour, 0, 0, 0)
  if (end.getTime() <= date.getTime()) end.setDate(end.getDate() + 1)
  return end.toISOString()
}

/** 毫秒差；时间非法时按 0 处理，不猜。 */
export function millisBetween(from: string, to: string): number {
  const a = Date.parse(from)
  const b = Date.parse(to)
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : 0
}
