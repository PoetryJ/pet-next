/**
 * FollowupRuntime：上游 SuperAgent Engine 的本地适配层。
 *
 * 复用边界：
 * - Ticket = 长期委托；Assignment = 一次执行；Input = 到达的信息；
 *   Attention = 用户问题；Report = 状态回报。
 * - 上游不认识 taskRevision/evidence/P3 规则；这些都在本层与 SQLite 里，
 *   不修改上游 15 文件。
 * - 引擎命令在同一事务里写聚合与 effect；提交后才派发 effect（工具/启动/投递）。
 * - 每次 Engine.report 之前由桥接器核对 assignmentId，旧 assignment 的报告被挡住。
 *
 * @module pet-next/experiments/task-followup/runtime/engine
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  Engine,
  UserError,
  latestAssignment,
  runningAssignment,
} from '../upstream/src/core/index.ts'
import type {
  AssessmentOutcome,
  Assignment,
  Executor,
  Outbox,
  Policy,
  Repositories,
  Ticket,
  Trigger,
} from '../upstream/src/core/index.ts'
import {
  DEFAULT_GOAL,
  EVENT_SCHEMA,
  canonicalJson,
  eventContentDigest,
  isQuietAt,
  millisBetween,
  quietEndsAt,
  sha256Bytes,
  stableId,
} from '../contracts.ts'
import type {
  AnswerResult,
  ArtifactPayload,
  AttentionView,
  ClockPort,
  CompletionCheck,
  ContinuationState,
  DecisionContext,
  DecisionPort,
  EvidenceRef,
  FollowupEvent,
  GoalCondition,
  IngestOutcome,
  InputRef,
  MemoryPort,
  MemoryReading,
  ObservedArtifact,
  ProposedDecision,
  ProposalSummary,
  QuietConfig,
  TaskSnapshot,
  TaskStage,
  TaskStateExport,
  TaskStatus,
  ToolName,
  ToolPort,
  ToolReceipt,
  ToolRequest,
  VisibilityReceipt,
} from '../contracts.ts'
import type { AttentionPort, WakeHandleResult, WakeJob } from '../contracts.ts'
import { SqliteRepositories } from './repo.ts'
import { WakeScheduler } from './scheduler.ts'
import type { EffectRow, FollowupDb, ProposalRow, TaskRow } from './db.ts'

export const POLICY_VERSION = 'pet-followup-r4/v1'
const MAX_DRAIN_STEPS = 64

export interface RuntimeWorkspace {
  readonly root: string
  readonly artifacts: string
}

export interface RuntimeOptions {
  readonly db: FollowupDb
  readonly clock: ClockPort
  readonly memory: MemoryPort
  readonly decision: DecisionPort
  readonly attention: AttentionPort
  readonly tools: ToolPort
  readonly quiet: QuietConfig
  readonly workspace: RuntimeWorkspace
  readonly actorId?: string
  /** 仅用于离线 H1 消融；默认 full，正式路径不允许关闭重验。 */
  readonly validationMode?: 'full' | 'proposal-only'
  /** 仅用于离线消融：提案先排队，调用 flushProposals() 才真正执行。 */
  readonly deferProposals?: boolean
  /** 仅用于离线消融：观察取消/更正时不主动撤销旧提案。 */
  readonly skipInvalidation?: boolean
  /** R5：等待重新判断的压缩间隔（毫秒）。演示用短值；评估用默认值。 */
  readonly wakeAfterMs?: number
}

export interface DelegateInput {
  readonly title: string
  readonly goal: string
  readonly goalCondition?: GoalCondition
  readonly sourceId?: string
  readonly at?: string
  readonly threadId?: string
}

export interface DelegateResult {
  readonly ticketId: string
  readonly taskRevision: number
  readonly eventId: string
  readonly decisionId: string
  readonly duplicate: boolean
}

export interface ChangeInput {
  readonly ticketId: string
  readonly goal: string
  readonly goalCondition?: GoalCondition
  readonly sourceId?: string
  readonly at?: string
}

export interface CancelInput {
  readonly ticketId: string
  readonly reason?: string
  readonly sourceId?: string
  readonly at?: string
}

export interface AnswerCommandInput {
  readonly attentionId: string
  readonly taskRevision: number
  readonly optionId: string
  readonly sourceId?: string
  readonly at?: string
}

export interface ObserveInput {
  readonly ticketId: string
  readonly observed: ObservedArtifact
}

export interface RecoveryReport {
  readonly tasks: number
  readonly restored: readonly string[]
  readonly needsReconciliation: readonly string[]
  readonly memoryRebuilt: boolean
  readonly details: readonly string[]
}

/** 显式对账入口：只处理“结果未知”的 effect，不提供通用自动重试。 */
export type ReconcileOption = 'accept_receipt' | 'abandon_attempt'

export interface ReconcileInput {
  readonly ticketId: string
  readonly option: ReconcileOption
  readonly note?: string
  readonly at?: string
}

export interface ReconcileResult {
  readonly ok: boolean
  readonly code:
    | 'reconciled'
    | 'nothing_to_reconcile'
    | 'no_receipt'
    | 'receipt_identity_missing'
    | 'receipt_identity_mismatch'
    | 'receipt_effect_mismatch'
    | 'receipt_attempt_mismatch'
    | 'receipt_tool_mismatch'
    | 'receipt_task_revision_mismatch'
    | 'receipt_assignment_mismatch'
    | 'receipt_not_ok'
    | 'receipt_inputs_unverified'
    | 'receipt_unresolved'
    | 'receipt_output_missing'
    | 'receipt_output_sha_mismatch'
    | 'unknown_option'
    | 'task_closed'
  readonly detail: string
  readonly effectIds: readonly string[]
  readonly blocked: readonly string[]
}

interface TaskRecord {
  ticketId: string
  title: string
  goal: string
  goalCondition: GoalCondition
  taskRevision: number
  assignmentId: string | null
  stage: TaskStage
  status: TaskStatus
  createdAt: string
  updatedAt: string
  eventCursor: number
  memoryCursor: number
  evidence: EvidenceRef[]
  lastProposal?: ProposalSummary
  lastAnswer?: { optionId: string; at: string }
  continuation?: ContinuationState
  attempt: number
  result?: TaskSnapshot['result']
  analysis?: TaskSnapshot['analysis']
  completion?: TaskSnapshot['completion']
  closeReason?: string
  diagnostics: string[]
}

interface ValidationRecord {
  readonly at: string
  readonly stage: 'proposal' | 'execute' | 'notify'
  readonly ok: boolean
  readonly code: string
  readonly detail: string
}

/** 构造输入身份只需要这四项；TaskRecord 与 TaskSnapshot 都满足。 */
interface InputIdentityTask {
  readonly ticketId: string
  readonly taskRevision: number
  readonly assignmentId: string | null
  readonly result?: TaskSnapshot['result']
}

export class FollowupRuntime {
  readonly db: FollowupDb
  readonly clock: ClockPort
  readonly memory: MemoryPort
  readonly decision: DecisionPort
  readonly attention: AttentionPort
  readonly tools: ToolPort
  readonly quiet: QuietConfig
  readonly workspace: RuntimeWorkspace
  readonly repo: SqliteRepositories
  readonly engine: Engine
  private readonly actorId: string
  private readonly validationMode: 'full' | 'proposal-only'
  private readonly deferProposals: boolean
  private readonly skipInvalidation: boolean
  /** 本进程正在执行的 effect；用于区分“活着的 running”和“崩溃留下的 running”。 */
  private readonly inFlight = new Set<string>()
  /** R5 持久唤醒调度。 */
  readonly scheduler: WakeScheduler
  private readonly wakeAfterMs: number

  constructor(options: RuntimeOptions) {
    this.db = options.db
    this.clock = options.clock
    this.memory = options.memory
    this.decision = options.decision
    this.attention = options.attention
    this.tools = options.tools
    this.quiet = options.quiet
    this.workspace = options.workspace
    this.actorId = options.actorId ?? 'owner'
    this.validationMode = options.validationMode ?? 'full'
    this.deferProposals = options.deferProposals ?? false
    this.skipInvalidation = options.skipInvalidation ?? false
    this.wakeAfterMs = options.wakeAfterMs ?? 10 * 60_000
    this.scheduler = new WakeScheduler({ db: this.db, now: () => this.clock.now() })
    this.repo = new SqliteRepositories(this.db)
    this.engine = new Engine({
      repo: this.repo as Repositories,
      policy: () => this.policy(),
      scope: { scope: () => ({ listened: true, observed: true }) },
      // 本轮没有模型：assessor 只登记请求，实际决策由 DecisionPort（scripted-rule）完成。
      assessor: { request: () => undefined },
      executor: this.executor(),
      outbox: this.outbox(),
      now: () => this.clock.now(),
    })
  }

  // ------------------------------------------------------------------
  // 公共命令
  // ------------------------------------------------------------------

  delegate(input: DelegateInput): DelegateResult {
    const now = input.at ?? this.clock.now()
    const sourceId = input.sourceId ?? `user-delegate-${randomUUID()}`
    const sourceRevision = '1'
    const eventId = stableId('ev', 'user.delegated', sourceId, sourceRevision)
    const existing = this.db.getEvent(eventId)
    if (existing?.ticketId) {
      const task = this.requireTask(existing.ticketId)
      return {
        ticketId: task.ticketId,
        taskRevision: task.taskRevision,
        eventId,
        decisionId: stableId('dec', 'user.delegated', sourceId),
        duplicate: true,
      }
    }
    const goalCondition = input.goalCondition ?? DEFAULT_GOAL
    const threadId = input.threadId ?? `followup/${sourceId}`
    const result = this.db.atomic(() => {
      const trigger = this.humanTrigger({
        id: `trig-${eventId}`,
        threadId,
        at: now,
        text: input.goal,
      })
      const received = this.engine.receive(trigger)
      if (received === 'duplicate') throw new Error(`delegation trigger already received: ${trigger.id}`)
      const outcome: AssessmentOutcome = {
        kind: 'accept',
        title: input.title,
        scope: 'followup',
        reason: '用户在面板上创建了持续跟进委托',
      }
      const decision = this.engine.decide(trigger.id, outcome)
      const ticketId = decision.ticketId
      if (!ticketId) throw new Error('engine accepted delegation without ticket id')
      const event = this.makeEvent({
        kind: 'user.delegated',
        sourceId,
        sourceRevision,
        at: now,
        ticketId,
        taskRevision: 1,
        payload: { title: input.title, goal: input.goal, goalCondition },
      })
      const inserted = this.db.insertEvent(event, this.clock.now())
      const record: TaskRecord = {
        ticketId,
        title: input.title,
        goal: input.goal,
        goalCondition,
        taskRevision: 1,
        assignmentId: runningAssignment(this.repo.tickets.get(ticketId)!)?.id ?? null,
        stage: 'awaiting_result',
        status: 'active',
        createdAt: now,
        updatedAt: now,
        eventCursor: inserted.seq,
        memoryCursor: 0,
        evidence: [],
        attempt: 1,
        diagnostics: [],
      }
      this.saveTask(record)
      const memory = this.memory.ingest({
        event,
        eventCursor: inserted.seq,
        ticketId,
        taskRevision: 1,
        label: '用户委托',
      })
      record.memoryCursor = memory.cursor
      this.saveTask(record)
      this.db.log('user.delegated', now, { ticketId, sourceId }, { eventId, seq: inserted.seq })
      return { ticketId, taskRevision: 1, eventId, decisionId: decision.id, duplicate: false }
    })
    this.db.maybeCrash('ingest_persisted')
    this.drain()
    return result
  }

