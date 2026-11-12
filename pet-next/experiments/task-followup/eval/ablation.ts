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
  readonly action: 'change' | 'cancel' | 'source-revision'
  readonly mode: 'proposal-only' | 'revalidate'
  readonly attempted: number
  readonly executed: number
  readonly rejected: number
  readonly leakedQuestions: number
  readonly leakedNotifications: number
  readonly leakedEffects: number
  readonly currentRevision: number
  /** 工具是否在“旧授权”下仍被派发（只有 proposal-only 允许出现）。 */
  readonly executedOnStaleAuthorization: boolean
  /** 回执里的 resultFileSha 是否与当前权威结果不同（混版执行）。 */
  readonly toolInputsMixed: boolean
  /** 完成检查是否通过（有效完成）。 */
  readonly validCompletion: boolean
}

export interface AblationSourceEvidence {
  readonly expectedResultFileSha: string
  readonly currentResultFileSha: string
  readonly receiptResultFileSha: string | null
  readonly receiptInputVerified: boolean
}

export interface AblationResult {
  readonly schema: 'pet-followup-ablation/v2'
  readonly note: string
  readonly metricDefinitions: Readonly<Record<string, string>>
  readonly runs: readonly AblationRun[]
  readonly sourceEvidence: Readonly<Record<string, AblationSourceEvidence>>
  readonly summary: {
    readonly proposalOnlyLeaks: number
    readonly revalidateLeaks: number
    readonly leakDelta: number
    readonly proposalOnlyStaleAuthorization: number
    readonly revalidateStaleAuthorization: number
    readonly mixedToolInputs: number
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
      executedOnStaleAuthorization: false,
      toolInputsMixed: false,
      validCompletion: current.status === 'completed' && runtime.completionCheck(current).ok,
    }
  } finally {
    db.close()
  }
}

/**
 * 必要反例：旧授权 + 新来源修订。
 * 绑定真正的 sourceRevision/resultFileSha，避免只比 taskRevision 的假通过。
 * 旧授权是否被执行（executedOnStaleAuthorization）与实际工具输入是否正确（toolInputsMixed）分开报告。
 */
