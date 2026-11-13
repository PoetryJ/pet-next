/**
 * final-demo：宿主 capability 接线测试。只验证接线（请求体字段、失败显式记录、未配置时的显式回退、重新评估轮次）；
 * 这里用记录型 fetch 返回 HTTP 错误，不产生任何模型输出，也不构成能力结论。真实模型结果见交付目录 live 记录。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_QUIET } from '../contracts.ts'
import { buildRuntime } from '../runtime/build.ts'
import { FakeClock } from '../runtime/clock.ts'
import { CapabilityNotConfigured, createCapabilityHandle } from '../service/capability-assessor.ts'
import { seedResult } from '../tools/seed.ts'
import { readResultFile } from '../tools/watch.ts'
import { ANALYSIS_GOAL } from './helpers.ts'

const tick = (ms = 30) => new Promise((done) => setTimeout(done, ms))

test('未配置模型：显式抛出 not_configured，宿主据此回退规则路径', () => {
  assert.throws(() => createCapabilityHandle({}), CapabilityNotConfigured)
  assert.throws(() => createCapabilityHandle({ PET_MODEL_BASE_URL: 'https://example.com/v1', PET_MODEL_NAME: 'x' }), CapabilityNotConfigured, '非回环无 key 拒绝')
})

test('接线：请求体带 enable_thinking=false/stream=false；provider 失败被记录为 failed，不生成动作；新原话触发新一轮', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pet-cap-wire-'))
  const bodies: Record<string, unknown>[] = []
  const recordingFetch = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ error: 'wiring test: no model here' }), { status: 503, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const handle = createCapabilityHandle({ PET_MODEL_BASE_URL: 'http://127.0.0.1:9/v1', PET_MODEL_NAME: 'wiring-test' }, recordingFetch)
  const clock = new FakeClock('2026-11-11T08:00:00.000Z')
  const built = buildRuntime({ workspaceRoot: root, policy: 'P3', dbPath: join(root, 'state', 'db.sqlite'), clock, quiet: DEFAULT_QUIET, assessment: { assessor: handle.assessor, timeoutMs: 5000 } })
  handle.attach(built.db.handle)
  try {
    const d = built.runtime.delegate({ title: '长期实验', goal: '结果不足时问我是否分析失败样本', goalCondition: ANALYSIS_GOAL, at: clock.now() })
    assert.equal(handle.appendTurn({ turnId: 't-delegate', sessionId: 'panel', at: clock.now(), role: 'user', text: '新委托：跟进 E17', taskIds: [d.ticketId] }), true)
    assert.equal(handle.appendTurn({ turnId: 't-delegate', sessionId: 'panel', at: clock.now(), role: 'user', text: '新委托：跟进 E17', taskIds: [d.ticketId] }), false, '同一原话不重复写入')
    const seed = seedResult({ workspace: root, experimentId: 'E17', runId: 'run-01', revision: 1, status: 'partial', total: 40, passed: 29, failed: 11 })
    const finding = readResultFile({ root, path: seed.resultPath, observedAt: clock.now() })
    built.runtime.observe({ ticketId: d.ticketId, observed: finding.observed! })
    await tick()
    await built.runtime.settleAssessments()
    const rows = built.runtime.listAssessments(d.ticketId)
    assert.ok(rows.length >= 1)
    const last = [...rows].sort((a, b) => b.event_cursor - a.event_cursor || b.round - a.round)[0]!
    assert.equal(last.status, 'failed')
    assert.match(String(last.error_detail), /extraction|http|503|provider/i)
    assert.equal(built.attention.listOpen(d.ticketId).length, 0, '失败不生成问题')
    assert.ok(bodies.length >= 1)
    for (const body of bodies) {
      assert.equal(body.stream, false)
      assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
      assert.equal(body.temperature, 0)
    }
    const before = rows.length
    handle.appendTurn({ turnId: 't-say', sessionId: 'panel', at: clock.now(), role: 'user', text: '改口：先别分析，等第二版', taskIds: [d.ticketId] })
    built.runtime.requestReassessment(d.ticketId)
    built.runtime.reevaluate()
    await tick()
    await built.runtime.settleAssessments()
    const after = built.runtime.listAssessments(d.ticketId)
    assert.equal(after.length, before + 1)
    assert.ok(after.some((row) => row.round === 1 && row.memory_cursor === last.memory_cursor && row.event_cursor === last.event_cursor), '同一身份的新一轮')
  } finally {
    built.runtime.abortAllAssessments('end')
    await built.runtime.settleAssessments()
    built.db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