  observe(input: ObserveInput): IngestOutcome {
    const task = this.requireTask(input.ticketId)
    const observed = input.observed
    const now = observed.observedAt || this.clock.now()
    if (task.status !== 'active') {
      return this.ignoreObservation(task, observed, `task ${task.status}`)
    }
    const verified = this.verifyArtifactFile(observed.path, observed.sha256)
    if (!verified.ok) {
      return this.ignoreObservation(task, observed, `result file verification failed: ${verified.detail}`)
    }
    if (observed.payload.artifactPath) {
      const artifact = this.verifyArtifactFile(observed.payload.artifactPath, observed.payload.artifactSha)
      if (!artifact.ok) {
        return this.ignoreObservation(task, observed, `artifact verification failed: ${artifact.detail}`)
      }
    }
    const sourceRevision = `r${observed.payload.revision}:${observed.payload.artifactSha.slice(0, 16)}`
    const eventId = stableId('ev', 'artifact.observed', observed.sourceId, sourceRevision)
    const existing = this.db.getEvent(eventId)
    if (existing) {
      return { disposition: 'duplicate', eventId, eventCursor: task.eventCursor, detail: 'same source revision already observed' }
    }
    const duplicateSha = this.db
      .listEvents(task.ticketId)
      .some(
        (event) =>
          event.kind === 'artifact.observed' &&
          (event.payload as unknown as ArtifactPayload).resultFileSha === observed.payload.resultFileSha,
      )
    if (duplicateSha) {
      return this.ignoreObservation(task, observed, 'same artifact SHA already observed')
    }

    const current = task.result
    let disposition: IngestOutcome['disposition'] = 'appended'
    let detail = 'artifact accepted'
    let conflict = false
    if (current && current.runId === observed.payload.runId) {
      if (observed.payload.revision < current.revision) {
        disposition = 'stale_revision'
        detail = `stale revision ${observed.payload.revision} < ${current.revision}`
      } else if (observed.payload.revision === current.revision && observed.payload.artifactSha !== current.artifactSha) {
        conflict = true
        detail = `same revision r${current.revision} with different SHA`
      }
    }

    const result = this.db.atomic(() => {
      const event = this.makeEvent({
        kind: 'artifact.observed',
        sourceId: observed.sourceId,
        sourceRevision,
        at: now,
        ticketId: task.ticketId,
        taskRevision: task.taskRevision,
        payload: {
          ...observed.payload,
          observedPath: this.relativeToRoot(observed.path),
        },
      })
      const inserted = this.db.insertEvent(event, this.clock.now())
      const fresh = this.requireTask(task.ticketId)
      fresh.eventCursor = inserted.seq
      fresh.updatedAt = now
      const memory = this.memory.ingest({
        event,
        eventCursor: inserted.seq,
        ticketId: fresh.ticketId,
        taskRevision: fresh.taskRevision,
        label: `inbox ${observed.payload.runId} r${observed.payload.revision}`,
      })
      fresh.memoryCursor = memory.cursor
      const ref: EvidenceRef = {
        sourceId: observed.sourceId,
        sourceRevision,
        sha256: observed.payload.resultFileSha,
        memoryEventIds: [memory.memoryEventId],
        noteIds: memory.noteIds,
        noteVersions: memory.noteVersions,
      }
      fresh.evidence = [...fresh.evidence, ref].slice(-8)
      if (disposition === 'appended' || conflict) {
        const hadAuthorization = Boolean(fresh.lastAnswer) || Boolean(fresh.analysis)
        if (fresh.analysis) {
          // 新来源修订让旧分析的“当前有效性”失效；历史证据留在事件/回执里。
          fresh.diagnostics = [...fresh.diagnostics.slice(-40), `analysis_invalidated:new_source:${sourceRevision}`]
          fresh.analysis = undefined
          fresh.completion = undefined
        }
        if (hadAuthorization || fresh.continuation) {
          // 旧授权只对旧来源有效：新来源必须重新授权，旧 attempt 不复用。
          fresh.attempt += 1
          fresh.lastAnswer = undefined
          fresh.continuation = undefined
          fresh.diagnostics = [...fresh.diagnostics.slice(-40), `authorization_invalidated:new_source:${sourceRevision}`]
        }
        if (!this.skipInvalidation) {
          this.invalidatePendingEffects(fresh.ticketId, 'source revision changed')
          this.invalidateOpenProposals(fresh.ticketId, 'source revision changed')
        }
        if (!conflict) {
          fresh.result = {
            runId: observed.payload.runId,
            revision: observed.payload.revision,
            status: observed.payload.status,
            metrics: observed.payload.metrics,
            artifactPath: observed.payload.artifactPath,
            artifactSha: observed.payload.artifactSha,
            resultPath: this.relativeToRoot(observed.path),
            resultFileSha: observed.payload.resultFileSha,
            ...(observed.payload.note ? { note: observed.payload.note } : {}),
          }
          fresh.stage = 'result_received'
        }
        fresh.diagnostics = [
          ...fresh.diagnostics.slice(-40),
          conflict ? `evidence_conflict:${detail}` : `artifact_accepted:${sourceRevision}`,
        ]
      } else {
        fresh.diagnostics = [...fresh.diagnostics.slice(-40), `artifact_${disposition}:${detail}`]
      }
      this.saveTask(fresh)
      if (disposition === 'appended' || conflict) {
        const superseded = this.attention.supersede(fresh.ticketId, fresh.taskRevision, 'new evidence revision', now)
        if (superseded.length) {
          const assignment = this.currentAssignmentId(fresh.ticketId)
          if (assignment) {
            this.reportSafe(fresh.ticketId, assignment, { state: 'waiting', summary: '证据已更新，旧问题已撤销并重新判定', question: null })
          }
        }
        this.attachTrigger(fresh, {
          id: `trig-${inserted.seq}-${event.eventId}`,
          threadId: this.taskThreadId(fresh.ticketId),
          at: now,
          text: `inbox ${observed.payload.runId} r${observed.payload.revision} ${observed.payload.status}`,
          human: false,
        })
      }
      this.db.log('artifact.observed', now, { ticketId: fresh.ticketId, sourceId: observed.sourceId }, { eventId, seq: inserted.seq, disposition })
      return { eventId, eventCursor: inserted.seq }
    })
    this.db.maybeCrash('ingest_persisted')
    this.drain()
    return { ...result, disposition, detail }
  }

  answer(input: AnswerCommandInput): AnswerResult {
    const now = input.at ?? this.clock.now()
    const attention = this.attention.get(input.attentionId)
    if (!attention) return { ok: false, code: 'unknown_attention', detail: 'attention not found' }
    if (attention.state === 'answered') return { ok: false, code: 'already_answered', detail: 'attention already answered' }
    const task = this.requireTask(attention.ticketId)
    const option = attention.options.find((item) => item.id === input.optionId)
    if (!option) return { ok: false, code: 'invalid_option', detail: `option ${input.optionId} not offered` }
    if (this.blockingEffects(task.ticketId).length) {
      return {
        ok: false,
        code: 'needs_reconciliation',
        detail: `unresolved effect(s) must be reconciled first: ${this.blockingEffects(task.ticketId)
          .map((effect) => effect.effect_id)
          .join(',')}`,
      }
    }
    // 主“用户离开电脑”模式：只有已送达/已呈现的问题才能被回应。
    const visibility = this.attention.visibility(attention.attentionId)
    if (!visibility.visible) {
      return {
        ok: false,
        code: 'not_visible',
        detail: `question was never delivered or presented (queuedAt=${visibility.queuedAt ?? 'none'})`,
      }
    }
    if (task.status !== 'active' || task.taskRevision !== input.taskRevision || attention.taskRevision !== task.taskRevision) {
      this.recordStaleAnswer(attention, input, task, now)
      return {
        ok: false,
        code: 'stale_answer',
        detail: `attention r${attention.taskRevision} / answer r${input.taskRevision} / current r${task.taskRevision}`,
      }
    }
    const sourceId = input.sourceId ?? `user-answer-${randomUUID()}`
    const result = this.db.atomic(() => {
      const fresh = this.requireTask(task.ticketId)
      const event = this.makeEvent({
        kind: 'user.answered',
        sourceId,
        sourceRevision: '1',
        at: now,
        ticketId: fresh.ticketId,
        taskRevision: fresh.taskRevision,
        payload: { attentionId: attention.attentionId, decisionKey: attention.decisionKey, optionId: option.id, label: option.label },
      })
      const inserted = this.db.insertEvent(event, this.clock.now())
      const answered = this.attention.answer({
        attentionId: attention.attentionId,
        taskRevision: fresh.taskRevision,
        optionId: option.id,
        now,
        sourceId,
      })
      if (!answered.ok) throw new Error(`attention answer rejected inside transaction: ${answered.code}`)
      const memory = this.memory.ingest({
        event,
        eventCursor: inserted.seq,
        ticketId: fresh.ticketId,
        taskRevision: fresh.taskRevision,
        label: `用户选择：${option.label}`,
      })
      fresh.eventCursor = inserted.seq
      fresh.memoryCursor = memory.cursor
      fresh.lastAnswer = { optionId: option.id, at: now }
      fresh.updatedAt = now
      if (option.id === 'keep_current' || option.id === 'use_latest') {
        fresh.diagnostics = fresh.diagnostics.filter((item) => !item.startsWith('evidence_conflict'))
      }
      if (option.id === 'use_latest') {
        const latestArtifact = this.db
          .listEvents(fresh.ticketId)
          .filter((event) => event.kind === 'artifact.observed')
          .at(-1)
        const payload = latestArtifact?.payload as unknown as ArtifactPayload | undefined
        if (payload) {
          fresh.result = {
            runId: payload.runId,
            revision: payload.revision,
            status: payload.status,
            metrics: payload.metrics,
            artifactPath: payload.artifactPath,
            artifactSha: payload.artifactSha,
            resultPath: String(latestArtifact!.payload.observedPath ?? ''),
            resultFileSha: payload.resultFileSha,
          }
        }
      }
      if (option.id === 'retry_analysis') {
        fresh.attempt += 1
        fresh.diagnostics = fresh.diagnostics.filter((item) => !item.startsWith('tool_failed:'))
      }
      if (fresh.continuation) {
        // 新授权：在已知拒绝之后建立新的 attempt，旧的失败留在 effect/diagnostics 里。
        if (option.id === 'analyze_failing') fresh.attempt += 1
        fresh.diagnostics = [
          ...fresh.diagnostics.slice(-40),
          `continuation_authorized:${option.id}:attempt${fresh.attempt}`,
        ]
        fresh.continuation = undefined
      }
      fresh.stage = option.id === 'analyze_failing' ? 'analyzing' : 'result_received'
      this.saveTask(fresh)
      const trigger = this.humanTrigger({
        id: `trig-${inserted.seq}-answer`,
        threadId: this.taskThreadId(fresh.ticketId),
        at: now,
        text: `回答：${option.label}`,
      })
      this.engine.receive(trigger)
      const currentAssignment = this.currentAssignmentId(fresh.ticketId)
      if (currentAssignment) {
        this.reportSafe(fresh.ticketId, currentAssignment, {
          state: 'progress',
          summary: `收到用户选择：${option.label}`,
          question: null,
          answers: trigger.id,
        })
      }
      this.db.log('user.answered', now, { ticketId: fresh.ticketId, attentionId: attention.attentionId }, { eventId: inserted.seq })
      return { attentionId: attention.attentionId, eventId: String(inserted.seq) }
    })
    this.db.maybeCrash('ingest_persisted')
    this.drain()
    const updated = this.attention.get(input.attentionId)!
    return { ok: true, attention: updated, answerEventId: result.eventId }
  }

  change(input: ChangeInput): { ok: boolean; taskRevision: number; eventId: string; detail: string } {
    const now = input.at ?? this.clock.now()
    const task = this.requireTask(input.ticketId)
    if (task.status !== 'active') return { ok: false, taskRevision: task.taskRevision, eventId: '', detail: `task ${task.status}` }
    const sourceId = input.sourceId ?? `user-change-${randomUUID()}`
    const goalCondition = input.goalCondition ?? task.goalCondition
    const result = this.db.atomic(() => {
      const fresh = this.requireTask(task.ticketId)
      fresh.taskRevision += 1
      fresh.goal = input.goal
      fresh.goalCondition = goalCondition
      fresh.attempt += 1
      fresh.continuation = undefined
      fresh.updatedAt = now
      fresh.stage = fresh.result ? 'result_received' : 'awaiting_result'
      const superseded = this.skipInvalidation ? [] : this.attention.supersede(fresh.ticketId, fresh.taskRevision, 'goal changed', now)
      if (!this.skipInvalidation) {
        this.invalidateOpenProposals(fresh.ticketId, 'goal changed')
        this.invalidatePendingEffects(fresh.ticketId, 'goal changed')
      }
      const event = this.makeEvent({
        kind: 'user.changed',
        sourceId,
        sourceRevision: '1',
        at: now,
        ticketId: fresh.ticketId,
        taskRevision: fresh.taskRevision,
        payload: { goal: input.goal, goalCondition },
      })
      const inserted = this.db.insertEvent(event, this.clock.now())
      const memory = this.memory.ingest({
        event,
        eventCursor: inserted.seq,
        ticketId: fresh.ticketId,
        taskRevision: fresh.taskRevision,
        label: '用户更正目标',
      })
      fresh.eventCursor = inserted.seq
      fresh.memoryCursor = memory.cursor
      fresh.diagnostics = [...fresh.diagnostics.slice(-40), `goal_changed:r${fresh.taskRevision}`]
      this.saveTask(fresh)
      const trigger = this.humanTrigger({
        id: `trig-${inserted.seq}-change`,
        threadId: this.taskThreadId(fresh.ticketId),
        at: now,
        text: `更正目标：${input.goal}`,
      })
      this.engine.receive(trigger)
      const currentAssignment = this.currentAssignmentId(fresh.ticketId)
      if (currentAssignment) {
        const report = this.reportSafe(fresh.ticketId, currentAssignment, {
          state: 'progress',
          summary: `目标已更正为 r${fresh.taskRevision}：${input.goal}`,
          question: null,
        })
        if (!report) fresh.diagnostics.push('change_report_blocked')
      }
      this.db.log('user.changed', now, { ticketId: fresh.ticketId, superseded: superseded.length }, { eventId: inserted.seq })
      return { eventId: String(inserted.seq), taskRevision: fresh.taskRevision }
    })
    this.db.maybeCrash('ingest_persisted')
    this.drain()
    return { ok: true, ...result, detail: 'goal changed' }
  }

  cancel(input: CancelInput): { ok: boolean; detail: string } {
    const now = input.at ?? this.clock.now()
    const task = this.requireTask(input.ticketId)
    if (task.status !== 'active') return { ok: false, detail: `task ${task.status}` }
    const sourceId = input.sourceId ?? `user-cancel-${randomUUID()}`
    this.db.atomic(() => {
      const fresh = this.requireTask(task.ticketId)
      fresh.taskRevision += 1
      fresh.status = 'cancelled'
      fresh.stage = 'cancelled'
      fresh.closeReason = input.reason ?? 'user cancelled'
      fresh.updatedAt = now
      if (!this.skipInvalidation) {
        this.attention.supersede(fresh.ticketId, fresh.taskRevision, 'task cancelled', now)
        this.invalidateOpenProposals(fresh.ticketId, 'task cancelled')
        this.invalidatePendingEffects(fresh.ticketId, 'task cancelled')
      }
      const event = this.makeEvent({
        kind: 'user.cancelled',
        sourceId,
        sourceRevision: '1',
        at: now,
        ticketId: fresh.ticketId,
        taskRevision: fresh.taskRevision,
        payload: { reason: fresh.closeReason },
      })
      const inserted = this.db.insertEvent(event, this.clock.now())
      const memory = this.memory.ingest({
        event,
        eventCursor: inserted.seq,
        ticketId: fresh.ticketId,
        taskRevision: fresh.taskRevision,
        label: '用户取消任务',
      })
      fresh.eventCursor = inserted.seq
      fresh.memoryCursor = memory.cursor
      this.saveTask(fresh)
      try {
        this.engine.stopTicket(fresh.ticketId, fresh.closeReason)
      } catch (error) {
        fresh.diagnostics.push(`stop_ticket_failed:${(error as Error).message}`)
        this.saveTask(fresh)
      }
      this.db.log('user.cancelled', now, { ticketId: fresh.ticketId }, { eventId: inserted.seq })
    })
    this.db.maybeCrash('ingest_persisted')
    this.drain()
    return { ok: true, detail: 'cancelled' }
  }

