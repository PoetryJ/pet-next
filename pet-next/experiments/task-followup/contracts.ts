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

/**
 * 执行输入身份：一次工具执行、回执与分析必须绑定同一组来源事实。
 * R4.1 起它是 effect/receipt/analysis 的必需字段；缺失即 fail closed，不补写。
 */
export interface InputRef {
  readonly taskId: string
  readonly taskRevision: number
  readonly assignmentId: string
  /** inbox 来源稳定键，例如 inbox/E17/run-01。 */
  readonly sourceId: string
  /** 来源修订键 r{revision}:{artifactSha16}。 */
  readonly sourceRevision: string
  readonly runId: string
  readonly revision: number
  /** result.json 自身字节 SHA；解析必须基于这份字节。 */
  readonly resultFileSha: string
  /** 结果引用的 artifact 字节 SHA。 */
  readonly artifactSha: string
  readonly resultPath: string | null
  readonly artifactPath: string | null
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
  /** 执行时实际核验过的输入身份；老格式回执为 null，completion 必须拒绝。 */
  readonly inputRef: InputRef | null
  /** 工具实际读取的字节是否与 inputRef 声明一致。 */
  readonly inputsVerified: boolean
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
  /** 已核验的输入身份；工具只允许基于这份身份读取不可变快照。 */
  readonly inputRef: InputRef
  /** 工作区内不可变快照路径（内容 SHA = inputRef.resultFileSha）。 */
  readonly resultSnapshotPath: string
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
  /** 实现标识：scripted-rule（P3/N1 基线）或 async-assessment（事务外 assessment 回交，经同一套校验执行）。 */
  readonly implementation: 'scripted-rule' | 'async-assessment'
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
  /** 第一次进入通知队列的时间。 */
  readonly notifiedAt?: string
  /** 通道确认送达的时间；只有送达/呈现后模拟用户才能回应。 */
  readonly deliveredAt?: string
  /** 明确打开面板并实际呈现该问题的时间。 */
  readonly presentedAt?: string
}

export type AnswerResult =
  | { readonly ok: true; readonly attention: AttentionView; readonly answerEventId: string }
  | {
      readonly ok: false
      readonly code: 'unknown_attention' | 'stale_answer' | 'already_answered' | 'invalid_option' | 'not_visible' | 'needs_reconciliation'
      readonly detail: string
    }

/** AttentionPort：问题必须有当前版本、证据、具体选择与等待原因。 */
/** 可见性回执：只有 delivered/presented 之后，模拟用户才能回应。 */
export interface VisibilityReceipt {
  readonly attentionId: string
  readonly visible: boolean
  readonly via: 'delivered' | 'presented' | null
  readonly at: string | null
  readonly queuedAt: string | null
}

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
  /** 通道把排队通知标记为送达；返回本次送达条数。 */
  deliverPending(now: string): readonly string[]
  /** 用户明确打开面板：把仍有效的问题标记为已呈现；返回本次呈现的 attentionId。 */
  present(ticketId: string, now: string): readonly string[]
  /** 报告某个问题的可核验可见性。 */
  visibility(attentionId: string): VisibilityReceipt
}

export interface AnswerInput {
  readonly attentionId: string
  readonly taskRevision: number
  readonly optionId: string
  readonly now: string
  readonly sourceId: string
}

/**
 * 显式应用时区（IANA）。禁止依赖宿主 TZ：同一配置在 Linux/Windows 必须给出同一语义。
 * R4.1 起进入 quiet 配置并计入 configSha 与 raw。
 */
export const DEFAULT_TIMEZONE = 'UTC' as const

/** 校验 IANA 时区名；非法值必须显式失败，不回退到宿主时区。 */
export function normalizeTimeZone(timeZone: string): string {
  const candidate = timeZone.trim()
  if (!candidate) throw new Error('timezone must not be empty')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(0)
  } catch {
    throw new Error(`invalid IANA timezone: ${candidate}`)
  }
  return candidate
}

/** 显式配置的静默/额度；不得从行为推断用户永久偏好。 */
export interface QuietConfig {
  /** IANA 时区，例如 UTC / Asia/Shanghai；所有静默与截止判断都用它。 */
  readonly timezone: string
  /** 该时区的本地小时，[fromHour, toHour) 为静默；相等表示无静默。 */
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
  timezone: DEFAULT_TIMEZONE,
  fromHour: 23,
  toHour: 7,
  allowUrgent: false,
  reminderQuotaPerHour: 3,
  minGapMs: 15 * 60_000,
  cooldownMs: 30 * 60_000,
  deadlineHour: 9,
}

export interface QuietInput extends Partial<QuietConfig> {
  readonly timezone?: string
}

