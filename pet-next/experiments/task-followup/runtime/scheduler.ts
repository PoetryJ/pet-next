/**
 * R5 持久唤醒调度：把“还需要再看一眼”的状态写成 SQLite 行，而不是内存定时器。
 *
 * 约束：
 * - 一个逻辑等待只保留一条有效 job（ticket + revision + assignment + reason + decisionId 的当前窗口）。
 * - job 只触发“当前状态重新判断”，绝不保存要执行的工具调用。
 * - 领取是原子的；已领取/已完成/已取消的 job 再被唤醒不会产生第二次动作。
 * - 本模块不判断策略，也不读 gold；到期时间由运行时按当前状态计算。
 *
 * @module pet-next/experiments/task-followup/runtime/scheduler
 */
import { stableId } from '../contracts.ts'
import type { WakeJob, WakeReason, WakeScheduleInput, WakeStatus } from '../contracts.ts'
import type { FollowupDb } from './db.ts'

export interface WakeSchedulerOptions {
  readonly db: FollowupDb
  readonly now: () => string
}

export class WakeScheduler {
  private readonly db: FollowupDb
  private readonly now: () => string

  constructor(options: WakeSchedulerOptions) {
    this.db = options.db
    this.now = options.now
  }

  /**
   * 稳定 jobId：同一 ticket/revision/reason/decision/dueAt（同一等待窗口）得到同一个 id。
   * generation>0 只在同窗旧行已被取消、需要合法新等待时使用（旧行保留为审计记录）。
   */
  static idFor(
    input: Pick<WakeScheduleInput, 'ticketId' | 'taskRevision' | 'reason' | 'decisionId'> & {
      readonly dueAt?: string
      readonly generation?: number
    },
  ): string {
    const parts = [input.ticketId, input.taskRevision, input.reason, input.decisionId ?? '', input.dueAt ?? '']
    if (input.generation) parts.push(`g${input.generation}`)
    return `wake-${stableId('job', parts.join('|')).slice(0, 20)}`
  }

  /**
   * R5.1 等待合并：同一 ticket/revision/assignment/reason/decision 的当前等待窗口至多一条 scheduled job。
   *
   * - 已有 scheduled 等待：直接复用；到期时间只允许提前，绝不后移（重复同步/重启不会让它永不到期）。
   *   R5 遗留的同窗重复 scheduled 行收敛为最早一条，其余标 cancelled 并写明原因（不删行）。
   * - 没有 scheduled 等待：按 dueAt 建新窗口。同 id 的 claimed/done 行表示该窗口已在处理或已处理，
   *   原样返回、绝不复活成 scheduled；同 id 的 cancelled 行保留审计，新等待用下一 generation 新建。
   * - 前一周期 done 与下一周期（不同 dueAt）scheduled 是两次合法等待，互不合并。
   */
  schedule(input: WakeScheduleInput): WakeJob {
    const at = this.now()
    const key = {
      ticketId: input.ticketId,
      taskRevision: input.taskRevision,
      assignmentId: input.assignmentId,
      reason: input.reason,
      decisionId: input.decisionId ?? null,
    }
    const active = this.db.listScheduledWakeJobsFor(key)
    if (active.length > 0) {
      const keep = active[0]!
      for (const extra of active.slice(1)) {
        this.db.updateWakeStatusFrom(extra.jobId, 'scheduled', 'cancelled', at, `dedup_superseded:${keep.jobId}`)
      }
      if (input.dueAt < keep.dueAt && this.db.moveWakeDueEarlier(keep.jobId, input.dueAt, at)) {
        return this.db.getWakeJob(keep.jobId) ?? keep
      }
      return keep
    }
    for (let generation = 0; generation < 1_000; generation += 1) {
      const jobId = WakeScheduler.idFor({ ...input, generation })
      const existing = this.db.getWakeJob(jobId)
      // 同 id 但派工不同（id 不含 assignment）属于另一逻辑等待；cancelled 窗口只留审计。两者都换下一 generation。
      if (existing && (existing.status === 'cancelled' || (existing.assignmentId ?? null) !== (input.assignmentId ?? null))) continue
      if (existing) return existing
      const job: WakeJob = {
        jobId,
        ticketId: input.ticketId,
        taskRevision: input.taskRevision,
        assignmentId: input.assignmentId,
        reason: input.reason,
        decisionId: input.decisionId ?? null,
        sourceId: input.sourceId ?? null,
        sourceRevision: input.sourceRevision ?? null,
        dueAt: input.dueAt,
        status: 'scheduled',
        attempts: 0,
        createdAt: at,
        updatedAt: at,
        detail: input.detail ?? null,
      }
      if (this.db.insertWakeJobIfAbsent(job)) return job
      return this.db.getWakeJob(jobId) ?? job
    }
    throw new Error(`wake job generations exhausted for ${input.ticketId}/${input.reason}`)
  }