  /** 时间推进：只推进注入时钟并处理到期/静默结束；不 sleep。 */
  tick(ms: number): { now: string; eventId: string } {
    const now = this.clock.advance(Math.max(0, ms))
    const sourceId = `clock-${now}`
    const eventId = stableId('ev', 'clock.advanced', sourceId, '1')
    this.db.atomic(() => {
      if (this.db.getEvent(eventId)) return
      const event = this.makeEvent({
        kind: 'clock.advanced',
        sourceId,
        sourceRevision: '1',
        at: now,
        ticketId: null,
        taskRevision: null,
        payload: { ms, now },
      })
      this.db.insertEvent(event, now)
    })
    this.drain()
    return { now, eventId }
  }

  /** 重启恢复：记忆追赶、effect 对账、上游 assignment 恢复。 */
  recover(): RecoveryReport {
    const details: string[] = []
    const restored: string[] = []
    const needsReconciliation: string[] = []
    let memoryRebuilt = false
    const tasks = this.listTasks()
    if (tasks.some((task) => task.eventCursor > this.memory.cursor())) {
      this.memory.rebuild()
      memoryRebuilt = true
      details.push(`memory projection rebuilt to cursor ${this.memory.cursor()}`)
    }
    for (const task of tasks) {
      const fresh = this.requireTask(task.ticketId)
      if (fresh.status !== 'active') {
        this.syncFromTicket(fresh)
        continue
      }
      if (fresh.memoryCursor < fresh.eventCursor) {
        const cursor = this.rebuildMemoryForTask(fresh)
        details.push(`task ${fresh.ticketId} memory caught up to ${cursor}`)
      }
      // running 与已经转入 needs_reconciliation 的 effect 一样，都是未解决的执行结果。
      // 跨进程恢复不得只挡一次：这里必须保留阻断，且不重建 assignment/不重新派发。
      const unresolved = this.db
        .listEffects()
        .filter(
          (effect) =>
            effect.ticket_id === fresh.ticketId &&
            effect.kind === 'tool' &&
            (effect.state === 'running' || effect.state === 'needs_reconciliation'),
        )
      if (unresolved.length) {
        for (const effect of unresolved) {
          if (effect.state !== 'running') continue
          this.db.atomic(() => {
            this.db.saveEffect({ ...effect, state: 'needs_reconciliation', detail: 'process ended while effect was running' })
            this.db.driverLog(this.clock.now(), fresh.ticketId, 'effect.needs_reconciliation', { effectId: effect.effect_id })
          })
        }
        const current = this.requireTask(fresh.ticketId)
        const ids = unresolved.map((effect) => effect.effect_id)
        const marker = `needs_reconciliation:${ids.join(',')}`
        current.stage = 'needs_reconciliation'
        if (!current.diagnostics.includes(marker)) {
          current.diagnostics = [...current.diagnostics.slice(-40), marker]
        }
        this.saveTask(current)
        if (!needsReconciliation.includes(fresh.ticketId)) needsReconciliation.push(fresh.ticketId)
        details.push(`task ${fresh.ticketId}: ${ids.length} unresolved effect(s) held, no blind retry, no assignment restart`)
        continue
      }
      const ticket = this.repo.tickets.get(fresh.ticketId)
      if (!ticket) {
        details.push(`task ${fresh.ticketId}: upstream ticket missing`)
        continue
      }
      if (ticket.ended) {
        this.syncFromTicket(fresh)
        details.push(`task ${fresh.ticketId}: upstream ticket already ended (${ticket.ended.outcome})`)
        continue
      }
      const running = runningAssignment(ticket)
      // 正在等用户（问题/续办）的任务没有在飞的工作，重启 assignment 只会无授权地改 attempt。
      if (running && (fresh.stage === 'awaiting_decision' || fresh.stage === 'continuation_pending')) {
        details.push(`task ${fresh.ticketId}: waiting for user (${fresh.stage}), assignment kept`)
        this.syncWake(fresh)
        continue
      }
      if (running) {
        // 已完成核验的工作不需要重启 assignment：直接把已核验的 ready 报告补齐并完成。
        const check = this.completionCheck(fresh)
        if (check.ok) {
          const reported = this.reportSafe(fresh.ticketId, running.id, {
            state: 'ready',
            summary: `恢复时确认目标条件已由核验产物满足：${check.artifactPath}`,
          })
          if (reported) {
            this.completeTask(this.requireTask(fresh.ticketId), check)
            const completed = this.requireTask(fresh.ticketId)
            if (completed.status === 'completed') {
              restored.push(fresh.ticketId)
              details.push(`task ${fresh.ticketId}: resumed to verified completion without restarting assignment`)
              continue
            }
            details.push(`task ${fresh.ticketId}: ready report sent but ticket not ended; falling back to assignment restart`)
          }
        }
        this.db.atomic(() => {
          this.engine.assignmentInterrupted(fresh.ticketId, running.id)
        })
        const after = this.repo.tickets.get(fresh.ticketId)!
        const nowRunning = runningAssignment(after)
        const updated = this.requireTask(fresh.ticketId)
        updated.assignmentId = nowRunning?.id ?? running.id
        updated.attempt = Math.max(updated.attempt, after.assignments.length)
        this.saveTask(updated)
        restored.push(fresh.ticketId)
        details.push(`task ${fresh.ticketId}: assignment interrupted handled (assignment ${updated.assignmentId})`)
      }
    }
    this.drain()
    return { tasks: tasks.length, restored, needsReconciliation, memoryRebuilt, details }
  }

  // ------------------------------------------------------------------
  // R5 持久唤醒
  // ------------------------------------------------------------------

  /** 当前应排的下一次唤醒；由持久状态推导，进程重启后可重建同一个 job。 */
  private syncWake(task: TaskSnapshot): WakeJob | null {
    const now = this.clock.now()
    const cancelAll = (detail: string): null => {
      this.scheduler.cancelFor(task.ticketId, detail)
      return null
    }
    if (task.status !== 'active') return cancelAll('task_not_active')
    if (task.stage === 'needs_reconciliation') return cancelAll('needs_reconciliation')
    const base = {
      ticketId: task.ticketId,
      taskRevision: task.taskRevision,
      assignmentId: task.assignmentId,
    }
    const open = task.openAttention
    if (open) {
      if (!open.deliveredAt && !open.presentedAt) {
        // 写库不等于送达：静默期内等静默结束，否则等最小间隔。
        const quiet = isQuietAt(now, this.quiet)
        const dueAt = quiet
          ? quietEndsAt(now, this.quiet)
          : new Date(Date.parse(now) + Math.max(1_000, this.quiet.minGapMs)).toISOString()
        return this.scheduler.schedule({
          ...base,
          reason: 'quiet',
          decisionId: open.decisionId,
          dueAt,
          detail: quiet ? 'quiet_hours' : 'min_gap',
        })
      }
      if (!open.answeredAt && open.deadline) {
        return this.scheduler.schedule({
          ...base,
          reason: 'deadline',
          decisionId: open.decisionId,
          dueAt: open.deadline,
          detail: 'unanswered_before_deadline',
        })
      }
      return cancelAll('attention_settled')
    }
    if (task.continuation) {
      const current = this.inputRefFromTask(task)
      if (current.ref && this.inputBytesMatch(task, current.ref)) {
        return this.scheduler.schedule({
          ...base,
          reason: 'continuation',
          decisionId: task.continuation.decisionId,
          dueAt: now,
          detail: 'input_restored',
        })
      }
      return cancelAll('continuation_waiting_input')
    }
    const last = this.db.listProposals(task.ticketId).at(-1)
    if (last && last.outcome === 'recorded' && last.kind === 'defer' && last.not_before) {
      // 重复的 defer 会被提案层去重（不新增行）。如果这条决定刚刚触发过，
      // 到期时间必须前移，否则会立刻再次到期形成忙循环；否则沿用提案给出的 notBefore。
      const previous = this.db.latestWakeJob(task.ticketId, 'defer', last.decision_id ?? null)
      const floor =
        previous && previous.status !== 'scheduled'
          ? new Date(Date.parse(previous.updatedAt) + this.wakeAfterMs).toISOString()
          : null
      const dueAt = floor && floor > last.not_before ? floor : last.not_before
      return this.scheduler.schedule({
        ...base,
        reason: 'defer',
        decisionId: last.decision_id,
        dueAt,
        detail: `defer:${last.reason_code}`,
      })
    }
    return cancelAll('no_pending_wait')
  }

  /** 续办唤醒前必须确认磁盘字节仍与当前结果一致（不只看事件身份）。 */
  private inputBytesMatch(task: TaskSnapshot, ref: InputRef): boolean {
    try {
      if (!ref.resultPath) return false
      const abs = this.absoluteToRoot(ref.resultPath)
      if (!existsSync(abs)) return false
      return sha256Bytes(readFileSync(abs)) === ref.resultFileSha
    } catch {
      return false
    }
  }

  private syncWakes(): void {
    for (const snapshot of this.listTasks()) this.syncWake(snapshot)
  }

  /** 不写 tick 事件，只按当前状态重判一次（服务循环用）。 */
  reevaluate(): { proposals: number; notifications: number } {
    const beforeProposals = this.db.listAllProposals().length
    const beforeNotifications = this.db.listNotificationReceipts().length
    this.drain()
    return {
      proposals: this.db.listAllProposals().length - beforeProposals,
      notifications: this.db.listNotificationReceipts().length - beforeNotifications,
    }
  }

  listWakeJobs(): WakeJob[] {
    return this.scheduler.list()
  }

  nextWakeAt(): string | null {
    return this.scheduler.nextDueAt()
  }

  /**
   * 处理一个到期 job：只重新判断当前状态，绝不执行 job 里保存的工具调用。
   * 原子领取失败（已处理/未到期）返回 none；任务/版本/派工不一致返回 stale。
   */
  wakeJob(jobId: string, at: string = this.clock.now()): WakeHandleResult {
    const claimed = this.scheduler.claim(jobId, at)
    if (!claimed) return { action: 'none', jobId, detail: 'not_claimable', proposals: 0, notifications: 0 }
    const task = this.listTasks().find((item) => item.ticketId === claimed.ticketId) ?? null
    if (!this.scheduler.isCurrent(claimed, task)) {
      this.scheduler.finish(claimed.jobId, 'cancelled', 'stale_task_or_revision')
      return { action: 'stale', jobId, detail: 'task_or_revision_changed', proposals: 0, notifications: 0 }
    }
    if (task!.status !== 'active') {
      this.scheduler.finish(claimed.jobId, 'cancelled', 'task_not_active')
      return { action: 'cancelled', jobId, detail: 'task_not_active', proposals: 0, notifications: 0 }
    }
    if (task!.stage === 'needs_reconciliation') {
      this.scheduler.finish(claimed.jobId, 'cancelled', 'needs_reconciliation')
      return { action: 'blocked', jobId, detail: 'needs_reconciliation', proposals: 0, notifications: 0 }
    }
    const beforeProposals = this.db.listProposals(task!.ticketId).length
    const beforeNotifications = this.db.listNotificationReceipts(task!.ticketId).length
    // 先记完成再重评：重评会按新状态排下一次 job，不能被这次 finish 覆盖。
    this.scheduler.finish(claimed.jobId, 'done', `wake:${claimed.reason}`)
    this.db.driverLog(at, task!.ticketId, 'wake.fired', { jobId: claimed.jobId, reason: claimed.reason })
    this.proposeAll()
    this.drain()
    return {
      action: 'woken',
      jobId,
      detail: claimed.reason,
      proposals: this.db.listProposals(task!.ticketId).length - beforeProposals,
      notifications: this.db.listNotificationReceipts(task!.ticketId).length - beforeNotifications,
    }
  }

  /** 处理所有已到期 job；返回逐条结果（供服务循环与测试）。 */
  wakeDue(at: string = this.clock.now()): WakeHandleResult[] {
    return this.scheduler.listDue(at).map((job) => this.wakeJob(job.jobId, at))
  }

  /**
   * 离线 H1 消融专用：把 deferProposals 排队的提案真正执行一次。
   * 正式路径不调用；它读取同一份提案行，按当前 validationMode 决定是否重验。
   */
  flushProposals(): { attempted: number; executed: number; rejected: number } {
    let attempted = 0
    let executed = 0
    let rejected = 0
    for (const row of this.db.listAllProposals()) {
      if (row.outcome !== 'open') continue
      attempted += 1
      const task = this.requireTask(row.ticket_id)
      if (task.status !== 'active') {
        rejected += 1
        continue
      }
      const ok = this.executeProposal(task, this.proposalFromRow(row), true)
      const after = this.db.getProposal(row.decision_id)
      if (ok || after?.outcome === 'open' || after?.outcome === 'merged' || after?.outcome === 'executed') executed += 1
      else rejected += 1
    }
    return { attempted, executed, rejected }
  }

