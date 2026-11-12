/**
 * R4.1 三个修复包的 before/after 反例。
 * 这些测试在 c7bd905 上会失败（见交付 before-fix/），修复后必须通过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { DEFAULT_QUIET, isQuietAt, normalizeTimeZone, quietEndsAt, stableId } from '../contracts.ts'
import type { InputRef, QuietConfig } from '../contracts.ts'
import { buildRuntime } from '../runtime/build.ts'
import { FakeClock } from '../runtime/clock.ts'
import { ANALYSIS_GOAL, answerHidden, answerOpen, harness, openAttention } from './helpers.ts'
import { runPolicyOverTrajectory } from '../eval/runner.ts'
import type { Trajectory } from '../eval/runner.ts'

// ---------------------------------------------------------------- 包 1

test('新来源修订使旧分析、未执行 effect 与旧问题失效', () => {
  const h = harness({ deferProposals: true })
  try {
    const d = h.built.runtime.delegate({ title: '来源失效', goal: '旧分析失效', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    h.clock.set('2026-11-11T08:10:00.000Z')
    const r1 = h.seed()
    h.observe(d.ticketId, r1.resultPath)
    // 排队但未执行的分析 effect：代表“已授权、尚未派发”的旧输入执行。
    const task = h.built.runtime.getTask(d.ticketId)
    const ref: InputRef = {
      taskId: d.ticketId,
      taskRevision: task.taskRevision,
      assignmentId: task.assignmentId!,
      sourceId: 'inbox/E17/run-01',
      sourceRevision: `r1:${r1.artifactSha.slice(0, 16)}`,
      runId: 'run-01',
      revision: 1,
      resultFileSha: r1.resultFileSha,
      artifactSha: r1.artifactSha,
      resultPath: 'inbox/E17/result.json',
      artifactPath: r1.artifactPath,
    }
    h.built.db.saveEffect({
      effect_id: stableId('fx', d.ticketId, task.taskRevision, 'tool', 'write_analysis', 'queued'),
      ticket_id: d.ticketId,
      task_revision: task.taskRevision,
      assignment_id: task.assignmentId,
      attempt_id: stableId('att', d.ticketId, task.taskRevision, 'tool', 'write_analysis', 'queued'),
      kind: 'tool',
      tool: 'write_analysis',
      args_json: JSON.stringify({ resultPath: 'inbox/E17/result.json' }),
      input_ref_json: JSON.stringify(ref),
      state: 'pending',
      created_at: h.clock.now(),
      started_at: null,
      finished_at: null,
      detail: null,
    })
    h.clock.set('2026-11-11T08:20:00.000Z')
    const r2 = h.seed({ revision: 2, failed: 5, passed: 35 })
    h.observe(d.ticketId, r2.resultPath)
    const after = h.built.runtime.getTask(d.ticketId)
    assert.equal(after.result?.revision, 2)
    assert.equal(after.analysis, undefined)
    const effect = h.built.db.getEffect(stableId('fx', d.ticketId, task.taskRevision, 'tool', 'write_analysis', 'queued'))!
    assert.equal(effect.state, 'invalidated')
    assert.equal(effect.detail, 'source revision changed')
    assert.equal(h.built.db.listReceipts(d.ticketId).length, 0)
    const staleProposals = h.built.db.listProposals(d.ticketId).filter((row) => row.outcome === 'invalidated')
    assert.ok(staleProposals.length >= 1)
    const check = h.built.runtime.completionCheck(after)
    assert.equal(check.ok, false)
    assert.equal(after.status, 'active')
  } finally {
    h.dispose()
  }
})

test('分析/receipt 的输入身份与当前结果不一致时不得完成', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '混版', goal: '逐项相等', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    h.clock.set('2026-11-11T08:10:00.000Z')
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    answerOpen(h, d.ticketId, 'analyze_failing')
    const task = h.built.runtime.getTask(d.ticketId)
    assert.equal(task.status, 'completed')
    assert.ok(task.analysis?.inputRef, 'analysis must carry input identity')
    assert.ok(task.completion?.inputRef, 'completion must carry input identity')

    // 把分析记录的输入身份改成一个不同的来源版本：完成检查必须拒绝。
    const wrong = { ...task.analysis!.inputRef!, resultFileSha: 'ff'.repeat(32) } as InputRef
    h.built.db.saveTaskRow({
      ...h.built.db.getTaskRow(d.ticketId)!,
      analysis_json: JSON.stringify({ ...task.analysis, inputRef: wrong }),
    })
    const check = h.built.runtime.completionCheck(h.built.runtime.getTask(d.ticketId))
    assert.equal(check.ok, false)
    assert.ok(check.reasons.includes('analysis_input_mismatch'), check.reasons.join(','))
    assert.equal(check.inputConsistent, false)
  } finally {
    h.dispose()
  }
})

test('老格式回执没有输入身份时 fail closed，不补写假身份', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '老回执', goal: 'fail closed', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    h.clock.set('2026-11-11T08:10:00.000Z')
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    answerOpen(h, d.ticketId, 'analyze_failing')
    assert.equal(h.built.runtime.getTask(d.ticketId).status, 'completed')
    h.built.db.handle.prepare('UPDATE receipts SET input_ref_json = NULL, inputs_verified = 0').run()
    const check = h.built.runtime.completionCheck(h.built.runtime.getTask(d.ticketId))
    assert.equal(check.ok, false)
    assert.ok(check.reasons.includes('receipt_input_identity_missing'), check.reasons.join(','))
    assert.ok(check.reasons.includes('receipt_inputs_unverified'), check.reasons.join(','))
    assert.equal(check.inputConsistent, false)
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------- 包 2

test('未知执行结果跨多次 recover 保持阻断，不新建 attempt/receipt', () => {
  const h = harness({ fileDb: true })
  try {
    const d = h.built.runtime.delegate({ title: '恢复阻断', goal: '未知结果不盲重试', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    h.clock.set('2026-11-11T08:10:00.000Z')
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    const task = h.built.runtime.getTask(d.ticketId)
    const effectId = stableId('fx', d.ticketId, task.taskRevision, 'tool', 'write_analysis', 'crash')
    h.built.db.saveEffect({
      effect_id: effectId,
      ticket_id: d.ticketId,
      task_revision: task.taskRevision,
      assignment_id: task.assignmentId,
      attempt_id: stableId('att', d.ticketId, task.taskRevision, 'tool', 'write_analysis', 'crash'),
      kind: 'tool',
      tool: 'write_analysis',
      args_json: JSON.stringify({ resultPath: 'inbox/E17/result.json' }),
      input_ref_json: null,
      state: 'running',
      created_at: h.clock.now(),
      started_at: h.clock.now(),
      finished_at: null,
      detail: null,
    })
    const before = { effects: h.built.db.listEffects().filter((item) => item.kind === 'tool').length, receipts: h.built.db.listReceipts(d.ticketId).length }
    for (let round = 0; round < 3; round += 1) {
      const report = h.built.runtime.recover()
      assert.deepEqual(report.needsReconciliation, [d.ticketId])
      assert.equal(h.built.runtime.getTask(d.ticketId).stage, 'needs_reconciliation')
    }
    assert.equal(h.built.db.listEffects().filter((item) => item.kind === 'tool').length, before.effects)
    assert.equal(h.built.db.listReceipts(d.ticketId).length, before.receipts)
    // 新事件/时间推进不能解除阻断。
    h.clock.set('2026-11-11T09:10:00.000Z')
    h.built.runtime.tick(0)
    assert.equal(h.built.runtime.getTask(d.ticketId).stage, 'needs_reconciliation')
    const hidden = answerHidden(h, d.ticketId, 'analyze_failing')
    assert.equal(hidden?.ok, false)
    assert.equal(hidden?.code, 'needs_reconciliation')
    // 没有回执时 accept_receipt 必须失败并保留阻断。
    const accepted = h.built.runtime.reconcile({ ticketId: d.ticketId, option: 'accept_receipt' })
    assert.equal(accepted.ok, false)
    assert.equal(accepted.code, 'no_receipt')
    assert.equal(h.built.runtime.getTask(d.ticketId).stage, 'needs_reconciliation')
    // 显式放弃后必须重新授权，不自动新建执行。
    const abandoned = h.built.runtime.reconcile({ ticketId: d.ticketId, option: 'abandon_attempt' })
    assert.equal(abandoned.ok, true)
    assert.equal(h.built.db.listEffects().filter((item) => item.kind === 'tool').length, before.effects)
    const afterAbandon = h.built.runtime.getTask(d.ticketId)
    assert.notEqual(afterAbandon.stage, 'needs_reconciliation')
    assert.equal(afterAbandon.attempt, task.attempt + 1)
    assert.ok(afterAbandon.diagnostics.includes('reauthorization_required'))
  } finally {
    h.dispose()
  }
})

test('有合法当前来源回执时可显式对账为完成', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '对账正控', goal: '合法回执可对账', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    h.clock.set('2026-11-11T08:10:00.000Z')
    const seed = h.seed()
    h.observe(d.ticketId, seed.resultPath)
    answerOpen(h, d.ticketId, 'analyze_failing')
    const completed = h.built.runtime.getTask(d.ticketId)
    assert.equal(completed.status, 'completed')
    const effect = h.built.db.listEffects().find((item) => item.kind === 'tool')!
    // 模拟“回执已落盘、进程在写回 effect 状态前退出”的窗口：effect 回到 needs_reconciliation。
    h.built.db.saveTaskRow({
      ...h.built.db.getTaskRow(d.ticketId)!,
      status: 'active',
      stage: 'needs_reconciliation',
      completion_json: null,
    })
    h.built.db.saveEffect({ ...effect, state: 'needs_reconciliation', detail: 'simulated crash window' })
    const blocked = h.built.runtime.completionCheck(h.built.runtime.getTask(d.ticketId))
    assert.equal(blocked.ok, false)
    assert.ok(blocked.reasons.some((reason) => reason.startsWith('unresolved_effect:')))
    const result = h.built.runtime.reconcile({ ticketId: d.ticketId, option: 'accept_receipt' })
    assert.equal(result.ok, true)
    assert.equal(result.code, 'reconciled')
    const after = h.built.runtime.getTask(d.ticketId)
    assert.equal(after.status, 'completed')
    assert.equal(h.built.db.listReceipts(d.ticketId).length, 1)
    assert.equal(h.built.db.listEffects().filter((item) => item.kind === 'tool' && item.state === 'succeeded').length, 1)
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------- 包 3

test('未送达/未呈现的问题不能回答，呈现后才可回答', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '可见性', goal: '看不到就不回答', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    const seed = h.seed()
    // 手工造一个 open 但没有通知的问题副本：用 quiet 覆盖不现实，这里直接删除通知。
    h.observe(d.ticketId, seed.resultPath)
    h.built.db.handle.prepare('DELETE FROM notifications').run()
    h.built.db.handle.prepare('UPDATE attentions SET notified_at = NULL, delivered_at = NULL, presented_at = NULL').run()
    const hidden = answerHidden(h, d.ticketId, 'analyze_failing')
    assert.equal(hidden?.ok, false)
    assert.equal(hidden?.code, 'not_visible')
    assert.equal(h.built.db.listReceipts(d.ticketId).length, 0)
    const presented = h.built.runtime.present(d.ticketId)
    assert.equal(presented.presented.length, 1)
    const visibility = h.built.runtime.attentionVisibility(presented.presented[0]!)
    assert.equal(visibility.visible, true)
    assert.equal(visibility.via, 'presented')
    assert.equal(answerOpen(h, d.ticketId, 'analyze_failing'), true)
    assert.equal(h.built.runtime.getTask(d.ticketId).status, 'completed')
  } finally {
    h.dispose()
  }
})

test('显式时区决定静默边界，不读宿主 TZ', () => {
  const utc: QuietConfig = { ...DEFAULT_QUIET, timezone: 'UTC', fromHour: 23, toHour: 7 }
  const shanghai: QuietConfig = { ...utc, timezone: 'Asia/Shanghai' }
  const instant = '2026-11-11T02:00:00.000Z'
  assert.equal(isQuietAt(instant, utc), true)
  assert.equal(isQuietAt(instant, shanghai), false)
  assert.equal(quietEndsAt(instant, utc), '2026-11-11T07:00:00.000Z')
  // 上海 23:30 本地 = 15:30Z；静默应结束在次日 07:00 本地 = 23:00Z。
  assert.equal(quietEndsAt('2026-11-11T15:30:00.000Z', shanghai), '2026-11-11T23:00:00.000Z')
  assert.throws(() => normalizeTimeZone('Mars/Olympus'), /invalid IANA timezone/)
})

test('运行时把同一份 quiet/timezone 传给策略，configSha 随之一致变化', () => {
  const root = new Set<string>()
  const build = (timezone: string): ReturnType<typeof buildRuntime> => {
    const workspaceRoot = `/tmp/r41-config-${timezone.replace('/', '-')}`
    root.add(workspaceRoot)
    rmSync(workspaceRoot, { recursive: true, force: true })
    return buildRuntime({ workspaceRoot, policy: 'P2', clock: new FakeClock('2026-11-11T08:00:00.000Z'), quiet: { ...DEFAULT_QUIET, timezone } })
  }
  const utc = build('UTC')
  const shanghai = build('Asia/Shanghai')
  try {
    assert.equal(utc.quiet.timezone, 'UTC')
    assert.equal(shanghai.quiet.timezone, 'Asia/Shanghai')
    assert.notEqual(utc.decision.configSha, shanghai.decision.configSha)
    assert.match(utc.decision.configSha, /^[0-9a-f]{64}$/)
  } finally {
    utc.db.close()
    shanghai.db.close()
    for (const path of root) rmSync(path, { recursive: true, force: true })
  }
})

test('可控时钟倒退必须失败，冲突步骤不得被 max() 掩盖', () => {
  const clock = new FakeClock('2026-11-11T09:00:00.000Z')
  assert.throws(() => clock.set('2026-11-11T08:00:00.000Z'), /clock_regression/)
  assert.equal(clock.now(), '2026-11-11T09:00:00.000Z')
  const trajectory: Trajectory = {
    id: 'T99',
    group: 'dev',
    name: '时间冲突',
    clockStart: '2026-11-11T08:00:00.000Z',
    steps: [
      { kind: 'delegate', at: '2026-11-11T08:00:00.000Z', title: 't', goal: 'g' },
      { kind: 'tick', at: '2026-11-11T09:00:00.000Z', minutes: 60 },
    ],
  }
  assert.throws(() => runPolicyOverTrajectory('P0', trajectory, { id: 'a', steps: trajectory.steps! }), /time_conflict/)
})

test('原有轨迹的 tick 只使用相对推进，时间轴单调', () => {
  const h = harness()
  try {
    const d = h.built.runtime.delegate({ title: '时间轴', goal: '单调', goalCondition: ANALYSIS_GOAL, at: h.clock.now() })
    h.clock.advance(300 * 60_000)
    assert.equal(h.clock.now(), '2026-11-11T13:00:00.000Z')
    assert.equal(h.built.runtime.getTask(d.ticketId).status, 'active')
  } finally {
    h.dispose()
  }
})
