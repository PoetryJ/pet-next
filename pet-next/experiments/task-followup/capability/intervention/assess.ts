/**
 * 事务外异步 assessment：snapshot + MemoryPacket → 模型结构化提案。
 * - assess() 不持有任何数据库事务；只构造请求、等待模型、解析，返回带身份的记录。
 * - submitAssessment() 在回交时对照“发起时身份”与“当前状态”：taskRevision / assignmentId /
 *   memoryCursor（仅本任务相关的记忆变化才算过期）/ 引用来源，再做结构 guard。
 * - guard 前的原始提案与 guard 后结论分两层记录；guard 不抹掉模型原始错误。
 */
import type { TaskSnapshot } from '../../contracts.ts'
import type { CapabilityMemoryStore } from '../memory/store.ts'
import type { MemoryPacket } from '../memory/types.ts'
import { makeRequest, parseModelJson } from '../model/protocol.ts'
import type { ModelClient, ModelMeta, ModelRequest } from '../model/protocol.ts'

export const REASON_CODES = [
  'waiting_external_info', 'needs_user_choice', 'ready_to_execute', 'no_current_action',
  'insufficient_evidence', 'cancelled', 'scheduled_digest', 'deadline_risk',
] as const
export type ReasonCode = (typeof REASON_CODES)[number]
export type InterventionKind = 'ask' | 'wait' | 'act' | 'digest' | 'none'
const KINDS: readonly InterventionKind[] = ['ask', 'wait', 'act', 'digest', 'none']

export interface AssessSnapshot {
  readonly taskId: string
  readonly title: string
  readonly goal: string
  readonly taskRevision: number
  readonly assignmentId: string | null
  readonly status: string
  readonly stage: string
  readonly now: string
  /** 当前可见的最新结果摘要（来自宿主已校验的结果，不是模型猜测） */
  readonly latestResult?: { readonly sourceId: string; readonly revision: number; readonly status: string; readonly summary: string; readonly assignment?: string; readonly artifact?: string } | null
  /** 共享等待契约：宿主给出的有界复查时刻（未知 ETA 时 wait 用它，不能自己编时间） */
  readonly waitContract?: { readonly boundedRecheckAt: string; readonly note?: string } | null
  /** 宿主可执行的动作选项（act/ask 时模型只能从中选） */
  readonly options?: readonly { readonly optionId: string; readonly label: string }[]
}

export function snapshotFromTask(task: TaskSnapshot, now: string, options?: AssessSnapshot['options']): AssessSnapshot {
  return {
    taskId: task.ticketId,
    title: task.title,
    goal: task.goal,
    taskRevision: task.taskRevision,
    assignmentId: task.assignmentId,
    status: task.status,
    stage: task.stage,
    now,
    latestResult: task.result
      ? { sourceId: task.result.runId, revision: task.result.revision, status: task.result.status, summary: task.result.note ?? JSON.stringify(task.result.metrics ?? {}) }
      : null,
    options,
  }
}

export interface AssessmentIdentity {
  readonly taskId: string
  readonly taskRevision: number
  readonly assignmentId: string | null
  readonly memoryCursor: number
  /** packet 中提供给模型的全部来源：原话 id 与条目 id */
  readonly sourceRefs: readonly string[]
}

export interface Proposal {
  readonly kind: InterventionKind
  readonly reasonCode: ReasonCode
  readonly question: string | null
  readonly optionIds: readonly string[]
  readonly wakeAt: string | null
  readonly waitFor: string | null
  readonly deadlineAt: string | null
  readonly deliverAt: string | null
  readonly batchable: boolean
  readonly evidenceTurnIds: readonly string[]
  readonly evidenceItemIds: readonly string[]
  readonly answerFacts: readonly { key: string; value: unknown; sourceTurnIds: readonly string[] }[]
}

export interface AssessmentRecord {
  readonly identity: AssessmentIdentity
  readonly request: ModelRequest
  readonly startedAt: string
  readonly model: ModelMeta | null
  readonly sessionId: string | null
  readonly rawText: string | null
  /** guard 前：模型原始结构化提案（解析失败为 null） */
  readonly proposal: Proposal | null
  readonly failure: { readonly code: string; readonly detail: string } | null
}

