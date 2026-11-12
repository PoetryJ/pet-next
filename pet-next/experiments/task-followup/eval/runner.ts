/**
 * 轨迹运行器：四种策略跑同一批事件计划、同一套 runtime/工具/时钟。
 *
 * 约束：
 * - 不读 gold；gold 只在 score 阶段读取；
 * - 用户回应由固定行为规则产生，所有策略一致；
 * - 所有时间来自 FakeClock，不 sleep；
 * - 每条运行都落原始事件/提案/注意力/回执，便于独立重评。
 *
 * @module pet-next/experiments/task-followup/eval/runner
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { normalizeTimeZone, sha256Hex, stableId } from '../contracts.ts'
import type {
  AttentionView,
  GoalCondition,
  PolicyId,
  ProposedDecision,
  QuietConfig,
  TaskStage,
  TaskStatus,
} from '../contracts.ts'
import { FROZEN_CONFIG } from '../decision/rules.ts'
import { buildRuntime } from '../runtime/build.ts'
import type { BuiltRuntime } from '../runtime/build.ts'
import { FakeClock } from '../runtime/clock.ts'
import { seedResult } from '../tools/seed.ts'
import type { SeedInput } from '../tools/seed.ts'
import { readResultFile } from '../tools/watch.ts'
import { EXPERIMENT_ROOT, FIXTURES_DIR } from '../paths.ts'
import { scoreAll } from './score.ts'
import { runAblation } from './ablation.ts'

export interface TrajectoryStep {
  readonly kind: string
  readonly at?: string
  readonly [key: string]: unknown
}

export interface TrajectoryVariant {
  readonly id: string
  readonly steps: readonly TrajectoryStep[]
}

export interface Trajectory {
  readonly id: string
  readonly group: 'dev' | 'heldout'
  readonly name: string
  readonly clockStart: string
  /** 显式 IANA 时区；缺省 UTC，绝不读宿主 TZ。 */
  readonly timezone?: string
  readonly quiet?: QuietConfig
  readonly goal?: { readonly requireAnalysis?: boolean }
  readonly steps?: readonly TrajectoryStep[]
  readonly variants?: readonly TrajectoryVariant[]
}

interface StepRecord {
  readonly index: number
  readonly kind: string
  readonly at: string
  readonly detail: string
}

