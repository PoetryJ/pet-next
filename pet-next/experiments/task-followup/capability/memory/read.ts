/**
 * readForDecision：按当前决定取完整、有效、可追溯的记忆证据组。
 * 1) 可见性：只看 asOf（及 asOfSeq）之前记录的原话/条目；历史查询以 historicalAt 为截止。
 * 2) 作用域：global + 同 project + 本任务；其他任务的条目不进入。
 * 3) 有效性：在评估时刻重新计算 supersede/过期/撤回；旧版本放 nonActionable。
 * 4) 检索：词项/中文二元组 BM25 + requiredSlots 字段匹配；偏好/约定作为决定依赖总是候选。
 * 5) 预算：以“条目+更正链+冲突对+原话引用”为一组，整组放入或整组放弃。
 */
import type { CapabilityMemoryStore } from './store.ts'
import type { ConflictEntry, EvidenceRef, MemoryItem, MemoryPacket, PacketItem, ReadForDecisionInput, Turn } from './types.ts'
import { keyTerms, normalizeKey, scoreDocs, terms } from './text.ts'

const t = (s: string) => Date.parse(s)

function slotMatches(key: string, slot: string): boolean {
  if (normalizeKey(key) === normalizeKey(slot)) return true
  const a = keyTerms(key)
  const b = keyTerms(slot)
  return b.length > 0 && b.every((x) => a.includes(x))
}

function coversTask(item: MemoryItem, taskId: string, projectId: string | null | undefined): boolean {
  if (item.scope.level === 'global') return true
  if (item.scope.level === 'task') return item.scope.id === taskId
  return projectId != null && item.scope.id === projectId
}