  /** 显式修复记忆投影；用于 eventCursor 领先 memoryCursor 的可恢复状态。 */
  repairMemory(): { cursor: number; tasks: readonly string[] } {
    const cursor = this.memory.rebuild()
    const tasks: string[] = []
    for (const task of this.listTasks()) {
      if (task.stage === 'memory_behind' || task.memoryCursor < task.eventCursor || this.memory.cursor() < task.eventCursor) {
        const fresh = this.requireTask(task.ticketId)
        fresh.memoryCursor = cursor
        if (fresh.stage === 'memory_behind') {
          fresh.stage = fresh.result ? 'result_received' : 'awaiting_result'
        }
        fresh.diagnostics = [...fresh.diagnostics.slice(-40), `memory_repaired:${cursor}`]
        this.saveTask(fresh)
        tasks.push(fresh.ticketId)
      }
    }
    this.drain()
    return { cursor, tasks }
  }

  /**
   * 通道送达：把 queued 通知标记为 delivered，并记录 attention 的送达时间。
   * 只做通道动作，不改任务状态。
   */
  deliverPending(at?: string): { delivered: number } {
    const now = at ?? this.clock.now()
    const ids = this.attention.deliverPending(now)
    for (const id of ids) {
      const receipt = this.db.getNotification(id)
      if (!receipt) continue
      this.db.driverLog(now, receipt.ticketId, 'notification.delivered', { notificationId: id, attentionId: receipt.attentionId })
    }
    return { delivered: ids.length }
  }

  /**
   * 用户明确打开面板：把当前仍有效的问题标记为已呈现。
   * 这是唯一的“面板可见”入口，不因为写入数据库就自动算作用户看过。
   */
  present(ticketId: string, at?: string): { presented: readonly string[] } {
    const now = at ?? this.clock.now()
    const ids = this.attention.present(ticketId, now)
    for (const id of ids) {
      this.db.driverLog(now, ticketId, 'attention.presented', { attentionId: id })
    }
    return { presented: ids }
  }

  /** 单个问题的可核验可见性（queued/delivered/presented 与时间）。 */
  attentionVisibility(attentionId: string): VisibilityReceipt {
    return this.attention.visibility(attentionId)
  }

  /**
   * 显式对账：只处理未解决的 tool effect。
   * - accept_receipt：有合法当前来源回执时把 effect 记为成功，随后走正常完成核验；
   * - abandon_attempt：放弃该次尝试，必须重新授权（attempt+1、清空 lastAnswer）才会新建 effect。
   * 两条路径都不自动重试；条件不满足时保持阻断并返回原文。
   */
  reconcile(input: ReconcileInput): ReconcileResult {
    const now = input.at ?? this.clock.now()
    const task = this.requireTask(input.ticketId)
    if (task.status !== 'active') {
      return { ok: false, code: 'task_closed', detail: `task ${task.status}`, effectIds: [], blocked: [] }
    }
    const unresolved = this.blockingEffects(input.ticketId)
    if (!unresolved.length) {
      return { ok: false, code: 'nothing_to_reconcile', detail: 'no unresolved effect', effectIds: [], blocked: [] }
    }
    const effectIds = unresolved.map((effect) => effect.effect_id)
    if (input.option === 'accept_receipt') {
      const blocked: string[] = []
      const current = this.inputRefFromTask(task)
      const accepted: { effect: EffectRow; receipt: ToolReceipt }[] = []
      let firstCode: ReconcileResult['code'] = 'receipt_not_ok'
      for (const effect of unresolved) {
        const receipt = this.db.getReceiptByEffect(effect.effect_id)
        if (!receipt) {
          blocked.push(`no_receipt:${effect.effect_id}`)
          firstCode = 'no_receipt'
          continue
        }
        // 只有“成功、已核验输入、无未解决状态、输出字节正确、身份完全匹配”的回执才能解除阻断。
        const rejection = this.receiptRejection(effect, receipt, task, current)
        if (rejection) {
          blocked.push(`${rejection.code}:${effect.effect_id}:${rejection.detail}`)
          if (blocked.length === 1) firstCode = rejection.code
          continue
        }
        accepted.push({ effect, receipt })
      }
      if (blocked.length) {
        this.db.driverLog(now, input.ticketId, 'reconcile.blocked', { option: input.option, blocked })
        return { ok: false, code: firstCode, detail: blocked.join(';'), effectIds, blocked }
      }
      this.db.atomic(() => {
        const fresh = this.requireTask(input.ticketId)
        for (const { effect, receipt } of accepted) {
          this.db.saveEffect({ ...effect, state: 'succeeded', finished_at: now, detail: `reconciled:${receipt.receiptId}` })
          if (receipt.tool === 'write_analysis' && receipt.ok && receipt.outputPath && receipt.outputSha256 && !fresh.analysis) {
            fresh.analysis = {
              artifactPath: this.relativeToRoot(this.absoluteToRoot(receipt.outputPath)),
              artifactSha: receipt.outputSha256,
              receiptId: receipt.receiptId,
              inputRef: receipt.inputRef,
            }
          }
        }
        fresh.stage = fresh.analysis ? 'analyzing' : fresh.result ? 'result_received' : 'awaiting_result'
        fresh.updatedAt = now
        fresh.diagnostics = [...fresh.diagnostics.slice(-40), `reconciled:accept_receipt:${effectIds.join(',')}`]
        this.saveTask(fresh)
        this.db.driverLog(now, input.ticketId, 'reconcile.accept_receipt', { effectIds, note: input.note ?? null })
      })
      this.drain()
      return { ok: true, code: 'reconciled', detail: `accepted receipt for ${effectIds.length} effect(s)`, effectIds, blocked: [] }
    }
    if (input.option === 'abandon_attempt') {
      this.db.atomic(() => {
        const fresh = this.requireTask(input.ticketId)
        for (const effect of unresolved) {
          this.db.saveEffect({
            ...effect,
            state: 'invalidated',
            finished_at: now,
            detail: `abandoned_by_reconciliation:${input.note ?? 'explicit'}`,
          })
        }
        // 放弃不等于允许盲重试：清空上一次回答与续办状态，并要求重新授权。
        fresh.attempt += 1
        fresh.lastAnswer = undefined
        fresh.continuation = undefined
        fresh.stage = fresh.result ? 'result_received' : 'awaiting_result'
        fresh.updatedAt = now
        fresh.diagnostics = [...fresh.diagnostics.slice(-40), `reconciliation_abandoned:${effectIds.join(',')}`, 'reauthorization_required']
        this.saveTask(fresh)
        this.db.driverLog(now, input.ticketId, 'reconcile.abandon_attempt', { effectIds, note: input.note ?? null })
      })
      this.drain()
      return { ok: true, code: 'reconciled', detail: `abandoned ${effectIds.length} effect(s); new authorization required`, effectIds, blocked: [] }
    }
    return { ok: false, code: 'unknown_option', detail: `unknown reconcile option ${String(input.option)}`, effectIds, blocked: [] }
  }

  /**
   * 回执合法性：接受前逐项核对 effect/attempt/任务/assignment/来源/成功/输入核验/输出字节。
   * 任何一项不成立都返回明确拒绝码；不修改 effect，也不解除原阻断。
   */
  private receiptRejection(
    effect: EffectRow,
    receipt: ToolReceipt,
    task: TaskRecord,
    current: { readonly ref: InputRef | null; readonly reasons: readonly string[] },
  ): { code: ReconcileResult['code']; detail: string } | null {
    const fail = (code: ReconcileResult['code'], detail: string): { code: ReconcileResult['code']; detail: string } => ({
      code,
      detail,
    })
    if (receipt.effectId !== effect.effect_id) return fail('receipt_effect_mismatch', `${receipt.effectId} != ${effect.effect_id}`)
    if (receipt.attemptId !== effect.attempt_id) return fail('receipt_attempt_mismatch', `${receipt.attemptId} != ${effect.attempt_id}`)
    if ((receipt.tool as string) !== (effect.tool as string)) return fail('receipt_tool_mismatch', `${receipt.tool} != ${effect.tool}`)
    if (effect.task_revision !== task.taskRevision) {
      return fail('receipt_task_revision_mismatch', `effect r${effect.task_revision} current r${task.taskRevision}`)
    }
    if (receipt.taskRevision !== task.taskRevision) {
      return fail('receipt_task_revision_mismatch', `receipt r${receipt.taskRevision} current r${task.taskRevision}`)
    }
    if ((effect.assignment_id ?? '') !== (task.assignmentId ?? '')) {
      return fail('receipt_assignment_mismatch', `effect ${effect.assignment_id ?? 'none'} current ${task.assignmentId ?? 'none'}`)
    }
    if (receipt.assignmentId !== (effect.assignment_id ?? '')) {
      return fail('receipt_assignment_mismatch', `receipt ${receipt.assignmentId} effect ${effect.assignment_id ?? 'none'}`)
    }
    if (!receipt.ok) return fail('receipt_not_ok', receipt.detail)
    if (!receipt.inputsVerified) return fail('receipt_inputs_unverified', receipt.detail)
    if (receipt.needsReconciliation) return fail('receipt_unresolved', receipt.detail)
    if (!receipt.inputRef) return fail('receipt_identity_missing', receipt.receiptId)
    if (!current.ref) return fail('receipt_identity_mismatch', `current_identity:${current.reasons.join('+')}`)
    if (canonicalJson(receipt.inputRef) !== canonicalJson(current.ref)) {
      return fail('receipt_identity_mismatch', 'receipt inputRef differs from current input')
    }
    if (effect.tool === 'write_analysis') {
      if (!receipt.outputPath || !receipt.outputSha256) return fail('receipt_output_missing', receipt.receiptId)
      const abs = this.absoluteToRoot(receipt.outputPath)
      if (!existsSync(abs)) return fail('receipt_output_missing', this.relativeToRoot(abs))
      const verify = this.verifyArtifactFile(abs, receipt.outputSha256)
      if (!verify.ok) return fail('receipt_output_sha_mismatch', verify.detail)
    }
    return null
  }

  /**
   * 未解决执行结果：跨进程遗留的 running 与已经转入 needs_reconciliation 的 effect。
   * 本进程正在执行的 running 不算阻断。
   */
  private blockingEffects(ticketId?: string): EffectRow[] {
    return this.db
      .listEffects()
      .filter(
        (effect) =>
          (ticketId === undefined || effect.ticket_id === ticketId) &&
          // 只有工具执行会产生不可确认的外部副作用；start/deliver 是幂等簿记。
          effect.kind === 'tool' &&
          (effect.state === 'needs_reconciliation' ||
            (effect.state === 'running' && !this.inFlight.has(effect.effect_id))),
      )
  }

  private isTicketBlocked(ticketId: string): boolean {
    return this.blockingEffects(ticketId).length > 0
  }

  /** 从权威事件与任务结果构造当前输入身份；任何缺项都返回 null + 原因。 */
  private inputRefFromTask(task: InputIdentityTask): { ref: InputRef | null; reasons: string[] } {
    const result = task.result
    if (!result) return { ref: null, reasons: ['result_missing'] }
    const reasons: string[] = []
    if (!result.resultPath) reasons.push('result_path_missing')
    if (!result.resultFileSha) reasons.push('result_file_sha_missing')
    if (!result.artifactSha) reasons.push('artifact_sha_missing')
    if (!result.artifactPath) reasons.push('artifact_path_missing')
    if (!task.assignmentId) reasons.push('assignment_missing')
    // 必须找“当前采用版本”的那条事件；冲突时最后一条事件可能不是被采用的版本。
    const event = this.db
      .listEvents(task.ticketId)
      .filter((item) => {
        if (item.kind !== 'artifact.observed') return false
        const payload = item.payload as unknown as ArtifactPayload
        return (
          payload.runId === result.runId &&
          payload.revision === result.revision &&
          payload.resultFileSha === result.resultFileSha &&
          payload.artifactSha === result.artifactSha
        )
      })
      .at(-1)
    if (!event) {
      const latest = this.db
        .listEvents(task.ticketId)
        .filter((item) => item.kind === 'artifact.observed')
        .at(-1)
      if (!latest) reasons.push('artifact_event_missing')
      else {
        const payload = latest.payload as unknown as ArtifactPayload
        if (payload.runId !== result.runId) reasons.push('event_run_mismatch')
        if (payload.revision !== result.revision) reasons.push('event_revision_mismatch')
        if (payload.resultFileSha !== result.resultFileSha) reasons.push('event_result_sha_mismatch')
        if (payload.artifactSha !== result.artifactSha) reasons.push('event_artifact_sha_mismatch')
      }
    }
    if (reasons.length) return { ref: null, reasons }
    return {
      ref: {
        taskId: task.ticketId,
        taskRevision: task.taskRevision,
        assignmentId: task.assignmentId!,
        sourceId: event!.sourceId,
        sourceRevision: event!.sourceRevision ?? '',
        runId: result.runId,
        revision: result.revision,
        resultFileSha: result.resultFileSha,
        artifactSha: result.artifactSha,
        resultPath: result.resultPath,
        artifactPath: result.artifactPath,
      },
      reasons: [],
    }
  }