/** 解析并规范化一份 quiet 配置；显式 timezone 优先，未给则用 fallback。 */
export function resolveQuiet(quiet: QuietInput | undefined, fallback: QuietConfig = DEFAULT_QUIET): QuietConfig {
  const merged: QuietConfig = { ...fallback, ...(quiet ?? {}) }
  return { ...merged, timezone: normalizeTimeZone(merged.timezone) }
}

/** 规则版本与配置指纹：日志里必须同时记录，避免“调阈值调赢”。 */
export const DECISION_RULE_VERSION = 'followup-rules/v1'
export const POLICY_IDS = ['P0', 'P1', 'P2', 'P3'] as const
export type PolicyId = (typeof POLICY_IDS)[number]
/** R5 对照用的策略集合：P3（原基线）与 N1（强简单规则）。 */
export const R5_POLICY_IDS = ['P3', 'N1'] as const
export type R5PolicyId = PolicyId | 'N1'

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
  /** 当前版本的输入是否已可核验（决定恢复入口能否现在就提问）。 */
  readonly inputReady: boolean
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
  readonly id: R5PolicyId
  readonly implementation: 'scripted-rule'
  readonly configSha: string
  propose(context: DecisionContext): readonly ProposedDecision[]
}

export type TaskStage =
  | 'awaiting_result'
  | 'result_received'
  | 'awaiting_decision'
  | 'continuation_pending'
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

/**
 * 已知的“执行前拒绝”留下的续办状态：用户授权已消耗但工具未执行。
 * 只允许在输入恢复且用户再次明确授权后创建新 attempt；不得自动重试。
 */
export interface ContinuationState {
  readonly kind: 'input_rejected'
  readonly detail: string
  readonly effectId: string
  /** 被拒绝时所在的 attempt；新授权会在此基础上 +1。 */
  readonly attempt: number
  /** 被消耗的授权（证据）：decisionId 与 optionId。 */
  readonly decisionId: string | null
  readonly optionId: string | null
  readonly at: string
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
  readonly continuation?: ContinuationState
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
    /** 生成该分析时的输入身份；老数据缺失时必须 fail closed。 */
    readonly inputRef?: InputRef | null
  }
  readonly completion?: {
    readonly at: string
    readonly receiptId: string | null
    readonly artifactSha: string | null
    readonly checkedPaths: readonly string[]
    readonly inputRef?: InputRef | null
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
  /** 当前完成核验；老库里的 completed 状态必须在这里也能通过才算有效。 */
  readonly completionCheck: CompletionCheck
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
  /** 当前权威输入；用于和 receipt/analysis 的 inputRef 逐项比较。 */
  readonly inputRef: InputRef | null
  /** 输入一致性的独立结论，供评分区分“状态完成”和“有效完成”。 */
  readonly inputConsistent: boolean
  readonly unresolvedEffects: readonly string[]
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

/** 通知可见性状态：排队 → 送达 → 呈现；回答只认送达/呈现。 */
export type NotificationState = 'queued' | 'delivered' | 'presented'

export interface NotificationReceipt {
  readonly notificationId: string
  readonly ticketId: string
  readonly attentionId: string | null
  readonly decisionId: string | null
  readonly text: string
  readonly state: NotificationState
  readonly createdAt: string
  readonly deliveredAt: string | null
  readonly presentedAt: string | null
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
      readonly notifiedAt?: string
      readonly deliveredAt?: string
      readonly presentedAt?: string
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
    readonly state: NotificationState
  }): void
  markNotification(
    notificationId: string,
    patch: { readonly state: NotificationState; readonly at: string },
  ): void
  getNotification(notificationId: string): NotificationReceipt | undefined
  listNotificationReceipts(ticketId?: string): readonly NotificationReceipt[]
  countNotificationsSince(ticketId: string, sinceIso: string): number
  lastNotificationAt(ticketId: string): string | null
  hasNotificationForAttention(attentionId: string): boolean
  hasDeliveredNotificationForAttention(attentionId: string): boolean
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

interface ZonedParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

/** 把一个瞬时按显式 IANA 时区拆成墙钟分量；不读宿主 TZ。 */
export function zonedParts(iso: string, timeZone: string): ZonedParts | null {
  const instant = Date.parse(iso)
  if (!Number.isFinite(instant)) return null
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeTimeZone(timeZone),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const values: Record<string, number> = {}
  for (const part of formatter.formatToParts(new Date(instant))) {
    if (part.type === 'literal') continue
    values[part.type] = Number(part.value)
  }
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  }
}

