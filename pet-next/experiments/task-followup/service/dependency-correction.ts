import type { ReportBinding } from '../contracts.ts'

// Accept an explicit edit to a named source on the selected task. A clause has
// to match in full: a question, quotation or conditional is not an edit.
export function resolveDependencyEdit(
  text: string,
  primary: { taskId: string; names: readonly string[] },
  bindings: readonly ReportBinding[],
): { bindings: ReportBinding[] } | null {
  if (!bindings.length) return null
  const names = new Map<string, Set<string>>()
  function register(name: string, id: string): void {
    const key = name.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
    if (!key) return
    const ids = names.get(key) ?? new Set<string>()
    ids.add(id)
    names.set(key, ids)
  }
  for (const name of primary.names) register(name, primary.taskId)
  for (const b of bindings) {
    register(b.alias, b.taskId)
    register(b.alias.replace(/\s*(?:的)?报告$/u, ''), b.taskId)
  }
  const command = text.normalize('NFKC').trim().replace(/^(?:更正|修改依赖)\s*[:：]\s*/u, '').replace(/[。.!！]$/u, '')
  const clauses = command.split(/[,，;；]/u).map(s => s.trim())
  const removed = new Set<string>()
  let keepOnly: string | undefined
  for (const clause of clauses) {
    const keep = /^只等\s*(.+?)(?:\s*的?报告)?(?:\s*(?:就|再)问我)?$/u.exec(clause)
    const drop = /^(.+?)\s*(?:那份|的报告|报告)?\s*(?:不用等|不再等)了?$/u.exec(clause)
      ?? /^(?:不用等|别等|不再等)\s*(.+?)(?:\s*的?报告)?了?$/u.exec(clause)
      // “B 失败/成功也不用问我/管/提醒”同样是显式改口：B 不再影响是否打扰我。
      ?? /^(.+?)\s*(?:那份|的报告|报告)?\s*(?:失败|成功)?\s*(?:也)?\s*(?:不用|无需|不需要)(?:再)?(?:问|管|提醒)(?:我)?$/u.exec(clause)
    const target = (keep ?? drop)?.[1]?.trim().replace(/\s+/gu, '').toLowerCase().replace(/(?:那份|的报告|报告)$/u, '')
    const ids = target && names.get(target)
    if (!ids || ids.size !== 1) {
      // 已经明确删除某个来源后，后面的描述性条件（“只有 A 失败才需要来问我”）
      // 不是第二条依赖命令；跳过它，不要因此丢掉前面的删除。
      if (removed.size > 0 && keepOnly === undefined && !/仍然需要|还要|也需要/u.test(clause)) continue
      return null
    }
    const id = [...ids][0]!
    if (keep) {
      if (keepOnly !== undefined && keepOnly !== id) return null
      keepOnly = id
    } else {
      if (id === primary.taskId) return null
      removed.add(id)
    }
  }
  if (keepOnly && removed.has(keepOnly)) return null
  const next = bindings.filter(b => !removed.has(b.taskId) && (!keepOnly || b.taskId === keepOnly))
  return next.length === bindings.length ? null : { bindings: next }
}
