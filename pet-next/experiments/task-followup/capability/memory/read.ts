/**
 * readForDecision：按当前决定取完整、有效、可追溯的记忆证据组。
 * 1) 可见性：只看 asOf（及 asOfSeq）之前记录的原话/条目；历史查询以 historicalAt 为截止。
 * 2) 作用域：global + 同 project + 本任务；其他任务的条目不进入。
 * 3) 有效性：在评估时刻重新计算 supersede/过期/撤回；旧版本放 nonActionable。
 * 4) 检索：词项/中文二元组 BM25 + requiredSlots 字段匹配；偏好/约定作为决定依赖总是候选。
 * 5) 预算：先给新原话留位，再放当前条目+冲突对+引用；旧更正链有余量才回填。
 */
import type { CapabilityMemoryStore } from './store.ts'
import type { ConflictEntry, EvidenceRef, MemoryItem, MemoryPacket, PacketItem, ReadForDecisionInput, Turn } from './types.ts'
import { keyTerms, normalizeKey, scoreDocs, terms } from './text.ts'
import { FOLLOWUP_ATTRIBUTES, resolveKey } from './attributes.ts'

const t = (s: string) => Date.parse(s)

/** 调用方槽位 → 共享属性 key（与抽取同一份定义）；未登记的槽位规范为 other.<name>。 */
export function slotKey(slot: string): string {
  const r = resolveKey(slot)
  return r.attribute ?? `other.${normalizeKey(slot)}`
}

function slotMatches(key: string, slot: string): boolean {
  if (key === slotKey(slot)) return true
  // 旧数据（定义引入前写入的 key）也走同一解析
  const k = resolveKey(key)
  return (k.attribute ?? `other.${normalizeKey(key)}`) === slotKey(slot)
}

function slotTerms(slot: string): string[] {
  const k = slotKey(slot)
  const def = FOLLOWUP_ATTRIBUTES.find((a) => a.id === k)
  return [...keyTerms(slot), ...(def ? [...keyTerms(def.id), ...def.aliases.flatMap(keyTerms), ...terms(def.description)] : [])]
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
    if (i.kind === 'outcome') return 0
    if (input.requiredSlots.some((s) => slotMatches(i.key, s))) return 1
    if (i.key.startsWith('other.') && input.requiredSlots.some((s) => [...keyTerms(i.key.slice(6)), ...terms(i.statement)].some((x) => slotTerms(s).includes(x)))) return 1
    if (i.kind === 'preference' || i.kind === 'commitment') return 2
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
  // Foreground user changes are working context, not leftover space after old notes.
  // A delayed/background extraction must never hide a newly received correction.
  const extracted = store.extractedTurnIds()
  const candidates = [...turns.values()]
    .filter((x: Turn) => t(x.at) <= cutoff && seqOk(x.seq) && !retractedBy(retractedTurns.get(x.turnId)?.at))
    .filter((x) => x.taskIds.length === 0 || x.taskIds.includes(input.taskId))
    .filter((x) => !extracted.has(x.turnId))
    .sort((a, b) => Number(b.role === 'user') - Number(a.role === 'user') || b.seq - a.seq)
  const recentTurns: EvidenceRef[] = []
  let chars = 0
  let truncated = false
  const recentBudget = Math.min(input.budget.maxChars, Math.max(
    Math.floor(input.budget.maxChars * 0.4),
    candidates.length ? JSON.stringify(candidates[0]).length + 100 : 0,
  ))
  for (const x of candidates) {
    const ref: EvidenceRef = { turnId: x.turnId, sessionId: x.sessionId, seq: x.seq, at: x.at, role: x.role, taskIds: x.taskIds, quote: x.text, start: 0, end: x.text.length }
    const cost = JSON.stringify(ref).length
    if (chars + cost > recentBudget) { truncated = true; continue }
    chars += cost
    recentTurns.push(ref)
  }
  if (candidates.length) diagnostics.push(`unextracted_turns:${candidates.length};included:${recentTurns.length}`)
  const sizeOf = (i: MemoryItem) => JSON.stringify(toPacket(i)).length + i.quotes.reduce((a, x) => a + x.text.length + 40, 0)
  const historyCandidates = new Set<string>()
  for (const r of ranked) {
    if (chosen.has(r.i.itemId)) continue
    const partners = conflicts.filter((c) => c.itemIds.includes(r.i.itemId)).flatMap((c) => c.itemIds).map((id) => byId.get(id)!).filter(Boolean)
    const group = [r.i, ...partners.filter((p) => p.itemId !== r.i.itemId)]
    const chain = group.flatMap(chainOf)
    const cost = group.filter((x) => !chosen.has(x.itemId)).reduce((a, x) => a + sizeOf(x), 0)
    const count = group.filter((x) => !chosen.has(x.itemId)).length
    if (chosen.size + count > input.budget.maxItems || chars + cost > input.budget.maxChars) {
      truncated = true
      continue
    }
    for (const g of group) chosen.add(g.itemId)
    for (const c of chain) historyCandidates.add(c.itemId)
    chars += cost
  }
  // The full lineage stays in storage. Current decision evidence takes precedence
  // over copying every superseded ancestor into the model's context.
  for (const id of historyCandidates) {
    const old = byId.get(id)!
    if (chosen.has(id) || chosenNon.has(id)) continue
    if (chars + sizeOf(old) > input.budget.maxChars) { truncated = true; continue }
    chosenNon.add(id)
    chars += sizeOf(old)
  }
  // 冲突条目（模型标记）也要随包给出，便于澄清
  for (const c of conflicts) for (const id of c.itemIds) {
    const i = byId.get(id)
    if (i && !chosen.has(id) && !chosenNon.has(id) && chars + sizeOf(i) <= input.budget.maxChars) {
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

  // 槽位解析：satisfied（同一属性的有效条目）/ unresolved（无同名属性，但有未登记条目或未抽取原话可能满足，交给 assessment 结合原话判断）/ missing（确实没有任何候选）
  const slotResolution = input.requiredSlots.map((slot) => {
    const sat = picked.filter((i) => slotMatches(i.key, slot) && i.status === 'active' && effective(i) === 'active')
    if (sat.length > 0) return { slot, key: slotKey(slot), status: 'satisfied' as const, itemIds: sat.map((i) => i.itemId), via: sat.map((i) => (i.key === slotKey(slot) ? 'attribute' : 'alias')) }
    const st = slotTerms(slot)
    const cands = actionable.filter((i) => i.key.startsWith('other.') && [...keyTerms(i.key.slice(6)), ...terms(i.statement)].some((x) => st.includes(x)))
    const omitted = actionable.some((i) => slotMatches(i.key, slot) && !chosen.has(i.itemId)) || cands.some((i) => !chosen.has(i.itemId))
    if (cands.length > 0 || candidates.length > 0 || omitted) {
      return { slot, key: slotKey(slot), status: 'unresolved' as const, itemIds: cands.filter((i) => chosen.has(i.itemId)).map((i) => i.itemId), via: [...(cands.length ? ['unmapped_items'] : []), ...(candidates.length ? ['unextracted_turns'] : []), ...(omitted ? ['evidence_outside_budget'] : [])] }
    }
    return { slot, key: slotKey(slot), status: 'missing' as const, itemIds: [] as string[], via: [] as string[] }
  })
  const missing = slotResolution.filter((r) => r.status === 'missing').map((r) => r.slot)
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
    context: { nonActionable: non, recentTurns, slotResolution, budgetUsed: { items: chosen.size, chars }, truncated, diagnostics },
  }
}
