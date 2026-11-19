/**
 * R6-usable 记忆适配层（A）。
 *
 * V（versioned）：真实 intake 的原话 → 模型抽取原子条目 → 结构化检索。
 * T（text）：滚动摘要（逐段连续覆盖）+ 中文词面检索；摘要带**引用轮次**，
 *            消费者拿到的 MemoryView 同时包含摘要、引用原话与检索原话。
 *
 * 关键修正（对应复核）：
 * - T 从最老未覆盖项起分批推进，只有成功持久化才提交连续前缀；不再 facts.slice(-30) 后跳到末尾。
 * - 摘要显式带 keyTurns（引用），编译输入因此能看到早期承诺的原话，而不是只看近期窗口。
 * - 中文检索按字/双字片段建索引（旧实现把整段汉字当一个词，召回为 0）。
 * - V/T 都产出 MemoryView（refs + viewSha + coveredSeq），由消费者记录并随请求提交。
 *
 * @module capability/memory/adapters
 */
import { extractPending } from './extract.ts'
import { readForDecision } from './read.ts'
import type { CapabilityMemoryStore } from './store.ts'
import type { MemoryPacket, Turn } from './types.ts'
import type { ModelClient } from '../model/protocol.ts'
import { makeRequest, parseModelJson } from '../model/protocol.ts'
import { contiguousPrefix, refsOf, sha256Text, viewShaOf } from './view.ts'
import type { MemoryView, ViewRef } from './view.ts'

export type MemoryAdapterKind = 'versioned' | 'text'

export function adapterKindFromEnv(env: Record<string, string | undefined>): MemoryAdapterKind {
  return env.PET_MEMORY_ADAPTER === 'text' ? 'text' : 'versioned'
}

export interface MemoryLoad {
  readonly kind: MemoryAdapterKind
  readonly packet: MemoryPacket
  readonly view: MemoryView
  readonly detail: Record<string, unknown>
  readonly extraction?: Awaited<ReturnType<typeof extractPending>>
}

const SUMMARY_SYSTEM = `你是“任务记忆摘要器”。把新到的对话压成给决策者看的事实摘要，只输出 JSON：
{"summary":"…","keyTurns":[1]}
规则：
- 保留：用户明确的要求/更正/取消/授权范围、截止与忙碌时段、已完成报告与其版本、仍未满足的依赖。
- 更正就替换旧说法，不要并列保留互相冲突的两种说法；不确定的标注“不确定”。
- newTurns 中的 n 是本批次的短编号。keyTurns 只列最关键的 1 至 4 个数字。优先引用承诺、更正和取消，避免罗列重复内容。
- 只写事实，不写建议；summary 限 160 个汉字，保留 previousSummary 中仍然有效的承诺。`

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/u

/**
 * 中文/英文混合分词：CJK 取单字 + 双字片段，ASCII 取词。
 * 单字保底召回（“报告”≈“报”“告”），双字保证精度（“报告回来”≈“报告/告回/回来”）。
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const lower = text.toLowerCase()
  for (const word of lower.match(/[a-z0-9_]+/g) ?? []) if (word.length > 1) out.push(`w:${word}`)
  const runs = lower.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/gu) ?? []
  for (const run of runs) {
    for (const ch of run) out.push(`c:${ch}`)
    for (let i = 0; i + 1 < run.length; i += 1) out.push(`b:${run.slice(i, i + 2)}`)
  }
  return out
}

function turnScope(turn: Turn, taskId: string): boolean {
  return turn.taskIds.length === 0 || turn.taskIds.includes(taskId)
}

/** 词面 BM25（k1=1.2,b=0.75），索引为字/双字片段。 */
export function bm25(turns: readonly Turn[], query: string, topK: number): Turn[] {
  const docs = turns.map((t) => tokenize(t.text))
  const df = new Map<string, number>()
  for (const doc of docs) for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1)
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(docs.length, 1)
  const q = [...new Set(tokenize(query))]
  const scored = turns.map((turn, i) => {
    const doc = docs[i]!
    let score = 0
    for (const term of q) {
      const tf = doc.filter((x) => x === term).length
      if (!tf) continue
      const idf = Math.log(1 + (turns.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5))
      score += (idf * tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * (doc.length / Math.max(avg, 1))))
    }
    return { turn, score }
  })
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.turn.seq - a.turn.seq)
    .slice(0, topK)
    .map((x) => x.turn)
}

