/**
 * 独立重评：只读 raw 运行记录（事件步骤、提案、注意力、通知、回执、driver log），
 * 用不依赖 runner/score 的另一套实现重算指标，并与记录的 metrics 逐项比对。
 *
 * R4.1 新增口径：有效完成、必需问题三段（产生/可见/回答）、通知可见性状态、
 * 实际无用提醒定义、运行时硬额度。任一字段无法独立重算就报失配，不给“看起来对”的便利。
 *
 * @module pet-next/experiments/task-followup/eval/reveal
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

interface Raw {
  readonly policy: string
  readonly trajectoryId: string
  readonly variantId: string
  readonly quiet?: { readonly reminderQuotaPerHour?: number }
  readonly steps: readonly { readonly kind: string; readonly at: string; readonly detail?: string }[]
  readonly proposals: readonly { readonly kind: string; readonly outcome: string; readonly reasonCode: string; readonly decisionKey: string }[]
  readonly asks?: readonly { readonly decisionKey: string; readonly reasonCode: string; readonly outcome: string }[]
  readonly attentions: readonly {
    readonly attentionId: string
    readonly decisionKey: string
    readonly state: string
    readonly createdAt: string
    readonly deliveredAt: string | null
    readonly presentedAt: string | null
  }[]
  readonly notifications: readonly {
    readonly at: string
    readonly attentionId: string | null
    readonly state: string
    readonly deliveredAt: string | null
  }[]
  readonly receipts: readonly { readonly tool: string; readonly ok: boolean; readonly bytesRead: number; readonly bytesWritten: number }[]
  readonly effects: readonly { readonly kind: string; readonly tool: string | null; readonly taskRevision: number }[]
  readonly driverLog: readonly { readonly phase: string; readonly detail?: string }[]
  readonly final: {
    readonly status: string
    readonly upstreamOutcome: string | null
    readonly completion: unknown
    readonly completionCheck?: { readonly ok?: boolean } | null
  }
  readonly metrics: Record<string, unknown>
}

export interface Revealed {
  readonly run: string
  readonly computed: Record<string, number | boolean | string | null>
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly recorded: unknown; readonly recomputed: unknown }[]
}

export function reveal(raw: Raw): Revealed {
  const asks = raw.asks ?? raw.proposals.filter((proposal) => proposal.kind === 'ask_user' && proposal.outcome !== 'invalidated')
  const askedKinds = [...new Set(asks.map((proposal) => proposal.reasonCode))].sort()
  const answered = new Set(raw.attentions.filter((attention) => attention.state === 'answered').map((attention) => attention.attentionId))
  const delivered = raw.notifications.filter((item) => item.state === 'delivered' || item.state === 'presented')
  const presented = raw.notifications.filter((item) => item.state === 'presented')
  const stateById = new Map(raw.attentions.map((attention) => [attention.attentionId, attention.state]))
  const unanswered = delivered.filter((item) => item.attentionId && stateById.get(item.attentionId) !== 'answered')
  const superseded = delivered.filter((item) => item.attentionId && stateById.get(item.attentionId) === 'superseded')
  const useless = superseded.filter((item) => {
    if (!item.attentionId) return false
    const view = raw.attentions.find((attention) => attention.attentionId === item.attentionId)
    if (!view) return false
    return raw.attentions.some(
      (other) =>
        other.attentionId !== view.attentionId &&
        other.decisionKey === view.decisionKey &&
        Date.parse(other.createdAt) >= Date.parse(view.createdAt),
    )
  })
  const buckets = new Map<string, number>()
  for (const item of delivered) {
    const key = String(Math.floor(Date.parse(item.at) / 3_600_000))
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  const quota = raw.quiet?.reminderQuotaPerHour ?? 3
  const hardQuotaViolations = [...buckets.values()].filter((count) => count > quota).length
  const toolEffects = raw.effects.filter((effect) => effect.kind === 'tool')
  const duplicateEffects =
    toolEffects.length - new Set(toolEffects.map((effect) => `${effect.tool}:${effect.taskRevision}`)).size
  const firstArtifact = raw.steps.find((step) => step.kind === 'artifact')
  const firstNotification = [...raw.notifications].map((notification) => notification.at).sort()[0]
  const latencyMs =
    firstArtifact && firstNotification ? Math.max(0, Date.parse(firstNotification) - Date.parse(firstArtifact.at)) : null
  const checkOk = raw.final.completionCheck?.ok === true
  const validCompletion = raw.final.status === 'completed' && checkOk
  const hiddenAnswersBlocked = raw.steps.filter(
    (step) => step.kind === 'answer' && String(step.detail ?? '').startsWith('user_did_not_see_question'),
  ).length
  const computed: Record<string, number | boolean | string | null> = {
    completed: raw.final.status === 'completed',
    validCompletion,
    notifications: raw.notifications.length,
    notificationsDelivered: delivered.length,
    notificationsPresented: presented.length,
    asks: asks.length,
    askedKinds: askedKinds.join(','),
    answeredAttentions: answered.size,
    answeredWithoutVisibility: raw.attentions.filter((a) => a.state === 'answered' && !a.deliveredAt && !a.presentedAt).length,
    hiddenAnswersBlocked,
    unansweredNotifications: unanswered.length,
    supersededNotifications: superseded.length,
    uselessNotifications: useless.length,
    hardQuotaViolations,
    staleAnswers: raw.driverLog.filter((entry) => entry.phase === 'attention.stale_answer').length,
    staleProposals: raw.driverLog.filter((entry) => entry.phase.startsWith('proposal.rejected') || entry.phase === 'proposal.notify_blocked').length,
    ioBytesRead: raw.receipts.reduce((sum, receipt) => sum + receipt.bytesRead, 0),
    ioBytesWritten: raw.receipts.reduce((sum, receipt) => sum + receipt.bytesWritten, 0),
    duplicateEffects,
    firstAskLatencyMs: latencyMs,
  }
  const checks = [
    check('completed', computed.completed, raw.metrics.completed),
    check('validCompletion', computed.validCompletion, raw.metrics.validCompletion),
    check('notifications', computed.notifications, raw.metrics.notifications),
    check('notificationsDelivered', computed.notificationsDelivered, raw.metrics.notificationsDelivered),
    check('notificationsPresented', computed.notificationsPresented, raw.metrics.notificationsPresented),
    check('asks', computed.asks, raw.metrics.asks),
    check('askedKinds', computed.askedKinds, (raw.metrics.askedKinds as string[]).join(',')),
    check('answeredAttentions', computed.answeredAttentions, raw.metrics.answeredAttentions),
    check('answeredWithoutVisibility', computed.answeredWithoutVisibility, raw.metrics.answeredWithoutVisibility),
    check('hiddenAnswersBlocked', computed.hiddenAnswersBlocked, raw.metrics.hiddenAnswersBlocked),
    check('unansweredNotifications', computed.unansweredNotifications, raw.metrics.unansweredNotifications),
    check('supersededNotifications', computed.supersededNotifications, raw.metrics.supersededNotifications),
    check('uselessNotifications', computed.uselessNotifications, raw.metrics.uselessNotifications),
    check('hardQuotaViolations', computed.hardQuotaViolations, raw.metrics.hardQuotaViolations),
    check('staleAnswers', computed.staleAnswers, raw.metrics.staleAnswers),
    check('ioBytesRead', computed.ioBytesRead, raw.metrics.ioBytesRead),
    check('ioBytesWritten', computed.ioBytesWritten, raw.metrics.ioBytesWritten),
    check('duplicateEffects', computed.duplicateEffects, raw.metrics.duplicateEffects),
    check('firstAskLatencyMs', computed.firstAskLatencyMs, raw.metrics.firstAskLatencyMs),
  ]
  return { run: `${raw.policy}/${raw.trajectoryId}-${raw.variantId}`, computed, checks }
}

function check(name: string, recomputed: unknown, recorded: unknown): { name: string; ok: boolean; recorded: unknown; recomputed: unknown } {
  return { name, ok: JSON.stringify(recomputed) === JSON.stringify(recorded), recorded, recomputed }
}

export function verifyRawDir(rawDir: string): { ok: boolean; files: number; mismatches: readonly { run: string; name: string; recorded: unknown; recomputed: unknown }[] } {
  const mismatches: { run: string; name: string; recorded: unknown; recomputed: unknown }[] = []
  let files = 0
  for (const policy of readdirSync(rawDir)) {
    let names: string[] = []
    try {
      names = readdirSync(join(rawDir, policy)).filter((name) => name.endsWith('.json'))
    } catch {
      continue
    }
    for (const name of names) {
      files += 1
      const raw = JSON.parse(readFileSync(join(rawDir, policy, name), 'utf8')) as Raw
      const revealed = reveal(raw)
      for (const item of revealed.checks) {
        if (!item.ok) mismatches.push({ run: revealed.run, name: item.name, recorded: item.recorded, recomputed: item.recomputed })
      }
    }
  }
  return { ok: mismatches.length === 0, files, mismatches }
}
