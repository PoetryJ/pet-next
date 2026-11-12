/**
 * R4.2 回归：回执合法性、已知输入拒绝后的续办授权、未知结果阻断。
 *
 * 这些测试全部走公开命令（delegate/observe/answer/reconcile/tick），
 * 只有“把 effect 置为 needs_reconciliation”的故障注入是直接写库，用于模拟进程中断。
 *
 * @module pet-next/experiments/task-followup/tests/r42
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { join } from 'node:path'
import { stableId } from '../contracts.ts'
import { answerOpen, harness, openAttention, ANALYSIS_GOAL } from './helpers.ts'
import type { Harness } from './helpers.ts'

function seedPath(h: Harness): string {
  return join(h.root, 'inbox', 'E17', 'result.json')
}

function startAnalysis(h: Harness) {
  const d = h.built.runtime.delegate({
    title: 'R4.2 回执',
    goal: '结果不足时分析失败样本',
    goalCondition: ANALYSIS_GOAL,
    at: h.clock.now(),
  })
  h.clock.set('2026-11-11T08:10:00.000Z')
  const seed = h.seed()
  h.observe(d.ticketId, seed.resultPath)
  return d.ticketId
}


/**
 * 合成“回执已落盘/状态未写回”的中断窗口：
 * 任务回到 active + needs_reconciliation，effect 回到 needs_reconciliation。
 * 仅用于回执合法性单测；真实崩溃路径由 runtime-independent 探针覆盖。
 */
function reopenReconciliationWindow(h: Harness, ticketId: string, effectId: string) {
  const row = h.built.db.getTaskRow(ticketId)!
  h.built.db.saveTaskRow({ ...row, status: 'active', stage: 'needs_reconciliation', completion_json: null })
  const effect = h.built.db.getEffect(effectId)!
  h.built.db.saveEffect({ ...effect, state: 'needs_reconciliation' })
}

function toolEffects(h: Harness, ticketId: string) {
  return h.built.db.listEffects().filter((effect) => effect.ticket_id === ticketId && effect.kind === 'tool')
}

// ---------------------------------------------------------------------------
// A. 失败/未验证回执不得解除不确定性阻断
// ---------------------------------------------------------------------------

