/**
 * 负控：每个都注入一种坏情况，检查系统是否真的挡住。
 *
 * 判定约定（与 R3 的 fixture 一致）：verdict=detected 表示系统检测/挡住了坏情况，
 * 子进程故意以 exit 1 退出；verdict=masked 表示坏情况被放过，子进程 exit 0。
 * 外层 harness 要求全部 detected，否则视为回归。任何一条被 MASKED 都不是“差不多通过”。
 *
 * @module pet-next/experiments/task-followup/eval/negative
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_QUIET, sha256Hex, stableId } from '../../contracts.ts'
import { AttentionQueue } from '../../attention/port.ts'
import { createPolicy } from '../../decision/rules.ts'
import { R31MemoryBridge } from '../../memory-bridge/port.ts'
import { FollowupRuntime } from '../../runtime/engine.ts'
import { FollowupDb } from '../../runtime/db.ts'
import { FakeClock } from '../../runtime/clock.ts'
import { LocalTools } from '../../tools/workspace.ts'
import { seedResult } from '../../tools/seed.ts'
import { readResultFile } from '../../tools/watch.ts'
import { EVAL_OUT } from '../../paths.ts'

export interface ControlResult {
  readonly name: string
  readonly detected: boolean
  readonly detail: string
}

function make(name: string, quiet = DEFAULT_QUIET, start = '2026-11-11T08:00:00.000Z') {
  const root = join(EVAL_OUT, 'work', 'negative', name)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const db = new FollowupDb(':memory:')
  const clock = new FakeClock(start)
  const tools = new LocalTools({ root })
  const memory = new R31MemoryBridge({ store: db, listEventRows: () => db.listEventRowEntries() })
  const attention = new AttentionQueue(db)
  const runtime = new FollowupRuntime({
    db,
    clock,
    memory,
    decision: createPolicy('P3', { quiet }),
    attention,
    tools,
    quiet,
    workspace: { root, artifacts: tools.artifactsDir() },
  })
  return { root, db, clock, attention, runtime }
}

function seedAndObserve(ctx: ReturnType<typeof make>, ticketId: string, status: 'partial' | 'failed' = 'partial') {
  const seeded = seedResult({
    workspace: ctx.root,
    experimentId: 'E17',
    runId: 'run-neg',
    revision: 1,
    status,
    total: 40,
    passed: 29,
    failed: 11,
  })
  const finding = readResultFile({ root: ctx.root, path: seeded.resultPath, observedAt: ctx.clock.now() })
  if (!finding.observed) throw new Error(`observe failed: ${finding.detail}`)
  return ctx.runtime.observe({ ticketId, observed: finding.observed })
}

function answerAuto(ctx: ReturnType<typeof make>, ticketId: string): void {
  const open = ctx.attention.listOpen(ticketId)[0]
  if (!open) return
  // 显式声明“用户打开了面板”，产生呈现回执；隐藏问题仍会被拒绝。
  ctx.runtime.present(ticketId)
  const option = open.options.find((item) => item.id === 'analyze_failing') ?? open.options[0]!
  ctx.runtime.answer({ attentionId: open.attentionId, taskRevision: open.taskRevision, optionId: option.id })
}

/** 1) 删掉当前目标请求：没有与当前 revision 对齐的目标事件，不得完成。 */
function dropGoal(): ControlResult {
  const ctx = make('drop-goal')
  try {
    const delegated = ctx.runtime.delegate({ title: '负控-目标', goal: '目标事件被删后不得完成', at: ctx.clock.now() })
    seedAndObserve(ctx, delegated.ticketId)
    answerAuto(ctx, delegated.ticketId)
    ctx.db.handle.prepare("DELETE FROM followup_events WHERE kind IN ('user.delegated','user.changed')").run()
    const check = ctx.runtime.completionCheck(ctx.runtime.getTask(delegated.ticketId))
    return {
      name: 'drop-goal',
      detected: !check.ok && check.reasons.includes('current_goal_event_missing'),
      detail: check.ok ? 'completion allowed without current goal event' : `blocked: ${check.reasons.join(',')}`,
    }
  } finally {
    ctx.db.close()
  }
}

