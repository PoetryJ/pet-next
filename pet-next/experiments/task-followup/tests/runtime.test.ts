import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex, stableId } from '../contracts.ts'
import { ANALYSIS_GOAL, answerOpen, fileSha, harness, openAttention } from './helpers.ts'

test('delegate 建立上游 ticket 与 running assignment，并报告 waiting', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '跟进 E17', goal: '等结果', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    const task = h.built.runtime.getTask(d.ticketId)
    assert.equal(task.stage, 'awaiting_result')
    assert.equal(task.status, 'active')
    const ticket = h.built.runtime.getTicket(d.ticketId)!
    assert.equal(ticket.assignments.length, 1)
    assert.equal(ticket.assignments[0]!.state, 'running')
    assert.equal(ticket.assignments[0]!.report?.state, 'waiting')
  } finally {
    h.dispose()
  }
})

test('observe 结果不足时提出一个带证据与选项的问题', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '跟进 E17', goal: '等结果', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    h.clock.set('2026-11-11T08:10:00.000Z')
    const seed = h.seed()
    const outcome = h.observe(d.ticketId, seed.resultPath)
    assert.equal(outcome.disposition, 'appended')
    const task = h.built.runtime.getTask(d.ticketId)
    assert.equal(task.stage, 'awaiting_decision')
    const open = openAttention(h, d.ticketId)!
    assert.ok(open.question.includes('11/40'))
    assert.ok(open.options.some((option) => option.id === 'analyze_failing'))
    assert.ok(open.evidenceRefs.length >= 1)
    const ticket = h.built.runtime.getTicket(d.ticketId)!
    assert.equal(ticket.attention?.question, open.question)
    assert.equal(h.built.runtime.notifications(d.ticketId).length, 1)
  } finally {
    h.dispose()
  }
})

test('answer 后本地工具生成真实产物，SHA 与回执一致，任务完成', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '跟进 E17', goal: '分析', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    h.clock.set('2026-11-11T08:10:00.000Z')
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    h.clock.set('2026-11-11T08:12:00.000Z')
    assert.equal(answerOpen(h, d.ticketId, 'analyze_failing'), true)
    const task = h.built.runtime.getTask(d.ticketId)
    assert.equal(task.status, 'completed')
    assert.ok(task.analysis?.receiptId)
    const abs = join(h.root, task.analysis!.artifactPath)
    assert.equal(fileSha(abs), task.analysis!.artifactSha)
    const receipt = h.built.db.getReceipt(task.analysis!.receiptId)!
    assert.equal(receipt.ok, true)
    assert.equal(receipt.outputSha256, task.analysis!.artifactSha)
    assert.ok(task.completion!.checkedPaths.length >= 2, 'completion re-read result and analysis paths')
    assert.equal(h.built.runtime.getTicket(d.ticketId)!.ended?.outcome, 'completed')
    assert.ok(readFileSync(abs, 'utf8').includes('失败样本'))
  } finally {
    h.dispose()
  }
})

test('重复观察同 SHA 不重做，也不产生第二个问题', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '跟进 E17', goal: '去重', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    const second = h.observe(d.ticketId, seed.resultPath)
    assert.equal(second.disposition, 'duplicate')
    const artifacts = h.built.db.listEvents(d.ticketId).filter((event) => event.kind === 'artifact.observed')
    assert.equal(artifacts.length, 1)
    assert.equal(h.built.attention.listOpen(d.ticketId).length, 1)
    assert.equal(h.built.runtime.notifications(d.ticketId).length, 1)
  } finally {
    h.dispose()
  }
})

test('乱序旧 revision 留档但不覆盖新值', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '跟进 E17', goal: '乱序', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    h.clock.set('2026-11-11T08:10:00.000Z')
    const newer = h.seed({ revision: 2, failed: 5, passed: 35 })
    h.observe(d.ticketId, newer.resultPath)
    const openKey = openAttention(h, d.ticketId)!.decisionKey
    h.clock.set('2026-11-11T08:15:00.000Z')
    const older = h.seed({ revision: 1, failed: 11, passed: 29 })
    const outcome = h.observe(d.ticketId, older.resultPath)
    assert.equal(outcome.disposition, 'stale_revision')
    const task = h.built.runtime.getTask(d.ticketId)
    assert.equal(task.result?.revision, 2)
    assert.equal(task.result?.metrics.failed, 5)
    assert.equal(openAttention(h, d.ticketId)!.decisionKey, openKey)
    assert.ok(task.diagnostics.some((item) => item.startsWith('artifact_stale_revision')))
  } finally {
    h.dispose()
  }
})