export const ASSESS_SYSTEM = `你是桌宠的跟进介入判断器。根据任务快照与记忆包，决定此刻对用户做什么，只输出一个 JSON 对象。
可选 kind：
- ask：现在就问用户（必须给出具体问题，引用证据）。
- wait：现在不打扰，等待某个预计到来的证据；必须给 waitFor（等什么）和 wakeAt（最晚重新判断时间，ISO8601 带时区）。
- act：无需用户即可执行宿主给出的某个选项（optionIds 只能取自 options）。
- digest：非紧急信息，放进下一次合并通知；给 deliverAt（最晚送达时间）。
- none：没有需要做的事。
reasonCode 取值：waiting_external_info, needs_user_choice, ready_to_execute, no_current_action, insufficient_evidence, cancelled, scheduled_digest, deadline_risk。
判断依据：只用记忆包中 status 为 active 的偏好、约定和事实；nonActionable 里的旧版本只能用来解释，不能作为依据。
考虑缺失信息、截止时间、预计下一条结果何时到、用户偏好的通知方式；等待能消除问题且来得及时选 wait；临近截止或可能造成不可逆错误时 ask。
memory.context.slotResolution 说明决定所需属性：satisfied 表示已有有效条目（直接使用，不要再问用户）；unresolved 表示没有同名条目，需结合 recentTurns 和条目原话自行判断是否已给出；只有 missing 且确实影响决定时才 ask 澄清。conflicts 影响决定时不要猜，应 ask 澄清。
若记忆中有 active 的 waitPolicy / notificationPolicy / availability（例如“等某版本/更正出来再问”“共享屏幕期间只记进度”），而当前 latestResult 还不满足其条件，应 wait（wakeAt 取预计更正时间）而不是 ask；条件满足且确有需要用户在 options 中选择时才 ask。
只有需要用户在 options 之间做选择、或用户明确要求确认时才 ask；正常进度、等待中的结果用 wait/digest/none，不要为了“确认一下”打扰用户。
输出格式：{"kind":"...","reasonCode":"...","question":"或null","optionIds":[],"wakeAt":"或null","waitFor":"或null","deadlineAt":"或null","deliverAt":"或null","batchable":true或false,"evidenceTurnIds":["原话id"],"evidenceItemIds":["条目itemId"],"answerFacts":[{"key":"字段","value":标量,"sourceTurnIds":["原话id"]}]}
所有时间（wakeAt/deadlineAt/deliverAt）必须是带时区的绝对 ISO8601，且晚于 snapshot.now。
等待契约：kind=wait 时必须在 evidenceTurnIds/evidenceItemIds 引用说明“在等什么”的证据；wakeAt 只能取 (1) 被引用证据里写明的预计到达时间/截止时间，或 (2) snapshot.waitContract.boundedRecheckAt（不知道何时到时用它）；不要自己编时间（如“24 小时后”）。等待期间不要改成反复问用户。
snapshot.latestResult 的 assignment 与 snapshot.assignmentId 不一致时，它是旧执行的结果，不能据此行动或提问。
batchable=true 表示这个问题可以与其他任务的问题合并在一次通知里回答。若输入含 question，answerFacts 必须逐个回答 question.requestedFactKeys 中的字段（key 原样使用；人/任务用实体 id；无有效证据时 value=null），sourceTurnIds 引用支持该值的原话 id。`

export function identityOf(snapshot: AssessSnapshot, packet: MemoryPacket): AssessmentIdentity {
  const refs = new Set<string>()
  for (const r of packet.evidenceRefs) refs.add(r.turnId)
  for (const r of packet.context.recentTurns) refs.add(r.turnId)
  for (const list of [packet.currentFacts, packet.preferences, packet.commitments, packet.outcomes, packet.context.nonActionable]) {
    for (const i of list) refs.add(i.itemId)
  }
  return { taskId: snapshot.taskId, taskRevision: snapshot.taskRevision, assignmentId: snapshot.assignmentId, memoryCursor: packet.memoryCursor, sourceRefs: [...refs].sort() }
}