/** 2) 伪造完成但无 receipt：worker 自称完成不算数。 */
function forgeCompletion(): ControlResult {
  const ctx = make('forge-completion')
  try {
    const delegated = ctx.runtime.delegate({ title: '负控-假完成', goal: '必须有回执', at: ctx.clock.now() })
    seedAndObserve(ctx, delegated.ticketId)
    const task = ctx.runtime.getTask(delegated.ticketId)
    const payload = {
      completion: true,
      receiptId: 'rcpt-forged',
      outputPath: 'artifacts/forged.md',
      outputSha256: 'deadbeef',
    }
    ctx.db.insertEvent(
      {
        schema: 'pet-followup-event/v1',
        eventId: stableId('ev', 'forge', 'completion', delegated.ticketId),
        sourceId: 'forge',
        sourceRevision: '1',
        observedAt: ctx.clock.now(),
        ticketId: delegated.ticketId,
        taskRevision: task.taskRevision,
        kind: 'tool.receipt',
        payload,
        contentSha256: sha256Hex(JSON.stringify(payload)),
      },
      ctx.clock.now(),
    )
    ctx.runtime.tick(0)
    const after = ctx.runtime.getTask(delegated.ticketId)
    const check = ctx.runtime.completionCheck(after)
    const receipts = ctx.db.listReceipts(delegated.ticketId)
    return {
      name: 'forge-completion',
      detected: after.status !== 'completed' && !check.ok && receipts.length === 0,
      detail: `status=${after.status} reasons=${check.reasons.join(',')} receipts=${receipts.length}`,
    }
  } finally {
    ctx.db.close()
  }
}

/** 3) 保留旧 taskRevision：更正后旧提案不得执行/通知。 */
function staleRevision(): ControlResult {
  const ctx = make('stale-revision')
  const root = ctx.root
  const db = ctx.db
  try {
    const deferred = new FollowupRuntime({
      db,
      clock: ctx.clock,
      memory: new R31MemoryBridge({ store: db, listEventRows: () => db.listEventRowEntries() }),
      decision: createPolicy('P3'),
      attention: ctx.attention,
      tools: new LocalTools({ root }),
      quiet: DEFAULT_QUIET,
      workspace: { root, artifacts: join(root, 'artifacts') },
      deferProposals: true,
    })
    const delegated = deferred.delegate({ title: '负控-旧版本', goal: '旧提案失效', at: ctx.clock.now() })
    seedAndObserve({ ...ctx, runtime: deferred } as ReturnType<typeof make>, delegated.ticketId)
    deferred.change({ ticketId: delegated.ticketId, goal: '新目标', at: ctx.clock.now() })
    const flush = deferred.flushProposals()
    const current = deferred.getTask(delegated.ticketId)
    const open = ctx.attention.listOpen(delegated.ticketId).filter((item) => item.taskRevision !== current.taskRevision)
    const stale = db.handle.prepare("SELECT COUNT(*) AS n FROM driver_log WHERE phase LIKE 'proposal.rejected%'").get() as { n: number }
    const invalidatedAsks = db
      .listProposals(delegated.ticketId)
      .filter((row) => row.kind === 'ask_user' && row.decision_key.includes('insufficient')).length
    const invalidated = db
      .listProposals(delegated.ticketId)
      .filter((row) => row.kind === 'ask_user' && row.outcome === 'invalidated').length
    return {
      name: 'stale-revision',
      detected: open.length === 0 && (flush.rejected > 0 || invalidated > 0),
      detail: `rejected=${flush.rejected} invalidated=${invalidated}/${invalidatedAsks} staleOpen=${open.length} staleLog=${Number(stale.n)}`,
    }
  } finally {
    db.close()
  }
}

