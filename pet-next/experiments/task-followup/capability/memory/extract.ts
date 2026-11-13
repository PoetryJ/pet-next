/**
 * 模型抽取：原话 → 原子记忆条目。
 * 这里只构造请求、解析与校验模型输出；不在本地用正则/固定句式“代替模型”抽取。
 */
import { createHash } from 'node:crypto'
import type { CapabilityMemoryStore } from './store.ts'
import type { Authority, ItemStatus, MemoryItem, MemoryKind, QuoteSpan, ScopeLevel, Turn } from './types.ts'
import { normalizeKey } from './text.ts'
import { FOLLOWUP_ATTRIBUTES, attributesForPrompt, resolveKey, timeLike } from './attributes.ts'
import type { AttributeDef } from './attributes.ts'
import { makeRequest, parseModelJson } from '../model/protocol.ts'
import type { ModelClient, ModelRequest, ModelResponse } from '../model/protocol.ts'

const KINDS: readonly MemoryKind[] = ['fact', 'preference', 'commitment', 'outcome']
const LEVELS: readonly ScopeLevel[] = ['global', 'project', 'task']
const STATUSES: readonly ItemStatus[] = ['active', 'hypothetical', 'inferred', 'conflict']

export const EXTRACTION_SYSTEM = `你是记忆抽取器。把对话原话拆成可核对的原子记忆条目，只输出一个 JSON 对象。
输出格式：{"coverage":[{"turnId":"本批每条新原话 id","status":"extracted|no_relevant_fact"}],"items":[{
 "kind":"fact|preference|commitment|outcome",
 "key":"必须取自输入 attributes 里的 key；确实没有合适的才写 other.<camelCase>。任务身份只放 scope，绝不写进 key（禁止 taskA、regressionSampleCount 这类）",
 "value":"JSON 标量（字符串/数字/布尔/null；人或任务用给定实体 id）",
 "statement":"一句话陈述",
 "scope":{"level":"global|project|task","id":"任务/项目 id；global 用 null"},
 "validFrom":"ISO8601 带时区；默认为原话时间",
 "validUntil":"ISO8601 或 null（原话给出绝对的结束时刻时填写）",
 "durationMinutes":"原话是相对时长（如“接下来4分钟”“两小时内”）时填分钟数，系统按原话时间换算；否则 null",
 "supersedes":["被本条更正的已有条目 itemId"],
 "confidence":0到1,
 "status":"active|hypothetical|inferred|conflict",
 "quotes":[{"turnId":"原话 id","start":起始下标,"end":结束下标,"text":"逐字摘录"}]
}]}
规则：
- 原子性：一个条目只表达一个属性（一个 key 一个值）。一句话里有多个意思（改配置、说明忙碌时段、给截止时间、提通知方式）就拆成多个条目。
- value 是该属性的简短值（如 "v2"、"2026-11-14T18:00:00+08:00"、"batch"、true），不要把整句原话当 value。
- quotes 只截取支持该条目的最短连续片段，不要整句引用。
- quotes.text 必须是该原话中逐字出现的片段；start/end 为该片段在原话中的字符下标（半开区间）。
- kind：preference=用户偏好/通知方式；commitment=约定、截止时间、许可或禁止；outcome=工具/执行回报的已验证结果；fact=其他事实。
- 只有 role=user 的原话能产生用户偏好、约定和许可；助手复述不能当成用户的话；工具回报才是执行结果。
- 作用域按原话所指对象判定：只对某任务生效的用 task；明确适用于所有事情的用 global。不要把对一个任务的更正扩散到其他任务。
- 用户更正旧设定时，新条目 supersedes 填旧条目 itemId（仅限给出的已有条目）。
- supersedes 只能指向同一 key、同一作用域的已有条目，并且仅在用户明确改口时填写。
- 假设、演练、举例、"如果…会怎样"的内容 status=hypothetical；不确定原话指哪个任务或是否更正时 status=conflict，不要猜。
- 相对时长写 durationMinutes（数字），不要自己换算 validUntil；“今天下班前”这类模糊时刻保留原文作 value，不要编造具体时刻。
- 只为 newTurns 产生条目：每个条目的 quotes 至少引用一条 newTurns 原话；priorTurnsForContext 只用于理解指代。
- coverage 必须逐条列出 newTurns 中每个 turnId：有条目的写 extracted，确实没有可记内容的写 no_relevant_fact。
- 输出要短：最多 8 个条目，statement 不超过 30 字。
- priorTurnsForContext 和 existingItems 里已有的内容不要重复输出；只有当新原话更正了某个已有条目时，输出新条目并在 supersedes 写该已有条目的 itemId。
- 用户关于“什么时候提醒/打断我”“忙的时候怎么处理”“哪些动作允许/禁止”“谁来做决定”的话都要抽成条目（notificationPolicy/availability/allowedActions/forbiddenActions/decisionOwner），这些直接决定之后要不要打扰用户。
- 用户说取消/暂停某个任务时，输出 key=taskStatus 的条目，scope 为该任务。
- 不要编造原话中没有的信息。没有可抽取内容时输出 {"items":[]}。
示例（与当前任务无关，仅示范格式）：existingItems 有 {"itemId":"mem-x1","key":"runTarget","value":20,"scope":{"level":"task","id":"task:weekly"}}；
新原话 {"id":"t9","at":"2026-03-02T09:00:00+08:00","role":"user","taskIds":["task:weekly"],"text":"周报统计改用30份样本，之前20份作废。下午两点前别打扰我，有要我选的再放面板。"}
应输出：{"items":[
 {"kind":"commitment","key":"runTarget","value":30,"statement":"周报统计样本数改为30","scope":{"level":"task","id":"task:weekly"},"validFrom":"2026-03-02T09:00:00+08:00","validUntil":null,"supersedes":["mem-x1"],"confidence":0.9,"status":"active","quotes":[{"turnId":"t9","start":0,"end":11,"text":"周报统计改用30份样本"}]},
 {"kind":"preference","key":"availability","value":"busy","statement":"14:00 前不要打扰","scope":{"level":"global","id":null},"validFrom":"2026-03-02T09:00:00+08:00","validUntil":"2026-03-02T14:00:00+08:00","supersedes":[],"confidence":0.8,"status":"active","quotes":[{"turnId":"t9","start":20,"end":29,"text":"下午两点前别打扰我"}]},
 {"kind":"preference","key":"notificationPolicy","value":"only_when_user_choice_needed","statement":"只有需要用户选择时才放到面板","scope":{"level":"global","id":null},"validFrom":"2026-03-02T09:00:00+08:00","validUntil":null,"supersedes":[],"confidence":0.8,"status":"active","quotes":[{"turnId":"t9","start":30,"end":39,"text":"有要我选的再放面板"}]}
]}`