  /**
   * 派发前核对：effect 预期的输入身份 == 当前权威身份，且磁盘字节 SHA 相等。
   * 通过后把已核验字节写入内容寻址快照，工具只读这份快照。
   */
  private verifyEffectInputs(effect: EffectRow): {
    ok: boolean
    detail: string
    inputRef: InputRef
    snapshotPath: string | null
  } {
    const empty: InputRef = {
      taskId: effect.ticket_id,
      taskRevision: effect.task_revision,
      assignmentId: effect.assignment_id ?? '',
      sourceId: '',
      sourceRevision: '',
      runId: '',
      revision: 0,
      resultFileSha: '',
      artifactSha: '',
      resultPath: null,
      artifactPath: null,
    }
    if (!effect.input_ref_json) {
      return { ok: false, detail: 'effect_input_identity_missing', inputRef: empty, snapshotPath: null }
    }
    const expected = JSON.parse(effect.input_ref_json) as InputRef
    const task = this.requireTask(effect.ticket_id)
    const current = this.inputRefFromTask(task)
    if (!current.ref) {
      return { ok: false, detail: `current_input_identity_incomplete:${current.reasons.join('+')}`, inputRef: expected, snapshotPath: null }
    }
    if (canonicalJson(current.ref) !== canonicalJson(expected)) {
      return { ok: false, detail: 'input_identity_changed_since_queued', inputRef: expected, snapshotPath: null }
    }
    if (!expected.resultPath) {
      return { ok: false, detail: 'expected_result_path_missing', inputRef: expected, snapshotPath: null }
    }
    const resultAbs = this.absoluteToRoot(expected.resultPath)
    const resultVerify = this.verifyArtifactFile(resultAbs, expected.resultFileSha)
    if (!resultVerify.ok) {
      return { ok: false, detail: `result_bytes:${resultVerify.detail}`, inputRef: expected, snapshotPath: null }
    }
    if (expected.artifactPath) {
      const artifactVerify = this.verifyArtifactFile(this.absoluteToRoot(expected.artifactPath), expected.artifactSha)
      if (!artifactVerify.ok) {
        return { ok: false, detail: `artifact_bytes:${artifactVerify.detail}`, inputRef: expected, snapshotPath: null }
      }
    }
    const snapshot = this.writeInputSnapshot(resultAbs, expected.resultFileSha)
    if (!snapshot.ok) {
      return { ok: false, detail: `snapshot:${snapshot.detail}`, inputRef: expected, snapshotPath: null }
    }
    return { ok: true, detail: 'inputs verified', inputRef: expected, snapshotPath: snapshot.path }
  }

  /** 内容寻址的不可变输入快照；同一 SHA 只写一次，已存在则重新校验。 */
  private writeInputSnapshot(resultAbs: string, expectedSha: string): { ok: boolean; detail: string; path: string | null } {
    const dir = join(this.workspace.root, 'state', 'inputs')
    const target = join(dir, `${expectedSha}.json`)
    mkdirSync(dir, { recursive: true })
    if (existsSync(target)) {
      const existing = sha256Bytes(readFileSync(target))
      if (existing === expectedSha) return { ok: true, detail: 'reused', path: this.relativeToRoot(target) }
      return { ok: false, detail: `snapshot sha ${existing.slice(0, 12)} != ${expectedSha.slice(0, 12)}`, path: null }
    }
    const bytes = readFileSync(resultAbs)
    const actual = sha256Bytes(bytes)
    if (actual !== expectedSha) return { ok: false, detail: `source sha ${actual.slice(0, 12)} != ${expectedSha.slice(0, 12)}`, path: null }
    writeFileSync(target, bytes)
    const written = sha256Bytes(readFileSync(target))
    if (written !== expectedSha) return { ok: false, detail: 'snapshot verify failed', path: null }
    return { ok: true, detail: 'created', path: this.relativeToRoot(target) }
  }

  // ------------------------------------------------------------------
  // 查询
  // ------------------------------------------------------------------

  listTasks(): TaskSnapshot[] {
    return this.db.listTaskRows().map((row) => this.toTask(row))
  }

  getTask(ticketId: string): TaskSnapshot {
    return this.requireTask(ticketId)
  }

  getTicket(ticketId: string): Ticket | undefined {
    return this.repo.tickets.get(ticketId)
  }

  exportTask(ticketId: string): TaskStateExport {
    const task = this.getTask(ticketId)
    const ticket = this.repo.tickets.get(ticketId)
    const assignment = ticket ? runningAssignment(ticket) ?? latestAssignment(ticket) : undefined
    return {
      schema: 'pet-followup-state/v1',
      generatedAt: this.clock.now(),
      ticketId,
      task,
      upstream: {
        ticket: {
          id: ticketId,
          title: ticket?.title ?? task.title,
          ...(ticket?.ended ? { ended: ticket.ended } : {}),
          ...(ticket?.attention ? { attention: ticket.attention } : {}),
          ...(assignment ? { assignment: assignment.id } : {}),
        },
        events: this.db.listEvents(ticketId),
      },
      decisions: this.db.listProposals(ticketId).map((row) => this.toSummary(row)),
      receipts: this.db.listReceipts(ticketId),
      completionCheck: this.completionCheck(task),
    }
  }

  completionCheck(task: TaskSnapshot): CompletionCheck {
    const reasons: string[] = []
    const identityReasons: string[] = []
    const checked: string[] = []
    const unresolved = this.blockingEffects(task.ticketId)
    if (unresolved.length) reasons.push(`unresolved_effect:${unresolved.map((effect) => effect.effect_id).join(',')}`)
    // 当前目标请求必须仍在权威事件里，且与当前 taskRevision 对齐。
    const goalEvent = this.db
      .listEvents(task.ticketId)
      .filter(
        (event) =>
          (event.kind === 'user.delegated' || event.kind === 'user.changed') &&
          event.taskRevision === task.taskRevision,
      )
      .at(-1)
    if (!goalEvent) reasons.push('current_goal_event_missing')

    // 当前权威输入：结果事件 + 任务里记录的来源身份，两者必须同时成立。
    const current = this.inputRefFromTask(task)
    if (task.result && !current.ref) {
      identityReasons.push(`current_input_identity_incomplete:${current.reasons.join('+')}`)
    }
    if (task.goalCondition.requireResultArtifact) {
      if (!task.result?.artifactPath) {
        reasons.push('result_artifact_missing')
      } else {
        const abs = this.absoluteToRoot(task.result.artifactPath)
        checked.push(abs)
        const verify = this.verifyArtifactFile(abs, task.result.artifactSha)
        if (!verify.ok) reasons.push(`result_artifact:${verify.detail}`)
      }
    }
    if (task.result) {
      if (!task.result.resultPath) {
        reasons.push('result_file_path_missing')
      } else {
        const abs = this.absoluteToRoot(task.result.resultPath)
        checked.push(abs)
        const verify = this.verifyArtifactFile(abs, task.result.resultFileSha)
        if (!verify.ok) identityReasons.push(`result_file:${verify.detail}`)
      }
    }
    if (task.result && task.goalCondition.insufficientStatuses.includes(task.result.status as 'succeeded' | 'failed' | 'partial')) {
      const accepted =
        task.lastAnswer?.optionId === 'accept_current' || task.lastAnswer?.optionId === 'accept_without_analysis'
      if (!accepted && !task.analysis) reasons.push('result_insufficient_unresolved')
    }
    let receiptId: string | null = null
    const insufficient = Boolean(
      task.result && task.goalCondition.insufficientStatuses.includes(task.result.status as 'succeeded' | 'failed' | 'partial'),
    )
    if (task.goalCondition.requireAnalysisArtifact && insufficient) {
      const analysis = task.analysis
      if (!analysis) {
        reasons.push('analysis_missing')
      } else {
        receiptId = analysis.receiptId
        const receipt = this.db.getReceipt(analysis.receiptId)
        if (!receipt) reasons.push('receipt_missing')
        else if (!receipt.ok) reasons.push('receipt_not_ok')
        else if (task.goalCondition.requireReceipt && receipt.taskRevision !== task.taskRevision) {
          reasons.push('receipt_revision_stale')
        }
        const abs = this.absoluteToRoot(analysis.artifactPath)
        checked.push(abs)
        const verify = this.verifyArtifactFile(abs, analysis.artifactSha)
        if (!verify.ok) reasons.push(`analysis_artifact:${verify.detail}`)
        if (receipt?.outputSha256 && receipt.outputSha256 !== analysis.artifactSha) reasons.push('receipt_sha_mismatch')

        // 当前输入 → 执行输入 → 回执 → 分析，逐项相等；缺身份即拒绝。
        if (!receipt?.inputRef) identityReasons.push('receipt_input_identity_missing')
        if (!receipt?.inputsVerified) identityReasons.push('receipt_inputs_unverified')
        if (!analysis.inputRef) identityReasons.push('analysis_input_identity_missing')
        if (!current.ref) {
          identityReasons.push('current_input_identity_unavailable')
        } else {
          if (receipt?.inputRef && canonicalJson(receipt.inputRef) !== canonicalJson(current.ref)) {
            identityReasons.push('receipt_input_mismatch')
          }
          if (analysis.inputRef && canonicalJson(analysis.inputRef) !== canonicalJson(current.ref)) {
            identityReasons.push('analysis_input_mismatch')
          }
          if (receipt?.inputRef && receipt.inputRef.resultFileSha !== analysis.inputRef?.resultFileSha) {
            identityReasons.push('receipt_analysis_input_mismatch')
          }
        }
      }
    }
    reasons.push(...identityReasons)
    return {
      ok: reasons.length === 0,
      reasons,
      receiptId,
      artifactPath: task.analysis?.artifactPath ?? task.result?.artifactPath ?? null,
      artifactSha: task.analysis?.artifactSha ?? task.result?.artifactSha ?? null,
      checkedPaths: checked,
      inputRef: current.ref,
      inputConsistent: identityReasons.length === 0 && Boolean(current.ref),
      unresolvedEffects: unresolved.map((effect) => effect.effect_id),
    }
  }

  // ------------------------------------------------------------------
  // 引擎配置
  // ------------------------------------------------------------------

  private policy(): Policy {
    return {
      version: POLICY_VERSION,
      paused: false,
      gate: (trigger: Trigger) => {
        if (trigger.source === 'pet' || trigger.source === 'inbox') {
          return {
            admissible: true,
            strength: trigger.human ? 'explicit' : 'inferred',
            basis: { via: 'followup' },
          }
        }
        return { admissible: false, reason: 'senderNotMember' }
      },
      revalidate: () => true,
      admitsInferred: () => false,
      evalTimeoutMs: 24 * 60 * 60_000,
    }
  }

  private executor(): Executor {
    return {
      start: (ticket: Ticket, assignment: Assignment) => {
        this.queueEffect({
          kind: 'start_assignment',
          ticketId: ticket.id,
          assignmentId: assignment.id,
          taskRevision: this.taskRevisionOrDefault(ticket.id),
          dedupeKey: `start:${assignment.id}`,
        })
      },
      deliver: (ticket: Ticket, assignment: Assignment) => {
        const inputIds = [...ticket.undelivered]
        if (!inputIds.length) return
        this.queueEffect({
          kind: 'deliver_inputs',
          ticketId: ticket.id,
          assignmentId: assignment.id,
          taskRevision: this.taskRevisionOrDefault(ticket.id),
          dedupeKey: `deliver:${assignment.id}:${inputIds.sort().join(',')}`,
          args: { inputIds },
        })
      },
      stop: (_ticket: Ticket, _assignment: Assignment, reason: string) => {
        this.db.driverLog(this.clock.now(), _ticket.id, 'executor.stop', { reason })
      },
    }
  }

  private outbox(): Outbox {
    return {
      send: (message) => {
        this.db.insertNotification({
          notificationId: message.id,
          ticketId: message.ticketId ?? '',
          attentionId: null,
          decisionId: null,
          text: message.text,
          createdAt: this.clock.now(),
          state: 'queued',
        })
      },
      status: (id) => {
        const row = this.db.handle.prepare('SELECT 1 AS present FROM notifications WHERE notification_id = ?').get(id) as
          | { present: number }
          | undefined
        return row ? 'sent' : undefined
      },
      withdraw: () => undefined,
    }
  }

  // ------------------------------------------------------------------
  // effect 队列
  // ------------------------------------------------------------------

  private queueEffect(input: {
    kind: string
    ticketId: string
    assignmentId: string | null
    taskRevision: number
    dedupeKey: string
    tool?: ToolName
    args?: Record<string, unknown>
    inputRef?: InputRef | null
  }): void {
    const effectId = stableId('fx', input.ticketId, input.taskRevision, input.kind, input.dedupeKey)
    const existing = this.db.getEffect(effectId)
    if (existing) return
    const row: EffectRow = {
      effect_id: effectId,
      ticket_id: input.ticketId,
      task_revision: input.taskRevision,
      assignment_id: input.assignmentId,
      attempt_id: stableId('att', input.ticketId, input.taskRevision, input.kind, input.dedupeKey),
      kind: input.kind,
      tool: input.tool ?? null,
      args_json: input.args ? canonicalJson(input.args) : null,
      input_ref_json: input.inputRef ? canonicalJson(input.inputRef) : null,
      state: 'pending',
      created_at: this.clock.now(),
      started_at: null,
      finished_at: null,
      detail: null,
    }
    this.db.saveEffect(row)
  }

  private drain(): void {
    try {
      for (let step = 0; step < MAX_DRAIN_STEPS; step += 1) {
        // 未对账的执行结果必须先人工/显式处理，不能靠后续 drain 绕过。
        const pending = this.db.listEffects('pending').filter((effect) => !this.isTicketBlocked(effect.ticket_id))
        if (pending.length) {
          this.db.maybeCrash('pre_dispatch')
          this.dispatchEffect(pending[0]!)
          continue
        }
        if (this.proposeAll()) continue
        break
      }
    } finally {
      this.deliverPending()
      this.syncWakes()
    }
  }

