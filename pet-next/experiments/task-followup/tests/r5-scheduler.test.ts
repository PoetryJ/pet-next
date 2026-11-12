/**
 * R5 持久唤醒：到期时间来自持久提案，重启可重建，重复唤醒幂等，旧版本不执行。
 *
 * @module pet-next/experiments/task-followup/tests/r5-scheduler
 */
import { strict as assert } from 'node:assert'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { ANALYSIS_GOAL, answerOpen, harness, openAttention } from './helpers.ts'

function delegate(h: ReturnType<typeof harness>, title = 'R5 唤醒') {
  return h.built.runtime.delegate({
    title,
    goal: '结果不足时分析失败样本',
    goalCondition: ANALYSIS_GOAL,
    at: h.clock.now(),
  })
}

test('等待结果产生一条持久 defer 唤醒，到期时间来自提案', () => {
  const h = harness({ policy: 'P2', fileDb: true })
  try {
    const d = delegate(h)
    const jobs = h.built.runtime.listWakeJobs().filter((job) => job.ticketId === d.ticketId)
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]!.reason, 'defer')
    assert.equal(jobs[0]!.status, 'scheduled')
    assert.equal(jobs[0]!.dueAt, '2026-11-11T08:10:00.000Z')
    assert.equal(h.built.runtime.nextWakeAt(), '2026-11-11T08:10:00.000Z')
  } finally {
    h.dispose()
  }
})

test('到期唤醒只重判当前状态：不执行工具、不产生回执', () => {
  const h = harness({ policy: 'P2', fileDb: true })
  try {
    const d = delegate(h)
    h.clock.set('2026-11-11T08:10:00.000Z')
    const results = h.built.runtime.wakeDue()
    assert.equal(results.length, 1)
    assert.equal(results[0]!.action, 'woken')
    assert.equal(h.built.db.listReceipts(d.ticketId).length, 0)
    assert.equal(h.built.db.listEffects().filter((effect) => effect.kind === 'tool').length, 0)
    const next = h.built.runtime.listWakeJobs().filter((job) => job.ticketId === d.ticketId && job.status === 'scheduled')
    assert.equal(next.length, 1)
    assert.equal(next[0]!.dueAt, '2026-11-11T08:20:00.000Z')
  } finally {
    h.dispose()
  }
})

test('重复到期检查幂等：同一 job 只处理一次', () => {
  const h = harness({ policy: 'P2', fileDb: true })
  try {
    const d = delegate(h)
    h.clock.set('2026-11-11T08:10:00.000Z')
    assert.equal(h.built.runtime.wakeDue().length, 1)
    assert.equal(h.built.runtime.wakeDue().length, 0)
    const done = h.built.runtime.listWakeJobs().filter((job) => job.ticketId === d.ticketId && job.status === 'done')
    assert.equal(done.length, 1)
    assert.equal(done[0]!.attempts, 1)
  } finally {
    h.dispose()
  }
})

test('重启后从持久提案重建同一条唤醒', () => {
  const h = harness({ policy: 'P2', fileDb: true })
  try {
    const d = delegate(h)
    h.clock.set('2026-11-11T08:05:00.000Z')
    h.reopen()
    const jobs = h.built.runtime.listWakeJobs().filter((job) => job.ticketId === d.ticketId && job.status === 'scheduled')
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]!.dueAt, '2026-11-11T08:10:00.000Z')
    h.clock.set('2026-11-11T08:10:00.000Z')
    assert.equal(h.built.runtime.wakeDue()[0]!.action, 'woken')
    assert.equal(h.built.db.listReceipts(d.ticketId).length, 0)
  } finally {
    h.dispose()
  }
})

