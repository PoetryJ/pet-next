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
记忆包有 conflicts 或 missing 影响决定时，不要猜，应 ask 澄清。
输出格式：{"kind":"...","reasonCode":"...","question":"或null","optionIds":[],"wakeAt":"或null","waitFor":"或null","deadlineAt":"或null","deliverAt":"或null","batchable":true或false,"evidenceTurnIds":["原话id"],"evidenceItemIds":["条目itemId"],"answerFacts":[{"key":"字段","value":标量,"sourceTurnIds":["原话id"]}]}
所有时间（wakeAt/deadlineAt/deliverAt）必须是带时区的绝对 ISO8601，且晚于 snapshot.now；从原话里的相对时间按原话时间换算。
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

export function buildAssessRequest(snapshot: AssessSnapshot, packet: MemoryPacket, question?: AssessQuestion): ModelRequest {
  const user = JSON.stringify({ snapshot, memory: packet, ...(question ? { question } : {}) })
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
export async function assess(snapshot: AssessSnapshot, packet: MemoryPacket, signal: AbortSignal | undefined, client: ModelClient, question?: AssessQuestion): Promise<AssessmentRecord> {
  const identity = identityOf(snapshot, packet)
  const request = buildAssessRequest(snapshot, packet, question)
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
  for (const ref of [...p.evidenceTurnIds, ...p.evidenceItemIds, ...p.answerFacts.flatMap((f) => f.sourceTurnIds)]) {
    if (!known.has(ref)) return res(false, 'evidence_unknown', `cited ${ref} not in packet`)
    if (retracted.has(ref)) return res(false, 'evidence_unknown', `cited retracted turn ${ref}`)
  }
  const staleCites = p.evidenceItemIds.filter((x) => nonActionable.has(x))
  if (staleCites.length > 0) return res(false, 'evidence_not_actionable', `cited superseded/expired items ${staleCites.join(',')}`)
  if ((p.kind === 'ask' || p.kind === 'act') && p.evidenceTurnIds.length + p.evidenceItemIds.length === 0) {
    return res(false, 'evidence_missing', `${p.kind} without evidence`, { kind: 'ask', reasonCode: 'insufficient_evidence' })
  }
  if (p.kind === 'wait') {
    if (!p.wakeAt || !Number.isFinite(Date.parse(p.wakeAt)) || Date.parse(p.wakeAt) <= Date.parse(current.now)) {
      return res(false, 'wait_without_recheck', `wakeAt=${p.wakeAt}`, { kind: 'ask', reasonCode: 'insufficient_evidence' })
    }
    if (p.deadlineAt && Number.isFinite(Date.parse(p.deadlineAt)) && Date.parse(p.wakeAt) >= Date.parse(p.deadlineAt)) {
      return res(false, 'wait_past_deadline', `wakeAt ${p.wakeAt} >= deadline ${p.deadlineAt}`, { kind: 'ask', reasonCode: 'deadline_risk' })
    }
  }
  if (p.kind === 'act' || (p.kind === 'ask' && p.optionIds.length > 0)) {
    const offered = new Set((snapshot?.options ?? []).map((o) => o.optionId))
    const bad = p.optionIds.filter((o) => !offered.has(o))
    if (bad.length > 0) return res(false, 'option_not_offered', bad.join(','))
    if (p.kind === 'act' && p.optionIds.length !== 1) return res(false, 'option_not_offered', 'act needs exactly one optionId')
  }
  if (p.kind === 'digest' && !p.deliverAt) checks.push('digest_without_deliverAt:deliver_on_next_window')
  return res(true, 'accepted', 'ok', null, checks)
}
