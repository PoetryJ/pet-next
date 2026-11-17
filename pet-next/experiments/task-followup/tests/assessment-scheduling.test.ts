/**
 * 评估调度（R6-usable）：同一任务同身份只允许一个在途 + 一个 dirty 追赶。
 *
 * 背景：真实长历史运行时出现过“同一身份每秒重判 / 新建→中止→再新建”的循环。
 * 这里用确定性 assessor（无模型）直接数 assessments 行数，先复现再约束。
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime } from '../runtime/build.ts'
import { FakeClock } from '../runtime/clock.ts'
import { DEFAULT_QUIET } from '../contracts.ts'
import { ANALYSIS_GOAL } from './helpers.ts'

const tick = (ms = 20) => new Promise((done) => setTimeout(done, ms))

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'pet-sched-'))
  const clock = new FakeClock('2026-11-17T01:00:00.000Z')
  let calls = 0
  const built = buildRuntime({
    workspaceRoot: root, policy: 'P3', dbPath: join(root, 'state', 'db.sqlite'), clock, quiet: DEFAULT_QUIET,
    assessment: {
      assessor: {
        id: 'stub', capability: true,
        async assess() {
          calls += 1
          return { drafts: [{ intent: 'none', reasonCode: 'nothing_to_do', reasonText: 'stub' }], raw: { provider: 'stub', model: 'none', rawOutput: '' } } as never
        },
      },
      timeoutMs: 5000,
    },
  })
  return { built, clock, calls: () => calls, root }
}

test('同身份反复 reevaluate：只产生一次评估，不循环重判', async () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '长历史', goal: '等结果', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    for (let i = 0; i < 8; i += 1) { h.built.runtime.reevaluate(); await tick() }
    await h.built.runtime.settleAssessments()
    const rows = h.built.runtime.listAssessments(d.ticketId)
    assert.equal(rows.length, 1, `expected 1 assessment, got ${rows.length}`)
    assert.equal(h.calls(), 1)
  } finally { h.built.db.close() }
})

test('新原话：在途时只记脏，settle 后只补跑一次', async () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '长历史', goal: '等结果', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    h.built.runtime.reevaluate()
    // 在途期间连续三次“新原话”
    h.built.runtime.requestReassessment(d.ticketId)
    h.built.runtime.requestReassessment(d.ticketId)
    h.built.runtime.requestReassessment(d.ticketId)
    await h.built.runtime.settleAssessments()
    await tick(50)
    const rows = h.built.runtime.listAssessments(d.ticketId)
    assert.ok(rows.length <= 2, `at most one catch-up, got ${rows.length}`)
  } finally { h.built.db.close() }
})