export interface RawRun {
  readonly schema: 'pet-followup-raw/v1'
  readonly policy: PolicyId
  readonly policyConfigSha: string
  /** 运行配置指纹：规则 + quiet（含 timezone）。 */
  readonly configSha: string
  readonly quiet: QuietConfig
  readonly timezone: string
  readonly trajectoryId: string
  readonly variantId: string
  readonly group: string
  readonly name: string
  readonly workspace: string
  readonly clockStart: string
  readonly finalClock: string
  /** 每步实际使用的时间机制（at / advance / none），用于旧/新时轴核对。 */
  readonly timeTrace: readonly { readonly index: number; readonly kind: string; readonly mode: string; readonly at: string }[]
  readonly steps: readonly StepRecord[]
  readonly observations: readonly {
    readonly afterStep: number
    readonly at: string
    readonly status: TaskStatus
    readonly stage: TaskStage
    readonly openAttentionId: string | null
    readonly notifications: number
  }[]
  readonly proposals: readonly {
    readonly decisionId: string
    readonly at: string
    readonly step: number
    readonly kind: string
    readonly decisionKey: string
    readonly reasonCode: string
    readonly taskRevision: number
    readonly outcome: string
  }[]
  readonly attentions: readonly {
    readonly attentionId: string
    readonly decisionKey: string
    readonly reasonCode: string | null
    readonly question: string
    readonly taskRevision: number
    readonly createdAt: string
    readonly deadline: string | null
    readonly state: string
    readonly answeredAt: string | null
    readonly answerOption: string | null
    readonly notifiedAt: string | null
    readonly deliveredAt: string | null
    readonly presentedAt: string | null
  }[]
  readonly notifications: readonly {
    readonly at: string
    readonly attentionId: string | null
    readonly text: string
    readonly state: string
    readonly deliveredAt: string | null
    readonly presentedAt: string | null
  }[]
  readonly receipts: readonly {
    readonly receiptId: string
    readonly tool: string
    readonly ok: boolean
    readonly outputPath: string | null
    readonly outputSha256: string | null
    readonly bytesRead: number
    readonly bytesWritten: number
    readonly taskRevision: number
  }[]
  readonly effects: readonly {
    readonly effectId: string
    readonly kind: string
    readonly tool: string | null
    readonly state: string
    readonly taskRevision: number
  }[]
  readonly driverLog: readonly { readonly at: string; readonly phase: string; readonly detail: string }[]
  readonly asks: readonly {
    readonly decisionKey: string
    readonly reasonCode: string
    readonly at: string
    readonly outcome: string
  }[]
  readonly final: {
    readonly status: TaskStatus
    readonly stage: TaskStage
    readonly taskRevision: number
    readonly completed: boolean
    readonly validCompletion: boolean
    readonly completion: unknown
    readonly completionCheck: unknown
    readonly diagnostics: readonly string[]
    readonly eventCursor: number
    readonly memoryCursor: number
    readonly upstreamOutcome: string | null
  }
  readonly metrics: {
    readonly completed: boolean
    readonly validCompletion: boolean
    readonly notifications: number
    readonly notificationsDelivered: number
    readonly notificationsPresented: number
    readonly asks: number
    readonly askedKinds: readonly string[]
    readonly answeredAttentions: number
    /** 已回答但没有任何送达/呈现回执的 attention 数；正式运行必须为 0。 */
    readonly answeredWithoutVisibility: number
    readonly hiddenAnswersBlocked: number
    readonly unansweredNotifications: number
    readonly supersededNotifications: number
    readonly uselessNotifications: number
    readonly quotaBlocks: number
    readonly hardQuotaViolations: number
    readonly staleAnswers: number
    readonly staleBlocks: number
    readonly staleProposals: number
    readonly corrections: number
    readonly proposeCalls: number
    readonly receipts: number
    readonly ioBytesRead: number
    readonly ioBytesWritten: number
    readonly duplicateEffects: number
    readonly firstAskLatencyMs: number | null
  }
}

export function loadTrajectories(): Trajectory[] {
  const dir = FIXTURES_DIR
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Trajectory)
}

/** 固定用户行为规则：所有策略一致，不对 P3 特别有利。 */
export function chooseOption(attention: AttentionView): string {
  const ids = attention.options.map((option) => option.id)
  for (const id of ['analyze_failing', 'retry_analysis', 'keep_current', 'continue_waiting', 'accept_current']) {
    if (ids.includes(id)) return id
  }
  return ids[0] ?? ''
}

function variantsOf(trajectory: Trajectory): TrajectoryVariant[] {
  if (trajectory.variants?.length) return [...trajectory.variants]
  return [{ id: 'a', steps: trajectory.steps ?? [] }]
}

