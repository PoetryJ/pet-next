/**
 * 宿主侧能力适配（集成负责人所有）：把 capability/memory + capability/intervention + 模型适配器
 * 接到 runtime 的事务外 AsyncAssessor 接口上。capability/** 原样使用，不修改。
 *
 * 每次 assess（不持事务）：
 *   extractPending（新原话 → 原子记忆，模型调用 1）→ readForDecision（按任务/时间/作用域检索有效记忆）
 *   → snapshotFromTask + 宿主可执行选项 → capability assess（模型调用 2）→ capability submitAssessment
 *   （证据/选项/等待 guard）→ 映射为 runtime 草案。
 * runtime.submitAssessment 再按“当前”任务核对 taskRevision/assignmentId/memoryCursor/eventCursor，
 * 然后走既有 proposal/notify 校验；guard 前（模型原始提案）与 guard 后结果两层都落库（assessments + cap_assessments）。
 *
 * 映射（H1：工具执行仍需用户在问题里明确授权）：
 *   ask → ask_now（问法可由模型改写；选项只能是宿主菜单中的选项）
 *   act → ask_now（只给被选的那个选项 + 原菜单其余选项；不越过用户授权直接执行工具），记 act_requires_user_authorization
 *   wait → wait（wakeAt 必填，由 runtime 持久化唤醒）
 *   digest / none → 只记录，不打扰
 * capability guard 拒绝：stale_* → 抛出 stale（runtime 记 failed/provider_error 前缀 stale_，下次身份变化重新评估）；
 *   其余拒绝 → 若有 fallback 则按 fallback，否则 none，并在 reasonText 写明拒绝码。
 *
 * @module pet-next/experiments/task-followup/service/capability-assessor
 */
import type { DatabaseSync } from 'node:sqlite'
import { CapabilityMemoryStore } from '../capability/memory/store.ts'
import { extractPending } from '../capability/memory/extract.ts'
import { readForDecision } from '../capability/memory/read.ts'
import { assess as capAssess, repairQuestion, REPAIRABLE, snapshotFromTask, submitAssessment as capSubmit } from '../capability/intervention/assess.ts'
import type { AssessmentRecord, SubmitResult } from '../capability/intervention/assess.ts'
import { ingestVerifiedOutcome, type VerifiedOutcome } from '../capability/memory/verified.ts'
import { InterventionStore } from '../capability/intervention/planner.ts'
import { OpenAICompatibleClient, configFromEnv } from '../capability/model/openai-compatible.ts'
import type { ModelClient } from '../capability/model/protocol.ts'
import type { MemoryPacket as CapPacket, Turn } from '../capability/memory/types.ts'
import type { AssessmentDraft, AssessmentResponse, AssessmentSnapshot, AsyncAssessor } from '../runtime/assessment.ts'
import { decideNeedRule, SHARED_READ_SLOTS } from '../capability/baselines/need-rule.ts'

export interface CapabilityHandle {
  readonly assessor: AsyncAssessor
  readonly attach: (db: DatabaseSync) => void
  /** 宿主写入原话（用户聊天/委托说明）或工具结果；返回是否新写入。 */
  readonly appendTurn: (turn: Omit<Turn, 'seq'> & { seq?: number }) => boolean
  readonly memorySummary: (taskId: string, now: string) => unknown
  /** 宿主已校验的结果：先逐字写入工具原话，再成为 authority=tool 的 outcome 条目（不让模型复述机器字段）。 */
  readonly ingestResult: (turn: Omit<Turn, 'seq'>, taskId: string, outcome: VerifiedOutcome) => boolean
  readonly hostRecheckMs: number
  readonly validateTaskControl: (control: NonNullable<AssessmentResponse['taskControl']>, snapshot: AssessmentSnapshot, now: string) => boolean
  readonly model: { readonly baseUrl: string; readonly name: string; readonly provider: string }
}

