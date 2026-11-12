/**
 * R5 强简单规则 NeedRule 的独立测试（不经过 P3）。
 *
 * @module pet-next/experiments/task-followup/tests/r5-need-rule
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_QUIET } from '../contracts.ts'
import type { GoalCondition, QuietConfig } from '../contracts.ts'
import { createNeedRule } from '../decision/r5/need-rule.ts'
import { NEED_RULE_CONFIG } from '../decision/r5/config.ts'
import { buildRuntime } from '../runtime/build.ts'
import { FakeClock } from '../runtime/clock.ts'
import { seedResult } from '../tools/seed.ts'
import { readResultFile } from '../tools/watch.ts'

const ANALYSIS_GOAL: GoalCondition = {
  requireResultArtifact: true,
  requireAnalysisArtifact: true,
  requireReceipt: true,
  insufficientStatuses: ['failed', 'partial'],
}

function setup(quiet: QuietConfig = DEFAULT_QUIET) {
  const root = mkdtempSync(join(tmpdir(), 'pet-r5-n1-'))
  const clock = new FakeClock('2026-11-11T08:00:00.000Z')
  const built = buildRuntime({
    workspaceRoot: root,
    policy: 'P3',
    dbPath: ':memory:',
    clock,
    quiet,
    decision: createNeedRule({ quiet }),
  })
  const seed = (patch: Record<string, unknown> = {}) =>
    seedResult({
      workspace: root,
      experimentId: 'E17',
      runId: 'run-01',
      revision: 1,
      status: 'partial',
      total: 40,
      passed: 30,
      failed: 10,
      ...patch,
    } as never)
  const observe = (ticketId: string, path: string) => {
    const finding = readResultFile({ root, path, observedAt: clock.now() })
    if (!finding.observed) throw new Error(`not observed: ${finding.detail}`)
    return built.runtime.observe({ ticketId, observed: finding.observed })
  }
  return { root, clock, built, seed, observe }
}

test('NeedRule 有独立配置 SHA 与 id，不与 P3 混用', () => {
  const a = createNeedRule({ quiet: DEFAULT_QUIET })
  const b = createNeedRule({ quiet: { ...DEFAULT_QUIET, timezone: 'Asia/Shanghai' } })
  assert.equal(a.id, 'N1')
  assert.notEqual(a.configSha, b.configSha)
  assert.equal(NEED_RULE_CONFIG.cooldownMs, 20 * 60_000)
})

test('结果不足：立即提出具体选择，不受失败阈值门控', () => {
  const h = setup()
  try {
    const d = h.built.runtime.delegate({ title: 'N1', goal: 'g', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    h.clock.set('2026-11-11T08:10:00.000Z')
    const seed = h.seed({ failed: 6, passed: 34 })
    h.observe(d.ticketId, seed.resultPath)
    const open = h.built.runtime.getTask(d.ticketId).openAttention
    assert.ok(open)
    assert.deepEqual(open!.options.map((item) => item.id).sort(), ['accept_current', 'analyze_failing', 'wait_more'])
  } finally {
    h.built.db.close()
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('用户明确等待：30 分钟内不再问，即使仍有必要问题', () => {
  const h = setup()
  try {
    const d = h.built.runtime.delegate({ title: 'N1', goal: 'g', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    h.clock.set('2026-11-11T08:10:00.000Z')
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    const open = h.built.runtime.getTask(d.ticketId).openAttention!
    h.built.runtime.present(d.ticketId)
    const answered = h.built.runtime.answer({ attentionId: open.attentionId, taskRevision: open.taskRevision, optionId: 'wait_more' })
    assert.equal(answered.ok, true)
    h.clock.set('2026-11-11T08:20:00.000Z')
    h.built.runtime.tick(0)
    assert.equal(Boolean(h.built.runtime.getTask(d.ticketId).openAttention), false)
    assert.equal(h.built.db.listProposals(d.ticketId).filter((row) => row.kind === 'ask_user').length, 1)
  } finally {
    h.built.db.close()
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('同一决策在冷却内不重复提问', () => {
  const h = setup()
  try {
    const d = h.built.runtime.delegate({
      title: 'N1',
      goal: 'g',
      goalCondition: { ...ANALYSIS_GOAL, requireAnalysisArtifact: false, requireReceipt: false },
      at: h.clock.now(),
    })
    h.clock.set('2026-11-11T08:10:00.000Z')
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    const open = h.built.runtime.getTask(d.ticketId).openAttention!
    h.built.runtime.present(d.ticketId)
    h.built.runtime.answer({ attentionId: open.attentionId, taskRevision: open.taskRevision, optionId: 'accept_current' })
    assert.equal(h.built.runtime.getTask(d.ticketId).status, 'completed')
    assert.equal(Boolean(h.built.runtime.getTask(d.ticketId).openAttention), false)
  } finally {
    h.built.db.close()
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('输入未恢复时只等待；恢复后提出新的重新授权问题', () => {
  const h = setup()
  try {
    const d = h.built.runtime.delegate({ title: 'N1', goal: 'g', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    h.clock.set('2026-11-11T08:10:00.000Z')
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    const open = h.built.runtime.getTask(d.ticketId).openAttention!
    h.built.runtime.present(d.ticketId)
    rmSync(seed.resultPath)
    h.built.runtime.answer({ attentionId: open.attentionId, taskRevision: open.taskRevision, optionId: 'analyze_failing' })
    const pending = h.built.runtime.getTask(d.ticketId)
    assert.equal(pending.stage, 'continuation_pending')
    assert.equal(Boolean(pending.openAttention), false)
    assert.equal(h.built.db.listProposals(d.ticketId).filter((row) => row.kind === 'ask_user').length, 1)
  } finally {
    h.built.db.close()
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('静默时段仍会提出，但通知延后（不丢问题）', () => {
  const quiet: QuietConfig = { ...DEFAULT_QUIET, fromHour: 23, toHour: 7 }
  const h = setup(quiet)
  try {
    h.clock.set('2026-11-11T23:30:00.000Z')
    const d = h.built.runtime.delegate({ title: 'N1', goal: 'g', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    h.clock.set('2026-11-11T23:35:00.000Z')
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    const task = h.built.runtime.getTask(d.ticketId)
    assert.ok(task.openAttention)
    assert.equal(task.openAttention!.deliveredAt, undefined)
    assert.ok(h.built.runtime.listWakeJobs().some((job) => job.dueAt === '2026-11-12T07:00:00.000Z'))
  } finally {
    h.built.db.close()
    rmSync(h.root, { recursive: true, force: true })
  }
})
