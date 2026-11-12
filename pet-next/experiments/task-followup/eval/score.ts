/**
 * 评分器：只读 raw 运行记录与 gold 期望，不 import runner，也不 import 策略。
 *
 * R4.1 口径（与 REVIEW 第五节对应）：
 * - 状态完成（completed）与“输入/回执当前一致的有效完成”（validCompletion）分开报；
 *   只有有效完成进入完成率。
 * - 必需问题分三段：已产生（askedKinds）、已可见（送达或呈现）、已回答。
 *   隐藏问题不算已触达。
 * - 运行时硬提醒额度（reminderQuotaPerHour）与 gold 参考上限（maxNotifications）分开字段。
 * - 未回答 / 被替换通知单列为代理指标；“实际无用提醒”另有显式定义（见 uselessNotifications）。
 *
 * @module pet-next/experiments/task-followup/eval/score
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PolicyId } from '../contracts.ts'
import { POLICY_IDS } from '../contracts.ts'

export interface GoldVariant {
  readonly mustComplete: boolean
  readonly requiredDecisions: readonly string[]
  readonly maxNotifications: number
  readonly expectedStatus: string
}

export interface GoldFile {
  readonly trajectoryId: string
  readonly variants: Readonly<Record<string, GoldVariant>>
}

interface RawAttention {
  readonly attentionId: string
  readonly decisionKey: string
  readonly reasonCode: string | null
  readonly state: string
  readonly createdAt: string
  readonly deliveredAt: string | null
  readonly presentedAt: string | null
}

interface RawLike {
  readonly policy: PolicyId
  readonly trajectoryId: string
  readonly variantId: string
  readonly group: string
  readonly timezone?: string
  readonly attentions: readonly RawAttention[]
  readonly asks: readonly { readonly decisionKey: string; readonly reasonCode: string; readonly outcome: string }[]
  readonly notifications: readonly {
    readonly attentionId: string | null
    readonly state: string
    readonly deliveredAt: string | null
  }[]
  readonly final: { readonly status: string; readonly validCompletion?: boolean }
  readonly metrics: {
    readonly completed: boolean
    readonly validCompletion?: boolean
    readonly notifications: number
    readonly notificationsDelivered?: number
    readonly notificationsPresented?: number
    readonly asks: number
    readonly askedKinds: readonly string[]
    readonly answeredAttentions: number
    readonly answeredWithoutVisibility?: number
    readonly hiddenAnswersBlocked?: number
    readonly unansweredNotifications?: number
    readonly supersededNotifications?: number
    readonly uselessNotifications?: number
    readonly quotaBlocks?: number
    readonly hardQuotaViolations?: number
    readonly deadlineMissed?: boolean
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

export interface PolicyScore {
  readonly policy: PolicyId
  readonly opportunities: number
  /** 状态为 completed 的次数（不等于有效完成）。 */
  readonly completions: number
  /** 当前输入 → 执行输入 → 回执 → 分析逐项一致且完成检查通过的次数。 */
  readonly validCompletions: number
  /** validCompletions / opportunities。 */
  readonly completionRate: number
  readonly mustComplete: number
  readonly completionSatisfied: number
  readonly validCompletionSatisfied: number
  readonly requiredDecisions: number
  readonly requiredProduced: number
  readonly requiredVisible: number
  readonly requiredAnswered: number
  readonly missed: number
  readonly missedDetail: readonly { readonly run: string; readonly kind: string }[]
  readonly hiddenRequired: readonly { readonly run: string; readonly kind: string }[]
  readonly notifications: number
  readonly notificationsDelivered: number
  readonly notificationsPresented: number
  readonly unansweredNotifications: number
  readonly supersededNotifications: number
  readonly uselessNotifications: number
  readonly quotaBlocks: number
  readonly hardQuotaViolations: number
  /** gold 参考上限（maxNotifications）被超过的 run 数；不是运行时硬额度。 */
  readonly goldReferenceOverBudgetRuns: number
  readonly answeredWithoutVisibility: number
  readonly hiddenAnswersBlocked: number
  /** 未完成且必要问题 deadline 已过的 run 数。 */
  readonly unfinishedBeforeDeadline: number
  readonly staleAnswers: number
  readonly staleProposals: number
  readonly staleBlocks: number
  readonly corrections: number
  readonly proposeCalls: number
  readonly ioBytesRead: number
  readonly ioBytesWritten: number
  readonly duplicateEffects: number
  readonly latencyMedianMs: number | null
  readonly timezones: readonly string[]
}