/** 输出结构本身的字段名不是属性（模型常把 taskIds/scope 当 key） */
export interface ExtractionCoverage { readonly turnId: string; readonly status: 'extracted' | 'no_relevant_fact' | 'uncovered' }
const META_KEYS = new Set(['taskids', 'taskid', 'task', 'scope', 'turnid', 'turnids', 'kind', 'key', 'value', 'status', 'id', 'itemid', 'quotes', 'statement', 'text', 'role'].map((k) => k))
export interface ExtractionContextItem {
  readonly itemId: string
  readonly kind: MemoryKind
  readonly key: string
  readonly value: unknown
  readonly scope: { level: ScopeLevel; id: string | null }
  readonly statement: string
}

export function buildExtractionRequest(input: {
  readonly newTurns: readonly Turn[]
  readonly priorTurns: readonly Turn[]
  readonly existingItems: readonly ExtractionContextItem[]
  readonly entities: readonly { id: string; type: string; label: string }[]
  readonly createdAt: string
  readonly keyVocabulary?: readonly string[]
  readonly attributes?: readonly AttributeDef[]
}): ModelRequest {
  const fmt = (t: Turn) => ({ id: t.turnId, sessionId: t.sessionId, seq: t.seq, at: t.at, role: t.role, taskIds: t.taskIds, text: t.text })
  const user = JSON.stringify({
    entities: input.entities,
    attributes: attributesForPrompt(input.attributes ?? FOLLOWUP_ATTRIBUTES),
    existingItems: input.existingItems,
    priorTurnsForContext: input.priorTurns.map(fmt),
    turnsToExtract: input.newTurns.map(fmt),
    instruction: '只从 turnsToExtract 产生新条目；priorTurnsForContext 仅用于理解指代。',
  })
  return makeRequest('memory-extract', [
    { role: 'system', content: EXTRACTION_SYSTEM },
    { role: 'user', content: user },
  ], input.createdAt)
}