/**
 * Qwen3 系列要求 enable_thinking=false、stream=false；适配器本身不带这些字段，
 * 宿主用 fetch 包装在请求体上补齐（不改 capability/**）。
 */
function qwenFetch(base: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>
        body.stream = false
        body.chat_template_kwargs = { ...(body.chat_template_kwargs as object | undefined), enable_thinking: false }
        if (body.max_tokens === undefined) body.max_tokens = 1024
        init = { ...init, body: JSON.stringify(body) }
      } catch {
        // 非 JSON 请求体原样发送
      }
    }
    return base(input, init)
  }) as typeof fetch
}

export class CapabilityNotConfigured extends Error {}

export interface CapabilityHandleOptions {
  /** 共享等待契约：模型未给出可引用的 ETA/截止时，由宿主在这一有界间隔后复查（不伪造事实时间，也不转成向用户提问）。 */
  readonly hostRecheckMs?: number
  readonly intervention?: 'model' | 'need-rule'
}

const ASSESS_MAX = 768
const EXTRACT_MAX = 1536

/** 等待契约：引用的 ETA（记忆条目值/有效期或 guard 的锚点修复）原样采用；否则用宿主有界复查。 */
export function applyWaitContract(record: AssessmentRecord, submit: SubmitResult, packet: CapPacket, now: string, hostRecheckMs: number): { submit: SubmitResult; contract: Record<string, unknown> | null } {
  const p = record.proposal
  if (!p || p.kind !== 'wait') return { submit, contract: null }
  const nowMs = Date.parse(now)
  const hostAt = (deadline: string | null) => {
    let at = nowMs + hostRecheckMs
    if (deadline && Number.isFinite(Date.parse(deadline))) at = Math.min(at, Date.parse(deadline) - 1000)
    return new Date(Math.max(at, nowMs + 1000)).toISOString()
  }
  if (submit.accepted && submit.proposal) {
    const c = submit.proposal
    const items = [...packet.currentFacts, ...packet.preferences, ...packet.commitments, ...packet.outcomes]
    const same = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && Date.parse(v) === Date.parse(c.wakeAt ?? '')
    const citedAnchor = items.find((i) => c.evidenceItemIds.includes(i.itemId) && (same(i.value) || same(i.validUntil)))
    const repaired = submit.checks.some((x) => x.startsWith('wakeAt_repaired:'))
    if (citedAnchor || repaired) return { submit, contract: { source: repaired ? 'guard_anchor' : 'cited_item', itemId: citedAnchor?.itemId ?? null, wakeAt: c.wakeAt, modelWakeAt: p.wakeAt } }
    const wakeAt = hostAt(c.deadlineAt)
    return { submit: { ...submit, proposal: { ...c, wakeAt }, checks: [...submit.checks, `wakeAt_uncited:${p.wakeAt}->host_bounded_recheck:${wakeAt}`] }, contract: { source: 'host_bounded_recheck', reason: 'model wakeAt not anchored to a cited item', modelWakeAt: p.wakeAt, wakeAt, hostRecheckMs } }
  }
  if (!submit.accepted && submit.code === 'wait_without_recheck' && submit.proposal) {
    const wakeAt = hostAt(submit.proposal.deadlineAt)
    return { submit: { ...submit, accepted: true, code: 'accepted', detail: `unknown ETA -> host bounded recheck (${submit.detail})`, proposal: { ...submit.proposal, wakeAt }, fallback: null, checks: [...submit.checks, `wait_unknown_eta->host_bounded_recheck:${wakeAt}`] }, contract: { source: 'host_bounded_recheck', reason: 'unknown ETA', modelWakeAt: p.wakeAt, wakeAt, hostRecheckMs } }
  }
  return { submit, contract: null }
}