function runSourceCase(mode: 'proposal-only' | 'revalidate'): {
  run: AblationRun
  evidence: AblationSourceEvidence
} {
  const root = join(EVAL_OUT, 'work', 'ablation', `source-${mode}`)
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
    const delegated = runtime.delegate({ title: 'H1 来源反例', goal: '来源修订后旧授权不得执行', at: START })
    const first = seedResult({
      workspace: root,
      experimentId: 'E17',
      runId: 'run-ab',
      revision: 1,
      status: 'partial',
      total: 40,
      passed: 29,
      failed: 11,
    })
    const finding = readResultFile({ root, path: first.resultPath, observedAt: clock.now() })
    if (finding.observed) runtime.observe({ ticketId: delegated.ticketId, observed: finding.observed })
    // 先把 r1 的问题真正落成 attention，再让用户基于 r1 授权一次分析（提案排队不执行）。
    runtime.flushProposals()
    const open = attention.listOpen(delegated.ticketId)[0]
    if (!open) throw new Error('source case: no attention after first flush')
    runtime.present(delegated.ticketId)
    runtime.answer({ attentionId: open.attentionId, taskRevision: open.taskRevision, optionId: 'analyze_failing' })
    const staleProposalIds = new Set(
      db
        .listProposals(delegated.ticketId)
        .filter((row) => row.outcome === 'open')
        .map((row) => row.decision_id),
    )
    // 磁盘出现 r2；观察后旧授权必须失效。
    const second = seedResult({
      workspace: root,
      experimentId: 'E17',
      runId: 'run-ab',
      revision: 2,
      status: 'partial',
      total: 40,
      passed: 35,
      failed: 5,
    })
    const secondFinding = readResultFile({ root, path: second.resultPath, observedAt: clock.now() })
    if (secondFinding.observed) runtime.observe({ ticketId: delegated.ticketId, observed: secondFinding.observed })
    const beforeEffects = new Set(db.listEffects().map((effect) => effect.effect_id))
    const flush = runtime.flushProposals()
    const executedStale = db
      .listProposals(delegated.ticketId)
      .some((row) => staleProposalIds.has(row.decision_id) && row.outcome === 'executed')
    // flush 只排队 effect；推进一次让真实派发发生（与正式 drain 同一路径）。
    runtime.tick(0)
    let task = runtime.getTask(delegated.ticketId)
    // 重验模式会重新提问；这里显式呈现并重新授权后执行一次。
    // deferProposals 下可能还有排队问题，最多两轮把当前有效问题处理完。
    for (let round = 0; round < 2; round += 1) {
      const next = attention.listOpen(delegated.ticketId)[0]
      if (!next || task.status === 'completed') break
      runtime.present(delegated.ticketId)
      runtime.answer({ attentionId: next.attentionId, taskRevision: next.taskRevision, optionId: 'analyze_failing' })
      runtime.flushProposals()
      runtime.tick(0)
      task = runtime.getTask(delegated.ticketId)
    }
    const newToolEffects = db
      .listEffects()
      .filter((effect) => !beforeEffects.has(effect.effect_id) && effect.kind === 'tool' && effect.state !== 'invalidated')
    const receipts = db.listReceipts(delegated.ticketId)
    const receipt = receipts.at(-1)
    const evidence: AblationSourceEvidence = {
      expectedResultFileSha: second.resultFileSha,
      currentResultFileSha: task.result?.resultFileSha ?? '',
      receiptResultFileSha: receipt?.inputRef?.resultFileSha ?? null,
      receiptInputVerified: receipt?.inputsVerified ?? false,
    }
    return {
      run: {
        scenario: 'source-revision-after-authorization',
        action: 'source-revision',
        mode,
        attempted: flush.attempted,
        executed: flush.executed,
        rejected: flush.rejected,
        leakedQuestions: 0,
        leakedNotifications: 0,
        leakedEffects: executedStale && newToolEffects.length > 0 ? newToolEffects.length : 0,
        currentRevision: task.taskRevision,
        executedOnStaleAuthorization: executedStale && newToolEffects.length > 0,
        toolInputsMixed: Boolean(receipt?.inputRef && task.result && receipt.inputRef.resultFileSha !== task.result.resultFileSha),
        validCompletion: task.status === 'completed' && runtime.completionCheck(task).ok,
      },
      evidence,
    }
  } finally {
    db.close()
  }
}

export function runAblation(): AblationResult {
  const sourceOnly = runSourceCase('proposal-only')
  const sourceRevalidate = runSourceCase('revalidate')
  const runs = [
    runCase('proposal-only', 'change'),
    runCase('revalidate', 'change'),
    runCase('proposal-only', 'cancel'),
    runCase('revalidate', 'cancel'),
    sourceOnly.run,
    sourceRevalidate.run,
  ]
  const leak = (mode: 'proposal-only' | 'revalidate'): number =>
    runs
      .filter((run) => run.mode === mode)
      .reduce((sum, run) => sum + run.leakedQuestions + run.leakedNotifications + run.leakedEffects, 0)
  return {
    schema: 'pet-followup-ablation/v2',
    note: '仅离线 fake sink；proposal-only 故意关闭更正后撤销与执行前重验，不接 UI/模型。工具输入身份与旧授权拦截分开报告。',
    metricDefinitions: {
      leakedEffects: '在旧版本/旧来源授权下仍被创建且未 invalidated 的 effect 数。',
      executedOnStaleAuthorization: '旧授权下仍派发了工具执行（只有 proposal-only 允许出现）。',
      toolInputsMixed: '回执里的 resultFileSha 与当前权威结果不同，即真正混版执行。',
      validCompletion: 'completionCheck.ok 且状态为 completed；绑定当前 sourceRevision/resultFileSha。',
    },
    runs,
    sourceEvidence: { 'proposal-only': sourceOnly.evidence, revalidate: sourceRevalidate.evidence },
    summary: {
      proposalOnlyLeaks: leak('proposal-only'),
      revalidateLeaks: leak('revalidate'),
      leakDelta: leak('proposal-only') - leak('revalidate'),
      proposalOnlyStaleAuthorization: runs.filter((run) => run.mode === 'proposal-only' && run.executedOnStaleAuthorization).length,
      revalidateStaleAuthorization: runs.filter((run) => run.mode === 'revalidate' && run.executedOnStaleAuthorization).length,
      mixedToolInputs: runs.filter((run) => run.toolInputsMixed).length,
    },
  }
}