test('取消任务使未到期唤醒失效，不再触发', () => {
  const h = harness({ policy: 'P2', fileDb: true })
  try {
    const d = delegate(h)
    assert.equal(h.built.runtime.cancel({ ticketId: d.ticketId, reason: 'user_cancel', at: h.clock.now() }).ok, true)
    const scheduled = h.built.runtime.listWakeJobs().filter((job) => job.ticketId === d.ticketId && job.status === 'scheduled')
    assert.equal(scheduled.length, 0)
    h.clock.set('2026-11-11T09:00:00.000Z')
    assert.equal(h.built.runtime.wakeDue().length, 0)
  } finally {
    h.dispose()
  }
})

test('旧版本 job 在到期时判定 stale，不产生提案或通知', () => {
  const h = harness({ policy: 'P2', fileDb: true })
  try {
    const d = delegate(h)
    h.built.runtime.change({ ticketId: d.ticketId, goal: '新目标：先给汇总', at: h.clock.now() })
    const old = h.built.runtime.scheduler.schedule({
      ticketId: d.ticketId,
      taskRevision: d.taskRevision,
      assignmentId: h.built.runtime.getTask(d.ticketId).assignmentId,
      reason: 'defer',
      decisionId: 'old-decision',
      dueAt: '2026-11-11T09:00:00.000Z',
    })
    const before = h.built.db.listProposals(d.ticketId).length
    h.clock.set('2026-11-11T09:00:00.000Z')
    const stale = h.built.runtime.wakeJob(old.jobId)
    assert.equal(stale.action, 'stale')
    assert.equal(h.built.db.listProposals(d.ticketId).length, before)
    assert.equal(h.built.db.listNotificationReceipts(d.ticketId).length, 0)
  } finally {
    h.dispose()
  }
})

test('输入未恢复的续办不排执行型唤醒', () => {
  const h = harness({ policy: 'P3', fileDb: true })
  try {
    const d = delegate(h)
    h.clock.set('2026-11-11T08:10:00.000Z')
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    const path = seed.resultPath
    rmSync(path)
    answerOpen(h, d.ticketId, 'analyze_failing')
    const task = h.built.runtime.getTask(d.ticketId)
    assert.equal(task.stage, 'continuation_pending')
    const scheduled = h.built.runtime.listWakeJobs().filter((job) => job.ticketId === d.ticketId && job.status === 'scheduled')
    assert.equal(scheduled.some((job) => job.reason === 'continuation'), false)
    h.clock.set('2026-11-11T12:00:00.000Z')
    h.built.runtime.wakeDue()
    assert.equal(h.built.db.listReceipts(d.ticketId).length, 0)
  } finally {
    h.dispose()
  }
})

test('输入恢复后续办唤醒到期重判，只提一个问题且不执行', () => {
  const h = harness({ policy: 'P3', fileDb: true })
  try {
    const d = delegate(h)
    h.clock.set('2026-11-11T08:10:00.000Z')
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    const bytes = readFileSync(seed.resultPath)
    rmSync(seed.resultPath)
    answerOpen(h, d.ticketId, 'analyze_failing')
    writeFileSync(seed.resultPath, bytes)
    h.observe(d.ticketId, seed.resultPath)
    // 重复观察不会派发；服务循环用一次 tick 做周期重判（不推进逻辑时间）。
    h.built.runtime.tick(0)
    const asked = openAttention(h, d.ticketId)
    assert.ok(asked)
    assert.match(asked!.decisionKey, /^continuation:/)
    const due = h.built.runtime
      .listWakeJobs()
      .filter((job) => job.ticketId === d.ticketId && job.status === 'scheduled')
    assert.equal(due.length, 1)
    assert.equal(due[0]!.reason, 'quiet')
    // 到期只把已提出的问题送达，不执行工具、不递增 attempt。
    h.clock.set('2026-11-11T08:41:00.000Z')
    const results = h.built.runtime.wakeDue()
    assert.ok(results.some((result) => result.action === 'woken'))
    const open = openAttention(h, d.ticketId)
    assert.ok(open?.deliveredAt)
    assert.equal(h.built.db.listReceipts(d.ticketId).length, 0)
    assert.equal(h.built.runtime.getTask(d.ticketId).attempt, 1)
  } finally {
    h.dispose()
  }
})