export function readForDecision(store: CapabilityMemoryStore, input: ReadForDecisionInput): MemoryPacket {
  const diagnostics: string[] = []
  const evalAt = input.intent === 'historical' && input.historicalAt ? input.historicalAt : input.asOf
  if (input.intent === 'historical' && !input.historicalAt) diagnostics.push('historical_without_historicalAt:using_asOf')
  const cutoff = Math.min(t(input.asOf), t(evalAt))
  const seqOk = (seq: number) => input.asOfSeq === undefined || seq <= input.asOfSeq
  const turns = new Map(store.turns().map((x) => [x.turnId, x]))
  const retractedTurns = store.retractedTurns()
  const retractedItems = store.retractedItems()
  const retractedBy = (at: string | undefined) => at !== undefined && t(at) <= t(input.asOf)

  const visible = store.items().filter((i) => t(i.recordedAt) <= cutoff && seqOk(i.recordedSeq))
  const inScope: MemoryItem[] = []
  let droppedRetracted = 0
  for (const i of visible) {
    if (!coversTask(i, input.taskId, input.projectId)) continue
    if (retractedBy(retractedItems.get(i.itemId)?.at) || i.quotes.some((q) => retractedBy(retractedTurns.get(q.turnId)?.at))) {
      droppedRetracted++
      continue
    }
    inScope.push(i)
  }
  if (droppedRetracted > 0) diagnostics.push(`retracted_excluded:${droppedRetracted}`)

  // 有效性在 evalAt 计算
  const canSupersede = (y: MemoryItem) => y.status === 'active' && t(y.validFrom) <= t(evalAt)
  const supersededBy = new Map<string, string[]>()
  for (const y of inScope) {
    if (!canSupersede(y)) continue
    for (const x of y.supersedes) supersededBy.set(x, [...(supersededBy.get(x) ?? []), y.itemId])
  }
  const effective = (i: MemoryItem): PacketItem['status'] => {
    if ((supersededBy.get(i.itemId) ?? []).length > 0) return 'superseded'
    if (i.validUntil && t(i.validUntil) <= t(evalAt)) return 'expired'
    if (t(i.validFrom) > t(evalAt)) return 'expired' // 尚未生效同样不可行动
    return i.status
  }
  const toPacket = (i: MemoryItem): PacketItem => ({
    itemId: i.itemId, kind: i.kind, key: i.key, value: i.value, statement: i.statement, scope: i.scope,
    validFrom: i.validFrom, validUntil: i.validUntil, status: effective(i), authority: i.authority, confidence: i.confidence,
    evidenceTurnIds: [...new Set(i.quotes.map((q) => q.turnId))], supersedes: i.supersedes, supersededBy: supersededBy.get(i.itemId) ?? [],
  })

  const actionable = inScope.filter((i) => ['active', 'inferred'].includes(effective(i)))
  const conflicts: ConflictEntry[] = inScope.filter((i) => effective(i) === 'conflict').map((i) => ({ key: i.key, itemIds: [i.itemId], reason: i.checks.find((c) => c.startsWith('scope') || c.startsWith('supersede')) ?? 'model_flagged_conflict' }))
  // 同作用域、同 key、不同值、彼此无更正关系 → 冲突，不按“最后一句”覆盖
  const byKey = new Map<string, MemoryItem[]>()
  for (const i of actionable.filter((x) => x.status === 'active')) {
    const k = `${i.key}|${i.scope.level}|${i.scope.id}`
    byKey.set(k, [...(byKey.get(k) ?? []), i])
  }
  for (const [k, list] of byKey) {
    const values = new Set(list.map((i) => JSON.stringify(i.value)))
    if (list.length > 1 && values.size > 1) conflicts.push({ key: k.split('|')[0]!, itemIds: list.map((i) => i.itemId), reason: 'same_scope_divergent_values' })
  }

  // 检索打分
  const q = [...terms(input.question), ...input.requiredSlots.flatMap(keyTerms)]
  const docOf = (i: MemoryItem) => [...terms(i.statement), ...keyTerms(i.key), ...terms(String(i.value ?? '')), ...i.quotes.flatMap((x) => terms(x.text))]
  const scores = scoreDocs(q, actionable.map(docOf))
  const tier = (i: MemoryItem) => {
    if (input.requiredSlots.some((s) => slotMatches(i.key, s))) return 0
    if (i.kind === 'preference' || i.kind === 'commitment') return 1
    if (i.kind === 'outcome') return 2
    return 3
  }
  const ranked = actionable
    .map((i, n) => ({ i, score: scores[n]!, tier: tier(i) }))
    .filter((r) => r.tier < 3 || r.score > 0)
    .sort((a, b) => a.tier - b.tier || b.score - a.score || t(b.i.recordedAt) - t(a.i.recordedAt))

  const byId = new Map(inScope.map((i) => [i.itemId, i]))
  const chainOf = (i: MemoryItem): MemoryItem[] => {
    const out: MemoryItem[] = []
    const stack = [...i.supersedes]
    while (stack.length > 0) {
      const id = stack.pop()!
      const old = byId.get(id)
      if (!old || out.includes(old)) continue
      out.push(old)
      stack.push(...old.supersedes)
    }
    return out
  }
  const chosen = new Set<string>()
  const chosenNon = new Set<string>()
  let chars = 0
  let truncated = false
  const sizeOf = (i: MemoryItem) => JSON.stringify(toPacket(i)).length + i.quotes.reduce((a, x) => a + x.text.length + 40, 0)
  for (const r of ranked) {
    if (chosen.has(r.i.itemId)) continue
    const partners = conflicts.filter((c) => c.itemIds.includes(r.i.itemId)).flatMap((c) => c.itemIds).map((id) => byId.get(id)!).filter(Boolean)
    const group = [r.i, ...partners.filter((p) => p.itemId !== r.i.itemId)]
    const chain = group.flatMap(chainOf)
    const cost = [...group, ...chain].filter((x) => !chosen.has(x.itemId) && !chosenNon.has(x.itemId)).reduce((a, x) => a + sizeOf(x), 0)
    const count = group.filter((x) => !chosen.has(x.itemId)).length
    if (chosen.size + count > input.budget.maxItems || chars + cost > input.budget.maxChars) {
      truncated = true
      continue
    }
    for (const g of group) chosen.add(g.itemId)
    for (const c of chain) chosenNon.add(c.itemId)
    chars += cost
  }
  // 冲突条目（模型标记）也要随包给出，便于澄清
  for (const c of conflicts) for (const id of c.itemIds) {
    const i = byId.get(id)
    if (i && !chosen.has(id) && chars + sizeOf(i) <= input.budget.maxChars) {
      chosenNon.add(id)
      chars += sizeOf(i)
    }
  }

  const picked = [...chosen].map((id) => byId.get(id)!)
  const pickedPackets = picked.map(toPacket)
  const non = [...chosenNon].filter((id) => !chosen.has(id)).map((id) => toPacket(byId.get(id)!))
  // 未进入 chosen 的假设性/过期条目只计数
  const hypothetical = inScope.filter((i) => effective(i) === 'hypothetical').length
  if (hypothetical > 0) diagnostics.push(`hypothetical_not_actionable:${hypothetical}`)

  const refsMap = new Map<string, EvidenceRef>()
  for (const i of [...picked, ...[...chosenNon].map((id) => byId.get(id)!)]) {
    for (const qt of i.quotes) {
      const turn = turns.get(qt.turnId)
      if (!turn) continue
      refsMap.set(`${qt.turnId}:${qt.start}:${qt.end}`, {
        turnId: turn.turnId, sessionId: turn.sessionId, seq: turn.seq, at: turn.at, role: turn.role, taskIds: turn.taskIds,
        quote: qt.text, start: qt.start, end: qt.end,
      })
    }
  }

  // 未抽取的相关原话：防止抽取遗漏/待抽取时完全失明，但只作上下文
  const extracted = store.extractedTurnIds()
  const recentTurns: EvidenceRef[] = []
  const candidates = [...turns.values()]
    .filter((x: Turn) => t(x.at) <= cutoff && seqOk(x.seq) && !retractedBy(retractedTurns.get(x.turnId)?.at))
    .filter((x) => x.taskIds.length === 0 || x.taskIds.includes(input.taskId))
    .filter((x) => !extracted.has(x.turnId))
    .sort((a, b) => b.seq - a.seq)
  for (const x of candidates) {
    if (chars + x.text.length + 80 > input.budget.maxChars) {
      truncated = true
      break
    }
    chars += x.text.length + 80
    recentTurns.push({ turnId: x.turnId, sessionId: x.sessionId, seq: x.seq, at: x.at, role: x.role, taskIds: x.taskIds, quote: x.text, start: 0, end: x.text.length })
  }
  if (candidates.length > 0) diagnostics.push(`unextracted_turns:${candidates.length}`)

  const missing = input.requiredSlots.filter((s) => !picked.some((i) => slotMatches(i.key, s) && i.status === 'active' && effective(i) === 'active'))
  return {
    schema: 'pet-capability-memory-packet/v1',
    taskId: input.taskId,
    asOf: input.asOf,
    evaluatedAt: evalAt,
    intent: input.intent,
    memoryCursor: store.cursor(),
    currentFacts: pickedPackets.filter((p) => p.kind === 'fact'),
    preferences: pickedPackets.filter((p) => p.kind === 'preference'),
    commitments: pickedPackets.filter((p) => p.kind === 'commitment'),
    outcomes: pickedPackets.filter((p) => p.kind === 'outcome'),
    evidenceRefs: [...refsMap.values()].sort((a, b) => a.seq - b.seq || a.start - b.start),
    missing,
    conflicts,
    context: { nonActionable: non, recentTurns, budgetUsed: { items: chosen.size, chars }, truncated, diagnostics },
  }
}
