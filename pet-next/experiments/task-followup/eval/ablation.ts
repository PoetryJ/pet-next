/**
 * H1 可控消融（仅离线 fake sink）：
 *   提案时校验（proposal-only） vs 执行/通知前重验（revalidate）
 * 在不接 UI、不接真实工具派发、只用内存库与通知表的条件下，测“失效提案泄漏”。
 *
 * 说明：proposal-only 模式故意跳过更正/取消时的撤销与执行前重验，
 * 只允许在这里使用；正式 runtime 默认 full。
 *
 * @module pet-next/experiments/task-followup/eval/ablation
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_QUIET } from '../contracts.ts'
import type { AttentionView } from '../contracts.ts'
import { AttentionQueue } from '../attention/port.ts'
import { createPolicy } from '../decision/rules.ts'
import { R31MemoryBridge } from '../memory-bridge/port.ts'
import { FollowupRuntime } from '../runtime/engine.ts'
import { FollowupDb } from '../runtime/db.ts'
import { FakeClock } from '../runtime/clock.ts'
import { LocalTools } from '../tools/workspace.ts'
import { seedResult } from '../tools/seed.ts'
import { readResultFile } from '../tools/watch.ts'
import { EVAL_OUT } from '../paths.ts'

export interface AblationRun {
  readonly scenario: string
  readonly action: 'change' | 'cancel'
  readonly mode: 'proposal-only' | 'revalidate'
  readonly attempted: number
  readonly executed: number
  readonly rejected: number
  readonly leakedQuestions: number
  readonly leakedNotifications: number
  readonly leakedEffects: number
  readonly currentRevision: number
}

export interface AblationResult {
  readonly schema: 'pet-followup-ablation/v1'
  readonly note: string
  readonly runs: readonly AblationRun[]
  readonly summary: {
    readonly proposalOnlyLeaks: number
    readonly revalidateLeaks: number
    readonly leakDelta: number
  }
}

const START = '2026-11-11T08:00:00.000Z'

function runCase(mode: 'proposal-only' | 'revalidate', action: 'change' | 'cancel'): AblationRun {
  const root = join(EVAL_OUT, 'work', 'ablation', `${mode}-${action}`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const db = new FollowupDb(':memory:')
  const clock = new FakeClock(START)
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
    quiet: DEFAULT_QUIET,
    workspace: { root, artifacts: tools.artifactsDir() },
    deferProposals: true,
    validationMode: mode === 'revalidate' ? 'full' : 'proposal-only',
    skipInvalidation: mode === 'proposal-only',
  })
  try {
    const delegated = runtime.delegate({
      title: 'H1 消融',
      goal: '提案后目标变化，旧提案不得继续执行',
      at: START,
    })
    const seeded = seedResult({
      workspace: root,
      experimentId: 'E17',
      runId: 'run-ab',
      revision: 1,
      status: 'partial',
      total: 40,
      passed: 29,
      failed: 11,
    })
    const finding = readResultFile({ root, path: seeded.resultPath, observedAt: clock.now() })
    if (finding.observed) runtime.observe({ ticketId: delegated.ticketId, observed: finding.observed })
    if (action === 'change') {
      runtime.change({ ticketId: delegated.ticketId, goal: '新的目标：只看失败聚类', at: clock.now() })
    } else {
      runtime.cancel({ ticketId: delegated.ticketId, reason: 'ablation cancel', at: clock.now() })
    }
    const current = runtime.getTask(delegated.ticketId)
    const beforeEffects = new Set(db.listEffects().map((effect) => effect.effect_id))
    const beforeAttentions = new Set(db.listAttentions(delegated.ticketId).map((item) => item.attentionId))
    const beforeNotifications = new Set(db.listNotifications(delegated.ticketId).map((item) => item.notificationId))
    const flush = runtime.flushProposals()
    const notifications = db.listNotifications(delegated.ticketId).filter((item) => !beforeNotifications.has(item.notificationId))
    const attentions: AttentionView[] = db.listAttentions(delegated.ticketId).filter((item) => !beforeAttentions.has(item.attentionId))
    const leakedQuestions = attentions.filter(
      (item) => item.taskRevision !== current.taskRevision && item.state !== 'superseded',
    ).length
    const leakedNotifications = notifications.filter((notification) => {
      if (!notification.attentionId) return false
      const view = db.getAttention(notification.attentionId)
      return Boolean(view && view.taskRevision !== current.taskRevision)
    }).length
    const leakedEffects = db
      .listEffects()
      .filter(
        (effect) =>
          !beforeEffects.has(effect.effect_id) &&
          effect.task_revision !== current.taskRevision &&
          effect.state !== 'invalidated',
      ).length
    return {
      scenario: `${action}-after-question`,
      action,
      mode,
      attempted: flush.attempted,
      executed: flush.executed,
      rejected: flush.rejected,
      leakedQuestions,
      leakedNotifications,
      leakedEffects,
      currentRevision: current.taskRevision,
    }
  } finally {
    db.close()
  }
}

export function runAblation(): AblationResult {
  const runs = [
    runCase('proposal-only', 'change'),
    runCase('revalidate', 'change'),
    runCase('proposal-only', 'cancel'),
    runCase('revalidate', 'cancel'),
  ]
  const leak = (mode: 'proposal-only' | 'revalidate'): number =>
    runs
      .filter((run) => run.mode === mode)
      .reduce((sum, run) => sum + run.leakedQuestions + run.leakedNotifications + run.leakedEffects, 0)
  return {
    schema: 'pet-followup-ablation/v1',
    note: '仅离线 fake sink；proposal-only 故意关闭更正后撤销与执行前重验，不接 UI/工具派发。',
    runs,
    summary: {
      proposalOnlyLeaks: leak('proposal-only'),
      revalidateLeaks: leak('revalidate'),
      leakDelta: leak('proposal-only') - leak('revalidate'),
    },
  }
}