  private dispatchEffect(effect: EffectRow): void {
    const now = this.clock.now()
    if (effect.kind === 'start_assignment' && effect.assignment_id) {
      this.db.atomic(() => {
        this.db.saveEffect({ ...effect, state: 'running', started_at: now })
        const task = this.requireTask(effect.ticket_id)
        if (task.status !== 'active') {
          this.db.saveEffect({ ...effect, state: 'invalidated', finished_at: now, detail: 'task not active' })
          return
        }
        if (!this.assignmentBelongsToTicket(task, effect.assignment_id!)) {
          this.db.saveEffect({ ...effect, state: 'invalidated', finished_at: now, detail: 'assignment no longer current' })
          return
        }
        const assignmentId = effect.assignment_id
        if (!assignmentId) return
        this.engine.assignmentStarted(effect.ticket_id, assignmentId)
        this.reportSafe(effect.ticket_id, assignmentId, {
          state: 'waiting',
          summary: '等待实验结果落盘（面板可关闭，委托仍在）',
        })
        task.assignmentId = effect.assignment_id
        task.stage = this.attention.listOpen(effect.ticket_id).length
          ? 'awaiting_decision'
          : task.result
            ? 'result_received'
            : 'awaiting_result'
        task.updatedAt = now
        this.saveTask(task)
        this.db.saveEffect({ ...effect, state: 'succeeded', finished_at: now })
        this.db.driverLog(now, effect.ticket_id, 'effect.start_assignment', { assignmentId: effect.assignment_id })
      })
      return
    }
    if (effect.kind === 'deliver_inputs' && effect.assignment_id) {
      const inputIds = this.parseInputIds(effect)
      this.db.atomic(() => {
        this.db.saveEffect({ ...effect, state: 'running', started_at: now })
        const task = this.requireTask(effect.ticket_id)
        const ticket = this.repo.tickets.get(effect.ticket_id)
        if (task.status !== 'active' || !ticket || ticket.ended) {
          this.db.saveEffect({ ...effect, state: 'invalidated', finished_at: now, detail: 'ticket/task no longer active' })
          return
        }
        const current = runningAssignment(ticket) ?? latestAssignment(ticket)
        if (!current || current.id !== effect.assignment_id) {
          this.db.saveEffect({ ...effect, state: 'invalidated', finished_at: now, detail: 'assignment no longer current' })
          this.db.driverLog(now, effect.ticket_id, 'effect.deliver_blocked', { reason: 'stale_assignment', effect: effect.effect_id })
          return
        }
        this.engine.inputsDelivered(effect.ticket_id, effect.assignment_id, inputIds)
        this.engine.inputsRead(effect.ticket_id, inputIds)
        this.reportSafe(effect.ticket_id, effect.assignment_id!, {
          state: 'progress',
          summary: `本地工作区已读取 ${inputIds.length} 条到达信息，正在核对证据`,
        })
        task.assignmentId = effect.assignment_id
        task.updatedAt = now
        this.saveTask(task)
        this.db.saveEffect({ ...effect, state: 'succeeded', finished_at: now })
        this.db.driverLog(now, effect.ticket_id, 'effect.deliver_inputs', { inputIds })
      })
      return
    }
    if (effect.kind === 'tool' && effect.tool) {
      this.dispatchTool(effect, effect.tool as ToolName)
      return
    }
    this.db.atomic(() => {
      this.db.saveEffect({ ...effect, state: 'invalidated', finished_at: now, detail: `unknown effect kind ${effect.kind}` })
    })
  }

  private dispatchTool(effect: EffectRow, tool: ToolName): void {
    const now = this.clock.now()
    const args = effect.args_json ? (JSON.parse(effect.args_json) as Record<string, string | number | boolean>) : {}
    this.db.atomic(() => {
      this.db.saveEffect({ ...effect, state: 'running', started_at: now })
    })
    this.inFlight.add(effect.effect_id)
    try {
      // 真实进程在“工具已开始、结果未确认”时退出：重启后必须进入 needs_reconciliation。
      this.db.maybeCrash('effect_running')

      // 派发前核对：当前权威结果 → effect 预期输入 → 磁盘实际字节。任何一项不成立都 fail closed。
      const gate = this.verifyEffectInputs(effect)
      if (!gate.ok) {
        this.db.atomic(() => {
          const at = this.clock.now()
          this.db.saveEffect({ ...effect, state: 'invalidated', finished_at: at, detail: `input_gate:${gate.detail}` })
          const task = this.requireTask(effect.ticket_id)
          task.diagnostics = [...task.diagnostics.slice(-40), `tool_input_rejected:${gate.detail}`]
          // 已知的“执行前拒绝”：授权已被消耗，工具没有执行。
          // 保留证据但不得继续驱动同一个动作；必须由用户对当前版本重新授权后才能新建 attempt。
          task.continuation = {
            kind: 'input_rejected',
            detail: gate.detail,
            effectId: effect.effect_id,
            attempt: task.attempt,
            decisionId: task.lastProposal?.decisionId ?? null,
            optionId: task.lastAnswer?.optionId ?? null,
            at,
          }
          task.lastAnswer = undefined
          if (task.stage !== 'needs_reconciliation') task.stage = 'continuation_pending'
          this.saveTask(task)
          this.db.driverLog(at, effect.ticket_id, 'effect.input_rejected', {
            effectId: effect.effect_id,
            detail: gate.detail,
            continuation: 'required',
          })
        })
        return
      }

      const request: ToolRequest = {
        tool,
        args: { ...args, ...(gate.snapshotPath ? { resultSnapshotPath: gate.snapshotPath } : {}) },
      }
      const execution = this.tools.execute(request, {
        effectId: effect.effect_id,
        attemptId: effect.attempt_id,
        ticketId: effect.ticket_id,
        taskRevision: effect.task_revision,
        assignmentId: effect.assignment_id ?? '',
        now,
        inputRef: gate.inputRef,
        resultSnapshotPath: gate.snapshotPath ?? '',
      })
      this.db.atomic(() => {
        const task = this.requireTask(effect.ticket_id)
        const receipt: ToolReceipt = execution.receipt
        this.db.saveEffect({
          ...effect,
          state: receipt.needsReconciliation ? 'needs_reconciliation' : receipt.ok ? 'succeeded' : 'failed',
          finished_at: this.clock.now(),
          detail: receipt.detail,
        })
        this.db.saveReceipt(receipt)
        const receiptEvent = this.makeEvent({
          kind: 'tool.receipt',
          sourceId: `receipt:${receipt.receiptId}`,
          sourceRevision: '1',
          at: receipt.finishedAt,
          ticketId: task.ticketId,
          taskRevision: task.taskRevision,
          payload: {
            tool: receipt.tool,
            effectId: receipt.effectId,
            receiptId: receipt.receiptId,
            ok: receipt.ok,
            outputPath: receipt.outputPath,
            outputSha256: receipt.outputSha256,
            bytesWritten: receipt.bytesWritten,
            detail: receipt.detail,
            needsReconciliation: receipt.needsReconciliation,
            inputRef: receipt.inputRef,
            inputsVerified: receipt.inputsVerified,
          },
        })
        const inserted = this.db.insertEvent(receiptEvent, this.clock.now())
        const memory = this.memory.ingest({
          event: receiptEvent,
          eventCursor: inserted.seq,
          ticketId: task.ticketId,
          taskRevision: task.taskRevision,
          label: `工具 ${receipt.tool} ${receipt.ok ? '成功' : '失败'}`,
        })
        task.eventCursor = inserted.seq
        task.memoryCursor = memory.cursor
        task.updatedAt = receipt.finishedAt
        if (receipt.ok && receipt.outputPath && receipt.outputSha256) {
          const ref: EvidenceRef = {
            sourceId: `receipt:${receipt.receiptId}`,
            sourceRevision: '1',
            sha256: receipt.outputSha256,
            memoryEventIds: [memory.memoryEventId],
            noteIds: memory.noteIds,
            noteVersions: memory.noteVersions,
          }
          task.evidence = [...task.evidence, ref].slice(-8)
        }
        if (receipt.tool === 'write_analysis' && receipt.ok && receipt.outputPath && receipt.outputSha256) {
          task.analysis = {
            artifactPath: this.relativeToRoot(this.absoluteToRoot(receipt.outputPath)),
            artifactSha: receipt.outputSha256,
            receiptId: receipt.receiptId,
            inputRef: receipt.inputRef,
          }
          task.stage = 'analyzing'
        } else if (receipt.needsReconciliation) {
          task.stage = 'needs_reconciliation'
          task.diagnostics = [...task.diagnostics.slice(-40), `needs_reconciliation:${receipt.effectId}`]
        } else if (!receipt.ok) {
          task.stage = 'awaiting_decision'
          task.diagnostics = [...task.diagnostics.slice(-40), `tool_failed:${receipt.tool}:${receipt.detail}`]
        }
        this.saveTask(task)
        this.db.driverLog(receipt.finishedAt, task.ticketId, 'effect.tool', {
          effect: effect.effect_id,
          receipt: receipt.receiptId,
          ok: receipt.ok,
          bytesWritten: receipt.bytesWritten,
          inputsVerified: receipt.inputsVerified,
        })
      })
      this.db.maybeCrash('receipt_persisted')
    } finally {
      this.inFlight.delete(effect.effect_id)
    }
  }

  // ------------------------------------------------------------------
  // 提案与完成
  // ------------------------------------------------------------------

  private proposeAll(): boolean {
    let progressed = false
    for (const snapshot of this.listTasks()) {
      if (snapshot.status !== 'active') continue
      if (snapshot.stage === 'memory_behind' || snapshot.stage === 'needs_reconciliation') continue
      if (snapshot.openAttention) {
        if (this.ensureAttentionNotified(snapshot)) progressed = true
        continue
      }
      const task = this.requireTask(snapshot.ticketId)
      if (!this.memoryCaughtUp(task)) {
        task.stage = 'memory_behind'
        task.diagnostics = [...task.diagnostics.slice(-40), `memory_behind:e${task.eventCursor}/m${task.memoryCursor}`]
        this.db.atomic(() => this.saveTask(task))
        continue
      }
      if (task.stage === 'memory_behind') {
        task.stage = task.result ? 'result_received' : 'awaiting_result'
        this.db.atomic(() => this.saveTask(task))
      }
      if (this.db.countEffects(task.ticketId, 'tool') > 0) {
        const pendingTool = this.db.listEffects('pending').some((effect) => effect.ticket_id === task.ticketId && effect.kind === 'tool')
        if (pendingTool) continue
      }
      const goal = this.completionCheck(task)
      if (goal.ok) {
        if (this.completeTask(task, goal)) progressed = true
        continue
      }

      const context = this.buildContext(task, goal.ok)
      const proposals = this.decision.propose(context)
      let executed = false
      for (const proposal of proposals) {
        if (this.executeProposal(task, proposal)) {
          executed = true
          break
        }
      }
      if (executed) progressed = true
    }
    return progressed
  }

  /** 静默结束后补发既有问题；同一个 attention 只发一次。 */
  private ensureAttentionNotified(task: TaskSnapshot): boolean {
    const attention = task.openAttention
    if (!attention) return false
    if (this.db.hasNotificationForAttention(attention.attentionId)) return false
    const notified = this.attention.notify(attention.attentionId, this.clock.now(), this.quiet, false)
    if (!notified.notified) return false
    this.db.driverLog(this.clock.now(), task.ticketId, 'attention.notified_late', {
      attentionId: attention.attentionId,
      reason: notified.reason,
    })
    return true
  }

  private executeProposal(task: TaskRecord, proposal: ProposedDecision, fromFlush = false): boolean {
    const now = this.clock.now()
    const stored = this.db.getProposal(proposal.decisionId)
    const validation =
      fromFlush && this.deferProposals && this.validationMode === 'proposal-only' && stored
        ? (JSON.parse(stored.validation_json) as ValidationRecord[])[0] ?? this.validateAt(task, proposal, 'proposal')
        : this.validateAt(task, proposal, 'proposal')
    const row: ProposalRow = {
      decision_id: proposal.decisionId,
      ticket_id: proposal.ticketId,
      task_revision: proposal.taskRevision,
      assignment_id: proposal.assignmentId,
      kind: proposal.kind,
      reason_code: proposal.reasonCode,
      reason_text: proposal.reasonText,
      decision_key: proposal.decisionKey ?? proposal.decisionId,
      question: proposal.question ?? null,
      options_json: proposal.options ? canonicalJson(proposal.options) : null,
      not_before: proposal.notBefore ?? null,
      deadline: proposal.deadline ?? null,
      tool_json: proposal.toolRequest ? canonicalJson(proposal.toolRequest) : null,
      evidence_json: canonicalJson(proposal.evidenceRefs),
      implementation: proposal.implementation,
      created_at: now,
      validation_json: canonicalJson([validation]),
      outcome: validation.ok ? 'open' : 'invalidated',
    }
    this.db.atomic(() => this.db.saveProposal(row))
    if (this.deferProposals && !fromFlush) {
      this.db.atomic(() => this.recordLastProposal(task, row, validation.ok ? 'open' : 'invalidated'))
      return false
    }
    if (!validation.ok) {
      this.db.driverLog(now, task.ticketId, 'proposal.rejected', { proposal: proposal.decisionId, code: validation.code, detail: validation.detail })
      this.recordLastProposal(task, row, 'invalidated')
      return false
    }
    if (proposal.kind === 'record_only' || proposal.kind === 'defer') {
      this.db.atomic(() => {
        this.db.saveProposal({ ...row, outcome: 'recorded' })
        this.recordLastProposal(task, row, 'recorded')
      })
      return false
    }
    if (proposal.kind === 'ask_user') {
      return this.executeAsk(task, proposal, row)
    }
    if (proposal.kind === 'continue_local') {
      return this.executeTool(task, proposal, row)
    }
    if (proposal.kind === 'notify_result') {
      return this.executeNotifyResult(task, proposal, row)
    }
    return false
  }

