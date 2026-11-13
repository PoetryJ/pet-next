import type { AssessSnapshot } from './assess.ts'
import type { MemoryPacket } from '../memory/types.ts'

/** Arithmetic and evidence ordering only. No selected action, rule verdict or gold. */
export function decisionFrame(snapshot: AssessSnapshot, packet: MemoryPacket) {
  const now = Date.parse(snapshot.now)
  const items = [...packet.currentFacts, ...packet.commitments, ...packet.preferences, ...packet.outcomes]
  const timeFacts = items.filter((i) => i.status === 'active' && ['expectedUpdateAt', 'decisionDeadline'].includes(i.key) && typeof i.value === 'string' && Number.isFinite(Date.parse(i.value))).map((i) => {
    const deltaMs = Date.parse(String(i.value)) - now
    return { itemId: i.itemId, key: i.key, at: i.value, relationToNow: deltaMs < 0 ? 'past' : deltaMs > 0 ? 'future' : 'now', secondsFromNow: Math.round(deltaMs / 1000), sourceTurnIds: i.evidenceTurnIds }
  })
  const observed = packet.outcomes.filter((i) => i.status === 'active' && i.key === 'resultObserved').sort((a, b) => Date.parse(b.validFrom) - Date.parse(a.validFrom))[0]
  return {
    currentTime: snapshot.now,
    currentVerifiedResult: snapshot.latestResult ?? null,
    currentResultObservedAt: observed?.validFrom ?? null,
    timeFacts,
    uncompiledUserUpdates: packet.context.recentTurns.filter((t) => t.role === 'user').sort((a, b) => b.seq - a.seq).slice(0, 3).map((t) => ({ turnId: t.turnId, at: t.at, text: t.quote })),
    note: 'past 表示已过去，不是未来更新排期。时间先后不自动证明完成；必须结合当前结果摘要、实际剩余问题和最新用户要求判断等待条件是否仍未满足。',
  }
}