export interface AssessQuestion {
  readonly text: string
  readonly requestedFactKeys: readonly string[]
}

/** 模型可见的行动包：有效断言 + 原话；历史旧值只给摘要（无 itemId，避免被复制成依据）；明确 allowedEvidenceIds。 */
export function modelView(packet: MemoryPacket) {
  const active = [...packet.currentFacts, ...packet.preferences, ...packet.commitments, ...packet.outcomes].map((i) => i.itemId)
  const turns = [...new Set([...packet.evidenceRefs.map((r) => r.turnId), ...packet.context.recentTurns.map((r) => r.turnId)])]
  return {
    ...packet,
    context: { ...packet.context, nonActionable: packet.context.nonActionable.map((i) => ({ key: i.key, oldValue: i.value, status: i.status, note: '历史值，仅用于理解变化，不能作为依据或引用' })) },
    allowedEvidenceIds: { itemIds: active, turnIds: turns },
  }
}

export function buildAssessRequest(snapshot: AssessSnapshot, packet: MemoryPacket, question?: AssessQuestion): ModelRequest {
  const user = JSON.stringify({ snapshot, memory: modelView(packet), ...(question ? { question } : {}) })
  return makeRequest('assess', [
    { role: 'system', content: ASSESS_SYSTEM },
    { role: 'user', content: user },
  ], snapshot.now)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
}

export function parseProposal(raw: string): { ok: true; proposal: Proposal } | { ok: false; detail: string } {
  const parsed = parseModelJson(raw)
  if (!parsed.ok) return { ok: false, detail: parsed.detail }
  const v: any = (parsed.value as any).action && typeof (parsed.value as any).action === 'object' ? { ...(parsed.value as any).action, answerFacts: (parsed.value as any).answerFacts } : parsed.value
  if (!KINDS.includes(v.kind)) return { ok: false, detail: `bad kind: ${v.kind}` }
  if (!REASON_CODES.includes(v.reasonCode)) return { ok: false, detail: `bad reasonCode: ${v.reasonCode}` }
  return {
    ok: true,
    proposal: {
      kind: v.kind,
      reasonCode: v.reasonCode,
      question: str(v.question),
      optionIds: strs(v.optionIds),
      wakeAt: str(v.wakeAt),
      waitFor: str(v.waitFor),
      deadlineAt: str(v.deadlineAt),
      deliverAt: str(v.deliverAt),
      batchable: v.batchable === true,
      evidenceTurnIds: strs(v.evidenceTurnIds ?? v.sourceTurnIds),
      evidenceItemIds: strs(v.evidenceItemIds),
      answerFacts: Array.isArray(v.answerFacts)
        ? v.answerFacts.filter((f: any) => f && typeof f.key === 'string').map((f: any) => ({ key: f.key, value: f.value ?? null, sourceTurnIds: strs(f.sourceTurnIds) }))
        : [],
    },
  }
}

/** 事务外异步评估。调用方负责：发起前读取 snapshot/packet，期间不持有事务。 */
export async function assess(snapshot: AssessSnapshot, packet: MemoryPacket, signal: AbortSignal | undefined, client: ModelClient, question?: AssessQuestion, maxTokens?: number): Promise<AssessmentRecord> {
  const identity = identityOf(snapshot, packet)
  const base = buildAssessRequest(snapshot, packet, question)
  const request = maxTokens ? { ...base, maxTokens } : base
  const startedAt = new Date().toISOString()
  const result = await client.complete(request, signal)
  if (!result.ok) {
    return { identity, request, startedAt, model: null, sessionId: null, rawText: null, proposal: null, failure: { code: result.code, detail: result.detail } }
  }
  const parsed = parseProposal(result.response.rawText)
  return {
    identity, request, startedAt,
    model: result.response.model,
    sessionId: result.response.sessionId,
    rawText: result.response.rawText,
    proposal: parsed.ok ? parsed.proposal : null,
    failure: parsed.ok ? null : { code: 'parse_error', detail: parsed.detail },
  }
}