function emptyPacket(taskId: string, now: string, recent: readonly Turn[], summary: string | null, cursor: number): MemoryPacket {
  const refs = recent.map((t) => ({
    turnId: t.turnId, sessionId: t.sessionId, seq: t.seq, at: t.at, role: t.role,
    taskIds: t.taskIds, quote: t.text, start: 0, end: t.text.length,
  }))
  return {
    schema: 'pet-capability-memory-packet/v1',
    taskId, asOf: now, evaluatedAt: now, intent: 'current', memoryCursor: cursor,
    currentFacts: [], preferences: [], commitments: [], outcomes: [],
    evidenceRefs: refs, missing: [], conflicts: [],
    context: {
      nonActionable: [], recentTurns: refs, slotResolution: [],
      budgetUsed: { items: 0, chars: summary?.length ?? 0 }, truncated: false,
      diagnostics: ['text-adapter:continuous-summary+cited-turns'],
    },
  }
}

interface TextState { seq: number; summary: string; keyTurns: string[]; batchLimit: number }

function readTextState(store: CapabilityMemoryStore, taskId: string): TextState {
  const db = store.db
  db.exec('CREATE TABLE IF NOT EXISTS cap_text_state (task_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, summary TEXT NOT NULL, updated_at TEXT NOT NULL);')
  const cols = db.prepare('PRAGMA table_info(cap_text_state)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'key_turns')) db.exec('ALTER TABLE cap_text_state ADD COLUMN key_turns TEXT')
  if (!cols.some((c) => c.name === 'batch_limit')) db.exec('ALTER TABLE cap_text_state ADD COLUMN batch_limit INTEGER')
  const row = db.prepare('SELECT seq, summary, key_turns, batch_limit FROM cap_text_state WHERE task_id = ?').get(taskId) as { seq: number; summary: string; key_turns: string | null; batch_limit: number | null } | undefined
  if (!row) return { seq: 0, summary: '', keyTurns: [], batchLimit: BATCH_TURNS }
  let keyTurns: string[] = []
  try { keyTurns = row.key_turns ? JSON.parse(row.key_turns) as string[] : [] } catch { keyTurns = [] }
  return { seq: Number(row.seq), summary: row.summary, keyTurns, batchLimit: row.batch_limit ?? BATCH_TURNS }
}

function writeTextState(store: CapabilityMemoryStore, taskId: string, previousSeq: number, seq: number, summary: string, keyTurns: readonly string[], at: string): void {
  store.db.prepare('INSERT INTO cap_text_state (task_id, seq, summary, key_turns, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET seq = excluded.seq, summary = excluded.summary, key_turns = excluded.key_turns, updated_at = excluded.updated_at WHERE cap_text_state.seq = ?')
    .run(taskId, seq, summary, JSON.stringify([...new Set(keyTurns)].slice(-12)), at, previousSeq)
}

const BATCH_TURNS = 48
const BATCH_CHARS = 2400
const MAX_CALLS_PER_REFRESH = 3
const SUMMARY_MAX_TOKENS = 384
const HOST_TURN = /^(回答：|用户选择：)/

/**
 * 逐段推进摘要。每一批都从最老未覆盖项开始，成功持久化后才提交连续前缀；
 * 截断或无效输出缩小批次重试。游标只越过已经持久化的连续前缀。
 */
export async function refreshSummary(
  store: CapabilityMemoryStore,
  client: ModelClient,
  taskId: string,
  now: string,
  signal?: AbortSignal,
): Promise<{ state: TextState; calls: number; error: string | null; lastRequestId: string | null }> {
  let state = readTextState(store, taskId)
  let calls = 0
  let error: string | null = null
  let lastRequestId: string | null = null
  let batchLimit = state.batchLimit
  while (calls < MAX_CALLS_PER_REFRESH) {
    const all = store.turns().filter((t) => turnScope(t, taskId) && t.seq > state.seq && !HOST_TURN.test(t.text))
    if (!all.length) break
    const batch: Turn[] = []
    let chars = 0
    for (const turn of all) {
      if (batch.length >= batchLimit) break
      if (batch.length > 0 && chars + turn.text.length > BATCH_CHARS) break
      batch.push(turn)
      chars += turn.text.length
    }
    if (!batch.length) break
    const request = makeRequest('memory-summarize', [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: JSON.stringify({
        taskId,
        previousSummary: state.summary,
        newTurns: batch.map((t, i) => ({ n: i + 1, at: t.at, role: t.role, text: t.text.slice(0, 600) })),
      }) },
    ], now)
    lastRequestId = request.requestId
    calls += 1
    const result = await client.complete({ ...request, maxTokens: SUMMARY_MAX_TOKENS }, signal)
    if (!result.ok) { error = `${result.code}:${result.detail}`; break }
    const parsed = parseModelJson(result.response.rawText)
    const raw = parsed.ok ? (parsed.value as { summary?: unknown; keyTurns?: unknown }) : null
    const summary = typeof raw?.summary === 'string' ? raw.summary.trim() : ''
    const refs = raw?.keyTurns
    const validRefs = Array.isArray(refs) && refs.length > 0 && refs.length <= 4
      && refs.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= batch.length)
    if (result.response.finishReason === 'length' || !summary || !validRefs) {
      error = result.response.finishReason === 'length' ? 'summary_truncated' : 'summary_invalid'
      if (batch.length === 1) break
      batchLimit = Math.ceil(batch.length / 2)
      // Retain the smaller batch across refreshes and process restarts without advancing the cursor.
      store.db.prepare(`INSERT INTO cap_text_state (task_id, seq, summary, updated_at, batch_limit)
        VALUES (?, 0, '', ?, ?) ON CONFLICT(task_id) DO UPDATE SET batch_limit = min(coalesce(batch_limit, ?), excluded.batch_limit)
        WHERE cap_text_state.seq = ?`).run(taskId, now, batchLimit, BATCH_TURNS, state.seq)
      continue
    }
    const cited = refs.map((n: number) => batch[n - 1]!.turnId)
    writeTextState(store, taskId, state.seq, batch.at(-1)!.seq, summary, [...state.keyTurns, ...cited], now)
    state = readTextState(store, taskId)
    error = null
  }
  return { state: readTextState(store, taskId), calls, error, lastRequestId }
}

