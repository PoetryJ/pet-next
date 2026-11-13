/**
 * 宿主已验证的工具结果直接成为 outcome 条目（authority=tool），不让模型从摘要里复述机器字段。
 * 来源仍是一条逐字原话（tool turn），条目引用整条原话；新结果对同任务旧结果的取代边由系统构建。
 */
import { createHash } from 'node:crypto'
import type { CapabilityMemoryStore } from './store.ts'
import type { MemoryItem, Turn } from './types.ts'

export interface VerifiedOutcome {
  readonly runId: string
  readonly revision: number
  readonly status: string
  readonly metrics: Record<string, unknown>
  readonly resultFileSha: string
  readonly artifactPath?: string | null
  readonly artifactSha?: string | null
}

export function ingestVerifiedOutcome(store: CapabilityMemoryStore, turn: Turn, taskId: string, o: VerifiedOutcome, at: string): MemoryItem {
  if (turn.role !== 'tool') throw new Error('verified outcome must come from a tool turn')
  const t = store.turn(turn.turnId)
  if (!t || t.text !== turn.text) throw new Error('tool turn must be persisted verbatim before ingestion')
  const superseded = new Set(store.items().flatMap((i) => i.supersedes))
  const prev = store.items().filter((i) => i.key === 'resultObserved' && i.scope.id === taskId && i.status === 'active' && !superseded.has(i.itemId))
  const value = `${o.runId}-r${o.revision}:${o.status}`
  const itemId = 'mem-v-' + createHash('sha256').update(taskId).update(value).update(o.resultFileSha).digest('hex').slice(0, 14)
  const existing = store.items().find((i) => i.itemId === itemId)
  if (existing) return existing
  const item: MemoryItem = {
    itemId, kind: 'outcome', key: 'resultObserved', value,
    statement: `${o.runId} 修订${o.revision} ${o.status}：${JSON.stringify(o.metrics)}；结果SHA ${o.resultFileSha.slice(0, 16)}${o.artifactSha ? `；产物 ${o.artifactPath} SHA ${o.artifactSha.slice(0, 16)}` : ''}`,
    scope: { level: 'task', id: taskId }, validFrom: turn.at, validUntil: null,
    supersedes: prev.map((p) => p.itemId), confidence: 1, status: 'active', authority: 'tool',
    quotes: [{ turnId: turn.turnId, start: 0, end: turn.text.length, text: turn.text }],
    recordedSeq: turn.seq, recordedAt: turn.at, origin: 'host-verified', checks: ['tool_verified'],
  }
  store.appendItem(item)
  store.recordExtraction({ requestId: `verified:${turn.turnId}`, status: 'applied', detail: `verified outcome ${value}`, turnIds: [turn.turnId] }, at)
  return item
}

/** 通用：宿主已验证的工具回执（如分析产物写入回执）成为 outcome 条目。 */
export function ingestToolReceipt(store: CapabilityMemoryStore, turn: Turn, taskId: string, key: string, value: string, statement: string, at: string): MemoryItem {
  if (turn.role !== 'tool') throw new Error('tool receipt must come from a tool turn')
  const itemId = 'mem-v-' + createHash('sha256').update(taskId).update(key).update(value).digest('hex').slice(0, 14)
  const existing = store.items().find((i) => i.itemId === itemId)
  if (existing) return existing
  const item: MemoryItem = {
    itemId, kind: 'outcome', key, value, statement, scope: { level: 'task', id: taskId }, validFrom: turn.at, validUntil: null,
    supersedes: [], confidence: 1, status: 'active', authority: 'tool',
    quotes: [{ turnId: turn.turnId, start: 0, end: turn.text.length, text: turn.text }],
    recordedSeq: turn.seq, recordedAt: turn.at, origin: 'host-verified', checks: ['tool_verified'],
  }
  store.appendItem(item)
  store.recordExtraction({ requestId: `verified:${turn.turnId}`, status: 'applied', detail: `verified ${key}=${value}`, turnIds: [turn.turnId] }, at)
  return item
}
