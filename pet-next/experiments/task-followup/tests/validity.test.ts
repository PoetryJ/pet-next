import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANALYSIS_GOAL, harness } from './helpers.ts'
import { R31MemoryBridge } from '../memory-bridge/port.ts'

// B1 门的四组反例：证明“拒绝原因与状态”，而不只是字符串不同。

test('同文本不同任务版本：旧版本提案在执行前失效', () => {
  const h = harness({ deferProposals: true })
  try {
    const d = h.built.runtime.delegate({ title: '版本反例', goal: '同一句话', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    const queued = h.built.db.listProposals(d.ticketId).filter((row) => row.kind === 'ask_user')
    assert.equal(queued.length, 1)
    assert.equal(queued[0]!.task_revision, 1)
    h.built.runtime.change({ ticketId: d.ticketId, goal: '同一句话', at: h.clock.now() })
    const after = h.built.db.listProposals(d.ticketId).filter((row) => row.kind === 'ask_user' && row.task_revision === 1)
    assert.equal(after[0]!.outcome, 'invalidated')
    h.built.runtime.flushProposals()
    assert.equal(h.built.attention.listOpen(d.ticketId).filter((item) => item.taskRevision === 1).length, 0)
  } finally {
    h.dispose()
  }
})

test('同任务不同来源版本：旧 SHA 的证据不能解锁执行', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '来源反例', goal: '证据绑定', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    const task = h.built.runtime.getTask(d.ticketId)
    const ref = task.evidence[0]!
    const bridge = new R31MemoryBridge({ store: h.built.db, listEventRows: () => h.built.db.listEventRowEntries() })
    const stale = bridge.validate([{ ...ref, sourceRevision: 'r0:deadbeef', sha256: 'ff'.repeat(32) }])
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'sha_mismatch')
  } finally {
    h.dispose()
  }
})

test('先提案后取消：排队提案不执行，注意力不创建', () => {
  const h = harness({ deferProposals: true })
  try {
    const d = h.built.runtime.delegate({ title: '取消反例', goal: '提案后取消', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    assert.equal(h.built.db.listProposals(d.ticketId).filter((row) => row.kind === 'ask_user').length, 1)
    h.built.runtime.cancel({ ticketId: d.ticketId, reason: '先提案后取消', at: h.clock.now() })
    const flush = h.built.runtime.flushProposals()
    assert.equal(flush.attempted, 0)
    assert.equal(h.built.attention.listOpen(d.ticketId).length, 0)
    assert.equal(h.built.runtime.notifications(d.ticketId).length, 0)
    assert.equal(h.built.runtime.getTask(d.ticketId).status, 'cancelled')
  } finally {
    h.dispose()
  }
})

test('先提案后更正：排队提案失效，新版本重新判定', () => {
  const h = harness({ deferProposals: false })
  try {
    const d = h.built.runtime.delegate({ title: '更正反例', goal: '提案后更正', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    const first = h.built.attention.listOpen(d.ticketId)[0]!
    h.clock.set('2026-11-11T08:20:00.000Z')
    h.built.runtime.change({ ticketId: d.ticketId, goal: '新目标', at: h.clock.now() })
    const superseded = h.built.attention.get(first.attentionId)!
    assert.equal(superseded.state, 'superseded')
    const task = h.built.runtime.getTask(d.ticketId)
    assert.equal(task.taskRevision, 2)
    const open = h.built.attention.listOpen(d.ticketId)[0]!
    assert.notEqual(open.attentionId, first.attentionId)
    assert.equal(open.taskRevision, 2)
  } finally {
    h.dispose()
  }
})
