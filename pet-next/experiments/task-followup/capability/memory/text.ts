/** 可解释的词项 + 中文二元组切分（不依赖向量模型）。 */
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u

export function terms(text: string): string[] {
  const out: string[] = []
  const lower = text.toLowerCase()
  let cjkRun = ''
  let word = ''
  const flushWord = () => {
    if (word.length > 0) out.push(word)
    word = ''
  }
  const flushCjk = () => {
    if (cjkRun.length === 1) out.push(cjkRun)
    for (let i = 0; i + 1 < cjkRun.length; i++) out.push(cjkRun.slice(i, i + 2))
    cjkRun = ''
  }
  for (const ch of lower) {
    if (CJK.test(ch)) {
      flushWord()
      cjkRun += ch
    } else if (/[\p{L}\p{N}_]/u.test(ch)) {
      flushCjk()
      word += ch
    } else {
      flushWord()
      flushCjk()
    }
  }
  flushWord()
  flushCjk()
  return out
}

/** camelCase / snake 字段名拆词，便于 requiredSlots 与 key 的松匹配 */
export function keyTerms(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
}

export function normalizeKey(key: string): string {
  const parts = keyTerms(key)
  return parts.map((p, i) => (i === 0 ? p : p[0]!.toUpperCase() + p.slice(1))).join('')
}

/** BM25 风格打分：idf 来自候选集合本身，小规模、可复算。 */
export function scoreDocs(query: readonly string[], docs: readonly (readonly string[])[]): number[] {
  const n = docs.length
  const df = new Map<string, number>()
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1)
  const avg = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, n)
  const qset = [...new Set(query)]
  return docs.map((d) => {
    const tf = new Map<string, number>()
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1)
    let s = 0
    for (const q of qset) {
      const f = tf.get(q)
      if (!f) continue
      const idf = Math.log(1 + (n - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5))
      s += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.length / Math.max(1, avg))))
    }
    return s
  })
}