  private executeAsk(task: TaskRecord, proposal: ProposedDecision, row: ProposalRow): boolean {
    const now = this.clock.now()
    if (!proposal.question || !proposal.options?.length) {
      this.db.atomic(() => this.db.saveProposal({ ...row, outcome: 'invalidated' }))
      return false
    }
    const notifyValidation =
      this.validationMode === 'proposal-only'
        ? { at: now, stage: 'notify' as const, ok: true, code: 'skipped', detail: 'proposal-only ablation' }
        : this.validateAt(task, proposal, 'notify')
    if (!notifyValidation.ok) {
      this.db.atomic(() => {
        this.db.saveProposal({ ...row, outcome: 'invalidated', validation_json: canonicalJson([notifyValidation]) })
        this.recordLastProposal(task, row, 'invalidated')
      })
      this.db.driverLog(now, task.ticketId, 'proposal.notify_blocked', { code: notifyValidation.code, detail: notifyValidation.detail })
      return false
    }
    const opened = this.attention.open(proposal, now, this.quiet)
    const urgent = this.isUrgent(proposal)
    const notified = this.attention.notify(opened.attention.attentionId, now, this.quiet, urgent)
    this.db.atomic(() => {
      const fresh = this.requireTask(task.ticketId)
      fresh.stage = 'awaiting_decision'
      fresh.updatedAt = now
      this.saveTask(fresh)
      this.db.saveProposal({
        ...row,
        outcome: opened.merged ? 'merged' : 'open',
        validation_json: canonicalJson([this.validateAt(fresh, proposal, 'proposal'), notifyValidation]),
      })
      this.recordLastProposal(fresh, row, opened.merged ? 'merged' : 'open')
    })
    const assignment = this.currentAssignmentId(task.ticketId)
    if (assignment) {
      this.reportSafe(task.ticketId, assignment, { state: 'waiting', summary: proposal.reasonText, question: proposal.question })
    }
    this.db.driverLog(now, task.ticketId, 'proposal.ask_user', {
      attentionId: opened.attention.attentionId,
      merged: opened.merged,
      notified: notified.notified,
      notifyReason: notified.reason,
      urgent,
    })
    return true
  }

  private executeTool(task: TaskRecord, proposal: ProposedDecision, row: ProposalRow): boolean {
    const now = this.clock.now()
    const request = proposal.toolRequest
    if (!request) {
      this.db.atomic(() => this.db.saveProposal({ ...row, outcome: 'invalidated' }))
      return false
    }
    const executeValidation =
      this.validationMode === 'proposal-only'
        ? { at: now, stage: 'execute' as const, ok: true, code: 'skipped', detail: 'proposal-only ablation' }
        : this.validateAt(task, proposal, 'execute')
    if (!executeValidation.ok) {
      this.db.atomic(() => {
        this.db.saveProposal({ ...row, outcome: 'invalidated', validation_json: canonicalJson([executeValidation]) })
        this.recordLastProposal(task, row, 'invalidated')
      })
      this.db.driverLog(now, task.ticketId, 'proposal.rejected_before_execute', { code: executeValidation.code, detail: executeValidation.detail })
      return false
    }
    const input = this.inputRefFromTask(task)
    if (!input.ref) {
      // 没有可核验的当前输入身份：不创建“盲执行”的工具 attempt。
      this.db.atomic(() => {
        const fresh = this.requireTask(task.ticketId)
        fresh.diagnostics = [
          ...fresh.diagnostics.slice(-40),
          `tool_input_unavailable:${input.reasons.join('+')}`,
        ]
        this.saveTask(fresh)
        this.db.saveProposal({ ...row, outcome: 'invalidated', validation_json: canonicalJson([executeValidation]) })
        this.recordLastProposal(fresh, row, 'invalidated')
      })
      this.db.driverLog(now, task.ticketId, 'proposal.input_unavailable', { reasons: input.reasons })
      return false
    }
    // 与 queueEffect 使用同一个 dedupeKey，否则“同一次尝试不重试”的判断永远不成立。
    const dedupeKey = `${request.tool}:${task.attempt}`
    const effectId = stableId('fx', task.ticketId, task.taskRevision, 'tool', dedupeKey)
    const existing = this.db.getEffect(effectId)
    if (existing) {
      // 已记录成功/失败/invalidated 的同一次尝试不自动重试；失败留给明确的下一步。
      this.db.atomic(() => {
        this.db.saveProposal({ ...row, outcome: 'executed', validation_json: canonicalJson([executeValidation]) })
        this.recordLastProposal(task, row, 'executed')
      })
      this.db.driverLog(now, task.ticketId, 'proposal.no_retry', { tool: request.tool, effectId, state: existing.state })
      return false
    }
    this.db.atomic(() => {
      this.queueEffect({
        kind: 'tool',
        ticketId: task.ticketId,
        assignmentId: task.assignmentId,
        taskRevision: task.taskRevision,
        dedupeKey,
        tool: request.tool,
        args: request.args,
        inputRef: input.ref,
      })
      this.db.saveProposal({ ...row, outcome: 'executed', validation_json: canonicalJson([executeValidation]) })
      const fresh = this.requireTask(task.ticketId)
      fresh.stage = 'analyzing'
      fresh.attempt = Math.max(fresh.attempt, task.attempt)
      this.saveTask(fresh)
      this.recordLastProposal(fresh, row, 'executed')
    })
    this.db.driverLog(now, task.ticketId, 'proposal.continue_local', { tool: request.tool, effectId })
    return true
  }

  private executeNotifyResult(task: TaskRecord, proposal: ProposedDecision, row: ProposalRow): boolean {
    const now = this.clock.now()
    const validation = this.validateAt(task, proposal, 'notify')
    if (!validation.ok) {
      this.db.atomic(() => this.db.saveProposal({ ...row, outcome: 'invalidated', validation_json: canonicalJson([validation]) }))
      return false
    }
    const notificationId = stableId('notif', task.ticketId, proposal.decisionId, 'result')
    this.db.atomic(() => {
      this.db.insertNotification({
        notificationId,
        ticketId: task.ticketId,
        attentionId: null,
        decisionId: proposal.decisionId,
        text: proposal.question ?? proposal.reasonText,
        createdAt: now,
        state: 'queued',
      })
      this.db.saveProposal({ ...row, outcome: 'executed', validation_json: canonicalJson([validation]) })
      this.recordLastProposal(task, row, 'executed')
    })
    return true
  }

  private completeTask(task: TaskRecord, check: CompletionCheck): boolean {
    const now = this.clock.now()
    const assignment = this.currentAssignmentId(task.ticketId)
    const reported = assignment
      ? this.reportSafe(task.ticketId, assignment, { state: 'ready', summary: `目标条件已由核验产物满足：${check.artifactPath}` })
      : false
    this.db.atomic(() => {
      const fresh = this.requireTask(task.ticketId)
      const ticket = this.repo.tickets.get(task.ticketId)
      if (!ticket?.ended || ticket.ended.outcome !== 'completed') {
        // 目标条件已满足但上游没有结束委托：不假装完成，转入显式待对账状态。
        fresh.diagnostics = [...fresh.diagnostics.slice(-40), `completion_blocked:${reported ? 'ticket_not_ended' : 'no_assignment'}`]
        fresh.stage = 'needs_reconciliation'
        this.saveTask(fresh)
        return
      }
      fresh.status = 'completed'
      fresh.stage = 'completed'
      fresh.updatedAt = now
      fresh.completion = {
        at: ticket.ended.at,
        receiptId: check.receiptId,
        artifactSha: check.artifactSha,
        checkedPaths: check.checkedPaths,
        inputRef: check.inputRef,
      }
      const event = this.makeEvent({
        kind: 'tool.receipt',
        sourceId: `complete:${task.ticketId}:${task.taskRevision}`,
        sourceRevision: '1',
        at: now,
        ticketId: task.ticketId,
        taskRevision: fresh.taskRevision,
        payload: { completion: true, receiptId: check.receiptId, artifactSha: check.artifactSha, checkedPaths: check.checkedPaths },
      })
      if (!this.db.getEvent(event.eventId)) {
        const inserted = this.db.insertEvent(event, now)
        const memory = this.memory.ingest({
          event,
          eventCursor: inserted.seq,
          ticketId: task.ticketId,
          taskRevision: fresh.taskRevision,
          label: '完成核验',
        })
        fresh.eventCursor = inserted.seq
        fresh.memoryCursor = memory.cursor
      }
      this.saveTask(fresh)
      this.db.driverLog(now, task.ticketId, 'task.completed', { receiptId: check.receiptId, artifactSha: check.artifactSha })
    })
    return true
  }

  // ------------------------------------------------------------------
  // 上下文与校验
  // ------------------------------------------------------------------

  private buildContext(task: TaskRecord, goalSatisfied: boolean): DecisionContext {
    const snapshot: TaskSnapshot = { ...task }
    const memory = this.memory.readRelevant(snapshot, task.goal)
    return {
      task: snapshot,
      trigger: this.db.listEvents(task.ticketId).at(-1) ?? null,
      evidence: task.evidence.slice(-4),
      memory,
      now: this.clock.now(),
      quiet: this.quiet,
      history: this.db.listProposals(task.ticketId).map((row) => this.toSummary(row)),
      openAttention: this.attention.listOpen(task.ticketId)[0],
      goalSatisfied,
      lastAnswer: task.lastAnswer,
      attempt: task.attempt,
      inputReady: this.currentInputReady(task),
    }
  }

  /** 当前版本的输入是否已可核验：身份齐全且磁盘字节与记录一致。 */
  private currentInputReady(task: TaskRecord): boolean {
    const current = this.inputRefFromTask(task)
    const ref = current.ref
    const resultPath = ref?.resultPath
    if (!ref || !resultPath) return false
    if (!this.verifyArtifactFile(this.absoluteToRoot(resultPath), ref.resultFileSha).ok) return false
    if (ref.artifactPath && !this.verifyArtifactFile(this.absoluteToRoot(ref.artifactPath), ref.artifactSha).ok) return false
    return true
  }

  private validateAt(task: TaskRecord, proposal: ProposedDecision, stage: ValidationRecord['stage']): ValidationRecord {
    const now = this.clock.now()
    const fresh = this.db.getTaskRow(task.ticketId)
    if (!fresh) return { at: now, stage, ok: false, code: 'task_missing', detail: 'task row missing' }
    const current = this.toTask(fresh)
    if (current.status !== 'active') return { at: now, stage, ok: false, code: 'task_closed', detail: current.status }
    if (proposal.taskRevision !== current.taskRevision) {
      return { at: now, stage, ok: false, code: 'stale_task_revision', detail: `proposal r${proposal.taskRevision} current r${current.taskRevision}` }
    }
    if (proposal.assignmentId !== (current.assignmentId ?? '')) {
      return { at: now, stage, ok: false, code: 'stale_assignment', detail: `proposal ${proposal.assignmentId} current ${current.assignmentId ?? 'none'}` }
    }
    if (!this.memoryCaughtUp(current)) {
      return { at: now, stage, ok: false, code: 'cursor_behind', detail: `event ${current.eventCursor} memory ${current.memoryCursor}` }
    }
    const verdict = this.memory.validate(proposal.evidenceRefs)
    if (!verdict.ok) return { at: now, stage, ok: false, code: verdict.code, detail: verdict.detail }
    return { at: now, stage, ok: true, code: 'ok', detail: 'version and evidence match current task' }
  }

  private memoryCaughtUp(task: TaskRecord): boolean {
    return task.memoryCursor >= task.eventCursor && this.memory.cursor() >= task.eventCursor
  }

  /** 紧急 = 决策截止在 15 分钟内；只有 allowUrgent=true 时才允许越过静默。 */
  private isUrgent(proposal: ProposedDecision): boolean {
    if (!proposal.deadline) return false
    const remaining = Date.parse(proposal.deadline) - Date.parse(this.clock.now())
    return Number.isFinite(remaining) && remaining >= 0 && remaining <= 15 * 60_000
  }

  // ------------------------------------------------------------------
  // 上游桥接
  // ------------------------------------------------------------------

