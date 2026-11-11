import { test } from 'node:test'
import assert from 'node:assert/strict'
import { R31MemoryBridge } from '../memory-bridge/port.ts'
import { ANALYSIS_GOAL, harness } from './helpers.ts'

test('证据引用通过校验；改 SHA 或换事件 id 都被拒绝', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '记忆校验', goal: '校验证据', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    const task = h.built.runtime.getTask(d.ticketId)
    const bridge = new R31MemoryBridge({ store: h.built.db, listEventRows: () => h.built.db.listEventRowEntries() })
    const ref = task.evidence[0]!
    assert.equal(bridge.validate([ref]).ok, true)
    const tampered = bridge.validate([{ ...ref, sha256: '00'.repeat(32) }])
    assert.equal(tampered.ok, false)
    assert.equal(tampered.code, 'sha_mismatch')
    const unknown = bridge.validate([{ ...ref, memoryEventIds: ['ev-missing'] }])
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 'unknown_event')
    assert.equal(bridge.validate([]).ok, true)
  } finally {
    h.dispose()
  }
})

test('读回的事实区分用户说过、承诺与已核验工具结果', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '事实分类', goal: '分类', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    const bridge = new R31MemoryBridge({ store: h.built.db, listEventRows: () => h.built.db.listEventRowEntries() })
    const reading = bridge.readRelevant(h.built.runtime.getTask(d.ticketId), 'E17')
    const authorities = new Set(reading.facts.map((fact) => fact.authority))
    assert.ok(authorities.has('user_said'))
    assert.ok(authorities.has('tool_verified'))
    assert.ok(reading.cursor >= 2)
  } finally {
    h.dispose()
  }
})

test('目标更正让旧目标笔记失效，但产物证据仍有效', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '更正失效', goal: '旧目标', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    const bridge = new R31MemoryBridge({ store: h.built.db, listEventRows: () => h.built.db.listEventRowEntries() })
    const artifactRef = h.built.runtime.getTask(d.ticketId).evidence[0]!
    h.clock.set('2026-11-11T08:20:00.000Z')
    h.built.runtime.change({ ticketId: d.ticketId, goal: '新目标：只看聚类', at: h.clock.now() })
    const reading = bridge.readRelevant(h.built.runtime.getTask(d.ticketId), 'E17')
    const invalidated = reading.notes.filter((note) => note.status === 'invalidated')
    assert.ok(invalidated.length >= 1)
    assert.equal(bridge.validate([artifactRef]).ok, true)
  } finally {
    h.dispose()
  }
})