/** guard 拒绝后的一次定向修复：短错误码 + 有效范围；调用方保证最多一次，并保留第一次原始输出。 */
export const REPAIRABLE: readonly string[] = ['evidence_unknown', 'evidence_not_actionable', 'evidence_missing', 'wait_without_recheck', 'wait_past_deadline', 'option_not_offered', 'model_failed']
export function repairQuestion(prev: SubmitResult, base?: AssessQuestion): AssessQuestion {
  return {
    text: `${base?.text ?? '此刻该做什么？'}\n[修复] 上一次输出被系统拒绝：${prev.code}（${prev.detail.slice(0, 160)}）。请重新判断：kind 只能是 ask/wait/act/digest/none；evidenceItemIds/evidenceTurnIds 只能取自 memory.allowedEvidenceIds；wakeAt/deadlineAt 必须是晚于 snapshot.now 的绝对时间；ask 的 optionIds 只能取自 snapshot.options，question 要写给用户能直接回答的具体选择。只输出一个 JSON 对象。`,
    requestedFactKeys: base?.requestedFactKeys ?? [],
  }
}

export type SubmitCode =
  | 'accepted'
  | 'model_failed'
  | 'stale_revision'
  | 'stale_assignment'
  | 'stale_memory'
  | 'evidence_unknown'
  | 'evidence_not_actionable'
  | 'evidence_missing'
  | 'wait_without_recheck'
  | 'wait_past_deadline'
  | 'option_not_offered'

export interface SubmitResult {
  readonly accepted: boolean
  readonly code: SubmitCode
  readonly detail: string
  /** guard 前提案（原样） */
  readonly proposal: Proposal | null
  /** guard 后建议：被拒时给宿主的保守替代（宿主可再走自己的规则/重新评估） */
  readonly fallback: { kind: InterventionKind; reasonCode: ReasonCode } | null
  readonly checks: readonly string[]
}

export interface CurrentState {
  readonly taskRevision: number
  readonly assignmentId: string | null
  readonly now: string
}