export async function loadTextMemory(options: {
  store: CapabilityMemoryStore
  client: ModelClient
  taskId: string
  now: string
  signal?: AbortSignal
  topK?: number
}): Promise<MemoryLoad> {
  const { store, client, taskId, now, signal } = options
  const refreshed = await refreshSummary(store, client, taskId, now, signal)
  const all = store.turns().filter((t) => turnScope(t, taskId))
  const byId = new Map(all.map((t) => [t.turnId, t]))
  const cited = refreshed.state.keyTurns.map((id) => byId.get(id)).filter((t): t is Turn => Boolean(t))
  const recent = all.slice(-4)
  const lastUser = [...all].reverse().find((t) => t.role === 'user')
  const retrieved = bm25(all, lastUser?.text ?? '', options.topK ?? 10)
  const picked = new Map<string, Turn>()
  for (const turn of [...cited, ...retrieved, ...recent]) picked.set(turn.turnId, turn)
  const visible = [...picked.values()].sort((a, b) => a.seq - b.seq)
  const refs = refsOf(visible)
  const summary = refreshed.state.summary || null
  const view: MemoryView = {
    kind: 'text',
    taskId,
    turns: visible,
    refs,
    coveredSeq: refreshed.state.seq,
    coverage: { coveredSeq: refreshed.state.seq, visitedSeq: all.at(-1)?.seq ?? 0, pending: all.filter((t) => t.seq > refreshed.state.seq).length },
    summary,
    summaryKeyTurns: refreshed.state.keyTurns,
    packet: emptyPacket(taskId, now, visible, summary, store.cursor()),
    viewSha: viewShaOf({ kind: 'text', refs, summary, coveredSeq: refreshed.state.seq }),
    detail: {
      adapter: 'text',
      summarizeCalls: refreshed.calls,
      summarizeRequestId: refreshed.lastRequestId,
      summarizeError: refreshed.error,
      summaryChars: summary?.length ?? 0,
      citedTurns: cited.map((t) => t.turnId),
      retrieved: retrieved.map((t) => t.turnId),
      visible: visible.map((t) => t.turnId),
      coveredSeq: refreshed.state.seq,
      pendingTurns: all.filter((t) => t.seq > refreshed.state.seq).length,
    },
  }
  return { kind: 'text', packet: view.packet, view, detail: view.detail }
}

