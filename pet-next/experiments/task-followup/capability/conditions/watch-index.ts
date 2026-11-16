/**
 * 字段 → 计划反向索引：新证据只重算被引用字段相关的计划。
 *
 * 与 scheduler 的分工：这里不自己 tick、不自己排队，只回答“这次变化该重算谁”，
 * 由宿主既有 scheduler 触发；重复事件用 (计划, 证据版本, 变化集合) 去重，避免每次
 * now 时间戳变化都当成新证据去调用模型。
 *
 * @module capability/conditions/watch-index
 */
export interface WatchStats {
  readonly plans: number
  readonly facts: number
  readonly evaluated: number
  readonly skipped: number
}

export class WatchIndex {
  private readonly byFact = new Map<string, Set<string>>()
  private readonly byPlan = new Map<string, readonly string[]>()
  private readonly admitted = new Map<string, Set<string>>()
  private evaluated = 0
  private skipped = 0

  add(compilationKey: string, watch: readonly string[]): void {
    this.remove(compilationKey)
    const facts = [...new Set(watch)].sort()
    this.byPlan.set(compilationKey, facts)
    for (const fact of facts) {
      const plans = this.byFact.get(fact) ?? new Set<string>()
      plans.add(compilationKey)
      this.byFact.set(fact, plans)
    }
  }

  remove(compilationKey: string): void {
    const facts = this.byPlan.get(compilationKey)
    if (!facts) return
    for (const fact of facts) {
      const plans = this.byFact.get(fact)
      plans?.delete(compilationKey)
      if (plans && plans.size === 0) this.byFact.delete(fact)
    }
    this.byPlan.delete(compilationKey)
    this.admitted.delete(compilationKey)
  }

  /** 只返回引用了变化字段的计划（排序稳定，便于对比原始记录）。 */
  affected(changedFacts: readonly string[]): string[] {
    const hit = new Set<string>()
    for (const fact of changedFacts) for (const plan of this.byFact.get(fact) ?? []) hit.add(plan)
    return [...hit].sort()
  }

  /**
   * 事件准入：同一计划 + 同一证据版本 + 同一变化集合只放行一次。
   * 无关事件（没有命中字段）直接不算；重复的 now 时间戳变化不构成新证据。
   */
  admit(compilationKey: string, evidenceVersion: string, changedFacts: readonly string[]): boolean {
    const affected = this.byPlan.has(compilationKey)
    if (!affected) {
      this.skipped += 1
      return false
    }
    const relevant = changedFacts.filter((f) => (this.byPlan.get(compilationKey) ?? []).includes(f)).sort()
    if (relevant.length === 0) {
      this.skipped += 1
      return false
    }
    const key = `${evidenceVersion}\u0000${relevant.join(',')}`
    const seen = this.admitted.get(compilationKey) ?? new Set<string>()
    if (seen.has(key)) {
      this.skipped += 1
      return false
    }
    seen.add(key)
    this.admitted.set(compilationKey, seen)
    this.evaluated += 1
    return true
  }

  stats(): WatchStats {
    return { plans: this.byPlan.size, facts: this.byFact.size, evaluated: this.evaluated, skipped: this.skipped }
  }
}