export interface ExtractionApplyReport {
  readonly requestId: string
  readonly accepted: readonly MemoryItem[]
  readonly rejected: readonly { index: number; reason: string }[]
  /** 新原话对已有同值断言的支持（不产生新条目） */
  readonly supports: readonly { index: number; itemId: string; turnIds: readonly string[] }[]
  /** 本批每条原话的覆盖状态 */
  readonly coverage: readonly ExtractionCoverage[]
  readonly parseError: string | null
}

function isoOk(s: unknown): s is string {
  return typeof s === 'string' && Number.isFinite(Date.parse(s))
}

/** 校验并写入模型抽取结果。response 必须来自真实模型调用（或测试中明确标注的夹具）。 */
export function applyExtraction(
  store: CapabilityMemoryStore,
  request: ModelRequest,
  response: Pick<ModelResponse, 'requestId' | 'rawText'>,
  coveredTurnIds: readonly string[],
  appliedAt: string,
  origin = request.requestId,
): ExtractionApplyReport {
  const parsed = parseModelJson(response.rawText)
  if (!parsed.ok) {
    store.recordExtraction({ requestId: request.requestId, status: 'failed', detail: parsed.detail, turnIds: coveredTurnIds }, appliedAt)
    return { requestId: request.requestId, accepted: [], rejected: [], supports: [], coverage: [], parseError: parsed.detail }
  }
  const rawItems = (parsed.value as any).items
  if (!Array.isArray(rawItems)) {
    store.recordExtraction({ requestId: request.requestId, status: 'failed', detail: 'items is not an array', turnIds: coveredTurnIds }, appliedAt)
    return { requestId: request.requestId, accepted: [], rejected: [], supports: [], coverage: [], parseError: 'items is not an array' }
  }
  const turns = new Map(store.turns().map((t) => [t.turnId, t]))
  const retracted = store.retractedTurns()
  const existing = new Map(store.items().map((i) => [i.itemId, i]))
  const retractedItems = store.retractedItems()
  const supersededIds = new Set(store.items().flatMap((i) => i.supersedes))
  const covered = new Set(coveredTurnIds)
  const accepted: MemoryItem[] = []
  const rejected: { index: number; reason: string }[] = []

  const supports: { index: number; itemId: string; turnIds: string[] }[] = []
  rawItems.forEach((raw: any, index: number) => {
    const checks: string[] = []
    if (!raw || typeof raw !== 'object') return rejected.push({ index, reason: 'not_object' })
    if (!KINDS.includes(raw.kind)) return rejected.push({ index, reason: `bad_kind:${raw.kind}` })
    if (typeof raw.key !== 'string' || normalizeKey(raw.key).length === 0) return rejected.push({ index, reason: 'bad_key' })
    const value = raw.value
    if (!(value === null || ['string', 'number', 'boolean'].includes(typeof value))) return rejected.push({ index, reason: 'value_not_scalar' })
    const resolved = resolveKey(raw.key)
    if (META_KEYS.has(normalizeKey(raw.key.replace(/^other\./, '')).toLowerCase())) return rejected.push({ index, reason: `key_is_metadata:${raw.key}` })
    let finalKey = resolved.attribute ?? `other.${normalizeKey(raw.key)}`
    if (resolved.via === 'alias') checks.push(`key_alias:${raw.key}->${resolved.attribute}`)
    if (resolved.via === 'unmapped') checks.push(`key_unmapped:${raw.key}`)
    const level = raw.scope?.level
    if (!LEVELS.includes(level)) return rejected.push({ index, reason: 'bad_scope' })
    const scopeId = level === 'global' ? null : typeof raw.scope?.id === 'string' && raw.scope.id.length > 0 ? raw.scope.id : undefined
    if (scopeId === undefined) return rejected.push({ index, reason: 'scope_id_missing' })
    let status: ItemStatus = STATUSES.includes(raw.status) ? raw.status : 'active'
    if (!STATUSES.includes(raw.status)) checks.push(`status_defaulted:${raw.status}`)

    // 引用逐字核对
    if (!Array.isArray(raw.quotes) || raw.quotes.length === 0) return rejected.push({ index, reason: 'no_quotes' })
    const quotes: QuoteSpan[] = []
    for (const q of raw.quotes) {
      const turn = turns.get(q?.turnId)
      if (!turn) return rejected.push({ index, reason: `quote_unknown_turn:${q?.turnId}` })
      if (!covered.has(turn.turnId)) checks.push(`quote_outside_batch:${turn.turnId}`)
      if (retracted.has(turn.turnId)) return rejected.push({ index, reason: `quote_retracted_turn:${turn.turnId}` })
      if (typeof q.text !== 'string' || q.text.length === 0) return rejected.push({ index, reason: 'quote_empty' })
      let start = Number(q.start)
      let end = Number(q.end)
      if (!(Number.isInteger(start) && Number.isInteger(end) && turn.text.slice(start, end) === q.text)) {
        const first = turn.text.indexOf(q.text)
        if (first < 0) return rejected.push({ index, reason: `quote_not_verbatim:${turn.turnId}` })
        if (turn.text.indexOf(q.text, first + 1) >= 0) return rejected.push({ index, reason: `quote_ambiguous_span:${turn.turnId}` })
        start = first
        end = first + q.text.length
        checks.push(`quote_relocated:${turn.turnId}`)
      }
      quotes.push({ turnId: turn.turnId, start, end, text: q.text })
    }
    // 只允许从本批原话产生新条目：全部引用都落在上下文原话里，说明是在重复抽取旧内容
    if (quotes.every((qq) => !covered.has(qq.turnId))) return rejected.push({ index, reason: 'all_quotes_outside_batch' })
    // 每句原话只抽一次：去掉批外引用，条目来源 = 本批原话片段
    for (let qi = quotes.length - 1; qi >= 0; qi--) if (!covered.has(quotes[qi]!.turnId)) quotes.splice(qi, 1)
    // 值不能是整句原话（应是短值）
    if (typeof value === 'string' && value.length >= 12 && quotes.some((qq) => { const tt = turns.get(qq.turnId)!.text; return tt.includes(value) && value.length >= 0.6 * tt.length })) return rejected.push({ index, reason: 'value_is_whole_utterance' })
    // 时间型属性（截止/预计到达）值必须是时间，否则不归入该属性
    const def = FOLLOWUP_ATTRIBUTES.find((a) => a.id === finalKey)
    if (def?.valueType === 'time' && !timeLike(value, isoOk(raw.validUntil) ? raw.validUntil : null, quotes.map((qq) => qq.text))) {
      checks.push(`attribute_type_mismatch:${finalKey}->other.${normalizeKey(raw.key)}`)
      finalKey = `other.${normalizeKey(raw.key)}`
    }
    // 来源片段去重：同一 key、同一作用域、引用片段重叠的既有/本批条目已存在 → 幂等跳过
    const overlaps = (a: readonly QuoteSpan[], b: readonly QuoteSpan[]) => a.some((x) => b.some((y) => x.turnId === y.turnId && x.start < y.end && y.start < x.end))
    // 既有条目（之前批次）重叠即重复；本批内仅在同值时视为重复（同一片段不同取值保留，交给冲突/假设判定）
    const sameSlot = (o: MemoryItem) => o.key === finalKey && o.scope.level === level && (o.scope.id ?? null) === (scopeId ?? null) && overlaps(o.quotes, quotes)
    const dup = [...existing.values()].find(sameSlot) ?? accepted.find((o) => sameSlot(o) && o.value === value && o.status === status)
    if (dup) return rejected.push({ index, reason: `duplicate_span:${dup.itemId}` })
    // 事实身份与请求身份分开：同作用域同属性同值的有效断言已存在 → 只记为新原话对它的支持，不产生新条目或更正链
    const canon = (v: unknown) => String(v).trim().toLowerCase()
    const same = [...existing.values()].find((o) => o.key === finalKey && o.scope.level === level && (o.scope.id ?? null) === (scopeId ?? null) && canon(o.value) === canon(value) && o.status !== 'hypothetical' && !retractedItems.has(o.itemId) && !supersededIds.has(o.itemId))
    if (same) { supports.push({ index, itemId: same.itemId, turnIds: quotes.map((qq) => qq.turnId) }); return }
    const quotedTurns = quotes.map((q) => turns.get(q.turnId)!)
    const roles = new Set(quotedTurns.map((t) => t.role))
    const authority: Authority = roles.has('user') ? 'user' : roles.has('tool') ? 'tool' : 'assistant'
    // 来源权威：模型不能把助手复述或猜测升级为用户偏好/执行结果
    if ((raw.kind === 'preference' || raw.kind === 'commitment') && authority !== 'user' && status === 'active') {
      status = 'inferred'
      checks.push('authority_downgraded:no_user_quote')
    }
    if (raw.kind === 'outcome' && !roles.has('tool') && status === 'active') {
      status = 'inferred'
      checks.push('authority_downgraded:no_tool_quote')
    }
    if (raw.kind === 'fact' && authority === 'assistant' && status === 'active') {
      status = 'inferred'
      checks.push('authority_downgraded:assistant_only')
    }
    // 作用域必须落在原话所在任务上下文内
    if (level === 'task') {
      const ctx = new Set(quotedTurns.flatMap((t) => t.taskIds))
      if (!ctx.has(scopeId!)) {
        status = 'conflict'
        checks.push(`scope_not_in_turn_context:${scopeId}`)
      }
    }
    const lastTurn = quotedTurns.reduce((a, b) => (a.seq >= b.seq ? a : b))
    const validFrom = isoOk(raw.validFrom) ? raw.validFrom : lastTurn.at
    if (!isoOk(raw.validFrom)) checks.push('validFrom_defaulted')
    const dur = Number(raw.durationMinutes)
    let validUntil = isoOk(raw.validUntil) ? raw.validUntil : null
    if (raw.durationMinutes != null && Number.isFinite(dur) && dur > 0) {
      const computed = new Date(Date.parse(lastTurn.at) + dur * 60_000).toISOString()
      if (validUntil && validUntil !== computed) checks.push(`validUntil_from_duration:${validUntil}->${computed}`)
      validUntil = computed
    }
    if (raw.validUntil != null && !isoOk(raw.validUntil)) checks.push('validUntil_unparseable_dropped')

    // 更正链：只能指向已存在条目；跨任务或换 key 不作为更正，转为冲突
    const supersedes: string[] = []
    for (const target of Array.isArray(raw.supersedes) ? raw.supersedes : []) {
      const old = existing.get(target) ?? accepted.find((a) => a.itemId === target)
      if (!old) {
        checks.push(`supersede_unknown:${target}`)
        continue
      }
      if (old.key !== finalKey) {
        // 换属性不是更正：忽略这条 supersedes，不把新条目整体打成冲突
        checks.push(`supersede_key_mismatch_ignored:${target}`)
        continue
      }
      if (overlaps(old.quotes, quotes)) { checks.push(`supersede_same_span_ignored:${target}`); continue }
      if (old.authority === 'user' && authority !== 'user') { checks.push(`supersede_authority_ignored:${target}`); continue }
      const sameScope = old.scope.level === level && old.scope.id === scopeId
      const narrows = old.scope.level === 'global' && level !== 'global'
      if (!sameScope && !narrows) {
        checks.push(`supersede_cross_scope:${target}`)
        status = 'conflict'
        continue
      }
      supersedes.push(target)
    }
    const confidence = typeof raw.confidence === 'number' ? Math.min(1, Math.max(0, raw.confidence)) : 0.5
    if (typeof raw.confidence !== 'number') checks.push('confidence_defaulted')
    const itemId = 'mem-' + createHash('sha256').update(request.requestId).update(String(index)).update(finalKey).digest('hex').slice(0, 16)
    const item: MemoryItem = {
      itemId,
      kind: raw.kind,
      key: finalKey,
      value,
      statement: typeof raw.statement === 'string' ? raw.statement : '',
      scope: { level, id: scopeId! },
      validFrom,
      validUntil,
      supersedes,
      confidence,
      status,
      authority,
      quotes,
      recordedSeq: lastTurn.seq,
      recordedAt: lastTurn.at,
      origin,
      checks,
    }
    accepted.push(item)
  })
  for (const item of accepted) store.appendItem(item)
  // 逐 turn 覆盖：有被接受条目/支持引用的，或模型明确声明 no_relevant_fact 的，才算已抽取；其余保持未覆盖（仍以原话出现在 recentTurns）
  const declared = new Map<string, string>()
  for (const c of Array.isArray((parsed.value as any).coverage) ? (parsed.value as any).coverage : []) if (c && typeof c.turnId === 'string') declared.set(c.turnId, String(c.status))
  const cited = new Set([...accepted.flatMap((i) => i.quotes.map((q) => q.turnId)), ...supports.flatMap((s2) => s2.turnIds)])
  const coverage: ExtractionCoverage[] = coveredTurnIds.map((t) => ({ turnId: t, status: cited.has(t) ? 'extracted' : declared.get(t) === 'no_relevant_fact' ? 'no_relevant_fact' : 'uncovered' }))
  const done = coverage.filter((c) => c.status !== 'uncovered').map((c) => c.turnId)
  const open = coverage.filter((c) => c.status === 'uncovered').map((c) => c.turnId)
  store.recordExtraction({ requestId: request.requestId, status: 'applied', detail: `accepted=${accepted.length} supports=${supports.length} rejected=${rejected.length} uncovered=${open.join(',') || '-'}`, turnIds: done }, appliedAt)
  if (open.length) store.recordExtraction({ requestId: `${request.requestId}:uncovered`, status: 'uncovered', detail: 'no accepted item cites these turns and model did not declare no_relevant_fact', turnIds: open }, appliedAt)
  return { requestId: request.requestId, accepted, rejected, supports, coverage, parseError: null }
}

