/**
 * R5 持久唤醒调度：把“还需要再看一眼”的状态写成 SQLite 行，而不是内存定时器。
 *
 * 约束：
 * - 一个逻辑等待只保留一条有效 job（ticket + reason + decisionId）。
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

  /** 稳定 jobId：同一 ticket/revision/reason/decision 反复调度得到同一个 id。 */
  static idFor(
    input: Pick<WakeScheduleInput, 'ticketId' | 'taskRevision' | 'reason' | 'decisionId'> & { readonly dueAt?: string },
  ): string {
    const key = [input.ticketId, input.taskRevision, input.reason, input.decisionId ?? '', input.dueAt ?? ''].join('|')
    return `wake-${stableId('job', key).slice(0, 20)}`
  }

  /** 合并/替换同一逻辑等待；不同 dueAt 直接覆盖，不新增无限 job。 */
  schedule(input: WakeScheduleInput): WakeJob {
    const jobId = WakeScheduler.idFor(input)
    const existing = this.db.getWakeJob(jobId)
    const at = this.now()
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
      attempts: existing?.attempts ?? 0,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      detail: input.detail ?? null,
    }
    this.db.saveWakeJob(job)
    return job
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
