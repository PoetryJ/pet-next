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
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
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
  millisBetween,
  sha256Bytes,
  stableId,
} from '../contracts.ts'
import type {
  AnswerResult,
  ArtifactPayload,
  AttentionView,
  ClockPort,
  CompletionCheck,
  DecisionContext,
  DecisionPort,
  EvidenceRef,
  FollowupEvent,
  GoalCondition,
  IngestOutcome,
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
} from '../contracts.ts'
import type { AttentionPort } from '../contracts.ts'
import { SqliteRepositories } from './repo.ts'
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
      const runningEffects = this.db.listEffects('running').filter((effect) => effect.ticket_id === fresh.ticketId)
      if (runningEffects.length) {
        for (const effect of runningEffects) {
          this.db.atomic(() => {
            this.db.saveEffect({ ...effect, state: 'needs_reconciliation', detail: 'process ended while effect was running' })
            this.db.driverLog(this.clock.now(), fresh.ticketId, 'effect.needs_reconciliation', { effectId: effect.effect_id })
          })
        }
        const current = this.requireTask(fresh.ticketId)
        current.stage = 'needs_reconciliation'
        current.diagnostics = [...current.diagnostics.slice(-40), `needs_reconciliation:${runningEffects.map((e) => e.effect_id).join(',')}`]
        this.saveTask(current)
        needsReconciliation.push(fresh.ticketId)
        details.push(`task ${fresh.ticketId}: ${runningEffects.length} running effect(s) need reconciliation, no blind retry`)
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
      if (running) {
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
    }
  }

  completionCheck(task: TaskSnapshot): CompletionCheck {
    const reasons: string[] = []
    const checked: string[] = []
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
      }
    }
    return {
      ok: reasons.length === 0,
      reasons,
      receiptId,
      artifactPath: task.analysis?.artifactPath ?? task.result?.artifactPath ?? null,
      artifactSha: task.analysis?.artifactSha ?? task.result?.artifactSha ?? null,
      checkedPaths: checked,
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
      state: 'pending',
      created_at: this.clock.now(),
      started_at: null,
      finished_at: null,
      detail: null,
    }
    this.db.saveEffect(row)
  }

  private drain(): void {
    for (let step = 0; step < MAX_DRAIN_STEPS; step += 1) {
      const pending = this.db.listEffects('pending')
      if (pending.length) {
        this.db.maybeCrash('pre_dispatch')
        this.dispatchEffect(pending[0]!)
        continue
      }
      if (this.proposeAll()) continue
      break
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
    const request: ToolRequest = { tool, args }
    this.db.atomic(() => {
      this.db.saveEffect({ ...effect, state: 'running', started_at: now })
    })
    // 真实进程在“工具已开始、结果未确认”时退出：重启后必须进入 needs_reconciliation。
    this.db.maybeCrash('effect_running')
    const execution = this.tools.execute(request, {
      effectId: effect.effect_id,
      attemptId: effect.attempt_id,
      ticketId: effect.ticket_id,
      taskRevision: effect.task_revision,
      assignmentId: effect.assignment_id ?? '',
      now,
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
        task.analysis = { artifactPath: this.relativeToRoot(this.absoluteToRoot(receipt.outputPath)), artifactSha: receipt.outputSha256, receiptId: receipt.receiptId }
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
      })
    })
    this.db.maybeCrash('receipt_persisted')
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
    const effectId = stableId('fx', task.ticketId, task.taskRevision, 'tool', request.tool, task.attempt)
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
        dedupeKey: `${request.tool}:${task.attempt}`,
        tool: request.tool,
        args: request.args,
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
    }
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
    return {
      ticketId: row.ticket_id,
      title: row.title,
      goal: row.goal,
      goalCondition: JSON.parse(row.goal_json) as GoalCondition,
      taskRevision: row.task_revision,
      assignmentId: row.assignment_id,
      stage: row.stage as TaskStage,
      status: row.status as TaskStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      eventCursor: row.event_cursor,
      memoryCursor: row.memory_cursor,
      evidence: JSON.parse(row.evidence_json) as EvidenceRef[],
      ...(row.last_proposal_json ? { lastProposal: JSON.parse(row.last_proposal_json) as ProposalSummary } : {}),
      ...(row.last_answer_json ? { lastAnswer: JSON.parse(row.last_answer_json) as { optionId: string; at: string } } : {}),
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