  private reportSafe(ticketId: string, assignmentId: string, report: Parameters<Engine['report']>[1]): boolean {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket || ticket.ended) {
      this.db.driverLog(this.clock.now(), ticketId, 'report.blocked', { reason: 'ticket_missing_or_ended', assignmentId })
      return false
    }
    const current = runningAssignment(ticket) ?? latestAssignment(ticket)
    if (!current || current.id !== assignmentId) {
      this.db.driverLog(this.clock.now(), ticketId, 'report.blocked', {
        reason: 'stale_assignment',
        attempted: assignmentId,
        current: current?.id ?? null,
      })
      return false
    }
    try {
      this.engine.report(ticketId, report)
      return true
    } catch (error) {
      const code = error instanceof UserError ? error.code : 'report_failed'
      this.db.driverLog(this.clock.now(), ticketId, 'report.blocked', { reason: code, detail: (error as Error).message })
      return false
    }
  }

  private attachTrigger(task: TaskRecord, input: { id: string; threadId: string; at: string; text: string; human: boolean }): void {
    const trigger: Trigger = {
      id: input.id,
      source: input.human ? 'pet' : 'inbox',
      threads: [{ source: 'pet', id: input.threadId }],
      actor: { source: input.human ? 'pet' : 'inbox', id: input.human ? this.actorId : 'watcher' },
      human: input.human,
      at: input.at,
      text: input.text,
      meta: { ticketId: task.ticketId },
      ...(input.human ? { channel: { source: 'pet', thread: input.threadId, address: { panel: '1' } } } : {}),
    }
    this.engine.receive(trigger)
    if (!input.human) {
      try {
        this.engine.decide(trigger.id, { kind: 'ignore', reason: '作为 Input 挂到既有委托，不另起任务' })
      } catch (error) {
        this.db.driverLog(this.clock.now(), task.ticketId, 'trigger.ignore_failed', { detail: (error as Error).message })
      }
    }
  }

  private humanTrigger(input: { id: string; threadId: string; at: string; text: string }): Trigger {
    return {
      id: input.id,
      source: 'pet',
      threads: [{ source: 'pet', id: input.threadId }],
      actor: { source: 'pet', id: this.actorId },
      human: true,
      addressed: 'direct',
      at: input.at,
      text: input.text,
      channel: { source: 'pet', thread: input.threadId, address: { panel: '1' } },
      meta: {},
    }
  }

  private taskThreadId(ticketId: string): string {
    const ticket = this.repo.tickets.get(ticketId)
    const origin = ticket ? this.repo.triggers.get(ticket.origin.triggerId) : undefined
    return origin?.threads[0]?.id ?? `followup/${ticketId}`
  }

  /** 引擎在 delegate 决策过程中调用 Executor 时，任务行还没写入；此时按首个版本处理。 */
  private taskRevisionOrDefault(ticketId: string): number {
    return this.db.getTaskRow(ticketId)?.task_revision ?? 1
  }

  private currentAssignmentId(ticketId: string): string | null {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket || ticket.ended) return null
    return (runningAssignment(ticket) ?? latestAssignment(ticket))?.id ?? null
  }

  private assignmentBelongsToTicket(task: TaskRecord, assignmentId: string): boolean {
    const ticket = this.repo.tickets.get(task.ticketId)
    if (!ticket) return false
    return ticket.assignments.some((assignment) => assignment.id === assignmentId && assignment.state !== 'ended')
  }

  private syncFromTicket(task: TaskRecord): void {
    const ticket = this.repo.tickets.get(task.ticketId)
    if (!ticket?.ended) return
    if (task.status !== 'active') return
    const fresh = this.requireTask(task.ticketId)
    fresh.updatedAt = this.clock.now()
    if (ticket.ended.outcome === 'completed') {
      const check = this.completionCheck(fresh)
      if (check.ok) {
        fresh.status = 'completed'
        fresh.stage = 'completed'
        fresh.completion = {
          at: ticket.ended.at,
          receiptId: check.receiptId,
          artifactSha: check.artifactSha,
          checkedPaths: check.checkedPaths,
          inputRef: check.inputRef,
        }
      } else {
        fresh.diagnostics = [...fresh.diagnostics.slice(-40), `ticket_completed_without_verified_artifact:${check.reasons.join(',')}`]
      }
    } else if (ticket.ended.by === 'human') {
      fresh.status = 'cancelled'
      fresh.stage = 'cancelled'
      fresh.closeReason ??= ticket.ended.reason ?? 'stopped by person'
    } else {
      fresh.status = 'failed'
      fresh.stage = 'failed'
      fresh.closeReason ??= ticket.ended.reason ?? ticket.ended.outcome
    }
    this.saveTask(fresh)
  }

  // ------------------------------------------------------------------
  // 任务记录
  // ------------------------------------------------------------------

  private requireTask(ticketId: string): TaskRecord {
    const row = this.db.getTaskRow(ticketId)
    if (!row) throw new Error(`unknown task ${ticketId}`)
    return this.toTask(row)
  }

  private toTask(row: TaskRow): TaskRecord {
    const open = this.attention.listOpen(row.ticket_id)
    // 未对账的执行结果在读取时就保持阻断；tick/新事件/普通 scan 不能把它改回普通阶段。
    const blocked = this.blockingEffects(row.ticket_id).length > 0
    const stage = blocked && row.status === 'active' ? 'needs_reconciliation' : (row.stage as TaskStage)
    return {
      ticketId: row.ticket_id,
      title: row.title,
      goal: row.goal,
      goalCondition: JSON.parse(row.goal_json) as GoalCondition,
      taskRevision: row.task_revision,
      assignmentId: row.assignment_id,
      stage,
      status: row.status as TaskStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      eventCursor: row.event_cursor,
      memoryCursor: row.memory_cursor,
      evidence: JSON.parse(row.evidence_json) as EvidenceRef[],
      ...(row.last_proposal_json ? { lastProposal: JSON.parse(row.last_proposal_json) as ProposalSummary } : {}),
      ...(row.last_answer_json ? { lastAnswer: JSON.parse(row.last_answer_json) as { optionId: string; at: string } } : {}),
      ...(row.continuation_json ? { continuation: JSON.parse(row.continuation_json) as ContinuationState } : {}),
      attempt: row.attempt,
      ...(row.result_json ? { result: JSON.parse(row.result_json) as NonNullable<TaskRecord['result']> } : {}),
      ...(row.analysis_json ? { analysis: JSON.parse(row.analysis_json) as NonNullable<TaskRecord['analysis']> } : {}),
      ...(row.completion_json ? { completion: JSON.parse(row.completion_json) as NonNullable<TaskRecord['completion']> } : {}),
      ...(row.close_reason ? { closeReason: row.close_reason } : {}),
      diagnostics: JSON.parse(row.diagnostics_json) as string[],
      ...(open[0] ? { openAttention: open[0] } : {}),
    }
  }

  private saveTask(task: TaskRecord): void {
    this.db.saveTaskRow({
      ticket_id: task.ticketId,
      task_revision: task.taskRevision,
      assignment_id: task.assignmentId,
      title: task.title,
      goal: task.goal,
      goal_json: canonicalJson(task.goalCondition),
      stage: task.stage,
      status: task.status,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      event_cursor: task.eventCursor,
      memory_cursor: task.memoryCursor,
      evidence_json: canonicalJson(task.evidence),
      last_proposal_json: task.lastProposal ? canonicalJson(task.lastProposal) : null,
      last_answer_json: task.lastAnswer ? canonicalJson(task.lastAnswer) : null,
      continuation_json: task.continuation ? canonicalJson(task.continuation) : null,
      attempt: task.attempt,
      result_json: task.result ? canonicalJson(task.result) : null,
      analysis_json: task.analysis ? canonicalJson(task.analysis) : null,
      completion_json: task.completion ? canonicalJson(task.completion) : null,
      close_reason: task.closeReason ?? null,
      diagnostics_json: canonicalJson(task.diagnostics),
    })
  }

  private recordLastProposal(task: TaskRecord, row: ProposalRow, outcome: ProposalSummary['outcome']): void {
    const summary: ProposalSummary = {
      decisionId: row.decision_id,
      kind: row.kind as ProposalSummary['kind'],
      decisionKey: row.decision_key,
      reasonCode: row.reason_code,
      createdAt: row.created_at,
      taskRevision: row.task_revision,
      outcome,
    }
    const fresh = this.requireTask(task.ticketId)
    fresh.lastProposal = summary
    this.saveTask(fresh)
  }

  private proposalFromRow(row: ProposalRow): ProposedDecision {
    const options = row.options_json ? (JSON.parse(row.options_json) as ProposedDecision['options']) : undefined
    const tool = row.tool_json ? (JSON.parse(row.tool_json) as ProposedDecision['toolRequest']) : undefined
    const notBefore = row.not_before ?? undefined
    const deadline = row.deadline ?? undefined
    return {
      decisionId: row.decision_id,
      ticketId: row.ticket_id,
      taskRevision: row.task_revision,
      assignmentId: row.assignment_id ?? '',
      evidenceRefs: JSON.parse(row.evidence_json) as EvidenceRef[],
      kind: row.kind as ProposedDecision['kind'],
      reasonCode: row.reason_code,
      reasonText: row.reason_text,
      decisionKey: row.decision_key,
      implementation: 'scripted-rule',
      ...(row.question ? { question: row.question } : {}),
      ...(options ? { options } : {}),
      ...(notBefore ? { notBefore } : {}),
      ...(deadline ? { deadline } : {}),
      ...(tool ? { toolRequest: tool } : {}),
    }
  }

  private toSummary(row: ProposalRow): ProposalSummary {
    return {
      decisionId: row.decision_id,
      kind: row.kind as ProposalSummary['kind'],
      decisionKey: row.decision_key,
      reasonCode: row.reason_code,
      createdAt: row.created_at,
      taskRevision: row.task_revision,
      outcome: row.outcome as ProposalSummary['outcome'],
    }
  }

  private invalidateOpenProposals(ticketId: string, reason: string): void {
    for (const row of this.db.listProposals(ticketId)) {
      if (row.outcome === 'open' || row.outcome === 'recorded') {
        this.db.saveProposal({ ...row, outcome: 'invalidated', reason_text: `${row.reason_text} (${reason})` })
      }
    }
  }

  private invalidatePendingEffects(ticketId: string, reason: string): void {
    for (const effect of this.db.listEffects('pending')) {
      if (effect.ticket_id === ticketId) {
        this.db.saveEffect({ ...effect, state: 'invalidated', finished_at: this.clock.now(), detail: reason })
      }
    }
  }

  private recordStaleAnswer(attention: AttentionView, input: AnswerCommandInput, task: TaskRecord, now: string): void {
    const sourceId = input.sourceId ?? `user-stale-answer-${randomUUID()}`
    this.db.atomic(() => {
      const event = this.makeEvent({
        kind: 'user.answered',
        sourceId,
        sourceRevision: '1',
        at: now,
        ticketId: attention.ticketId,
        taskRevision: input.taskRevision,
        payload: {
          attentionId: attention.attentionId,
          optionId: input.optionId,
          accepted: false,
          reason: 'stale_answer',
          attentionRevision: attention.taskRevision,
          currentRevision: task.taskRevision,
        },
      })
      if (!this.db.getEvent(event.eventId)) this.db.insertEvent(event, now)
      this.attention.answer({
        attentionId: attention.attentionId,
        taskRevision: input.taskRevision,
        optionId: input.optionId,
        now,
        sourceId,
      })
      this.db.driverLog(now, attention.ticketId, 'attention.stale_answer', {
        attentionId: attention.attentionId,
        attentionRevision: attention.taskRevision,
        answerRevision: input.taskRevision,
        currentRevision: task.taskRevision,
      })
    })
  }

  // ------------------------------------------------------------------
  // 文件核对
  // ------------------------------------------------------------------

  verifyArtifactFile(path: string, expectedSha: string): { ok: boolean; detail: string; bytes: number } {
    const abs = this.absoluteToRoot(path)
    if (!this.insideRoot(abs)) return { ok: false, detail: `outside workspace: ${path}`, bytes: 0 }
    if (!existsSync(abs)) return { ok: false, detail: `missing file: ${this.relativeToRoot(abs)}`, bytes: 0 }
    const info = statSync(abs)
    if (!info.isFile()) return { ok: false, detail: `not a file: ${path}`, bytes: 0 }
    const bytes = readFileSync(abs)
    const sha = sha256Bytes(bytes)
    if (sha !== expectedSha) return { ok: false, detail: `sha mismatch ${sha.slice(0, 12)} != ${expectedSha.slice(0, 12)}`, bytes: bytes.length }
    return { ok: true, detail: 'sha matched', bytes: bytes.length }
  }

  absoluteToRoot(path: string): string {
    return isAbsolute(path) ? path : resolve(this.workspace.root, path)
  }

  relativeToRoot(path: string): string {
    const abs = isAbsolute(path) ? path : resolve(this.workspace.root, path)
    return relative(this.workspace.root, abs)
  }

  insideRoot(abs: string): boolean {
    const rel = relative(this.workspace.root, abs)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }

  private ignoreObservation(task: TaskRecord, observed: ObservedArtifact, detail: string): IngestOutcome {
    const now = this.clock.now()
    const sourceRevision = `r${observed.payload.revision}:${observed.payload.artifactSha.slice(0, 16)}`
    const eventId = stableId('ev', 'artifact.observed', observed.sourceId, sourceRevision)
    this.db.atomic(() => {
      const fresh = this.requireTask(task.ticketId)
      fresh.diagnostics = [...fresh.diagnostics.slice(-40), `artifact_ignored:${detail}`]
      fresh.updatedAt = now
      this.saveTask(fresh)
      this.db.driverLog(now, task.ticketId, 'artifact.ignored', { detail, sourceId: observed.sourceId })
    })
    return { disposition: 'ignored', eventId, eventCursor: task.eventCursor, detail }
  }

  private rebuildMemoryForTask(task: TaskRecord): number {
    const cursor = this.memory.rebuild()
    const fresh = this.requireTask(task.ticketId)
    fresh.memoryCursor = cursor
    fresh.diagnostics = [...fresh.diagnostics.slice(-40), `memory_caught_up:${cursor}`]
    this.saveTask(fresh)
    return cursor
  }

  private makeEvent(input: {
    kind: FollowupEvent['kind']
    sourceId: string
    sourceRevision: string | null
    at: string
    ticketId: string | null
    taskRevision: number | null
    payload: Record<string, unknown>
  }): FollowupEvent {
    const contentSha256 = eventContentDigest({
      kind: input.kind,
      sourceId: input.sourceId,
      sourceRevision: input.sourceRevision,
      ticketId: input.ticketId,
      taskRevision: input.taskRevision,
      payload: input.payload,
    })
    return {
      schema: EVENT_SCHEMA,
      eventId: stableId('ev', input.kind, input.sourceId, input.sourceRevision ?? 'none'),
      sourceId: input.sourceId,
      sourceRevision: input.sourceRevision,
      observedAt: input.at,
      ticketId: input.ticketId,
      taskRevision: input.taskRevision,
      kind: input.kind,
      payload: input.payload,
      contentSha256,
    }
  }

  private parseInputIds(effect: EffectRow): string[] {
    if (!effect.args_json) return []
    const args = JSON.parse(effect.args_json) as { inputIds?: string[] }
    return args.inputIds ?? []
  }

  /** 供 demo 状态页展示的最近通知。 */
  notifications(ticketId: string): { notificationId: string; text: string; createdAt: string; attentionId: string | null }[] {
    return this.db.listNotifications(ticketId)
  }

  /** 冷却判断的公共工具，供各策略复用同一配置。 */
  cooldownRemaining(lastAt: string | null, now: string, quiet: QuietConfig): number {
    if (!lastAt) return 0
    return Math.max(0, quiet.cooldownMs - millisBetween(lastAt, now))
  }
}

/** 任务状态里没有“开放问题”时的显式空值，便于调用方分支。 */
export function openAttentionOf(task: TaskSnapshot): AttentionView | undefined {
  return task.openAttention
}
