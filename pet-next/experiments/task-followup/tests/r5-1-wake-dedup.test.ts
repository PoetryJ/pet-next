/**
 * R5.1 A：同一等待不产生冗余 job。
 *
 * - 重复 reevaluate → 重启 → 实际到期：同一 quiet 等待只有一条 job，dueAt 不后移，到期只领取一次。
 * - 普通重复 schedule 不复活 claimed/done/cancelled。
 * - 合法下一轮 defer（前周期 done + 下一周期 scheduled）仍然发生。
 * - 不同 decision/版本/派工不误合并；R5 遗留同窗重复行安全收敛并保留审计行。
 *
 * 这里是 FakeClock 单测（调度机制回归），不是自动服务证据；自动服务见归档 realtime-service.mjs。
 *
 * @module pet-next/experiments/task-followup/tests/r5-1-wake-dedup
 */
import { strict as assert } from 'node:assert'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import type { WakeJob } from '../contracts.ts'
import { ANALYSIS_GOAL, answerOpen, harness, openAttention } from './helpers.ts'

function delegate(h: ReturnType<typeof harness>, title = 'R5.1 唤醒合并') {
  return h.built.runtime.delegate({ title, goal: '结果不足时分析失败样本', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
}

function quietJobs(h: ReturnType<typeof harness>, ticketId: string, decisionId: string): WakeJob[] {
  return h.built.runtime.listWakeJobs().filter((job) => job.ticketId === ticketId && job.reason === 'quiet' && job.decisionId === decisionId)
}

/** 构造“已写库但未送达”的续办问题：与 R5 自然续办同一路径（输入恢复后自动提问）。 */
function undeliveredContinuationQuestion(h: ReturnType<typeof harness>) {
  const d = delegate(h)
  h.clock.set('2026-11-11T08:10:00.000Z')
  const seed = h.seed()
  h.observe(d.ticketId, seed.resultPath)
  const bytes = readFileSync(seed.resultPath)
  rmSync(seed.resultPath)
  answerOpen(h, d.ticketId, 'analyze_failing')
  writeFileSync(seed.resultPath, bytes)
  h.observe(d.ticketId, seed.resultPath)
  h.built.runtime.tick(0)
  const asked = openAttention(h, d.ticketId)
  assert.ok(asked, 'continuation question exists')
  assert.match(asked!.decisionKey, /^continuation:/)
  assert.equal(asked!.deliveredAt, undefined, 'question persisted but not yet delivered (min gap)')
  return { ticketId: d.ticketId, decisionId: asked!.decisionId, attentionId: asked!.attentionId }
}

test('R5.1 重复 reevaluate → 重启 → 实际到期：同一 quiet 等待只有一条 job，dueAt 不后移，到期领取一次', () => {
  const h = harness({ policy: 'P3', fileDb: true })
  try {
    const q = undeliveredContinuationQuestion(h)
    const first = quietJobs(h, q.ticketId, q.decisionId)
    assert.equal(first.length, 1)
    const job0 = first[0]!
    assert.equal(job0.status, 'scheduled')
    assert.equal(job0.attempts, 0)
    assert.ok(job0.dueAt > h.clock.now(), 'quiet wait is in the future')

    // 服务循环式重复重判：时间前进但未到期，不能新增同窗 job，也不能把 dueAt 往后推。
    for (let index = 0; index < 5; index += 1) {
      h.clock.advance(60_000)
      assert.ok(h.clock.now() < job0.dueAt)
      h.built.runtime.reevaluate()
      const jobs = quietJobs(h, q.ticketId, q.decisionId)
      assert.equal(jobs.length, 1, `reevaluate #${index + 1} keeps one quiet job`)
      assert.equal(jobs[0]!.jobId, job0.jobId)
      assert.equal(jobs[0]!.dueAt, job0.dueAt, 'dueAt is not pushed later')
      assert.equal(jobs[0]!.status, 'scheduled')
      assert.equal(jobs[0]!.attempts, 0)
    }

    // 重启（新 runtime 读同一 SQLite + recover）：仍是同一条、同一 dueAt。
    h.reopen()
    h.built.runtime.reevaluate()
    const afterRestart = quietJobs(h, q.ticketId, q.decisionId)
    assert.equal(afterRestart.length, 1)
    assert.equal(afterRestart[0]!.jobId, job0.jobId)
    assert.equal(afterRestart[0]!.dueAt, job0.dueAt)
    assert.equal(h.built.db.listNotificationReceipts(q.ticketId).filter((n) => n.attentionId === q.attentionId && n.deliveredAt).length, 0)

    // 实际到期：领取一次，问题送达一次，不执行工具、不递增 attempt。
    h.clock.set(job0.dueAt)
    const results = h.built.runtime.wakeDue()
    assert.deepEqual(
      results.map((result) => [result.jobId, result.action]),
      [[job0.jobId, 'woken']],
    )
    const fired = h.built.db.getWakeJob(job0.jobId)!
    assert.equal(fired.status, 'done')
    assert.equal(fired.attempts, 1)
    const delivered = h.built.db.listNotificationReceipts(q.ticketId).filter((n) => n.attentionId === q.attentionId && n.deliveredAt)
    assert.equal(delivered.length, 1, 'exactly one delivered notification for the question')
    assert.ok(openAttention(h, q.ticketId)?.deliveredAt)
    assert.equal(h.built.db.listReceipts(q.ticketId).length, 0, 'no tool receipt without new authorization')
    assert.equal(h.built.runtime.getTask(q.ticketId).attempt, 1)

    // 送达后：再重判/重启都不再新增或领取 quiet 等待，通知数不变。
    h.clock.advance(60_000)
    h.built.runtime.reevaluate()
    h.reopen()
    h.clock.advance(60 * 60_000)
    h.built.runtime.reevaluate()
    assert.equal(h.built.runtime.wakeDue().filter((result) => result.jobId === job0.jobId).length, 0)
    const finalJobs = quietJobs(h, q.ticketId, q.decisionId)
    assert.equal(finalJobs.length, 1)
    assert.equal(finalJobs[0]!.attempts, 1)
    assert.equal(finalJobs.filter((job) => job.status === 'scheduled').length, 0)
    assert.equal(
      h.built.db.listNotificationReceipts(q.ticketId).filter((n) => n.attentionId === q.attentionId && n.deliveredAt).length,
      1,
    )
  } finally {
    h.dispose()
  }
})

test('R5.1 送达后残留的 quiet 等待被标 cancelled 并记录原因，不再被领取', () => {
  const h = harness({ policy: 'P3', fileDb: true })
  try {
    const q = undeliveredContinuationQuestion(h)
    const job0 = quietJobs(h, q.ticketId, q.decisionId)[0]!
    // 用户主动打开面板：问题经呈现送达，quiet 等待已无必要。
    h.built.runtime.present(q.ticketId)
    h.built.runtime.reevaluate()
    const row = h.built.db.getWakeJob(job0.jobId)!
    assert.equal(row.status, 'cancelled')
    assert.equal(row.attempts, 0)
    assert.match(row.detail ?? '', /^quiet_superseded:(delivered|answered|attention_closed)$/)
    h.clock.set(job0.dueAt)
    assert.equal(h.built.runtime.wakeDue().filter((result) => result.jobId === job0.jobId).length, 0)
    assert.equal(h.built.db.getWakeJob(job0.jobId)!.attempts, 0)
  } finally {
    h.dispose()
  }
})

test('R5.1 普通重复 schedule 不复活 claimed/done/cancelled', () => {
  const h = harness({ policy: 'P2', fileDb: true })
  try {
    const d = delegate(h)
    const task = h.built.runtime.getTask(d.ticketId)
    const base = { ticketId: d.ticketId, taskRevision: task.taskRevision, assignmentId: task.assignmentId, reason: 'catch_up' as const }
    const scheduler = h.built.runtime.scheduler
    const doneJob = scheduler.schedule({ ...base, decisionId: 'done-case', dueAt: '2026-11-11T08:01:00.000Z' })
    const cancelledJob = scheduler.schedule({ ...base, decisionId: 'cancel-case', dueAt: '2026-11-11T08:01:00.000Z' })
    const claimedJob = scheduler.schedule({ ...base, decisionId: 'claim-case', dueAt: '2026-11-11T08:01:00.000Z' })
    h.clock.set('2026-11-11T08:01:00.000Z')
    assert.ok(scheduler.claim(doneJob.jobId))
    scheduler.finish(doneJob.jobId, 'done', 'test:done')
    scheduler.cancel(cancelledJob.jobId, 'test:cancelled')
    assert.ok(scheduler.claim(claimedJob.jobId))

    const againDone = scheduler.schedule({ ...base, decisionId: 'done-case', dueAt: doneJob.dueAt })
    assert.equal(againDone.jobId, doneJob.jobId)
    assert.equal(h.built.db.getWakeJob(doneJob.jobId)!.status, 'done')
    assert.equal(h.built.db.getWakeJob(doneJob.jobId)!.attempts, 1)

    const againClaimed = scheduler.schedule({ ...base, decisionId: 'claim-case', dueAt: claimedJob.dueAt })
    assert.equal(againClaimed.jobId, claimedJob.jobId)
    assert.equal(h.built.db.getWakeJob(claimedJob.jobId)!.status, 'claimed')

    // 被取消窗口的旧行保留为审计；同一等待若再次需要，用新 generation 新建，不把 cancelled 改回 scheduled。
    const againCancelled = scheduler.schedule({ ...base, decisionId: 'cancel-case', dueAt: cancelledJob.dueAt })
    assert.notEqual(againCancelled.jobId, cancelledJob.jobId)
    assert.equal(h.built.db.getWakeJob(cancelledJob.jobId)!.status, 'cancelled')
    assert.equal(h.built.db.getWakeJob(cancelledJob.jobId)!.detail, 'test:cancelled')
    assert.equal(againCancelled.status, 'scheduled')
    assert.equal(againCancelled.attempts, 0)

    const due = scheduler.listDue().map((job) => job.jobId)
    assert.equal(due.includes(doneJob.jobId), false)
    assert.equal(due.includes(claimedJob.jobId), false)
    assert.equal(due.includes(cancelledJob.jobId), false)
  } finally {
    h.dispose()
  }
})

test('R5.1 合法下一轮 defer 正控：前周期 done、下一周期 scheduled，重复重判不增行', () => {
  const h = harness({ policy: 'P2', fileDb: true })
  try {
    const d = delegate(h)
    const deferJobs = () => h.built.runtime.listWakeJobs().filter((job) => job.ticketId === d.ticketId && job.reason === 'defer')
    assert.equal(deferJobs().length, 1)
    assert.equal(deferJobs()[0]!.dueAt, '2026-11-11T08:10:00.000Z')

    h.clock.set('2026-11-11T08:05:00.000Z')
    h.built.runtime.reevaluate()
    h.built.runtime.reevaluate()
    assert.equal(deferJobs().length, 1, 'repeated reevaluate before due adds no defer job')

    h.clock.set('2026-11-11T08:10:00.000Z')
    assert.deepEqual(h.built.runtime.wakeDue().map((r) => r.action), ['woken'])
    let rows = deferJobs()
    assert.equal(rows.filter((job) => job.status === 'done').length, 1)
    assert.equal(rows.filter((job) => job.status === 'scheduled').length, 1)
    assert.equal(rows.find((job) => job.status === 'scheduled')!.dueAt, '2026-11-11T08:20:00.000Z')

    h.built.runtime.reevaluate()
    h.reopen()
    h.built.runtime.reevaluate()
    rows = deferJobs()
    assert.equal(rows.length, 2, 'restart/reevaluate do not add a third defer row')

    h.clock.set('2026-11-11T08:20:00.000Z')
    assert.deepEqual(h.built.runtime.wakeDue().map((r) => r.action), ['woken'], 'next cycle still wakes')
    rows = deferJobs()
    assert.equal(rows.filter((job) => job.status === 'done').length, 2)
    assert.ok(rows.every((job) => job.status !== 'done' || job.attempts === 1))
    assert.equal(rows.filter((job) => job.status === 'scheduled').length, 1)
    assert.equal(rows.find((job) => job.status === 'scheduled')!.dueAt, '2026-11-11T08:30:00.000Z')
    assert.equal(h.built.db.listReceipts(d.ticketId).length, 0)
  } finally {
    h.dispose()
  }
})

test('R5.1 不同 decision/版本/派工不合并；同窗 dueAt 只前移不后移', () => {
  const h = harness({ policy: 'P2', fileDb: true })
  try {
    const d = delegate(h)
    const task = h.built.runtime.getTask(d.ticketId)
    const scheduler = h.built.runtime.scheduler
    const base = { ticketId: d.ticketId, taskRevision: task.taskRevision, assignmentId: task.assignmentId, reason: 'catch_up' as const }
    const a = scheduler.schedule({ ...base, decisionId: 'decision-a', dueAt: '2026-11-11T09:00:00.000Z' })
    const b = scheduler.schedule({ ...base, decisionId: 'decision-b', dueAt: '2026-11-11T09:00:00.000Z' })
    const v = scheduler.schedule({ ...base, taskRevision: task.taskRevision + 1, decisionId: 'decision-a', dueAt: '2026-11-11T09:00:00.000Z' })
    const s = scheduler.schedule({ ...base, assignmentId: 'other-assignment', decisionId: 'decision-a', dueAt: '2026-11-11T09:00:00.000Z' })
    assert.equal(new Set([a.jobId, b.jobId, v.jobId, s.jobId]).size, 4)

    const later = scheduler.schedule({ ...base, decisionId: 'decision-a', dueAt: '2026-11-11T09:30:00.000Z' })
    assert.equal(later.jobId, a.jobId)
    assert.equal(h.built.db.getWakeJob(a.jobId)!.dueAt, '2026-11-11T09:00:00.000Z', 'not pushed later')
    const earlier = scheduler.schedule({ ...base, decisionId: 'decision-a', dueAt: '2026-11-11T08:45:00.000Z' })
    assert.equal(earlier.jobId, a.jobId)
    assert.equal(h.built.db.getWakeJob(a.jobId)!.dueAt, '2026-11-11T08:45:00.000Z', 'may move earlier')
    const rows = h.built.runtime.listWakeJobs().filter((job) => job.reason === 'catch_up')
    assert.equal(rows.filter((job) => job.decisionId === 'decision-a' && job.taskRevision === task.taskRevision && job.assignmentId === task.assignmentId).length, 1)
  } finally {
    h.dispose()
  }
})

test('R5.1 R5 遗留同窗重复 scheduled 行（测试副本）安全收敛：保留最早一条，其余 cancelled 留审计', () => {
  const h = harness({ policy: 'P2', fileDb: true })
  try {
    const d = delegate(h)
    const task = h.built.runtime.getTask(d.ticketId)
    const at = h.clock.now()
    // 模拟 R5 旧 upsert 产生的同窗重复行（只在本测试的临时 SQLite 中）。
    const legacy = ['2026-11-11T08:00:02.000Z', '2026-11-11T08:00:01.000Z', '2026-11-11T08:00:03.000Z'].map((dueAt, index) => {
      const job: WakeJob = {
        jobId: `wake-legacy-${index}`,
        ticketId: d.ticketId,
        taskRevision: task.taskRevision,
        assignmentId: task.assignmentId,
        reason: 'quiet',
        decisionId: 'legacy-decision',
        sourceId: null,
        sourceRevision: null,
        dueAt,
        status: 'scheduled',
        attempts: 0,
        createdAt: at,
        updatedAt: at,
        detail: 'min_gap',
      }
      h.built.db.saveWakeJob(job)
      return job
    })
    const before = h.built.runtime.listWakeJobs().length
    const kept = h.built.runtime.scheduler.schedule({
      ticketId: d.ticketId,
      taskRevision: task.taskRevision,
      assignmentId: task.assignmentId,
      reason: 'quiet',
      decisionId: 'legacy-decision',
      dueAt: '2026-11-11T08:00:09.000Z',
      detail: 'min_gap',
    })
    assert.equal(kept.jobId, 'wake-legacy-1', 'earliest legacy row kept')
    assert.equal(kept.dueAt, '2026-11-11T08:00:01.000Z')
    assert.equal(h.built.runtime.listWakeJobs().length, before, 'no row deleted, none added')
    for (const id of ['wake-legacy-0', 'wake-legacy-2']) {
      const row = h.built.db.getWakeJob(id)!
      assert.equal(row.status, 'cancelled')
      assert.equal(row.detail, 'dedup_superseded:wake-legacy-1')
    }
    void legacy
  } finally {
    h.dispose()
  }
})