/** 4) 重复 effect：同一次尝试只执行一次，重复观察不得产生第二个回执。 */
function duplicateEffect(): ControlResult {
  const ctx = make('duplicate-effect')
  try {
    const delegated = ctx.runtime.delegate({ title: '负控-重复', goal: '重复事件不重做', at: ctx.clock.now() })
    seedAndObserve(ctx, delegated.ticketId)
    answerAuto(ctx, delegated.ticketId)
    const seededPath = join(ctx.root, 'inbox', 'E17', 'result.json')
    for (let index = 0; index < 2; index += 1) {
      const again = readResultFile({ root: ctx.root, path: seededPath, observedAt: ctx.clock.now() })
      if (again.observed) ctx.runtime.observe({ ticketId: delegated.ticketId, observed: again.observed })
    }
    const toolEffects = ctx.db.listEffects().filter((effect) => effect.kind === 'tool')
    const analysisReceipts = ctx.db.listReceipts(delegated.ticketId).filter((receipt) => receipt.tool === 'write_analysis')
    return {
      name: 'duplicate-effect',
      detected: toolEffects.length === 1 && analysisReceipts.length === 1,
      detail: `toolEffects=${toolEffects.length} receipts=${analysisReceipts.length}`,
    }
  } finally {
    ctx.db.close()
  }
}

/** 5) 改变静默配置：静默内不提醒，静默结束后补发一次。时区显式 UTC。 */
function quietConfig(): ControlResult {
  const quiet = { ...DEFAULT_QUIET, timezone: 'UTC', fromHour: 23, toHour: 7 }
  const ctx = make('quiet-config', quiet, '2026-11-11T02:00:00.000Z')
  try {
    const delegated = ctx.runtime.delegate({ title: '负控-静默', goal: '静默不打扰', at: ctx.clock.now() })
    seedAndObserve(ctx, delegated.ticketId)
    const duringQuiet = ctx.db.listNotifications(delegated.ticketId).length
    ctx.clock.set('2026-11-11T07:05:00.000Z')
    ctx.runtime.tick(0)
    const afterQuiet = ctx.db.listNotifications(delegated.ticketId).length
    const delivered = ctx.db.listNotifications(delegated.ticketId).filter((row) => row.state === 'delivered' || row.state === 'presented').length
    return {
      name: 'quiet-config',
      detected: duringQuiet === 0 && afterQuiet === 1 && delivered === 1,
      detail: `duringQuiet=${duringQuiet} afterQuiet=${afterQuiet} delivered=${delivered}`,
    }
  } finally {
    ctx.db.close()
  }
}

/** 5b) 同一瞬时（02:00Z）在 Asia/Shanghai 是 10:00 本地：不静默、必须送达。 */
function quietTimezoneShanghai(): ControlResult {
  const quiet = { ...DEFAULT_QUIET, timezone: 'Asia/Shanghai', fromHour: 23, toHour: 7 }
  const ctx = make('quiet-timezone-shanghai', quiet, '2026-11-11T02:00:00.000Z')
  try {
    const delegated = ctx.runtime.delegate({ title: '负控-时区', goal: '上海时区静默边界', at: ctx.clock.now() })
    seedAndObserve(ctx, delegated.ticketId)
    const notifications = ctx.db.listNotifications(delegated.ticketId)
    const delivered = notifications.filter((row) => row.state === 'delivered' || row.state === 'presented').length
    return {
      name: 'quiet-timezone-shanghai',
      detected: notifications.length === 1 && delivered === 1,
      detail: `02:00Z=10:00Asia/Shanghai notifications=${notifications.length} delivered=${delivered} timezone=${quiet.timezone}`,
    }
  } finally {
    ctx.db.close()
  }
}

