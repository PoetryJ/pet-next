/**
 * R6-comparison 记忆适配层（A）。
 *
 * 两种**真实不同**的实现，供五臂对照使用：
 * - versioned（V）：现有版本化记忆——模型抽取原子条目，按任务/时间/作用域检索有效条目；
 *   下游看到的是结构化 currentFacts/preferences/commitments。
 * - text（T）：强文本基线——滚动摘要（模型调用 purpose=memory-summarize）+ 词面 BM25 检索原话；
 *   下游看不到结构化条目，只看到摘要与检索到的原话，因此请求内容与 V 不同。
 *
 * 约束：不改 runtime/engine.ts、tools/workspace.ts 与核心门；只在 capability/ 内新增实现，
 * 由 service/ 选择。选择依据 PET_MEMORY_ADAPTER（默认 versioned，旧行为不变）。
 *
 * @module capability/memory/adapters
 */
import { extractPending } from './extract.ts'
import { readForDecision } from './read.ts'
import type { CapabilityMemoryStore } from './store.ts'
import type { MemoryPacket, Turn } from './types.ts'
import type { ModelClient } from '../model/protocol.ts'
import { makeRequest, parseModelJson } from '../model/protocol.ts'

export type MemoryAdapterKind = 'versioned' | 'text'

export function adapterKindFromEnv(env: Record<string, string | undefined>): MemoryAdapterKind {
  return env.PET_MEMORY_ADAPTER === 'text' ? 'text' : 'versioned'
}

export interface MemoryLoad {
  readonly kind: MemoryAdapterKind
  readonly packet: MemoryPacket
  /** text 适配器给出的可见原话；versioned 为 null（沿用原有 packet 推导）。 */
  readonly turns: readonly Turn[] | null
  readonly summary: string | null
  readonly detail: Record<string, unknown>
  readonly extraction?: Awaited<ReturnType<typeof extractPending>>
}

const SUMMARY_SYSTEM = `你是“任务记忆摘要器”。把新到的对话压成给决策者看的事实摘要，只输出 JSON：{"summary":"..."}。
规则：
- 保留：用户明确的要求/更正/取消/授权范围、截止与忙碌时段、已完成报告与其版本、仍未满足的依赖。
- 更正就替换旧说法，不要并列保留互相冲突的两种说法；不确定的标注“不确定”。
- 只写事实，不写建议；不超过 600 个汉字；不要编造原话里没有的内容。`

const TERMS = /[\u4e00-\u9fff]{2,}|[A-Za-z]{3,}|\d+/g

function terms(text: string): string[] {
  return (text.toLowerCase().match(TERMS) ?? []).filter((t) => t.length > 1)
}

function turnScope(turn: Turn, taskId: string): boolean {
  return turn.taskIds.length === 0 || turn.taskIds.includes(taskId)
}

/** 词面 BM25（k1=1.2,b=0.75）：强文本基线的检索器，不借助结构化记忆。 */
export function bm25(turns: readonly Turn[], query: string, topK: number): Turn[] {
  const docs = turns.map((t) => terms(t.text))
  const df = new Map<string, number>()
  for (const doc of docs) for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1)
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(docs.length, 1)
  const q = [...new Set(terms(query))]
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
    taskId,
    asOf: now,
    evaluatedAt: now,
    intent: 'current',
    memoryCursor: cursor,
    currentFacts: [],
    preferences: [],
    commitments: [],
    outcomes: [],
    evidenceRefs: refs,
    missing: [],
    conflicts: [],
    context: {
      nonActionable: [],
      recentTurns: refs,
      slotResolution: [],
      budgetUsed: { items: 0, chars: summary?.length ?? 0 },
      truncated: false,
      diagnostics: ['text-adapter:rolling-summary+bm25', ...(summary ? [`summary:${summary.slice(0, 200)}`] : [])],
    },
  }
}

function readTextState(store: CapabilityMemoryStore, taskId: string): { seq: number; summary: string } {
  const db = store.db
  db.exec('CREATE TABLE IF NOT EXISTS cap_text_state (task_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, summary TEXT NOT NULL, updated_at TEXT NOT NULL);')
  const row = db.prepare('SELECT seq, summary FROM cap_text_state WHERE task_id = ?').get(taskId) as { seq: number; summary: string } | undefined
  return row ? { seq: Number(row.seq), summary: row.summary } : { seq: 0, summary: '' }
}

