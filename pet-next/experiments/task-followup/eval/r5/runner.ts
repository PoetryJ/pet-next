/**
 * R5 12 条配对故事的运行器：P3 与 NeedRule 使用同一 scheduler/时钟/用户步骤。
 *
 * 不读 gold；gold 只在 score 阶段读取。所有时间来自显式步骤或 FakeClock。
 *
 * @module pet-next/experiments/task-followup/eval/r5/runner
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GoalCondition, PolicyId, QuietConfig } from '../../contracts.ts'
import { DEFAULT_QUIET, normalizeTimeZone } from '../../contracts.ts'
import { createPolicy } from '../../decision/rules.ts'
import { createNeedRule } from '../../decision/r5/need-rule.ts'
import { buildRuntime } from '../../runtime/build.ts'
import type { BuiltRuntime } from '../../runtime/build.ts'
import { FakeClock } from '../../runtime/clock.ts'
import { seedResult } from '../../tools/seed.ts'
import { readResultFile } from '../../tools/watch.ts'
import { EXPERIMENT_ROOT } from '../../paths.ts'

export const R5_POLICIES = ['P3', 'N1'] as const
export type R5Policy = (typeof R5_POLICIES)[number]

export interface R5Step {
  readonly kind: string
  readonly at: string
  readonly [key: string]: unknown
}

export interface R5Trajectory {
  readonly id: string
  readonly family: string
  readonly pair: string
  readonly split: 'dev' | 'heldout'
  readonly name: string
  readonly clockStart: string
  readonly timezone?: string
  readonly quiet?: QuietConfig
  readonly goal?: { readonly requireAnalysis?: boolean }
  readonly steps: readonly R5Step[]
}

export interface R5Raw {
  readonly schema: 'pet-followup-r5-raw/v1'
  readonly policy: R5Policy
  readonly trajectoryId: string
  readonly family: string
  readonly split: string
  readonly workspace: string
  readonly clockStart: string
  readonly finalClock: string
  readonly timezone: string
  readonly configSha: string
  readonly quiet: QuietConfig
  readonly steps: readonly { readonly index: number; readonly kind: string; readonly at: string; readonly detail: string }[]
  readonly observations: readonly { readonly index: number; readonly at: string; readonly notes: string[] }[]
  readonly proposals: readonly unknown[]
  readonly attentions: readonly {
    readonly attentionId: string
    readonly decisionId: string
    readonly decisionKey: string
    readonly taskRevision: number
    readonly assignmentId: string
    readonly ticketId: string
    readonly state: string
    readonly createdAt: string
    readonly deadline: string | null
    readonly notifiedAt: string | null
    readonly deliveredAt: string | null
    readonly presentedAt: string | null
    readonly answeredAt: string | null
    readonly answerOption: string | null
  }[]
  readonly notifications: readonly {
    readonly notificationId: string
    readonly attentionId: string | null
    readonly createdAt: string
    readonly deliveredAt: string | null
    readonly presentedAt: string | null
  }[]
  readonly wakes: readonly { readonly at: string; readonly jobId: string; readonly action: string; readonly detail: string }[]
  readonly receipts: readonly unknown[]
  readonly effects: readonly unknown[]
  readonly asks: readonly {
    readonly decisionId: string
    readonly decisionKey: string
    readonly reasonCode: string
    readonly ticketId: string
    readonly taskRevision: number
    readonly assignmentId: string
    readonly at: string
    readonly outcome: string
  }[]
  readonly driverLog: readonly { readonly at: string; readonly phase: string; readonly detail: string }[]
  readonly final: {
    readonly status: string
    readonly stage: string
    readonly taskRevision: number
    readonly completed: boolean
    readonly validCompletion: boolean
    readonly completionCheck: { readonly ok: boolean; readonly reasons: string[] } | null
  }
  readonly metrics: Record<string, unknown>
}

export function loadR5Trajectories(): R5Trajectory[] {
  const dir = join(EXPERIMENT_ROOT, 'fixtures', 'r5')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as R5Trajectory)
}

function goalFor(trajectory: R5Trajectory): GoalCondition {
  return {
    requireResultArtifact: true,
    requireAnalysisArtifact: trajectory.goal?.requireAnalysis !== false,
    requireReceipt: trajectory.goal?.requireAnalysis !== false,
    insufficientStatuses: ['failed', 'partial'],
  }
}

function decisionFor(policy: R5Policy, quiet: QuietConfig) {
  if (policy === 'N1') return createNeedRule({ quiet })
  // P3 使用原规则；quiet 注入保持与 R4 一致。
  return createPolicy('P3' as PolicyId, { quiet })
}

interface RunState {
  built: BuiltRuntime
  root: string
  dbPath: string
}

function open(root: string, policy: R5Policy, quiet: QuietConfig, clock: FakeClock): RunState {
  const dbPath = join(root, 'state', 'followup.sqlite')
  const built = buildRuntime({
    workspaceRoot: root,
    policy: 'P3',
    dbPath,
    clock,
    quiet,
    decision: decisionFor(policy, quiet),
  })
  return { built, root, dbPath }
}

export function runR5Trajectory(policy: R5Policy, trajectory: R5Trajectory): R5Raw {
  const root = mkdtempSync(join(tmpdir(), `pet-r5-${policy}-`))
  const timezone = normalizeTimeZone(trajectory.timezone ?? 'UTC')
  const quiet: QuietConfig = { ...DEFAULT_QUIET, ...(trajectory.quiet ?? {}), timezone }
  const clock = new FakeClock(trajectory.clockStart)
  let state = open(root, policy, quiet, clock)
  const steps: { index: number; kind: string; at: string; detail: string }[] = []
  const observations: { index: number; at: string; notes: string[] }[] = []
  const wakes: { at: string; jobId: string; action: string; detail: string }[] = []
  let ticketId: string | null = null

  const drainWakes = (): void => {
    for (const result of state.built.runtime.wakeDue(clock.now())) {
      wakes.push({ at: clock.now(), jobId: result.jobId, action: result.action, detail: result.detail })
    }
  }

  trajectory.steps.forEach((step, index) => {
    if (step.at && step.kind !== 'tick') clock.set(String(step.at))
    const payload = step as unknown as Record<string, unknown>
    switch (step.kind) {
      case 'delegate': {
        const result = state.built.runtime.delegate({
          title: String(payload.title ?? trajectory.id),
          goal: String(payload.goal ?? 'R5'),
          goalCondition: goalFor(trajectory),
          at: clock.now(),
        })
        ticketId = result.ticketId
        steps.push({ index, kind: step.kind, at: clock.now(), detail: `delegated ${result.ticketId.slice(0, 8)}` })
        break
      }
      case 'artifact': {
        const seed = seedResult({
          workspace: root,
          experimentId: String(payload.experiment ?? 'E41'),
          runId: String(payload.runId ?? 'run-01'),
          revision: Number(payload.revision ?? 1),
          status: (payload.status ?? 'partial') as 'failed' | 'partial' | 'succeeded',
          total: Number(payload.total ?? 40),
          passed: Number(payload.passed ?? 28),
          failed: Number(payload.failed ?? 12),
        })
        steps.push({ index, kind: step.kind, at: clock.now(), detail: `artifact ${seed.resultPath}` })
        break
      }
      case 'observe': {
        if (!ticketId) throw new Error('observe before delegate')
        const dir = join(root, 'inbox', String(payload.experiment ?? 'E41'))
        const resultPath = join(dir, 'result.json')
        const finding = existsSync(resultPath) ? readResultFile({ root, path: resultPath, observedAt: clock.now() }) : null
        const outcome = finding?.observed
          ? state.built.runtime.observe({ ticketId, observed: finding.observed })
          : { disposition: 'missing', detail: 'result.json missing' }
        const notes = [String((outcome as { disposition?: string }).disposition ?? 'unknown')]
        observations.push({ index, at: clock.now(), notes })
        steps.push({ index, kind: step.kind, at: clock.now(), detail: `observe ${notes.join(',')}` })
        break
      }
      case 'present': {
        if (!ticketId) throw new Error('present before delegate')
        state.built.runtime.present(ticketId, clock.now())
        steps.push({ index, kind: step.kind, at: clock.now(), detail: 'presented' })
        break
      }
      case 'answer': {
        if (!ticketId) throw new Error('answer before delegate')
        state.built.runtime.present(ticketId, clock.now())
        const open = state.built.runtime.getTask(ticketId).openAttention
        const result = open
          ? state.built.runtime.answer({
              attentionId: open.attentionId,
              taskRevision: open.taskRevision,
              optionId: String(payload.option),
            })
          : { ok: false as const, code: 'no_open_attention' as const, detail: 'no open attention' }
        steps.push({
          index,
          kind: step.kind,
          at: clock.now(),
          detail: result.ok ? `answered ${String(payload.option)}` : `answer rejected ${result.code}`,
        })
        break
      }
      case 'change': {
        if (!ticketId) throw new Error('change before delegate')
        state.built.runtime.change({ ticketId, goal: String(payload.goal ?? '新目标'), at: clock.now() })
        steps.push({ index, kind: step.kind, at: clock.now(), detail: 'changed goal' })
        break
      }
      case 'cancel': {
        if (!ticketId) throw new Error('cancel before delegate')
        state.built.runtime.cancel({ ticketId, reason: String(payload.reason ?? 'user_cancel'), at: clock.now() })
        steps.push({ index, kind: step.kind, at: clock.now(), detail: 'cancelled' })
        break
      }
      case 'tick': {
        const minutes = Number(payload.minutes ?? 0)
        clock.advance(minutes * 60_000)
        state.built.runtime.tick(0)
        drainWakes()
        steps.push({ index, kind: step.kind, at: clock.now(), detail: `advanced ${minutes}m` })
        break
      }
      case 'restart': {
        state.built.db.close()
        state = open(root, policy, quiet, clock)
        const report = state.built.runtime.recover()
        drainWakes()
        steps.push({ index, kind: step.kind, at: clock.now(), detail: `recovered restored=${report.restored.length}` })
        break
      }
      default:
        steps.push({ index, kind: step.kind, at: clock.now(), detail: 'ignored' })
    }
    // 模拟服务循环：每步之后处理到期 job（同一 scheduler，两种策略一致）。
    drainWakes()
  })

  const task = ticketId ? state.built.runtime.getTask(ticketId) : null
  const check = task ? state.built.runtime.completionCheck(task) : null
  const raw: R5Raw = {
    schema: 'pet-followup-r5-raw/v1',
    policy,
    trajectoryId: trajectory.id,
    family: trajectory.family,
    split: trajectory.split,
    workspace: root,
    clockStart: trajectory.clockStart,
    finalClock: clock.now(),
    timezone,
    configSha: decisionFor(policy, quiet).configSha,
    quiet,
    steps,
    observations,
    proposals: state.built.db.listProposals(ticketId ?? ''),
    attentions: state.built.db.listAttentions(ticketId ?? '').map((attention) => ({
      attentionId: attention.attentionId,
      decisionId: attention.decisionId,
      decisionKey: attention.decisionKey,
      taskRevision: attention.taskRevision,
      assignmentId: attention.assignmentId,
      ticketId: attention.ticketId,
      state: attention.state,
      createdAt: attention.createdAt,
      deadline: attention.deadline ?? null,
      notifiedAt: attention.notifiedAt ?? null,
      deliveredAt: attention.deliveredAt ?? null,
      presentedAt: attention.presentedAt ?? null,
      answeredAt: attention.answeredAt ?? null,
      answerOption: attention.answer?.optionId ?? null,
    })),
    notifications: state.built.db.listNotificationReceipts(ticketId ?? '').map((notification) => ({
      notificationId: notification.notificationId,
      attentionId: notification.attentionId,
      createdAt: notification.createdAt,
      deliveredAt: notification.deliveredAt ?? null,
      presentedAt: notification.presentedAt ?? null,
    })),
    wakes,
    receipts: state.built.db.listReceipts(ticketId ?? ''),
    effects: state.built.db.listEffects(),
    asks: state.built.db.listProposals(ticketId ?? '').map((row) => ({
      decisionId: row.decision_id,
      decisionKey: row.decision_key,
      reasonCode: row.reason_code,
      ticketId: row.ticket_id,
      taskRevision: row.task_revision,
      assignmentId: row.assignment_id ?? '',
      at: row.created_at,
      outcome: row.outcome,
    })),
    driverLog: (state.built.db.handle
      .prepare('SELECT at, phase, detail_json FROM driver_log WHERE ticket_id = ? ORDER BY at, rowid')
      .all(ticketId ?? '') as unknown as { at: string; phase: string; detail_json: string }[]).map((row) => ({
      at: row.at,
      phase: row.phase,
      detail: row.detail_json,
    })),
    final: {
      status: task?.status ?? 'missing',
      stage: task?.stage ?? 'missing',
      taskRevision: task?.taskRevision ?? 0,
      completed: task?.status === 'completed',
      validCompletion: Boolean(task?.status === 'completed' && check?.ok),
      completionCheck: check ? { ok: check.ok, reasons: [...check.reasons] } : null,
    },
    metrics: {
      notifications: state.built.db.listNotificationReceipts(ticketId ?? '').length,
      notificationsDelivered: state.built.db
        .listNotificationReceipts(ticketId ?? '')
        .filter((item) => Boolean(item.deliveredAt)).length,
      asks: state.built.db.listProposals(ticketId ?? '').filter((row) => row.kind === 'ask_user').length,
      receipts: state.built.db.listReceipts(ticketId ?? '').length,
      wakes: wakes.length,
      wakeFired: wakes.filter((item) => item.action === 'woken').length,
      wakeStale: wakes.filter((item) => item.action === 'stale').length,
      wakeCancelled: wakes.filter((item) => item.action === 'cancelled').length,
      duplicateReceipts:
        state.built.db.listReceipts(ticketId ?? '').length -
        new Set(state.built.db.listReceipts(ticketId ?? '').map((receipt) => receipt.effectId)).size,
      duplicateNotifications:
        state.built.db.listNotificationReceipts(ticketId ?? '').length -
        new Set(state.built.db.listNotificationReceipts(ticketId ?? '').map((item) => item.attentionId)).size,
    },
  }
  return raw
}

export function runR5All(): { runs: number; rawDir: string } {
  const rawDir = join(EXPERIMENT_ROOT, 'out', 'r5', 'raw')
  rmSync(rawDir, { recursive: true, force: true })
  const trajectories = loadR5Trajectories()
  let runs = 0
  for (const policy of R5_POLICIES) {
    mkdirSync(join(rawDir, policy), { recursive: true })
    for (const trajectory of trajectories) {
      const raw = runR5Trajectory(policy, trajectory)
      writeFileSync(join(rawDir, policy, `${trajectory.id}.json`), `${JSON.stringify(raw, null, 2)}\n`)
      runs += 1
    }
  }
  return { runs, rawDir }
}