/** 取尚未抽取的原话，构造并发送一次抽取请求；模型不可用时返回失败（不本地代填）。 */
export async function extractPending(
  store: CapabilityMemoryStore,
  client: ModelClient,
  options: { entities: readonly { id: string; type: string; label: string }[]; now: string; signal?: AbortSignal; contextTurns?: number; keyVocabulary?: readonly string[]; maxTurns?: number; roles?: readonly string[]; maxTokens?: number },
): Promise<{ status: 'nothing' | 'applied' | 'failed' | 'pending'; request?: ModelRequest; report?: ExtractionApplyReport; detail?: string }> {
  const done = store.extractedTurnIds()
  const retracted = store.retractedTurns()
  const all = store.turns().filter((t) => !retracted.has(t.turnId))
  const triedUncovered = new Set(store.extractions().filter((e) => e.status === 'uncovered').flatMap((e) => e.turnIds))
  const failedBefore = new Set(store.extractions().filter((e) => e.status === 'failed').flatMap((e) => e.turnIds))
  let fresh = all.filter((t) => !done.has(t.turnId) && !triedUncovered.has(t.turnId) && (!options.roles || options.roles.includes(t.role))).slice(0, options.maxTurns ?? Infinity)
  if (fresh.length === 0) return { status: 'nothing' }
  // 上次失败（多为输出截断）的批次缩到单条原话重试，而不是加大输出上限
  if (fresh.length > 1 && failedBefore.has(fresh[0]!.turnId)) fresh = [fresh[0]!]
  const prior = all.filter((t) => done.has(t.turnId)).slice(-(options.contextTurns ?? 6))
  // existingItems 只给本批涉及作用域（global + 本批任务）的有效头节点
  const scopes = new Set(fresh.flatMap((t) => t.taskIds))
  const superseded = new Set(store.items().flatMap((i) => i.supersedes))
  const retractedItems = store.retractedItems()
  const existing = store.items()
    .filter((i) => i.status === 'active' && !superseded.has(i.itemId) && !retractedItems.has(i.itemId) && (i.scope.level === 'global' || scopes.has(i.scope.id ?? '')))
    .slice(-30)
    .map((i) => ({ itemId: i.itemId, kind: i.kind, key: i.key, value: i.value, scope: i.scope, statement: i.statement }))
  const request = buildExtractionRequest({ newTurns: fresh, priorTurns: prior, existingItems: existing, entities: options.entities, createdAt: options.now, keyVocabulary: options.keyVocabulary })
  const result = await client.complete(options.maxTokens ? { ...request, maxTokens: options.maxTokens } : request, options.signal)
  if (!result.ok) {
    if (result.code !== 'pending' && result.code !== 'aborted') store.recordExtraction({ requestId: request.requestId, status: 'failed', detail: `${result.code}: ${result.detail}`, turnIds: fresh.map((t) => t.turnId) }, options.now)
    return { status: result.code === 'pending' ? 'pending' : 'failed', request, detail: `${result.code}: ${result.detail}` }
  }
  const report = applyExtraction(store, request, result.response, fresh.map((t) => t.turnId), options.now)
  return { status: report.parseError ? 'failed' : 'applied', request, report }
}