export function createCapabilityHandle(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, clientOverride?: ModelClient, handleOptions: CapabilityHandleOptions = {}): CapabilityHandle {
  const hostRecheckMs = handleOptions.hostRecheckMs ?? 30 * 60_000
  const cfg = configFromEnv(env)
  if (!clientOverride && !cfg.ok) throw new CapabilityNotConfigured(`模型未配置：缺 ${cfg.missing.join(', ')}`)
  const client: ModelClient = clientOverride ?? new OpenAICompatibleClient(cfg.ok ? cfg.config : undefined, qwenFetch(fetchImpl))
  let store: CapabilityMemoryStore | null = null
  let plan: InterventionStore | null = null
  const need = (): { store: CapabilityMemoryStore; plan: InterventionStore } => {
    if (!store || !plan) throw new Error('provider_error: capability store not attached to host database')
    return { store, plan }
  }
  let seq = 0
  const taskControl = (taskId: string, now: string): AssessmentResponse['taskControl'] => {
    const { store: s } = need()
    const packet = readForDecision(s, { taskId, asOf: now, intent: 'current', question: '用户当前任务状态', requiredSlots: ['taskStatus'], budget: { maxItems: 8, maxChars: 2000 } })
    const item = [...packet.commitments, ...packet.currentFacts].find((i) => i.key === 'taskStatus' && i.authority === 'user' && i.status === 'active' && i.scope.level === 'task' && i.scope.id === taskId && /^(cancelled|canceled|cancel|取消|已取消|终止|停止)$/i.test(String(i.value)))
    if (!item || packet.conflicts.some((c) => c.itemIds.includes(item.itemId))) return undefined
    const source = s.items().find((i) => i.itemId === item.itemId)!
    // A newer, not-yet-compiled user message may reverse the cancellation.
    if (packet.context.recentTurns.some((t) => t.role === 'user' && t.seq > source.recordedSeq)) return undefined
    return { kind: 'cancel', itemId: item.itemId, reason: `用户取消：${item.statement}` }
  }
  const assessor: AsyncAssessor = {
    id: `${handleOptions.intervention === 'need-rule' ? 'strong-need-rule:shared-extraction' : 'capability'}:${cfg.ok ? cfg.config.model : 'override'}`,
    capability: handleOptions.intervention !== 'need-rule',
    async assess(snapshot: AssessmentSnapshot, _packet, signal): Promise<AssessmentResponse> {
      const { store: s, plan: p } = need()
      const task = snapshot.task
      const extraction = await extractPending(s, client, {
        entities: [{ id: task.ticketId, type: 'task', label: task.title }],
        now: new Date().toISOString(),
        signal,
        maxTurns: 3,
        roles: ['user', 'assistant'],
        maxTokens: EXTRACT_MAX,
        taskId: task.ticketId,
      })
      if (extraction.status === 'failed') throw new Error(`provider_error: memory extraction failed: ${extraction.detail ?? ''}`)
      if (signal.aborted) throw signal.reason ?? new Error('aborted')
      const now = new Date().toISOString()
      const control = taskControl(task.ticketId, new Date().toISOString())
      if (control) return {
        drafts: [], taskControl: control,
        raw: { provider: extraction.response?.model.provider ?? 'persisted-user-memory', model: extraction.response?.model.name ?? 'no-new-model-call', rawOutput: extraction.response?.rawText ?? '', requestPayload: extraction.request ?? null, meta: { taskControl: control, extraction: extraction.report ?? null } },
      }
      const packet = readForDecision(s, {
        taskId: task.ticketId,
        asOf: now,
        intent: 'current',
        question: `${task.title} 当前结果、授权范围、通知偏好与等待条件`,
        requiredSlots: SHARED_READ_SLOTS,
        budget: { maxItems: 24, maxChars: 4500 },
      })
      if (!task.result && !snapshot.actionMenu.some((item) => item.kind === 'ask_user' || item.kind === 'continue_local')) return {
        drafts: [{ intent: 'none', reasonCode: 'await_new_evidence', reasonText: '目录监听持续等待结果；当前无可选行动，不重复占用模型判断。' }],
        raw: { provider: 'event-driven-host', model: 'no-intervention-model-call', rawOutput: '', meta: { extraction: { status: extraction.status, requestId: extraction.request?.requestId ?? null }, memoryPacket: packet, waitsFor: 'new result or user message' } },
      }
      if (handleOptions.intervention === 'need-rule') {
        const ruleSnapshot = { ...snapshot, now }
        const rule = decideNeedRule(ruleSnapshot, packet, { recheckMs: hostRecheckMs })
        return { drafts: rule.drafts, ...(rule.taskControl ? { taskControl: rule.taskControl } : {}), raw: { provider: 'shared-extraction-deterministic-intervention', model: 'none for intervention', rawOutput: JSON.stringify(rule), requestPayload: { snapshot: ruleSnapshot, memory: packet }, meta: { extraction: { status: extraction.status, requestId: extraction.request?.requestId ?? null }, trace: rule.trace, config: rule.config } } }
      }
      const askTemplate = snapshot.actionMenu.find((item) => item.kind === 'ask_user')
      const options = (askTemplate?.options ?? []).map((option) => ({ optionId: option.id, label: option.label }))
      const capSnapshot = snapshotFromTask(task, now, options)
      // The model sees the same bounded wake option that the submission guard uses.
      const currentSnapshot = { ...capSnapshot, waitContract: { boundedRecheckAt: new Date(Date.now() + hostRecheckMs).toISOString() } }
      const baseQ = { text: '此刻该做什么：等待、马上问我、合并到摘要、直接执行某个选项，还是什么都不做？', requestedFactKeys: [] as string[] }
      let record = await capAssess(currentSnapshot, packet, signal, client, baseQ, ASSESS_MAX)
      let submit = capSubmit(record, packet, { taskRevision: task.taskRevision, assignmentId: task.assignmentId, now: new Date().toISOString() }, s, currentSnapshot)
      let first: Record<string, unknown> | null = null
      // 等待契约优先：未知 ETA 不是错误，由宿主有界复查，不触发修复/提问
      let wc = applyWaitContract(record, submit, packet, new Date().toISOString(), hostRecheckMs)
      submit = wc.submit
      // 至多一次定向修复重评（第一次原始输出照样落库）
      if (!submit.accepted && REPAIRABLE.includes(submit.code) && record.failure?.code !== 'timeout' && !signal.aborted) {
        p.logAssessment(record, submit, null, now)
        first = { requestId: record.request.requestId, rawText: record.rawText, code: submit.code, detail: submit.detail, proposal: record.proposal }
        record = await capAssess(currentSnapshot, packet, signal, client, repairQuestion(submit, baseQ), ASSESS_MAX)
        submit = capSubmit(record, packet, { taskRevision: task.taskRevision, assignmentId: task.assignmentId, now: new Date().toISOString() }, s, currentSnapshot)
        wc = applyWaitContract(record, submit, packet, new Date().toISOString(), hostRecheckMs)
        submit = wc.submit
      }
      p.logAssessment(record, submit, null, now)
      const raw = {
        provider: record.model?.provider ?? (cfg.ok ? cfg.config.provider : 'override'),
        model: record.model?.name ?? (cfg.ok ? cfg.config.model : 'unknown'),
        rawOutput: record.rawText ?? '',
        requestPayload: record.request,
        meta: { extraction: { status: extraction.status, detail: extraction.detail ?? null }, firstAttemptRejected: first, capabilitySubmit: submit, waitContract: wc.contract, memoryPacket: packet, capabilityIdentity: record.identity, sessionId: record.sessionId },
      }
      if (record.failure) throw new Error(`${record.failure.code === 'parse_error' ? 'parse_error' : 'provider_error'}: capability assess ${record.failure.code}: ${record.failure.detail}`)
      const proposal = (submit.proposal ?? record.proposal)!
      if (!submit.accepted && submit.code.startsWith('stale_')) throw new Error(`provider_error: ${submit.code} ${submit.detail}`)
      // 修复一次仍被拒：不自动当授权、不转成提问，只记录（等下一次证据变化再评估）
      const kind = submit.accepted ? proposal.kind : 'none'
      const why = submit.accepted ? `${proposal.reasonCode}` : `capability guard 拒绝 ${submit.code}（${submit.detail}）；修复一次仍被拒→只记录，等待下一次证据变化`
      const drafts: AssessmentDraft[] = []
      const optionList = askTemplate?.options ?? []
      if ((kind === 'ask' || kind === 'act') && askTemplate) {
        const chosen = proposal.optionIds.length ? optionList.filter((option) => proposal.optionIds.includes(option.id)) : optionList
        const ordered = [...chosen, ...optionList.filter((option) => !chosen.includes(option))]
        drafts.push({
          intent: 'ask_now',
          actionId: askTemplate.actionId,
          reasonCode: kind === 'act' ? 'act_requires_user_authorization' : `cap_${proposal.reasonCode}`,
          reasonText: `${why}${kind === 'act' ? '；模型建议直接执行，但工具执行须由用户授权，改为提问' : ''}`,
          ...(submit.accepted && proposal.question ? { question: proposal.question } : {}),
          options: ordered,
          ...(proposal.deadlineAt ? { deadline: proposal.deadlineAt } : {}),
        })
      } else if (kind === 'wait' && submit.accepted && proposal.wakeAt) {
        const src = wc.contract?.source === 'host_bounded_recheck' ? '宿主有界复查' : '引用的预计时间'
        drafts.push({ intent: 'wait', reasonCode: `cap_${proposal.reasonCode}`, reasonText: `${why}；等待：${proposal.waitFor ?? '新证据'}；复查时间来自${src}`, notBefore: proposal.wakeAt, ...(proposal.deadlineAt ? { deadline: proposal.deadlineAt } : {}) })
      } else if (kind === 'digest') {
        drafts.push({ intent: 'digest', reasonCode: `cap_${proposal.reasonCode}`, reasonText: why })
      } else {
        drafts.push({ intent: 'none', reasonCode: `cap_${proposal.reasonCode}`, reasonText: why })
      }
      return { drafts, raw }
    },
  }
  return {
    assessor,
    attach(db: DatabaseSync) {
      store = new CapabilityMemoryStore(db)
      plan = new InterventionStore(db)
      seq = (store.turns().at(-1)?.seq ?? 0)
    },
    appendTurn(turn) {
      const { store: s } = need()
      if (s.turns().some((existing) => existing.turnId === turn.turnId)) return false
      seq += 1
      s.appendTurn({ ...turn, seq: turn.seq ?? seq } as Turn)
      return true
    },
    ingestResult(turn, taskId, outcome) {
      const { store: s } = need()
      if (!s.turns().some((existing) => existing.turnId === turn.turnId)) {
        seq += 1
        s.appendTurn({ ...turn, seq } as Turn)
      }
      ingestVerifiedOutcome(s, s.turn(turn.turnId)!, taskId, outcome, turn.at)
      return true
    },
    hostRecheckMs,
    validateTaskControl(control, snapshot, now) {
      const current = taskControl(snapshot.task.ticketId, now)
      return !!current && current.kind === control.kind && current.itemId === control.itemId
    },
    memorySummary(taskId: string, now: string) {
      const { store: s } = need()
      return readForDecision(s, { taskId, asOf: now, intent: 'current', question: '', requiredSlots: [], budget: { maxItems: 20, maxChars: 3000 } })
    },
    model: { baseUrl: cfg.ok ? cfg.config.baseUrl : 'override', name: cfg.ok ? cfg.config.model : 'override', provider: cfg.ok ? cfg.config.provider : 'override' },
  }
}