export function runPolicyOverTrajectory(
  policy: PolicyId,
  trajectory: Trajectory,
  variant: TrajectoryVariant,
): RawRun {
  const runId = `${policy}-${trajectory.id}-${variant.id}`
  const workspace = resolve(EXPERIMENT_ROOT, 'out', 'eval', 'work', runId)
  rmSync(workspace, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })
  const dbPath = join(workspace, 'state', 'followup.sqlite')
  const quiet: QuietConfig = {
    ...(trajectory.quiet ?? FROZEN_CONFIG.quiet),
    timezone: normalizeTimeZone(trajectory.quiet?.timezone ?? trajectory.timezone ?? FROZEN_CONFIG.quiet.timezone),
  }
  const clock = new FakeClock(trajectory.clockStart)
  let proposeCalls = 0
  const onPropose = (): void => {
    proposeCalls += 1
  }
  let built: BuiltRuntime = buildRuntime({ workspaceRoot: workspace, policy, dbPath, clock, quiet, onPropose })
  let ticketId: string | null = null
  let lastSeed: SeedInput | null = null
  let firstAttentionId: string | null = null
  let firstResultAt: string | null = null
  const steps: StepRecord[] = []
  const observations: RawRun['observations'][number][] = []
  const ingestLog: string[] = []

  const observeCurrent = (experimentId: string): void => {
    if (!ticketId) return
    const dir = join(workspace, 'inbox', experimentId)
    const path = join(dir, 'result.json')
    if (!existsSync(path)) {
      ingestLog.push(`missing ${path}`)
      return
    }
    const finding = readResultFile({ root: workspace, path, observedAt: clock.now() })
    if (finding.status !== 'observed' || !finding.observed) {
      ingestLog.push(`${finding.status}:${finding.detail}`)
      return
    }
    const outcome = built.runtime.observe({ ticketId, observed: finding.observed })
    ingestLog.push(`${outcome.disposition}:${outcome.detail}`)
  }

  const goalCondition: GoalCondition = {
    requireResultArtifact: true,
    requireAnalysisArtifact: trajectory.goal?.requireAnalysis !== false,
    requireReceipt: true,
    insufficientStatuses: ['failed', 'partial'],
  }

  const counts = {
    proposed: 0,
    notified: 0,
    effects: 0,
    receipts: 0,
  }
  const note = (label: string): void => {
    ingestLog.push(label)
  }

  let hiddenAnswersBlocked = 0
  const timeTrace: { readonly index: number; readonly kind: string; readonly mode: string; readonly at: string }[] = []
  try {
    for (let index = 0; index < variant.steps.length; index += 1) {
      const step = variant.steps[index]!
      // 每步只允许绝对 at 或相对 advance 之一；同时给两者直接失败并保留原始步骤。
      const absolute = typeof step.at === 'string' && step.at.length > 0
      const relative = step.kind === 'tick' && typeof step.minutes === 'number'
      if (absolute && relative) {
        throw new Error(
          `time_conflict: step ${index} (${step.kind}) has both at=${String(step.at)} and minutes=${String(step.minutes)}`,
        )
      }
      if (step.kind === 'tick' && !relative && !absolute) {
        throw new Error(`time_missing: tick step ${index} needs at or minutes`)
      }
      if (relative) clock.advance(Number(step.minutes) * 60_000)
      if (absolute) clock.set(String(step.at))
      const at = clock.now()
      timeTrace.push({ index, kind: step.kind, mode: relative ? 'advance' : absolute ? 'at' : 'none', at })
      let detail = 'noop'
      switch (step.kind) {
        case 'delegate': {
          const result = built.runtime.delegate({
            title: String(step.title ?? trajectory.name),
            goal: String(step.goal ?? trajectory.name),
            goalCondition,
            sourceId: `fixture-${trajectory.id}-${variant.id}-delegate`,
            at,
          })
          ticketId = result.ticketId
          detail = `delegated ${ticketId}`
          break
        }
        case 'artifact': {
          if (!ticketId) throw new Error('artifact before delegate')
          firstResultAt ??= at
          const seed: SeedInput = {
            workspace,
            experimentId: String(step.experimentId ?? 'E17'),
            runId: String(step.runId ?? 'run-01'),
            revision: Number(step.revision ?? 1),
            status: (step.status ?? 'partial') as SeedInput['status'],
            total: Number(step.total ?? 40),
            passed: Number(step.passed ?? 29),
            failed: Number(step.failed ?? 11),
            ...(step.contentSalt ? { contentSalt: String(step.contentSalt) } : {}),
          }
          lastSeed = seed
          seedResult(seed)
          observeCurrent(seed.experimentId)
          detail = `artifact ${seed.runId} r${seed.revision}${step.contentSalt ? ' conflict' : ''}`
          break
        }
        case 'rescan': {
          observeCurrent(lastSeed?.experimentId ?? 'E17')
          detail = 'rescan inbox'
          break
        }
        case 'unrelated': {
          const exp = String(step.experimentId ?? 'E18')
          seedResult({
            workspace,
            experimentId: exp,
            runId: 'run-other',
            revision: 1,
            status: 'partial',
            total: 10,
            passed: 5,
            failed: 5,
          })
          note(`wrote ${exp} but did not scan it`)
          detail = `unrelated ${exp}`
          break
        }
        case 'deleteResult': {
          if (lastSeed) rmSync(join(workspace, 'inbox', lastSeed.experimentId, 'result.json'), { force: true })
          detail = 'result.json deleted before analysis'
          break
        }
        case 'restoreResult': {
          if (lastSeed) {
            seedResult(lastSeed)
            detail = 'result.json restored'
          }
          break
        }
        case 'panel': {
          if (!ticketId) throw new Error('panel before delegate')
          const presented = built.runtime.present(ticketId, at)
          detail = `panel presented ${presented.presented.length} question(s)`
          note(detail)
          break
        }
        case 'answer': {
          if (!ticketId) throw new Error('answer before delegate')
          const open = built.attention.listOpen(ticketId)[0]
          const requested = String(step.option ?? 'auto')
          const attention = requested === 'stale' ? firstAttentionId : open?.attentionId
          if (!attention) {
            detail = 'no open attention to answer'
            note(detail)
            break
          }
          // 固定用户行为规则（四策略共享）：没送达/没呈现的问题，用户看不到，也就不回答。
          const visibility = built.runtime.attentionVisibility(attention)
          if (!visibility.visible) {
            hiddenAnswersBlocked += 1
            detail = `user_did_not_see_question (${visibility.queuedAt ? 'queued_only' : 'never_notified'})`
            note(detail)
            break
          }
          const target = built.attention.get(attention)
          const optionId = requested === 'auto' || requested === 'stale' ? chooseOption(target ?? open!) : requested
          const result = built.runtime.answer({ attentionId: attention, taskRevision: built.runtime.getTask(ticketId).taskRevision, optionId, at })
          detail = result.ok ? `answered ${optionId}` : `answer rejected ${result.code}`
          note(detail)
          break
        }
        case 'change': {
          if (!ticketId) throw new Error('change before delegate')
          const result = built.runtime.change({ ticketId, goal: String(step.goal ?? 'changed goal'), at })
          detail = `change r${result.taskRevision} ${result.ok}`
          break
        }
        case 'cancel': {
          if (!ticketId) throw new Error('cancel before delegate')
          const result = built.runtime.cancel({ ticketId, reason: String(step.reason ?? 'fixture cancel'), at })
          detail = `cancel ${result.ok}`
          break
        }
        case 'tick': {
          // 时间推进已在上方完成；这里只处理到期工作并写 clock.advanced，避免双推进。
          built.runtime.tick(0)
          detail = relative ? `tick +${String(step.minutes)}m` : `tick to ${at}`
          break
        }
        case 'restart': {
          built.db.close()
          built = buildRuntime({ workspaceRoot: workspace, policy, dbPath, clock, quiet, onPropose })
          const report = built.runtime.recover()
          detail = `restart recovered ${report.tasks} tasks, recon=${report.needsReconciliation.length}`
          break
        }
        case 'fakeCompletion': {
          if (!ticketId) throw new Error('fakeCompletion before delegate')
          const task = built.runtime.getTask(ticketId)
          const payload = {
            completion: true,
            receiptId: 'rcpt-forged',
            artifactSha: 'deadbeef',
            outputPath: 'artifacts/forged.md',
            outputSha256: 'deadbeef',
          }
          const event = {
            schema: 'pet-followup-event/v1' as const,
            eventId: stableId('ev', 'rogue-worker', ticketId, 'forged-completion'),
            sourceId: 'rogue-worker',
            sourceRevision: '1',
            observedAt: at,
            ticketId,
            taskRevision: task.taskRevision,
            kind: 'tool.receipt' as const,
            payload,
            contentSha256: sha256Hex(JSON.stringify(payload)),
          }
          built.db.insertEvent(event, at)
          built.runtime.tick(0)
          detail = 'forged completion event inserted (no receipt row)'
          break
        }
        default:
          throw new Error(`unknown step kind ${step.kind}`)
      }
      // 通道在每一步末尾把 queued 通知送达；四策略共用同一规则。
      built.runtime.deliverPending(clock.now())
      steps.push({ index, kind: step.kind, at, detail })
      const task = ticketId ? built.runtime.getTask(ticketId) : null
      const open = ticketId ? built.attention.listOpen(ticketId)[0] : undefined
      if (open && !firstAttentionId) firstAttentionId = open.attentionId
      observations.push({
        afterStep: index,
        at: clock.now(),
        status: (task?.status ?? 'active') as TaskStatus,
        stage: (task?.stage ?? 'awaiting_result') as TaskStage,
        openAttentionId: open?.attentionId ?? null,
        notifications: ticketId ? built.runtime.notifications(ticketId).length : 0,
      })
    }

    const task = ticketId ? built.runtime.getTask(ticketId) : null
    const ticket = ticketId ? built.runtime.getTicket(ticketId) : undefined
    const proposals = ticketId ? built.db.listProposals(ticketId) : []
    const attentions = ticketId ? built.db.listAttentions(ticketId) : []
    const notifications = ticketId ? built.db.listNotifications(ticketId) : []
    const receipts = ticketId ? built.db.listReceipts(ticketId) : []
    const effects = ticketId ? built.db.listEffects().filter((effect) => effect.ticket_id === ticketId) : []
    const driverLog = ticketId
      ? (built.db.handle
          .prepare('SELECT at, phase, detail_json FROM driver_log WHERE ticket_id = ? ORDER BY id')
          .all(ticketId) as unknown as { at: string; phase: string; detail_json: string }[])
      : []
    const asks = proposals.filter((row) => row.kind === 'ask_user' && row.outcome !== 'invalidated')
    const askedKinds = [...new Set(asks.map((row) => row.reason_code))].sort()
    const reasonByKey = new Map(asks.map((row) => [row.decision_key, row.reason_code]))
    const answered = attentions.filter((row) => row.state === 'answered')
    const attentionState = new Map(attentions.map((row) => [row.attentionId, row.state]))
    const delivered = notifications.filter((row) => row.state === 'delivered' || row.state === 'presented')
    const presentedNotifications = notifications.filter((row) => row.state === 'presented')
    const unanswered = delivered.filter((row) => row.attentionId && attentionState.get(row.attentionId) !== 'answered')
    const superseded = delivered.filter((row) => row.attentionId && attentionState.get(row.attentionId) === 'superseded')
    // “实际无用提醒”的显式定义：已送达、未获回答、且同 decisionKey 在之后又被重新提问
    // （即这条提醒在用户行动前就被替换）。这是代理指标，不等同于“未回答”。
    const useless = superseded.filter((row) => {
      if (!row.attentionId) return false
      const view = attentions.find((item) => item.attentionId === row.attentionId)
      if (!view) return false
      return attentions.some(
        (other) =>
          other.attentionId !== view.attentionId &&
          other.decisionKey === view.decisionKey &&
          Date.parse(other.createdAt) >= Date.parse(view.createdAt),
      )
    })
    const firstNotification = notifications
      .filter((row) => row.attentionId)
      .map((row) => row.createdAt)
      .sort()[0]
    const quotaBuckets = new Map<string, number>()
    for (const row of delivered) {
      const bucket = `${row.ticketId}:${Math.floor(Date.parse(row.createdAt) / 3_600_000)}`
      quotaBuckets.set(bucket, (quotaBuckets.get(bucket) ?? 0) + 1)
    }
    const hardQuotaViolations = [...quotaBuckets.values()].filter((count) => count > quiet.reminderQuotaPerHour).length
    const quotaBlocks = driverLog.filter(
      (row) => row.phase === 'proposal.ask_user' && String(row.detail_json).includes('quota_exceeded'),
    ).length
    const staleAnswers = driverLog.filter((row) => row.phase === 'attention.stale_answer').length
    const staleBlocks = driverLog.filter((row) => row.phase === 'report.blocked' && String(row.detail_json).includes('stale_assignment')).length
    const staleProposals = driverLog.filter(
      (row) =>
        (row.phase === 'proposal.rejected' || row.phase === 'proposal.rejected_before_execute' || row.phase === 'proposal.notify_blocked') &&
        String(row.detail_json).includes('stale_'),
    ).length
    const corrections = steps.filter((row) => row.kind === 'change' && row.detail.includes('true')).length
    const toolEffects = effects.filter((effect) => effect.kind === 'tool')
    const duplicateEffects = toolEffects.length - new Set(toolEffects.map((effect) => `${effect.tool}:${effect.task_revision}`)).size
    const ioRead = receipts.reduce((sum, receipt) => sum + receipt.bytesRead, 0)
    const ioWritten = receipts.reduce((sum, receipt) => sum + receipt.bytesWritten, 0)
    const check = task ? built.runtime.completionCheck(task) : null
    const validCompletion = Boolean(task?.status === 'completed' && check?.ok)

    return {
      schema: 'pet-followup-raw/v1',
      policy,
      policyConfigSha: built.decision.configSha,
      configSha: built.configSha,
      quiet,
      timezone: quiet.timezone,
      trajectoryId: trajectory.id,
      variantId: variant.id,
      group: trajectory.group,
      name: trajectory.name,
      workspace,
      clockStart: trajectory.clockStart,
      finalClock: clock.now(),
      timeTrace,
      steps,
      observations,
      proposals: proposals.map((row) => ({
        decisionId: row.decision_id,
        at: row.created_at,
        step: observations.filter((observation) => observation.at <= row.created_at).length - 1,
        kind: row.kind,
        decisionKey: row.decision_key,
        reasonCode: row.reason_code,
        taskRevision: row.task_revision,
        outcome: row.outcome,
      })),
      attentions: attentions.map((row) => ({
        attentionId: row.attentionId,
        decisionKey: row.decisionKey,
        reasonCode: reasonByKey.get(row.decisionKey) ?? null,
        question: row.question,
        taskRevision: row.taskRevision,
        createdAt: row.createdAt,
        deadline: row.deadline ?? null,
        state: row.state,
        answeredAt: row.answeredAt ?? null,
        answerOption: row.answer?.optionId ?? null,
        notifiedAt: row.notifiedAt ?? null,
        deliveredAt: row.deliveredAt ?? null,
        presentedAt: row.presentedAt ?? null,
      })),
      notifications: notifications.map((row) => ({
        at: row.createdAt,
        attentionId: row.attentionId ?? null,
        text: row.text,
        state: row.state,
        deliveredAt: row.deliveredAt ?? null,
        presentedAt: row.presentedAt ?? null,
      })),
      receipts: receipts.map((receipt) => ({
        receiptId: receipt.receiptId,
        tool: receipt.tool,
        ok: receipt.ok,
        outputPath: receipt.outputPath,
        outputSha256: receipt.outputSha256,
        bytesRead: receipt.bytesRead,
        bytesWritten: receipt.bytesWritten,
        taskRevision: receipt.taskRevision,
      })),
      effects: effects.map((effect) => ({
        effectId: effect.effect_id,
        kind: effect.kind,
        tool: effect.tool,
        state: effect.state,
        taskRevision: effect.task_revision,
      })),
      asks: asks.map((row) => ({
        decisionKey: row.decision_key,
        reasonCode: row.reason_code,
        at: row.created_at,
        outcome: row.outcome,
      })),
      driverLog: driverLog.map((row) => ({ at: row.at, phase: row.phase, detail: row.detail_json })),
      final: {
        status: task?.status ?? 'active',
        stage: task?.stage ?? 'awaiting_result',
        taskRevision: task?.taskRevision ?? 0,
        completed: task?.status === 'completed',
        validCompletion,
        completion: task?.completion ?? null,
        completionCheck: check,
        diagnostics: task?.diagnostics ?? [],
        eventCursor: task?.eventCursor ?? 0,
        memoryCursor: task?.memoryCursor ?? 0,
        upstreamOutcome: ticket?.ended?.outcome ?? null,
      },
      metrics: {
        completed: task?.status === 'completed',
        validCompletion,
        notifications: notifications.length,
        notificationsDelivered: delivered.length,
        notificationsPresented: presentedNotifications.length,
        asks: asks.length,
        askedKinds,
        answeredAttentions: answered.length,
        answeredWithoutVisibility: answered.filter((row) => !row.deliveredAt && !row.presentedAt).length,
        hiddenAnswersBlocked,
        unansweredNotifications: unanswered.length,
        supersededNotifications: superseded.length,
        uselessNotifications: useless.length,
        quotaBlocks,
        hardQuotaViolations,
        staleAnswers,
        staleBlocks,
        staleProposals,
        corrections,
        proposeCalls,
        receipts: receipts.length,
        ioBytesRead: ioRead,
        ioBytesWritten: ioWritten,
        duplicateEffects,
        firstAskLatencyMs:
          firstResultAt && firstNotification ? Math.max(0, Date.parse(firstNotification) - Date.parse(firstResultAt)) : null,
      },
    }
  } finally {
    try {
      built.db.close()
    } catch {
      // 已关闭
    }
  }
}