test('取消后迟到的结果只留档，不产生行动', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '跟进 E17', goal: '取消', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    h.built.runtime.cancel({ ticketId: d.ticketId, reason: 'test cancel', at: h.clock.now() })
    const task = h.built.runtime.getTask(d.ticketId)
    assert.equal(task.status, 'cancelled')
    const seed = h.seed()
    const outcome = h.observe(d.ticketId, seed.resultPath)
    assert.equal(outcome.disposition, 'ignored')
    assert.equal(h.built.attention.listOpen(d.ticketId).length, 0)
    assert.equal(h.built.runtime.notifications(d.ticketId).length, 0)
    assert.equal(h.built.runtime.getTicket(d.ticketId)!.ended?.by, 'human')
  } finally {
    h.dispose()
  }
})

test('重启后委托、问题与答案仍然有效', () => {
  const h = harness({ fileDb: true })
  try {
    const d = h.built.runtime.delegate({ title: '跟进 E17', goal: '重启', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    h.clock.set('2026-11-11T08:10:00.000Z')
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    const before = openAttention(h, d.ticketId)!
    h.clock.set('2026-11-11T08:11:00.000Z')
    const reopened = h.reopen()
    const task = reopened.runtime.getTask(d.ticketId)
    assert.equal(task.status, 'active')
    assert.equal(task.stage, 'awaiting_decision')
    const after = reopened.attention.listOpen(d.ticketId)[0]!
    assert.equal(after.attentionId, before.attentionId)
    h.clock.set('2026-11-11T08:12:00.000Z')
    const answered = reopened.runtime.answer({ attentionId: after.attentionId, taskRevision: after.taskRevision, optionId: 'analyze_failing' })
    assert.equal(answered.ok, true)
    assert.equal(reopened.runtime.getTask(d.ticketId).status, 'completed')
  } finally {
    h.dispose()
  }
})

test('记忆未追上权威事件时进入 memory_behind，修复后恢复', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '跟进 E17', goal: '记忆游标', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    h.built.db.clearProjection()
    h.built.runtime.tick(0)
    assert.equal(h.built.runtime.getTask(d.ticketId).stage, 'memory_behind')
    const repaired = h.built.runtime.repairMemory()
    assert.ok(repaired.cursor >= 1)
    const task = h.built.runtime.getTask(d.ticketId)
    assert.notEqual(task.stage, 'memory_behind')
    assert.ok(task.memoryCursor >= task.eventCursor)
  } finally {
    h.dispose()
  }
})

test('伪造完成事件没有回执，任务不得完成', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '跟进 E17', goal: '假完成', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    const task = h.built.runtime.getTask(d.ticketId)
    const payload = { completion: true, receiptId: 'rcpt-forged', outputPath: 'artifacts/x.md', outputSha256: 'deadbeef' }
    h.built.db.insertEvent(
      {
        schema: 'pet-followup-event/v1',
        eventId: stableId('ev', 'forge', d.ticketId),
        sourceId: 'forge',
        sourceRevision: '1',
        observedAt: h.clock.now(),
        ticketId: d.ticketId,
        taskRevision: task.taskRevision,
        kind: 'tool.receipt',
        payload,
        contentSha256: sha256Hex(JSON.stringify(payload)),
      },
      h.clock.now(),
    )
    h.built.runtime.tick(0)
    const after = h.built.runtime.getTask(d.ticketId)
    assert.notEqual(after.status, 'completed')
    const check = h.built.runtime.completionCheck(after)
    assert.equal(check.ok, false)
    assert.equal(h.built.db.listReceipts(d.ticketId).length, 0)
  } finally {
    h.dispose()
  }
})

test('输入字节在派发前消失：拒绝执行、只记录一次、不自动重试', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '跟进 E17', goal: '失败', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    rmSync(seed.resultPath, { force: true })
    answerOpen(h, d.ticketId, 'analyze_failing')
    const effects = h.built.db.listEffects().filter((effect) => effect.kind === 'tool')
    assert.equal(effects.length, 1)
    // 派发前核对磁盘字节失败：不产生回执，effect 记 invalidated 而不是执行后再失败。
    assert.equal(effects[0]!.state, 'invalidated')
    assert.match(String(effects[0]!.detail), /^input_gate:/)
    assert.equal(h.built.db.listReceipts(d.ticketId).length, 0)
    h.clock.set('2026-11-11T08:40:00.000Z')
    h.built.runtime.tick(10 * 60_000)
    assert.equal(h.built.db.listEffects().filter((effect) => effect.kind === 'tool').length, 1)
    const task = h.built.runtime.getTask(d.ticketId)
    assert.ok(task.diagnostics.some((item) => item.startsWith('tool_input_rejected:')))
    assert.notEqual(task.status, 'completed')
  } finally {
    h.dispose()
  }
})