/** 6) 隐藏问题：未送达/未呈现时回答必须被拒绝；送达后才允许。 */
function hiddenAnswer(): ControlResult {
  const quiet = { ...DEFAULT_QUIET, timezone: 'UTC', fromHour: 23, toHour: 7 }
  const ctx = make('hidden-answer', quiet, '2026-11-11T02:00:00.000Z')
  try {
    const delegated = ctx.runtime.delegate({ title: '负控-可见性', goal: '没看到就不能答', at: ctx.clock.now() })
    seedAndObserve(ctx, delegated.ticketId)
    const open = ctx.attention.listOpen(delegated.ticketId)[0]!
    const hidden = ctx.runtime.answer({ attentionId: open.attentionId, taskRevision: open.taskRevision, optionId: 'analyze_failing' })
    const afterHidden = ctx.runtime.getTask(delegated.ticketId)
    const receiptsAfterHidden = ctx.db.listReceipts(delegated.ticketId).length
    ctx.clock.set('2026-11-11T07:05:00.000Z')
    ctx.runtime.tick(0)
    const visibility = ctx.runtime.attentionVisibility(open.attentionId)
    const visible = ctx.runtime.answer({ attentionId: open.attentionId, taskRevision: open.taskRevision, optionId: 'analyze_failing' })
    return {
      name: 'hidden-answer',
      detected:
        !hidden.ok &&
        hidden.code === 'not_visible' &&
        afterHidden.status === 'active' &&
        receiptsAfterHidden === 0 &&
        visibility.visible &&
        visible.ok,
      detail: `hidden=${hidden.ok ? 'accepted' : hidden.code} receipts=${receiptsAfterHidden} afterDelivery=${visible.ok ? 'accepted' : visible.code}`,
    }
  } finally {
    ctx.db.close()
  }
}

/** 7) 旧来源字节：磁盘换成 r2 但未 observe，执行必须失败且不生成回执。 */
function staleInput(): ControlResult {
  const ctx = make('stale-input')
  try {
    const delegated = ctx.runtime.delegate({ title: '负控-旧输入', goal: '按当前权威版本执行', at: ctx.clock.now() })
    const first = seedResult({
      workspace: ctx.root,
      experimentId: 'E17',
      runId: 'run-neg',
      revision: 1,
      status: 'partial',
      total: 40,
      passed: 29,
      failed: 11,
    })
    const finding = readResultFile({ root: ctx.root, path: first.resultPath, observedAt: ctx.clock.now() })
    if (finding.observed) ctx.runtime.observe({ ticketId: delegated.ticketId, observed: finding.observed })
    // 磁盘换成 r2，但从不 observe：任务权威结果仍是 r1。
    seedResult({
      workspace: ctx.root,
      experimentId: 'E17',
      runId: 'run-neg',
      revision: 2,
      status: 'partial',
      total: 40,
      passed: 35,
      failed: 5,
    })
    answerAuto(ctx, delegated.ticketId)
    const task = ctx.runtime.getTask(delegated.ticketId)
    const receipts = ctx.db.listReceipts(delegated.ticketId)
    const rejected = ctx.db
      .listEffects()
      .some((effect) => effect.kind === 'tool' && String(effect.detail ?? '').startsWith('input_gate:'))
    return {
      name: 'stale-input',
      detected: task.status !== 'completed' && receipts.length === 0 && Boolean(task.analysis) === false && rejected,
      detail: `status=${task.status} receipts=${receipts.length} analysis=${task.analysis ? 'present' : 'none'} gate=${rejected}`,
    }
  } finally {
    ctx.db.close()
  }
}

/**
 * 8) 重复恢复：running 转入 needs_reconciliation 后，第二次恢复仍阻断，不新增 attempt/receipt。
 * 说明：本控制用写库方式模拟“进程在工具执行中退出”，真实 exit 42 子进程证据见
 * tools/r41-acceptance.mjs；这里只验持久阻断不被后续 recover 绕过。
 */