export interface ScoreSummary {
  readonly schema: 'pet-followup-scores/v2'
  readonly generatedAt: string
  readonly metricDefinitions: Readonly<Record<string, string>>
  readonly policies: Readonly<Record<string, PolicyScore>>
  readonly table: readonly (PolicyScore & { readonly policy: PolicyId })[]
  readonly comparison: {
    readonly p3VsP2: {
      readonly validCompletionDelta: number
      readonly missedDelta: number
      readonly notificationsDelta: number
      readonly p3MeetsP2ValidCompletionAndMiss: boolean
      readonly note: string
    }
  }
}

const METRIC_DEFINITIONS = {
  completions: 'final.status === completed 的次数；仅作状态计数。',
  validCompletions: 'completed 且 completionCheck.ok（当前输入与 receipt/analysis 的 inputRef 逐项相等）的次数。',
  completedRate: 'validCompletions / opportunities；只有有效完成进入完成率。',
  requiredProduced: 'gold.requiredDecisions 中，存在未被撤销的 ask_user 提案的项数。',
  requiredVisible: 'requiredProduced 中，对应 attention 有 deliveredAt 或 presentedAt 的项数；隐藏问题不算触达。',
  requiredAnswered: 'requiredVisible 中，对应 attention 状态为 answered 的项数。',
  answeredWithoutVisibility: '已回答但无送达/呈现回执的 attention 数；正式运行必须为 0。',
  unfinishedBeforeDeadline: '最终未完成、且至少一个问题的 deadline 已过的 run 数。',
  notificationChannel: '评估中的 delivered 由本地 fake channel 在每步末尾自动送达，属模拟通道，不代表真实系统通知。',
  unansweredNotifications: '已送达但对应 attention 未被回答的通知数（代理指标，不等于无用打扰）。',
  supersededNotifications: '已送达但对应 attention 被替换的通知数（代理指标）。',
  uselessNotifications:
    '实际无用提醒：已送达、未回答、且同 decisionKey 在之后被重新提问（在用户行动前就被替换）。标签依据仅为 raw 里的通知状态与 attention 时序。',
  hardQuotaViolations: '同一 ticket 任一滚动整点桶内已送达通知数超过 reminderQuotaPerHour 的桶数。',
  goldReferenceOverBudgetRuns: 'notifications 超过 gold.maxNotifications 的 run 数；这是参考上限，不是运行时硬额度。',
} as const

export function scoreAll(rawDir: string, goldDir: string): ScoreSummary {
  const gold = loadGold(goldDir)
  const runs: { raw: RawLike; gold?: GoldVariant }[] = []
  for (const policy of POLICY_IDS) {
    let files: string[]
    try {
      files = readdirSync(join(rawDir, policy)).filter((name) => name.endsWith('.json')).sort()
    } catch {
      continue
    }
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(rawDir, policy, file), 'utf8')) as RawLike
      runs.push({
        raw,
        ...(gold[raw.trajectoryId]?.variants[raw.variantId] ? { gold: gold[raw.trajectoryId]!.variants[raw.variantId]! } : {}),
      })
    }
  }
  const policies: Record<string, PolicyScore> = {}
  for (const policy of POLICY_IDS) {
    policies[policy] = scorePolicy(policy, runs.filter((run) => run.raw.policy === policy))
  }
  const p2 = policies.P2!
  const p3 = policies.P3!
  const summary: ScoreSummary = {
    schema: 'pet-followup-scores/v2',
    generatedAt: new Date().toISOString(),
    metricDefinitions: METRIC_DEFINITIONS,
    policies,
    table: POLICY_IDS.map((policy) => policies[policy]!),
    comparison: {
      p3VsP2: {
        validCompletionDelta: p3.validCompletions - p2.validCompletions,
        missedDelta: p3.missed - p2.missed,
        notificationsDelta: p3.notifications - p2.notifications,
        p3MeetsP2ValidCompletionAndMiss: p3.validCompletions >= p2.validCompletions && p3.missed <= p2.missed,
        note: '只报原始差值；是否支持 H2 由报告按这些计数判断，不在这里改口径。',
      },
    },
  }
  return summary
}

