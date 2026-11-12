/**
 * R5 独立评分：只看 raw 列表 + gold 的窗口，不导入 R4 评分，也不把 raw.metrics 当真值。
 *
 * 口径：
 * - produced：按 kind 找到当前有效 ask（身份字段必须齐全，缺失 fail closed）；
 * - visible：与 ask 的 decisionId 精确连接的 attention，送达/呈现时间落在 [earliest, latest]；
 * - answered：visible 且 state=answered 且 option 等于 gold.action；
 * - overdue：送达晚于 latest；
 * - pending：已产生但未可见，且最终时钟仍在 latest 之前（censored，不算成功也不算漏办）；
 * - missed：未产生（或身份不可证实）。
 *
 * @module pet-next/experiments/task-followup/eval/r5/score
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface R5GoldRequirement {
  readonly kind: string
  readonly earliest: string
  readonly latest: string
  readonly action: string
}

export interface R5Gold {
  readonly trajectoryId: string
  readonly family: string
  readonly split: string
  readonly mustComplete: boolean
  readonly expectedStatus: string
  readonly maxNotifications: number
  readonly required: readonly R5GoldRequirement[]
}

interface Ask {
  readonly decisionId: string
  readonly decisionKey: string
  readonly reasonCode: string
  readonly ticketId: string
  readonly taskRevision: number
  readonly assignmentId: string
  readonly at: string
  readonly outcome: string
}

interface Attention {
  readonly attentionId: string
  readonly decisionId: string
  readonly decisionKey: string
  readonly ticketId: string
  readonly taskRevision: number
  readonly assignmentId: string
  readonly state: string
  readonly createdAt: string
  readonly deadline: string | null
  readonly deliveredAt: string | null
  readonly presentedAt: string | null
  readonly answeredAt: string | null
  readonly answerOption: string | null
}

interface Notification {
  readonly notificationId: string
  readonly attentionId: string | null
  readonly createdAt: string
  readonly deliveredAt: string | null
  readonly presentedAt: string | null
}

export interface R5RawLike {
  readonly schema: string
  readonly policy: string
  readonly trajectoryId: string
  readonly family: string
  readonly split: string
  readonly clockStart: string
  readonly finalClock: string
  readonly timezone: string
  readonly configSha: string
  readonly steps: readonly { readonly kind: string; readonly at: string; readonly detail: string }[]
  readonly asks: readonly Ask[]
  readonly attentions: readonly Attention[]
  readonly notifications: readonly Notification[]
  readonly wakes: readonly { readonly at: string; readonly jobId: string; readonly action: string; readonly detail: string }[]
  readonly receipts: readonly { readonly receiptId: string; readonly effectId: string; readonly tool: string }[]
  readonly final: {
    readonly status: string
    readonly stage: string
    readonly completed: boolean
    readonly validCompletion: boolean
    readonly completionCheck: { readonly ok: boolean; readonly reasons: readonly string[] } | null
  }
}

export interface R5RequirementResult {
  readonly kind: string
  readonly produced: boolean
  readonly visible: boolean
  readonly answered: boolean
  readonly actionOk: boolean
  readonly overdue: boolean
  readonly pending: boolean
  readonly missed: boolean
  readonly reason: string
  readonly attentionId: string | null
  readonly deliveredAt: string | null
}

export interface R5RunScore {
  readonly policy: string
  readonly trajectoryId: string
  readonly family: string
  readonly split: string
  readonly mustComplete: boolean
  readonly completed: boolean
  readonly validCompletion: boolean
  readonly notifications: number
  readonly delivered: number
  readonly presented: number
  readonly duplicateNotifications: number
  readonly staleNotifications: number
  readonly notificationsAfterCancel: number
  readonly overBudget: boolean
  readonly wakes: number
  readonly wakeFired: number
  readonly wakeStale: number
  readonly requirements: readonly R5RequirementResult[]
  readonly produced: number
  readonly visible: number
  readonly answered: number
  readonly actionOk: number
  readonly overdue: number
  readonly pending: number
  readonly missed: number
}

const isId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const isRevision = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0

function effectiveAsk(raw: R5RawLike, kind: string): Ask | null {
  const asks = raw.asks.filter((item) => item.reasonCode === kind && item.outcome !== 'invalidated')
  if (!asks.length) return null
  return (
    [...asks].sort((a, b) => a.taskRevision - b.taskRevision || a.at.localeCompare(b.at)).at(-1) ?? null
  )
}

function within(iso: string | null, earliest: string, latest: string): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  return t >= Date.parse(earliest) && t <= Date.parse(latest)
}

export function scoreR5Run(raw: R5RawLike, gold: R5Gold): R5RunScore {
  const results: R5RequirementResult[] = gold.required.map((requirement) => {
    const ask = effectiveAsk(raw, requirement.kind)
    if (!ask) {
      return {
        kind: requirement.kind,
        produced: false,
        visible: false,
        answered: false,
        actionOk: false,
        overdue: false,
        pending: false,
        missed: true,
        reason: 'not_proposed',
        attentionId: null,
        deliveredAt: null,
      }
    }
    if (!isId(ask.decisionId) || !isId(ask.ticketId) || !isRevision(ask.taskRevision) || !isId(ask.assignmentId)) {
      return {
        kind: requirement.kind,
        produced: true,
        visible: false,
        answered: false,
        actionOk: false,
        overdue: false,
        pending: false,
        missed: true,
        reason: 'ask_identity_incomplete',
        attentionId: null,
        deliveredAt: null,
      }
    }
    const candidates = raw.attentions.filter((item) => item.decisionId === ask.decisionId)
    if (candidates.length !== 1) {
      return {
        kind: requirement.kind,
        produced: true,
        visible: false,
        answered: false,
        actionOk: false,
        overdue: false,
        pending: false,
        missed: true,
        reason: candidates.length === 0 ? 'attention_missing' : 'attention_ambiguous',
        attentionId: null,
        deliveredAt: null,
      }
    }
    const attention = candidates[0]!
    if (
      attention.taskRevision !== ask.taskRevision ||
      !isId(attention.ticketId) ||
      attention.ticketId !== ask.ticketId ||
      !isId(attention.assignmentId) ||
      attention.assignmentId !== ask.assignmentId
    ) {
      return {
        kind: requirement.kind,
        produced: true,
        visible: false,
        answered: false,
        actionOk: false,
        overdue: false,
        pending: false,
        missed: true,
        reason: 'identity_mismatch',
        attentionId: attention.attentionId,
        deliveredAt: null,
      }
    }
    const seenAt = attention.deliveredAt ?? attention.presentedAt
    const visible = within(seenAt, requirement.earliest, requirement.latest)
    const overdue = seenAt !== null && Date.parse(seenAt) > Date.parse(requirement.latest)
    const pending = !seenAt && Date.parse(raw.finalClock) < Date.parse(requirement.latest)
    const answered = visible && attention.state === 'answered'
    const actionOk = answered && attention.answerOption === requirement.action
    return {
      kind: requirement.kind,
      produced: true,
      visible,
      answered,
      actionOk,
      overdue,
      pending,
      missed: !visible && !pending && !overdue,
      reason: visible ? 'visible' : overdue ? 'overdue' : pending ? 'pending' : 'not_visible',
      attentionId: attention.attentionId,
      deliveredAt: seenAt,
    }
  })

  const notifications = raw.notifications
  const duplicates = notifications.length - new Set(notifications.map((item) => item.attentionId)).size
  const askRevision = new Map(raw.asks.map((ask) => [ask.decisionId, ask.taskRevision]))
  const stale = notifications.filter((item) => {
    const attention = raw.attentions.find((entry) => entry.attentionId === item.attentionId)
    if (!attention) return true
    const revision = askRevision.get(attention.decisionId)
    return revision !== undefined && revision !== attention.taskRevision
  }).length
  const cancelAt = raw.steps.find((step) => step.kind === 'cancel')?.at ?? null
  const afterCancel =
    raw.final.status === 'cancelled'
      ? notifications.filter(
          (item) => Boolean(item.deliveredAt) && cancelAt !== null && item.deliveredAt! > cancelAt,
        ).length
      : 0

  return {
    policy: raw.policy,
    trajectoryId: raw.trajectoryId,
    family: raw.family,
    split: raw.split,
    mustComplete: gold.mustComplete,
    completed: raw.final.completed,
    validCompletion: raw.final.validCompletion,
    notifications: notifications.length,
    delivered: notifications.filter((item) => Boolean(item.deliveredAt)).length,
    presented: notifications.filter((item) => Boolean(item.presentedAt)).length,
    duplicateNotifications: duplicates,
    staleNotifications: stale,
    notificationsAfterCancel: afterCancel,
    overBudget: notifications.length > gold.maxNotifications,
    wakes: raw.wakes.length,
    wakeFired: raw.wakes.filter((item) => item.action === 'woken').length,
    wakeStale: raw.wakes.filter((item) => item.action === 'stale').length,
    requirements: results,
    produced: results.filter((item) => item.produced).length,
    visible: results.filter((item) => item.visible).length,
    answered: results.filter((item) => item.answered).length,
    actionOk: results.filter((item) => item.actionOk).length,
    overdue: results.filter((item) => item.overdue).length,
    pending: results.filter((item) => item.pending).length,
    missed: results.filter((item) => item.missed).length,
  }
}

export interface R5PolicyScore {
  readonly policy: string
  readonly runs: number
  readonly required: number
  readonly produced: number
  readonly visible: number
  readonly answered: number
  readonly actionOk: number
  readonly overdue: number
  readonly pending: number
  readonly missed: number
  readonly validCompletions: number
  readonly mustCompleteSatisfied: number
  readonly notifications: number
  readonly delivered: number
  readonly duplicateNotifications: number
  readonly staleNotifications: number
  readonly notificationsAfterCancel: number
  readonly overBudgetRuns: number
}

export interface R5Summary {
  readonly schema: 'pet-followup-r5-scores/v1'
  readonly generatedAt: string
  readonly note: string
  readonly policies: Record<string, R5PolicyScore>
  readonly table: readonly R5PolicyScore[]
  readonly runs: readonly R5RunScore[]
}

export function loadR5Gold(goldDir: string): Map<string, R5Gold> {
  const map = new Map<string, R5Gold>()
  for (const name of readdirSync(goldDir).filter((item) => item.endsWith('.json'))) {
    const gold = JSON.parse(readFileSync(join(goldDir, name), 'utf8')) as R5Gold
    map.set(gold.trajectoryId, gold)
  }
  return map
}

export function scoreR5(rawDir: string, goldDir: string): R5Summary {
  const gold = loadR5Gold(goldDir)
  const policies: Record<string, R5PolicyScore> = {}
  const all: R5RunScore[] = []
  for (const policy of readdirSync(rawDir).sort()) {
    const runs = readdirSync(join(rawDir, policy))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => {
        const raw = JSON.parse(readFileSync(join(rawDir, policy, name), 'utf8')) as R5RawLike
        const g = gold.get(raw.trajectoryId)
        if (!g) throw new Error(`gold missing for ${raw.trajectoryId}`)
        return scoreR5Run(raw, g)
      })
    all.push(...runs)
    const sum = (pick: (run: R5RunScore) => number): number => runs.reduce((total, run) => total + pick(run), 0)
    policies[policy] = {
      policy,
      runs: runs.length,
      required: sum((run) => run.requirements.length),
      produced: sum((run) => run.produced),
      visible: sum((run) => run.visible),
      answered: sum((run) => run.answered),
      actionOk: sum((run) => run.actionOk),
      overdue: sum((run) => run.overdue),
      pending: sum((run) => run.pending),
      missed: sum((run) => run.missed),
      validCompletions: runs.filter((run) => run.validCompletion && run.mustComplete).length,
      mustCompleteSatisfied: runs.filter((run) => run.mustComplete).length,
      notifications: sum((run) => run.notifications),
      delivered: sum((run) => run.delivered),
      duplicateNotifications: sum((run) => run.duplicateNotifications),
      staleNotifications: sum((run) => run.staleNotifications),
      notificationsAfterCancel: sum((run) => run.notificationsAfterCancel),
      overBudgetRuns: runs.filter((run) => run.overBudget).length,
    }
  }
  return {
    schema: 'pet-followup-r5-scores/v1',
    generatedAt: new Date().toISOString(),
    note: 'R5 12 故事（6 对）与 R4 固定 72 runs 分开；pending 是 censored，不算成功也不算漏办。',
    policies,
    table: Object.values(policies),
    runs: all,
  }
}