export async function loadVersionedMemory(options: {
  store: CapabilityMemoryStore
  client: ModelClient
  taskId: string
  taskTitle: string
  now: string
  signal?: AbortSignal
  extract: { entities: { id: string; type: string; label: string }[]; maxTurns: number; maxTokens: number }
  read: { question: string; requiredSlots: readonly string[]; maxItems: number; maxChars: number }
}): Promise<MemoryLoad> {
  const { store, client, taskId, taskTitle, now, signal } = options
  const extraction = await extractPending(store, client, {
    entities: options.extract.entities,
    now, signal,
    maxTurns: options.extract.maxTurns,
    roles: ['user', 'assistant'],
    maxTokens: options.extract.maxTokens,
    taskId,
    ignorePrefixes: ['回答：', '用户选择：'],
  })
  // 抽取失败不拖垮整次判断：沿用已持久化的记忆，并把错误显式记录（缺的部分仍然缺失）。
  const extractionError = extraction.status === 'failed' ? (extraction.detail ?? 'extraction_failed') : null
  const packet = readForDecision(store, {
    taskId, asOf: now, intent: 'current',
    question: options.read.question || `${taskTitle} 当前结果、授权范围、通知偏好与等待条件`,
    requiredSlots: options.read.requiredSlots,
    budget: { maxItems: options.read.maxItems, maxChars: options.read.maxChars },
  })
  const all = store.turns().filter((t) => turnScope(t, taskId))
  const seqOf = new Map(all.map((t) => [t.turnId, t.seq]))
  const covered = contiguousPrefix(store.extractedTurnIds(), (id) => seqOf.get(id) ?? null)
  // 消费者可见原话：条目证据 + recentTurns（都是真实 intake 的轮次）
  const ids = new Set<string>()
  for (const item of [...packet.currentFacts, ...packet.preferences, ...packet.commitments, ...packet.outcomes]) for (const id of item.evidenceTurnIds) ids.add(id)
  for (const ref of packet.context.recentTurns) ids.add(ref.turnId)
  // 最近 3 条用户原话必须在视图里：改口/取消常常还没被抽取，但消费者必须看到。
  for (const turn of all.filter((t) => t.role === 'user').slice(-3)) ids.add(turn.turnId)
  const visible = all.filter((t) => ids.has(t.turnId)).sort((a, b) => a.seq - b.seq)
  const refs = refsOf(visible)
  const view: MemoryView = {
    kind: 'versioned',
    taskId,
    turns: visible,
    refs,
    coveredSeq: covered,
    coverage: { coveredSeq: covered, visitedSeq: all.at(-1)?.seq ?? 0, pending: all.filter((t) => t.seq > covered).length },
    summary: null,
    summaryKeyTurns: [],
    packet,
    viewSha: viewShaOf({ kind: 'versioned', refs, summary: null, coveredSeq: covered }),
    detail: {
      adapter: 'versioned',
      extraction: extraction.status,
      extractionError,
      items: packet.currentFacts.length + packet.preferences.length + packet.commitments.length,
      consumedTurns: visible.map((t) => t.turnId),
      coveredSeq: covered,
      pendingTurns: all.filter((t) => t.seq > covered).length,
    },
  }
  return { kind: 'versioned', packet, view, detail: view.detail, extraction }
}

export function loadMemory(kind: MemoryAdapterKind, options: Parameters<typeof loadVersionedMemory>[0]): Promise<MemoryLoad> {
  return kind === 'text' ? loadTextMemory(options) : loadVersionedMemory(options)
}

export type { MemoryView, ViewRef }
export { sha256Text }
