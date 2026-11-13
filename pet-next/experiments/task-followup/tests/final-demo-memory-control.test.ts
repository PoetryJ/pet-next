import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_QUIET } from '../contracts.ts'
import { buildRuntime } from '../runtime/build.ts'
import { FakeClock } from '../runtime/clock.ts'
import { createCapabilityHandle } from '../service/capability-assessor.ts'
import { FixtureClient } from '../capability/tests/fixture-model.ts'
import { seedResult } from '../tools/seed.ts'
import { readResultFile } from '../tools/watch.ts'
import { ANALYSIS_GOAL } from './helpers.ts'

for (const role of ['user', 'assistant'] as const) test(`自然语言任务取消接入真实 runtime，来源=${role}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pet-memory-control-'))
  const clock = new FakeClock(new Date().toISOString())
  const client = new FixtureClient((req) => {
    if (req.purpose === 'memory-extract') {
      const turns = JSON.parse(req.messages[1]!.content).turnsToExtract
      const u = turns.find((t: any) => t.id === 'cancel')
      return JSON.stringify({ coverage: turns.map((t: any) => ({ turnId: t.id, status: t.id === 'cancel' ? 'extracted' : 'no_relevant_fact' })), items: u ? [{ key: 'taskStatus', value: 'cancelled', scope: { level: 'task', id: u.taskIds[0] }, quotes: [{ turnId: u.id, text: '取消展板任务，不用再提醒我' }] }] : [] })
    }
    return JSON.stringify({ kind: 'none', reasonCode: 'no_current_action', evidenceTurnIds: [], evidenceItemIds: [] })
  })
  const handle = createCapabilityHandle({}, fetch, client)
  const built = buildRuntime({ workspaceRoot: root, policy: 'P3', clock, quiet: DEFAULT_QUIET, assessment: { assessor: handle.assessor, validateTaskControl: handle.validateTaskControl } })
  handle.attach(built.db.handle)
  try {
    const d = built.runtime.delegate({ title: '展板', goal: '持续跟进展板', goalCondition: ANALYSIS_GOAL })
    handle.appendTurn({ turnId: 'cancel', sessionId: 's', at: clock.now(), role, taskIds: [d.ticketId], text: '取消展板任务，不用再提醒我。灯塔仍继续。' })
    const seed = seedResult({ workspace: root, experimentId: 'P', runId: 'poster', revision: 1, status: 'partial', total: 10, passed: 8, failed: 2 })
    built.runtime.observe({ ticketId: d.ticketId, observed: readResultFile({ root, path: seed.resultPath, observedAt: clock.now() }).observed! })
    await built.runtime.settleAssessments()
    assert.equal(built.runtime.listTasks().find((t) => t.ticketId === d.ticketId)!.status, role === 'user' ? 'cancelled' : 'active')
    assert.equal(built.attention.listOpen(d.ticketId).length, 0)
    if (role === 'user') {
      const row = built.runtime.listAssessments(d.ticketId).find((r) => r.status === 'submitted')!
      assert.equal(JSON.parse(row.post_guard_json!)[0].code, 'user_memory_cancel')
      const control = JSON.parse(row.raw_json!).meta.taskControl
      handle.appendTurn({ turnId: 'reverse', sessionId: 's', at: clock.now(), role: 'user', taskIds: [d.ticketId], text: '先别取消，继续跟进。' })
      assert.equal(handle.validateTaskControl(control, JSON.parse(row.snapshot_json), clock.now()), false, '更晚的未编译用户原话使旧取消证据失效')
    }
  } finally {
    built.runtime.abortAllAssessments('test end')
    await built.runtime.settleAssessments()
    built.db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('未配置证据复验器的任意 assessor 不能直接取消任务', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pet-control-untrusted-'))
  const built = buildRuntime({ workspaceRoot: root, policy: 'P3', clock: new FakeClock(new Date().toISOString()), quiet: DEFAULT_QUIET, assessment: { assessor: { id: 'fixture-untrusted', capability: false, async assess() { return { drafts: [], taskControl: { kind: 'cancel', itemId: 'made-up', reason: 'fabricated' }, raw: { provider: 'fixture', model: 'fixture', rawOutput: '' } } } } } })
  try {
    const d = built.runtime.delegate({ title: '保留任务', goal: '等待结果', goalCondition: ANALYSIS_GOAL })
    const seed = seedResult({ workspace: root, experimentId: 'P', runId: 'poster', revision: 1, status: 'partial', total: 10, passed: 8, failed: 2 })
    built.runtime.observe({ ticketId: d.ticketId, observed: readResultFile({ root, path: seed.resultPath, observedAt: new Date().toISOString() }).observed! })
    await built.runtime.settleAssessments()
    assert.equal(built.runtime.listTasks()[0]!.status, 'active')
    assert.ok(built.runtime.listAssessments(d.ticketId).some((r) => r.post_guard_json?.includes('invalid_task_control')))
  } finally { built.runtime.abortAllAssessments('test end'); await built.runtime.settleAssessments(); built.db.close(); rmSync(root, { recursive: true, force: true }) }
})
