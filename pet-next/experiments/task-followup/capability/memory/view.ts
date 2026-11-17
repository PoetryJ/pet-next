/**
 * MemoryView：编译/评估真正消费的记忆视图（R6-usable）。
 *
 * 为什么要它：上一轮只把摘要塞进 diagnostics，编译器读的是“全部 turn”，
 * 于是“花了钱生成摘要但没人消费”，也无法证明实际用了哪些原话。
 *
 * 约定：
 * - refs 是实际交给消费者的原话（编译输入/评估请求里出现的就是这些）；
 * - viewSha 由 kind + refs(sha) + summarySha + coveredSeq 计算，随每次消费一起记录；
 * - coveredSeq 只表示**连续**已处理前缀，跳过的项不算覆盖。
 *
 * @module capability/memory/view
 */
import { createHash } from 'node:crypto'
import type { MemoryPacket, Turn } from './types.ts'

export interface ViewRef {
  readonly turnId: string
  readonly seq: number
  readonly sha256: string
}

export interface MemoryView {
  readonly kind: 'versioned' | 'text'
  readonly taskId: string
  /** 消费者拿到的原话（带全文，用于编译与评估请求）。 */
  readonly turns: readonly Turn[]
  readonly refs: readonly ViewRef[]
  /** 连续已覆盖到的 seq（0 表示没有连续覆盖）。 */
  readonly coveredSeq: number
  readonly coverage: { readonly coveredSeq: number; readonly visitedSeq: number; readonly pending: number }
  readonly summary: string | null
  readonly summaryKeyTurns: readonly string[]
  readonly packet: MemoryPacket
  readonly viewSha: string
  readonly detail: Record<string, unknown>
}

export const sha256Text = (text: string): string => createHash('sha256').update(text).digest('hex')

export function viewShaOf(input: {
  kind: MemoryView['kind']
  refs: readonly ViewRef[]
  summary: string | null
  coveredSeq: number
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      kind: input.kind,
      refs: input.refs.map((r) => [r.turnId, r.sha256]),
      summary: input.summary === null ? null : sha256Text(input.summary),
      coveredSeq: input.coveredSeq,
    }))
    .digest('hex')
}

export function refsOf(turns: readonly Turn[]): ViewRef[] {
  return turns.map((t) => ({ turnId: t.turnId, seq: t.seq, sha256: sha256Text(t.text) }))
}

/** 连续覆盖前缀：从 1 开始，遇到缺口即停（不是“最大 seq”）。 */
export function contiguousPrefix(ids: Iterable<string>, seqOf: (id: string) => number | null): number {
  const seqs = new Set<number>()
  for (const id of ids) {
    const seq = seqOf(id)
    if (seq !== null) seqs.add(seq)
  }
  let run = 0
  while (seqs.has(run + 1)) run += 1
  return run
}