/** 指定瞬时在该时区的 UTC 偏移（毫秒）。 */
export function zoneOffsetMs(iso: string, timeZone: string): number {
  const instant = Date.parse(iso)
  const parts = zonedParts(iso, timeZone)
  if (!Number.isFinite(instant) || !parts) return 0
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUtc - instant
}

/** 把该时区的墙钟时间换算成瞬时；UTC/Asia-Shanghai 无 DST，迭代一次即可。 */
export function zonedWallToInstant(
  wall: { year: number; month: number; day: number; hour: number; minute?: number },
  timeZone: string,
): string {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute ?? 0, 0, 0)
  let instant = naive - zoneOffsetMs(new Date(naive).toISOString(), timeZone)
  instant = naive - zoneOffsetMs(new Date(instant).toISOString(), timeZone)
  return new Date(instant).toISOString()
}

/** 该瞬时在显式时区的小时（0..23）。 */
export function zonedHour(iso: string, timeZone: string): number | null {
  return zonedParts(iso, timeZone)?.hour ?? null
}

/** 是否落在显式静默时段；时区非法直接抛错，不回退宿主 TZ。 */
export function isQuietAt(iso: string, quiet: QuietConfig): boolean {
  if (quiet.fromHour === quiet.toHour) return false
  const hour = zonedHour(iso, quiet.timezone)
  if (hour === null) return false
  return quiet.fromHour < quiet.toHour
    ? hour >= quiet.fromHour && hour < quiet.toHour
    : hour >= quiet.fromHour || hour < quiet.toHour
}

/** 静默结束时刻；不在静默中返回原时刻。 */
export function quietEndsAt(iso: string, quiet: QuietConfig): string {
  if (!isQuietAt(iso, quiet)) return iso
  const parts = zonedParts(iso, quiet.timezone)
  if (!parts) return iso
  const current = Date.parse(iso)
  const candidate = zonedWallToInstant(
    { year: parts.year, month: parts.month, day: parts.day, hour: quiet.toHour },
    quiet.timezone,
  )
  if (Date.parse(candidate) > current) return candidate
  const nextDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1))
  return zonedWallToInstant(
    { year: nextDay.getUTCFullYear(), month: nextDay.getUTCMonth() + 1, day: nextDay.getUTCDate(), hour: quiet.toHour },
    quiet.timezone,
  )
}

/** 该时区下一个整点 hour（若已过则顺延到明天）。 */
export function nextZonedHour(iso: string, hour: number, timeZone: string): string {
  const parts = zonedParts(iso, timeZone)
  if (!parts) return iso
  const candidate = zonedWallToInstant(
    { year: parts.year, month: parts.month, day: parts.day, hour },
    timeZone,
  )
  if (Date.parse(candidate) > Date.parse(iso)) return candidate
  const nextDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1))
  return zonedWallToInstant(
    { year: nextDay.getUTCFullYear(), month: nextDay.getUTCMonth() + 1, day: nextDay.getUTCDate(), hour },
    timeZone,
  )
}

/** 毫秒差；时间非法时按 0 处理，不猜。 */
export function millisBetween(from: string, to: string): number {
  const a = Date.parse(from)
  const b = Date.parse(to)
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : 0
}

// ---------------------------------------------------------------- R5 持久唤醒

/** 唤醒原因：只影响可读日志与去重键，不改变策略判断。 */
export type WakeReason = 'defer' | 'quiet' | 'cooldown' | 'continuation' | 'deadline' | 'catch_up'

export type WakeStatus = 'scheduled' | 'claimed' | 'done' | 'cancelled'

/**
 * 持久唤醒记录。jobId 稳定；同一 task/revision/reason/decision 只保留一条有效记录。
 * 任何身份字段缺失的 job 都不得执行（见 Scheduler.claim）。
 */
export interface WakeJob {
  readonly jobId: string
  readonly ticketId: string
  readonly taskRevision: number
  readonly assignmentId: string | null
  readonly reason: WakeReason
  readonly decisionId: string | null
  readonly sourceId: string | null
  readonly sourceRevision: string | null
  readonly dueAt: string
  readonly status: WakeStatus
  readonly attempts: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly detail: string | null
}

export interface WakeScheduleInput {
  readonly ticketId: string
  readonly taskRevision: number
  readonly assignmentId: string | null
  readonly reason: WakeReason
  readonly decisionId?: string | null
  readonly sourceId?: string | null
  readonly sourceRevision?: string | null
  readonly dueAt: string
  readonly detail?: string | null
}

export interface WakeHandleResult {
  readonly action: 'woken' | 'stale' | 'cancelled' | 'none' | 'blocked'
  readonly jobId: string
  readonly detail: string
  readonly proposals: number
  readonly notifications: number
}