test('真实失败回执不能 accept_receipt，effect 保持 needs_reconciliation', () => {
  const h = harness()
  try {
    const ticketId = startAnalysis(h)
    // 输出路径被目录占用：真实写失败，回执 ok=false。
    const artifactDir = join(h.root, 'artifacts', ticketId)
    mkdirSync(join(artifactDir, 'analysis-run-01-r1.md'), { recursive: true })
    answerOpen(h, ticketId, 'analyze_failing')
    const task = h.built.runtime.getTask(ticketId)
    assert.equal(task.stage, 'needs_reconciliation')
    const receipt = h.built.db.listReceipts(ticketId)[0]!
    assert.equal(receipt.ok, false)
    assert.equal(receipt.needsReconciliation, true)
    assert.equal(receipt.inputsVerified, false)

    const result = h.built.runtime.reconcile({ ticketId, option: 'accept_receipt' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'receipt_not_ok')
    assert.equal(h.built.runtime.getTask(ticketId).stage, 'needs_reconciliation')
    assert.equal(toolEffects(h, ticketId)[0]!.state, 'needs_reconciliation')
    assert.equal(h.built.db.listReceipts(ticketId).length, 1)
  } finally {
    h.dispose()
  }
})

test('成功但未核验输入的回执同样被拒', () => {
  const h = harness()
  try {
    const ticketId = startAnalysis(h)
    answerOpen(h, ticketId, 'analyze_failing')
    const effect = toolEffects(h, ticketId)[0]!
    reopenReconciliationWindow(h, ticketId, effect.effect_id)
    // 纯无效记录测试：只把回执标成“未核验输入”，不伪造输入身份。
    h.built.db.handle.prepare('UPDATE receipts SET inputs_verified = 0 WHERE effect_id = ?').run(effect.effect_id)
    const result = h.built.runtime.reconcile({ ticketId, option: 'accept_receipt' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'receipt_inputs_unverified')
    assert.equal(h.built.db.getEffect(effect.effect_id)!.state, 'needs_reconciliation')
    assert.equal(h.built.runtime.getTask(ticketId).status, 'active')
  } finally {
    h.dispose()
  }
})

test('输出缺失或字节改变时 accept_receipt 被拒', () => {
  const h = harness()
  try {
    const ticketId = startAnalysis(h)
    answerOpen(h, ticketId, 'analyze_failing')
    const effect = toolEffects(h, ticketId)[0]!
    const receipt = h.built.db.listReceipts(ticketId)[0]!
    const output = join(h.root, receipt.outputPath!)
    const bytes = readFileSync(output)

    reopenReconciliationWindow(h, ticketId, effect.effect_id)
    writeFileSync(output, Buffer.concat([bytes, Buffer.from('\nchanged')]))
    const mismatch = h.built.runtime.reconcile({ ticketId, option: 'accept_receipt' })
    assert.equal(mismatch.ok, false)
    assert.equal(mismatch.code, 'receipt_output_sha_mismatch')

    rmSync(output)
    const missing = h.built.runtime.reconcile({ ticketId, option: 'accept_receipt' })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'receipt_output_missing')
    assert.equal(h.built.db.getEffect(effect.effect_id)!.state, 'needs_reconciliation')
  } finally {
    h.dispose()
  }
})

test('合法回执仍可显式对账为成功', () => {
  const h = harness()
  try {
    const ticketId = startAnalysis(h)
    answerOpen(h, ticketId, 'analyze_failing')
    const effect = toolEffects(h, ticketId)[0]!
    // 模拟“回执已落盘、effect 状态未写回”的中断窗口。
    reopenReconciliationWindow(h, ticketId, effect.effect_id)
    const task = h.built.runtime.getTask(ticketId)
    const check = h.built.runtime.completionCheck(task)
    assert.equal(check.ok, false)
    const result = h.built.runtime.reconcile({ ticketId, option: 'accept_receipt' })
    assert.equal(result.ok, true)
    assert.equal(result.code, 'reconciled')
    assert.equal(h.built.db.getEffect(effect.effect_id)!.state, 'succeeded')
    assert.equal(h.built.db.listReceipts(ticketId).length, 1)
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// A. 已知输入拒绝：新授权前不执行，新授权后新建 attempt
// ---------------------------------------------------------------------------

test('输入恢复后有可见继续入口，新授权前不创建新 attempt', () => {
  const h = harness()
  try {
    const ticketId = startAnalysis(h)
    const path = seedPath(h)
    const bytes = readFileSync(path)
    rmSync(path)
    // 回答已被接受（授权被消耗），但工具在执行前被输入门拒绝。
    assert.equal(answerOpen(h, ticketId, 'analyze_failing'), true)
    const rejected = h.built.runtime.getTask(ticketId)
    assert.equal(rejected.stage, 'continuation_pending')
    assert.equal(rejected.lastAnswer, undefined)
    assert.equal(rejected.continuation?.kind, 'input_rejected')
    assert.equal(rejected.continuation?.optionId, 'analyze_failing')
    assert.equal(toolEffects(h, ticketId)[0]!.state, 'invalidated')
    assert.equal(h.built.db.listReceipts(ticketId).length, 0)

    // 恢复完全相同的原字节；重复观察不创建新问题（事件去重）。
    writeFileSync(path, bytes)
    h.observe(ticketId, path)
    assert.equal(openAttention(h, ticketId), undefined)

    // 冷却结束后出现“当前版本重新授权”的可见问题。
    h.clock.set('2026-11-11T08:41:00.000Z')
    h.built.runtime.tick(0)
    const open = openAttention(h, ticketId)
    assert.ok(open)
    assert.match(open.decisionKey, /^continuation:run-01:r1:a1$/)
    assert.deepEqual(open.options.map((option) => option.id), ['retry_analysis', 'accept_without_analysis'])
    assert.equal(h.built.runtime.attentionVisibility(open.attentionId).visible, true)

    // 新授权之前：没有新的 attempt、没有新的回执、没有可执行的 tool effect。
    const before = h.built.runtime.getTask(ticketId)
    assert.equal(before.attempt, 1)
    assert.equal(toolEffects(h, ticketId).filter((effect) => effect.state !== 'invalidated').length, 0)
    assert.equal(h.built.db.listReceipts(ticketId).length, 0)

    // 新授权：建立 attempt 2 并只执行一次。
    assert.equal(answerOpen(h, ticketId, 'retry_analysis'), true)
    const after = h.built.runtime.getTask(ticketId)
    assert.equal(after.status, 'completed')
    assert.equal(after.attempt, 2)
    assert.equal(after.continuation, undefined)
    const receipts = h.built.db.listReceipts(ticketId)
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0]!.ok, true)
    assert.equal(receipts[0]!.inputRef?.revision, 1)
    // 旧失败证据保留。
    assert.equal(toolEffects(h, ticketId)[0]!.state, 'invalidated')
    assert.ok(String(toolEffects(h, ticketId)[0]!.detail).startsWith('input_gate:'))
  } finally {
    h.dispose()
  }
})

test('输入仍未恢复时只 defer，不制造必然被拒的问题', () => {
  const h = harness()
  try {
    const ticketId = startAnalysis(h)
    const path = seedPath(h)
    rmSync(path)
    answerOpen(h, ticketId, 'analyze_failing')
    h.clock.set('2026-11-11T09:00:00.000Z')
    h.built.runtime.tick(0)
    assert.equal(openAttention(h, ticketId), undefined)
    const task = h.built.runtime.getTask(ticketId)
    assert.equal(task.continuation?.kind, 'input_rejected')
    assert.equal(task.attempt, 1)
    assert.equal(h.built.db.listReceipts(ticketId).length, 0)
  } finally {
    h.dispose()
  }
})

test('未知执行结果不会被续办入口绕过', () => {
  const h = harness()
  try {
    const ticketId = startAnalysis(h)
    answerOpen(h, ticketId, 'analyze_failing')
    const effect = toolEffects(h, ticketId)[0]!
    reopenReconciliationWindow(h, ticketId, effect.effect_id)
    // 模拟“工具执行中进程退出且回执未落盘”：effect 仍是 running，且不在本进程的 inFlight。
    h.built.db.handle.prepare('DELETE FROM receipts WHERE effect_id = ?').run(effect.effect_id)
    h.built.db.saveEffect({ ...effect, state: 'running' })
    h.built.runtime.tick(0)
    const task = h.built.runtime.getTask(ticketId)
    assert.equal(task.stage, 'needs_reconciliation')
    assert.equal(openAttention(h, ticketId), undefined)
    assert.equal(task.attempt, 1)
    assert.equal(h.built.db.listReceipts(ticketId).length, 0)

    const reconciled = h.built.runtime.reconcile({ ticketId, option: 'accept_receipt' })
    assert.equal(reconciled.ok, false)
    assert.equal(reconciled.code, 'no_receipt')
    assert.equal(h.built.db.getEffect(effect.effect_id)!.state, 'running')
    // 普通 recover/tick 不会执行它。
    h.built.runtime.tick(0)
    assert.equal(h.built.db.listReceipts(ticketId).length, 0)
    assert.equal(h.built.runtime.getTask(ticketId).attempt, 1)
  } finally {
    h.dispose()
  }
})

test('跨进程重启后续办入口与授权仍正确', () => {
  const h = harness({ fileDb: true })
  try {
    const ticketId = startAnalysis(h)
    const path = seedPath(h)
    const bytes = readFileSync(path)
    rmSync(path)
    answerOpen(h, ticketId, 'analyze_failing')
    assert.ok(h.built.runtime.getTask(ticketId).continuation)
    // 真实重开：关闭 SQLite，重新 build 并 recover。
    h.reopen()
    const restored = h.built.runtime.getTask(ticketId)
    assert.equal(restored.continuation?.kind, 'input_rejected')
    // recover 会为新 assignment 递增代数（既有语义）；关键是授权前不执行。
    const before = restored.attempt
    assert.equal(h.built.db.listReceipts(ticketId).length, 0)
    writeFileSync(path, bytes)
    h.clock.set('2026-11-11T08:41:00.000Z')
    h.built.runtime.tick(0)
    const open = openAttention(h, ticketId)
    assert.ok(open)
    assert.match(open.decisionKey, /^continuation:run-01:r1:a1$/)
    assert.equal(h.built.db.listReceipts(ticketId).length, 0)
    assert.equal(answerOpen(h, ticketId, 'retry_analysis'), true)
    assert.equal(h.built.runtime.getTask(ticketId).status, 'completed')
    assert.equal(h.built.runtime.getTask(ticketId).attempt, before + 1)
    assert.equal(h.built.db.listReceipts(ticketId).length, 1)
  } finally {
    h.dispose()
  }
})

test('续办状态在目标更正后失效', () => {
  const h = harness()
  try {
    const ticketId = startAnalysis(h)
    rmSync(seedPath(h))
    answerOpen(h, ticketId, 'analyze_failing')
    assert.ok(h.built.runtime.getTask(ticketId).continuation)
    h.clock.set('2026-11-11T08:20:00.000Z')
    const changed = h.built.runtime.change({ ticketId, goal: '改成只看失败数', at: h.clock.now() })
    assert.equal(changed.ok, true)
    assert.equal(h.built.runtime.getTask(ticketId).continuation, undefined)
  } finally {
    h.dispose()
  }
})

test('重复观察同一来源不会重复建 attempt 或回执', () => {
  const h = harness()
  try {
    const ticketId = startAnalysis(h)
    const path = seedPath(h)
    const bytes = readFileSync(path)
    rmSync(path)
    answerOpen(h, ticketId, 'analyze_failing')
    writeFileSync(path, bytes)
    h.observe(ticketId, path)
    h.observe(ticketId, path)
    h.clock.set('2026-11-11T08:41:00.000Z')
    h.built.runtime.tick(0)
    h.built.runtime.tick(0)
    assert.equal(h.built.runtime.getTask(ticketId).attempt, 1)
    assert.equal(h.built.attention.listOpen(ticketId).length, 1)
    assert.equal(h.built.db.listReceipts(ticketId).length, 0)
  } finally {
    h.dispose()
  }
})

test('回执事件保留被消耗的决策身份', () => {
  const h = harness()
  try {
    const ticketId = startAnalysis(h)
    rmSync(seedPath(h))
    answerOpen(h, ticketId, 'analyze_failing')
    const continuation = h.built.runtime.getTask(ticketId).continuation!
    assert.ok(continuation.decisionId)
    const ask = h.built.db.listProposals(ticketId).find((row) => row.decision_id === continuation.decisionId)
    // 被消耗的是“执行本地分析”的那次授权动作。
    assert.equal(ask?.kind, 'continue_local')
    assert.equal(ask?.reason_code, 'analysis_requested')
    assert.equal(
      continuation.effectId,
      stableId('fx', ticketId, 1, 'tool', 'write_analysis:1'),
    )
  } finally {
    h.dispose()
  }
})
