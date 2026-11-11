/**
 * 评分器：只读 raw 运行记录与 gold 期望，不 import runner，也不 import 策略。
 *
 * 输出是原始计数与分母，不是加权总分：完成数/机会数、必要决策漏报、
 * 无用/重复提醒、过期行动、首次需要选择到提问的延迟、调用数与 I/O 字节。
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

interface RawLike {
  readonly policy: PolicyId
  readonly trajectoryId: string
  readonly variantId: string
  readonly group: string
  readonly metrics: {
    readonly completed: boolean
    readonly notifications: number
    readonly asks: number
    readonly askedKinds: readonly string[]
    readonly wastedNotifications: number
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
  readonly final: { readonly status: string }
}

export interface PolicyScore {
  readonly policy: PolicyId
  readonly opportunities: number
  readonly completions: number
  readonly mustComplete: number
  readonly completionSatisfied: number
  readonly requiredDecisions: number
  readonly requiredCovered: number
  readonly missed: number
  readonly missedDetail: readonly { readonly run: string; readonly kind: string }[]
  readonly notifications: number
  readonly wastedNotifications: number
  readonly overBudgetRuns: number
  readonly staleAnswers: number
  readonly staleProposals: number
  readonly staleBlocks: number
  readonly corrections: number
  readonly proposeCalls: number
  readonly ioBytesRead: number
  readonly ioBytesWritten: number
  readonly duplicateEffects: number
  readonly latencyMedianMs: number | null
}

export interface ScoreSummary {
  readonly schema: 'pet-followup-scores/v1'
  readonly generatedAt: string
  readonly policies: Readonly<Record<string, PolicyScore>>
  readonly table: readonly (PolicyScore & { readonly policy: PolicyId })[]
  readonly comparison: {
    readonly p3VsP2: {
      readonly completionDelta: number
      readonly missedDelta: number
      readonly notificationsDelta: number
      readonly p3MeetsP2CompletionAndMiss: boolean
      readonly note: string
    }
  }
}

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
      runs.push({ raw, ...(gold[raw.trajectoryId]?.variants[raw.variantId] ? { gold: gold[raw.trajectoryId]!.variants[raw.variantId]! } : {}) })
    }
  }
  const policies: Record<string, PolicyScore> = {}
  for (const policy of POLICY_IDS) {
    policies[policy] = scorePolicy(policy, runs.filter((run) => run.raw.policy === policy))
  }
  const p2 = policies.P2!
  const p3 = policies.P3!
  const summary: ScoreSummary = {
    schema: 'pet-followup-scores/v1',
    generatedAt: new Date().toISOString(),
    policies,
    table: POLICY_IDS.map((policy) => policies[policy]!),
    comparison: {
      p3VsP2: {
        completionDelta: p3.completions - p2.completions,
        missedDelta: p3.missed - p2.missed,
        notificationsDelta: p3.notifications - p2.notifications,
        p3MeetsP2CompletionAndMiss: p3.completions >= p2.completions && p3.missed <= p2.missed,
        note: '只报原始差值；是否支持 H2 由报告按这些计数判断，不在这里改口径。',
      },
    },
  }
  return summary
}

function scorePolicy(policy: PolicyId, runs: readonly { raw: RawLike; gold?: GoldVariant }[]): PolicyScore {
  const missedDetail: { run: string; kind: string }[] = []
  let completions = 0
  let mustComplete = 0
  let completionSatisfied = 0
  let requiredTotal = 0
  let requiredCovered = 0
  let notifications = 0
  let wasted = 0
  let overBudget = 0
  let staleAnswers = 0
  let staleProposals = 0
  let staleBlocks = 0
  let corrections = 0
  let proposeCalls = 0
  let ioRead = 0
  let ioWritten = 0
  let duplicateEffects = 0
  const latencies: number[] = []
  for (const run of runs) {
    const raw = run.raw
    if (raw.metrics.completed) completions += 1
    notifications += raw.metrics.notifications
    wasted += raw.metrics.wastedNotifications
    staleAnswers += raw.metrics.staleAnswers
    staleProposals += raw.metrics.staleProposals
    staleBlocks += raw.metrics.staleBlocks
    corrections += raw.metrics.corrections
    proposeCalls += raw.metrics.proposeCalls
    ioRead += raw.metrics.ioBytesRead
    ioWritten += raw.metrics.ioBytesWritten
    duplicateEffects += raw.metrics.duplicateEffects
    if (raw.metrics.firstAskLatencyMs !== null) latencies.push(raw.metrics.firstAskLatencyMs)
    if (!run.gold) continue
    if (run.gold.mustComplete) mustComplete += 1
    if (raw.metrics.completed === run.gold.mustComplete) completionSatisfied += 1
    if (raw.metrics.notifications > run.gold.maxNotifications) overBudget += 1
    for (const kind of run.gold.requiredDecisions) {
      requiredTotal += 1
      if (raw.metrics.askedKinds.includes(kind)) {
        requiredCovered += 1
      } else {
        missedDetail.push({ run: `${raw.trajectoryId}-${raw.variantId}`, kind })
      }
    }
  }
  return {
    policy,
    opportunities: runs.length,
    completions,
    mustComplete,
    completionSatisfied,
    requiredDecisions: requiredTotal,
    requiredCovered,
    missed: requiredTotal - requiredCovered,
    missedDetail,
    notifications,
    wastedNotifications: wasted,
    overBudgetRuns: overBudget,
    staleAnswers,
    staleProposals,
    staleBlocks,
    corrections,
    proposeCalls,
    ioBytesRead: ioRead,
    ioBytesWritten: ioWritten,
    duplicateEffects,
    latencyMedianMs: median(latencies),
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