function writeTextState(store: CapabilityMemoryStore, taskId: string, seq: number, summary: string, at: string): void {
  store.db.prepare('INSERT INTO cap_text_state (task_id, seq, summary, updated_at) VALUES (?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET seq = excluded.seq, summary = excluded.summary, updated_at = excluded.updated_at')
    .run(taskId, seq, summary, at)
}

/** 滚动摘要：只有真的出现新原话才调用模型；失败保留旧摘要并记录，不伪造。 */
export async function refreshSummary(
  store: CapabilityMemoryStore,
  client: ModelClient,
  taskId: string,
  now: string,
  signal?: AbortSignal,
): Promise<{ summary: string; seq: number; requestId: string | null; called: boolean; detail?: string }> {
  const state = readTextState(store, taskId)
  const turns = store.turns().filter((t) => turnScope(t, taskId) && t.seq > state.seq)
  if (!turns.length) return { summary: state.summary, seq: state.seq, requestId: null, called: false }
  const batch = turns.slice(-30)
  const user = JSON.stringify({
    taskId,
    previousSummary: state.summary,
    newTurns: batch.map((t) => ({ id: t.turnId, at: t.at, role: t.role, text: t.text.slice(0, 400) })),
  })
  const request = makeRequest('memory-summarize', [
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: user },
  ], now)
  const result = await client.complete(request, signal)
  if (!result.ok) return { summary: state.summary, seq: state.seq, requestId: request.requestId, called: true, detail: `${result.code}:${result.detail}` }
  const parsed = parseModelJson(result.response.rawText)
  const raw = parsed.ok ? (parsed.value as { summary?: unknown }) : null
  const summary = raw && typeof raw.summary === 'string' ? raw.summary.slice(0, 2000) : null
  if (!summary) return { summary: state.summary, seq: state.seq, requestId: request.requestId, called: true, detail: 'summary_parse_failed' }
  const seq = batch.at(-1)!.seq
  writeTextState(store, taskId, seq, summary, now)
  return { summary, seq, requestId: request.requestId, called: true }
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
  const recent = all.slice(-4)
  const lastUser = [...all].reverse().find((t) => t.role === 'user')
  const retrieved = bm25(all, lastUser?.text ?? '', options.topK ?? 6)
  const picked = new Map<string, Turn>()
  for (const turn of [...recent, ...retrieved]) picked.set(turn.turnId, turn)
  const visible = [...picked.values()].sort((a, b) => a.seq - b.seq)
  return {
    kind: 'text',
    packet: emptyPacket(taskId, now, visible, refreshed.summary || null, store.cursor()),
    turns: visible,
    summary: refreshed.summary || null,
    detail: {
      adapter: 'text',
      summarizeCall: refreshed.called,
      summarizeRequestId: refreshed.requestId,
      summaryChars: refreshed.summary.length,
      retrieved: retrieved.map((t) => t.turnId),
      visible: visible.map((t) => t.turnId),
      ...(refreshed.detail ? { summarizeError: refreshed.detail } : {}),
    },
  }
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
    now,
    signal,
    maxTurns: options.extract.maxTurns,
    roles: ['user', 'assistant'],
    maxTokens: options.extract.maxTokens,
    taskId,
    // “回答：现在处理”这类宿主记录不产生新的用户事实；避免每次作答都再抽取一轮。
    ignorePrefixes: ['回答：', '用户选择：'],
  })
  if (extraction.status === 'failed') throw new Error(`provider_error: memory extraction failed: ${extraction.detail ?? ''}`)
  const packet = readForDecision(store, {
    taskId,
    asOf: now,
    intent: 'current',
    question: options.read.question || `${taskTitle} 当前结果、授权范围、通知偏好与等待条件`,
    requiredSlots: options.read.requiredSlots,
    budget: { maxItems: options.read.maxItems, maxChars: options.read.maxChars },
  })
  return {
    kind: 'versioned',
    packet,
    turns: null,
    summary: null,
    extraction,
    detail: { adapter: 'versioned', extraction: extraction.status, items: packet.currentFacts.length + packet.preferences.length + packet.commitments.length },
  }
}

/** 统一入口：按 kind 选择；失败向上抛（由宿主记 failed，不静默换实现）。 */
export function loadMemory(kind: MemoryAdapterKind, options: Omit<Parameters<typeof loadVersionedMemory>[0], never>): Promise<MemoryLoad> {
  return kind === 'text' ? loadTextMemory(options) : loadVersionedMemory(options)
}