function repeatRecover(): ControlResult {
  const ctx = make('repeat-recover')
  try {
    const delegated = ctx.runtime.delegate({ title: '负控-重复恢复', goal: '未知执行结果持续阻断', at: ctx.clock.now() })
    seedAndObserve(ctx, delegated.ticketId)
    const task = ctx.runtime.getTask(delegated.ticketId)
    // 手工写入一条“工具已开始、进程退出”的 effect；不生成回执，也不生成分析。
    ctx.db.saveEffect({
      effect_id: stableId('fx', delegated.ticketId, task.taskRevision, 'tool', 'write_analysis', 'crash'),
      ticket_id: delegated.ticketId,
      task_revision: task.taskRevision,
      assignment_id: task.assignmentId,
      attempt_id: stableId('att', delegated.ticketId, task.taskRevision, 'tool', 'write_analysis', 'crash'),
      kind: 'tool',
      tool: 'write_analysis',
      args_json: JSON.stringify({ resultPath: 'inbox/E17/result.json' }),
      input_ref_json: null,
      state: 'running',
      created_at: ctx.clock.now(),
      started_at: ctx.clock.now(),
      finished_at: null,
      detail: null,
    })
    const before = {
      attempts: ctx.db.listEffects().filter((effect) => effect.kind === 'tool').length,
      receipts: ctx.db.listReceipts(delegated.ticketId).length,
    }
    const first = ctx.runtime.recover()
    const second = ctx.runtime.recover()
    const third = ctx.runtime.recover()
    const after = {
      attempts: ctx.db.listEffects().filter((effect) => effect.kind === 'tool').length,
      receipts: ctx.db.listReceipts(delegated.ticketId).length,
    }
    const blockedTask = ctx.runtime.getTask(delegated.ticketId)
    const visibleAnswer = ctx.runtime.answer({
      attentionId: ctx.attention.listOpen(delegated.ticketId)[0]?.attentionId ?? 'missing',
      taskRevision: blockedTask.taskRevision,
      optionId: 'analyze_failing',
    })
    return {
      name: 'repeat-recover',
      detected:
        first.needsReconciliation.length === 1 &&
        second.needsReconciliation.length === 1 &&
        third.needsReconciliation.length === 1 &&
        after.attempts === before.attempts &&
        after.receipts === before.receipts &&
        blockedTask.stage === 'needs_reconciliation' &&
        !visibleAnswer.ok &&
        visibleAnswer.code === 'needs_reconciliation',
      detail: `recon=1/${first.needsReconciliation.length},${second.needsReconciliation.length},${third.needsReconciliation.length} attempts=${before.attempts}->${after.attempts} receipts=${before.receipts}->${after.receipts} stage=${blockedTask.stage} answer=${visibleAnswer.ok ? 'accepted' : visibleAnswer.code}`,
    }
  } finally {
    ctx.db.close()
  }
}

/** 9) 时钟倒退：受控时钟必须失败，不能悄悄 max() 掩盖。 */
function clockRegression(): ControlResult {
  const ctx = make('clock-regression')
  try {
    ctx.clock.set('2026-11-11T09:00:00.000Z')
    let failed = false
    let detail = ''
    try {
      ctx.clock.set('2026-11-11T08:00:00.000Z')
    } catch (error) {
      failed = true
      detail = (error as Error).message
    }
    return {
      name: 'clock-regression',
      detected: failed && detail.includes('clock_regression') && ctx.clock.now() === '2026-11-11T09:00:00.000Z',
      detail: failed ? detail : 'clock accepted regression',
    }
  } finally {
    ctx.db.close()
  }
}

export const CONTROLS: Record<string, () => ControlResult> = {
  'drop-goal': dropGoal,
  'forge-completion': forgeCompletion,
  'stale-revision': staleRevision,
  'duplicate-effect': duplicateEffect,
  'quiet-config': quietConfig,
  'quiet-timezone-shanghai': quietTimezoneShanghai,
  'hidden-answer': hiddenAnswer,
  'stale-input': staleInput,
  'repeat-recover': repeatRecover,
  'clock-regression': clockRegression,
}

export function runControl(name: string): ControlResult {
  const control = CONTROLS[name]
  if (!control) throw new Error(`unknown control ${name}`)
  return control()
}