export async function runEvaluation(_workspace?: string): Promise<number> {
  const trajectories = loadTrajectories()
  const rawDir = join(EXPERIMENT_ROOT, 'out', 'eval', 'raw')
  rmSync(rawDir, { recursive: true, force: true })
  const policies: PolicyId[] = ['P0', 'P1', 'P2', 'P3']
  let runs = 0
  for (const policy of policies) {
    mkdirSync(join(rawDir, policy), { recursive: true })
    for (const trajectory of trajectories) {
      for (const variant of variantsOf(trajectory)) {
        const raw = runPolicyOverTrajectory(policy, trajectory, variant)
        const file = join(rawDir, policy, `${trajectory.id}-${variant.id}.json`)
        writeJson(file, raw)
        runs += 1
        process.stdout.write(
          `${policy} ${trajectory.id}-${variant.id} completed=${raw.metrics.completed} notifications=${raw.metrics.notifications} asks=${raw.metrics.asks}\n`,
        )
      }
    }
  }
  const summary = scoreAll(rawDir, join(EXPERIMENT_ROOT, 'gold'))
  writeJson(join(EXPERIMENT_ROOT, 'out', 'eval', 'scores', 'summary.json'), summary)
  const ablation = runAblation()
  writeJson(join(EXPERIMENT_ROOT, 'out', 'eval', 'ablation.json'), ablation)
  process.stdout.write(`\nruns=${runs}\n`)
  process.stdout.write(`${JSON.stringify(summary.table, null, 2)}\n`)
  process.stdout.write(`\nablation ${JSON.stringify(ablation.summary)}\n`)
  return 0
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function unusedProposalType(_value: ProposedDecision): void {
  // 保留类型导出，防止 strip-only 误删 import。
}