function scorePolicy(policy: PolicyId, runs: readonly { raw: RawLike; gold?: GoldVariant }[]): PolicyScore {
  const missedDetail: { run: string; kind: string }[] = []
  const hiddenRequired: { run: string; kind: string }[] = []
  let completions = 0
  let validCompletions = 0
  let mustComplete = 0
  let completionSatisfied = 0
  let validCompletionSatisfied = 0
  let requiredTotal = 0
  let requiredProduced = 0
  let requiredVisible = 0
  let requiredAnswered = 0
  let notifications = 0
  let notificationsDelivered = 0
  let notificationsPresented = 0
  let unansweredNotifications = 0
  let supersededNotifications = 0
  let uselessNotifications = 0
  let quotaBlocks = 0
  let hardQuotaViolations = 0
  let overBudget = 0
  let answeredWithoutVisibility = 0
  let hiddenAnswersBlocked = 0
  let unfinishedBeforeDeadline = 0
  let staleAnswers = 0
  let staleProposals = 0
  let staleBlocks = 0
  let corrections = 0
  let proposeCalls = 0
  let ioRead = 0
  let ioWritten = 0
  let duplicateEffects = 0
  const latencies: number[] = []
  const timezones = new Set<string>()
  for (const run of runs) {
    const raw = run.raw
    const valid = raw.final.validCompletion ?? raw.metrics.validCompletion ?? false
    if (raw.metrics.completed) completions += 1
    if (valid) validCompletions += 1
    notifications += raw.metrics.notifications
    notificationsDelivered += raw.metrics.notificationsDelivered ?? 0
    notificationsPresented += raw.metrics.notificationsPresented ?? 0
    unansweredNotifications += raw.metrics.unansweredNotifications ?? 0
    supersededNotifications += raw.metrics.supersededNotifications ?? 0
    uselessNotifications += raw.metrics.uselessNotifications ?? 0
    quotaBlocks += raw.metrics.quotaBlocks ?? 0
    hardQuotaViolations += raw.metrics.hardQuotaViolations ?? 0
    answeredWithoutVisibility += raw.metrics.answeredWithoutVisibility ?? 0
    hiddenAnswersBlocked += raw.metrics.hiddenAnswersBlocked ?? 0
    if (raw.metrics.deadlineMissed) unfinishedBeforeDeadline += 1
    staleAnswers += raw.metrics.staleAnswers
    staleProposals += raw.metrics.staleProposals
    staleBlocks += raw.metrics.staleBlocks
    corrections += raw.metrics.corrections
    proposeCalls += raw.metrics.proposeCalls
    ioRead += raw.metrics.ioBytesRead
    ioWritten += raw.metrics.ioBytesWritten
    duplicateEffects += raw.metrics.duplicateEffects
    if (raw.timezone) timezones.add(raw.timezone)
    if (raw.metrics.firstAskLatencyMs !== null) latencies.push(raw.metrics.firstAskLatencyMs)
    if (!run.gold) continue
    if (run.gold.mustComplete) mustComplete += 1
    if (raw.metrics.completed === run.gold.mustComplete) completionSatisfied += 1
    if (valid === run.gold.mustComplete) validCompletionSatisfied += 1
    if (raw.metrics.notifications > run.gold.maxNotifications) overBudget += 1
    for (const kind of run.gold.requiredDecisions) {
      requiredTotal += 1
      const runLabel = `${raw.trajectoryId}-${raw.variantId}`
      const ask = raw.asks.find((item) => item.reasonCode === kind && item.outcome !== 'invalidated')
      const attention = ask ? raw.attentions.find((item) => item.decisionKey === ask.decisionKey) : undefined
      const visible = Boolean(attention?.deliveredAt || attention?.presentedAt)
      const answered = attention?.state === 'answered'
      if (!ask) {
        missedDetail.push({ run: runLabel, kind })
        continue
      }
      requiredProduced += 1
      if (!visible) {
        hiddenRequired.push({ run: runLabel, kind })
        continue
      }
      requiredVisible += 1
      if (answered) requiredAnswered += 1
    }
  }
  return {
    policy,
    opportunities: runs.length,
    completions,
    validCompletions,
    completionRate: runs.length ? validCompletions / runs.length : 0,
    mustComplete,
    completionSatisfied,
    validCompletionSatisfied,
    requiredDecisions: requiredTotal,
    requiredProduced,
    requiredVisible,
    requiredAnswered,
    missed: requiredTotal - requiredProduced,
    missedDetail,
    hiddenRequired,
    notifications,
    notificationsDelivered,
    notificationsPresented,
    unansweredNotifications,
    supersededNotifications,
    uselessNotifications,
    quotaBlocks,
    hardQuotaViolations,
    goldReferenceOverBudgetRuns: overBudget,
    answeredWithoutVisibility,
    hiddenAnswersBlocked,
    unfinishedBeforeDeadline,
    staleAnswers,
    staleProposals,
    staleBlocks,
    corrections,
    proposeCalls,
    ioBytesRead: ioRead,
    ioBytesWritten: ioWritten,
    duplicateEffects,
    latencyMedianMs: median(latencies),
    timezones: [...timezones].sort(),
  }
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!
}

export function loadGold(goldDir: string): Record<string, GoldFile> {
  const out: Record<string, GoldFile> = {}
  for (const name of readdirSync(goldDir).filter((file) => file.endsWith('.json')).sort()) {
    const file = JSON.parse(readFileSync(join(goldDir, name), 'utf8')) as GoldFile
    out[file.trajectoryId] = file
  }
  return out
}

export function writeScore(summary: ScoreSummary, path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`)
}