export function submitAssessment(record: AssessmentRecord, packet: MemoryPacket, current: CurrentState, store: CapabilityMemoryStore, snapshot?: AssessSnapshot): SubmitResult {
  const p = record.proposal
  const res = (accepted: boolean, code: SubmitCode, detail: string, fallback: SubmitResult['fallback'] = null, checks: string[] = []): SubmitResult => ({ accepted, code, detail, proposal: p, fallback, checks })
  if (record.failure || !p) return res(false, 'model_failed', record.failure ? `${record.failure.code}: ${record.failure.detail}` : 'no proposal')
  const id = record.identity
  if (current.taskRevision !== id.taskRevision) return res(false, 'stale_revision', `${id.taskRevision} -> ${current.taskRevision}`)
  if (current.assignmentId !== id.assignmentId) return res(false, 'stale_assignment', `${id.assignmentId} -> ${current.assignmentId}`)
  const relevant = store.logSince(id.memoryCursor).filter((r) => r.kind !== 'extraction' && (r.scopes.includes(id.taskId) || r.scopes.includes('global')))
  if (relevant.length > 0) return res(false, 'stale_memory', `memory advanced for task: ${relevant.map((r) => `${r.kind}:${r.ref}`).join(',')}`)

  const known = new Set(id.sourceRefs)
  const nonActionable = new Set(packet.context.nonActionable.map((i) => i.itemId))
  const retracted = store.retractedTurns()
  const checks: string[] = []
  // 引用清洗：未知/已撤回/已失效引用逐个剔除并记录（属于 guard 前错误）；只有剔除后不剩任何有效依据才拒绝整个动作
  const bad = (ref: string) => !known.has(ref) || retracted.has(ref)
  const allRefs = [...p.evidenceTurnIds, ...p.evidenceItemIds]
  const unknown = allRefs.filter(bad)
  const stale = p.evidenceItemIds.filter((x) => !bad(x) && nonActionable.has(x))
  const evidenceTurnIds = p.evidenceTurnIds.filter((x) => !bad(x))
  const evidenceItemIds = p.evidenceItemIds.filter((x) => !bad(x) && !nonActionable.has(x))
  const answerFacts = p.answerFacts.map((f) => ({ ...f, sourceTurnIds: f.sourceTurnIds.filter((x) => !bad(x)) }))
  const factUnknown = p.answerFacts.flatMap((f) => f.sourceTurnIds).filter(bad)
  if (unknown.length) checks.push(`dropped_unknown_refs:${unknown.join(',')}`)
  if (factUnknown.length) checks.push(`dropped_unknown_fact_refs:${factUnknown.join(',')}`)
  if (stale.length) checks.push(`dropped_non_actionable_refs:${stale.join(',')}`)
  const remaining = evidenceTurnIds.length + evidenceItemIds.length
  // 依赖旧值：被引用的失效条目有不同取值的当前继任者、而继任者未被引用 → 这是按旧版本行动，拒绝
  const activeItems = [...packet.currentFacts, ...packet.preferences, ...packet.commitments, ...packet.outcomes]
  const staleItems = packet.context.nonActionable.filter((i) => stale.includes(i.itemId))
  const reliesOnOld = staleItems.filter((o) => {
    const succ = activeItems.filter((a) => a.supersedes.includes(o.itemId) || o.supersededBy.includes(a.itemId))
    return succ.some((a) => a.value !== o.value) && !succ.some((a) => p.evidenceItemIds.includes(a.itemId))
  })
  if (reliesOnOld.length > 0) return res(false, 'evidence_not_actionable', `relies on superseded value ${reliesOnOld.map((o) => `${o.itemId}=${JSON.stringify(o.value)}`).join(',')}`)
  if (allRefs.length > 0 && remaining === 0) {
    if (stale.length > 0) return res(false, 'evidence_not_actionable', `cited only superseded/expired items ${stale.join(',')}`)
    return res(false, 'evidence_unknown', `cited ${unknown.join(',')} not in packet`)
  }
  if (factUnknown.length > 0 && remaining === 0) return res(false, 'evidence_unknown', `answer facts cite unknown ${factUnknown.join(',')}`)
  const offeredIds = new Set((snapshot?.options ?? []).map((o) => o.optionId))
  const askBadOpts = p.kind === 'ask' ? p.optionIds.filter((o) => !offeredIds.has(o)) : []
  const askOpts = p.kind === 'ask' ? p.optionIds.filter((o) => offeredIds.has(o)) : p.optionIds
  if (askBadOpts.length && askOpts.length) checks.push(`dropped_unoffered_options:${askBadOpts.join(',')}`)
  const cleaned: { -readonly [K in keyof Proposal]: Proposal[K] } = { ...p, evidenceTurnIds, evidenceItemIds, answerFacts, optionIds: askBadOpts.length && askOpts.length ? askOpts : p.optionIds }
  const res2 = (accepted: boolean, code: SubmitCode, detail: string, fallback: SubmitResult['fallback'] = null, extra: string[] = []): SubmitResult => ({ accepted, code, detail, proposal: cleaned, fallback, checks: [...checks, ...extra] })
  if ((p.kind === 'ask' || p.kind === 'act') && remaining === 0) {
    return res2(false, 'evidence_missing', `${p.kind} without evidence`, { kind: 'ask', reasonCode: 'insufficient_evidence' })
  }
  if (p.kind === 'wait') {
    // 共享等待契约：wait 必须引用有效证据；wakeAt 只能是 (a) 被引用证据里给出的明确时间（ETA/截止）或 (b) 宿主给的有界复查时刻；
    // 其他时间（如无依据的 +24h、当前时间）一律改为有界复查并记录；不伪造事实时间，也不改成去问用户。
    const nowMs = Date.parse(current.now)
    const future = (v: string | null | undefined) => !!v && Number.isFinite(Date.parse(v)) && Date.parse(v) > nowMs
    if (remaining === 0) return res2(false, 'evidence_missing', 'wait without cited evidence')
    const citedItems = activeItems.filter((i) => evidenceItemIds.includes(i.itemId))
    const turnText = new Map([...packet.evidenceRefs, ...packet.context.recentTurns].map((r) => [r.turnId, store.turn(r.turnId)?.text ?? r.quote]))
    const anchors: { at: string; src: string }[] = []
    for (const i of citedItems) for (const v of [i.value, i.validUntil]) if (typeof v === 'string' && future(v)) anchors.push({ at: new Date(Date.parse(v)).toISOString(), src: i.itemId })
    for (const t of evidenceTurnIds) for (const m of (turnText.get(t) ?? '').match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})/g) ?? []) if (future(m)) anchors.push({ at: new Date(Date.parse(m)).toISOString(), src: t })
    const near = (x: string, y: string) => Math.abs(Date.parse(x) - Date.parse(y)) <= 2000
    const bounded = snapshot?.waitContract?.boundedRecheckAt && future(snapshot.waitContract.boundedRecheckAt) ? snapshot.waitContract.boundedRecheckAt : null
    const memAnchor = (key: string) => activeItems.filter((i) => i.key === key).map((i) => ({ id: i.itemId, at: typeof i.value === 'string' && future(i.value) ? i.value : future(i.validUntil) ? i.validUntil : null })).filter((x) => x.at).sort((x, y) => Date.parse(x.at!) - Date.parse(y.at!))[0]
    let wakeAt: string | null = p.wakeAt
    const hit = wakeAt && future(wakeAt) ? anchors.find((a2) => near(a2.at, wakeAt!)) : undefined
    if (hit) checks.push(`wakeAt_from_evidence:${hit.src}`)
    else if (wakeAt && future(wakeAt) && bounded && Date.parse(wakeAt) <= Date.parse(bounded)) checks.push('wakeAt_within_bounded_recheck')
    else if (bounded) { checks.push(`wakeAt_unsupported:${p.wakeAt}->bounded:${bounded}`); wakeAt = bounded }
    else {
      const e = anchors.sort((x, y) => Date.parse(x.at) - Date.parse(y.at))[0] ?? (() => { const m = memAnchor('expectedUpdateAt') ?? memAnchor('decisionDeadline'); return m ? { at: m.at!, src: m.id } : undefined })()
      if (!e) return res2(false, 'wait_without_recheck', `wakeAt=${p.wakeAt}; no cited time and no host bounded recheck`, { kind: 'ask', reasonCode: 'insufficient_evidence' })
      checks.push(`wakeAt_repaired:${p.wakeAt}->${e.at}@${e.src}`)
      wakeAt = e.at
    }
    let deadlineAt: string | null = p.deadlineAt
    if (deadlineAt && !(future(deadlineAt) && (anchors.some((a2) => near(a2.at, deadlineAt!)) || activeItems.some((i) => i.key === 'decisionDeadline' && typeof i.value === 'string' && near(i.value, deadlineAt!))))) {
      const d = memAnchor('decisionDeadline')
      checks.push(`deadlineAt_unsupported:${deadlineAt}${d ? `->${d.at}@${d.id}` : '->dropped'}`)
      deadlineAt = d ? d.at : null
    }
    if (deadlineAt && Date.parse(wakeAt!) >= Date.parse(deadlineAt)) {
      return res2(false, 'wait_past_deadline', `wakeAt ${wakeAt} >= deadline ${deadlineAt}`, { kind: 'ask', reasonCode: 'deadline_risk' })
    }
    ;(cleaned as any).wakeAt = wakeAt
    ;(cleaned as any).deadlineAt = deadlineAt
  }
  if (p.kind === 'act' || (p.kind === 'ask' && cleaned.optionIds.length > 0)) {
    const bad = cleaned.optionIds.filter((o) => !offeredIds.has(o))
    if (bad.length > 0) return res2(false, 'option_not_offered', bad.join(','))
    if (p.kind === 'act' && p.optionIds.length !== 1) return res2(false, 'option_not_offered', 'act needs exactly one optionId')
  }
  if (p.kind === 'digest' && !p.deliverAt) checks.push('digest_without_deliverAt:deliver_on_next_window')
  return res2(true, 'accepted', 'ok')
}