  /**
   * 取消某任务除 keepJobId 外的 scheduled 等待（只限给定 reason）；detailFor 给出逐条处理原因。
   * 用于已送达/已回答/改版本/换派工/换问题的 quiet 等待不再被冗余领取。
   */
  cancelSuperseded(ticketId: string, reason: WakeReason, keepJobId: string | null, detailFor: (job: WakeJob) => string): number {
    const at = this.now()
    let cancelled = 0
    for (const job of this.db.listWakeJobs({ ticketId, status: 'scheduled' })) {
      if (job.reason !== reason || job.jobId === keepJobId) continue
      if (this.db.updateWakeStatusFrom(job.jobId, 'scheduled', 'cancelled', at, detailFor(job))) cancelled += 1
    }
    return cancelled
  }

  /** 取消某任务的全部 scheduled 等待（完成/取消/更正/未知阻断）。 */
  cancelFor(ticketId: string, detail: string): number {
    const at = this.now()
    let cancelled = 0
    for (const job of this.db.listWakeJobs({ ticketId, status: 'scheduled' })) {
      this.db.updateWakeStatus(job.jobId, 'cancelled', at, detail)
      cancelled += 1
    }
    return cancelled
  }

  cancel(jobId: string, detail: string): void {
    this.db.updateWakeStatus(jobId, 'cancelled', this.now(), detail)
  }

  listDue(at: string = this.now()): WakeJob[] {
    return this.db.listWakeJobs({ status: 'scheduled' }).filter((job) => job.dueAt <= at)
  }

  list(): WakeJob[] {
    return this.db.listWakeJobs()
  }

  nextDueAt(): string | null {
    return this.db.nextWakeAt()
  }

  /** 原子领取；失败（已领取/已完成/未到期）返回 null。 */
  claim(jobId: string, at: string = this.now()): WakeJob | null {
    const before = this.db.getWakeJob(jobId)
    if (!before) return null
    if (!this.db.claimWakeJob(jobId, at)) return null
    return this.db.getWakeJob(jobId)
  }

  finish(jobId: string, status: Extract<WakeStatus, 'done' | 'cancelled'>, detail: string): void {
    this.db.updateWakeStatus(jobId, status, this.now(), detail)
  }

  /** 任务/版本/派工任一不一致即视为旧 job。 */
  isCurrent(
    job: WakeJob,
    current: { readonly ticketId: string; readonly taskRevision: number; readonly assignmentId: string | null } | null,
  ): boolean {
    if (!current) return false
    if (job.ticketId !== current.ticketId) return false
    if (job.taskRevision !== current.taskRevision) return false
    if (job.assignmentId !== null && job.assignmentId !== current.assignmentId) return false
    return true
  }
}

export const WAKE_REASONS: readonly WakeReason[] = ['defer', 'quiet', 'cooldown', 'continuation', 'deadline', 'catch_up']
