/**
 * 五个负控：每个都注入一种坏情况，检查系统是否真的挡住。
 *
 * 判定约定（与 R3 的 fixture 一致）：verdict=detected 表示系统检测/挡住了坏情况，
 * 子进程故意以 exit 1 退出；verdict=masked 表示坏情况被放过，子进程 exit 0。
 * 外层 harness 要求五个都 detected，否则视为回归。
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

function make(name: string, quiet = DEFAULT_QUIET) {
  const root = join(EVAL_OUT, 'work', 'negative', name)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const db = new FollowupDb(':memory:')
  const clock = new FakeClock('2026-11-11T08:00:00.000Z')
  const tools = new LocalTools({ root })
  const memory = new R31MemoryBridge({ store: db, listEventRows: () => db.listEventRowEntries() })
  const attention = new AttentionQueue(db)
  const runtime = new FollowupRuntime({
    db,
    clock,
    memory,
    decision: createPolicy('P3'),
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
    // 再扫同一份文件两次。
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

/** 5) 改变静默配置：静默内不提醒，静默结束后补发一次。 */
function quietConfig(): ControlResult {
  const ctx = make('quiet-config', { ...DEFAULT_QUIET, fromHour: 23, toHour: 7 })
  ctx.clock.set('2026-11-11T02:00:00.000Z')
  try {
    const delegated = ctx.runtime.delegate({ title: '负控-静默', goal: '静默不打扰', at: ctx.clock.now() })
    seedAndObserve(ctx, delegated.ticketId)
    const duringQuiet = ctx.db.listNotifications(delegated.ticketId).length
    ctx.clock.set('2026-11-11T07:05:00.000Z')
    ctx.runtime.tick(0)
    const afterQuiet = ctx.db.listNotifications(delegated.ticketId).length
    return {
      name: 'quiet-config',
      detected: duringQuiet === 0 && afterQuiet === 1,
      detail: `duringQuiet=${duringQuiet} afterQuiet=${afterQuiet}`,
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
}

export function runControl(name: string): ControlResult {
  const control = CONTROLS[name]
  if (!control) throw new Error(`unknown control ${name}`)
  return control()
}
