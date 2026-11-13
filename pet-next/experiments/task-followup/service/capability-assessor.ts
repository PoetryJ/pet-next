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
import { assess as capAssess, snapshotFromTask, submitAssessment as capSubmit } from '../capability/intervention/assess.ts'
import { InterventionStore } from '../capability/intervention/planner.ts'
import { OpenAICompatibleClient, configFromEnv } from '../capability/model/openai-compatible.ts'
import type { ModelClient } from '../capability/model/protocol.ts'
import type { Turn } from '../capability/memory/types.ts'
import type { AssessmentDraft, AssessmentResponse, AssessmentSnapshot, AsyncAssessor } from '../runtime/assessment.ts'

export interface CapabilityHandle {
  readonly assessor: AsyncAssessor
  readonly attach: (db: DatabaseSync) => void
  /** 宿主写入原话（用户聊天/委托说明）或工具结果；返回是否新写入。 */
  readonly appendTurn: (turn: Omit<Turn, 'seq'> & { seq?: number }) => boolean
  readonly memorySummary: (taskId: string, now: string) => unknown
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

export function createCapabilityHandle(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, clientOverride?: ModelClient): CapabilityHandle {
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
  const assessor: AsyncAssessor = {
    id: `capability:${cfg.ok ? cfg.config.model : 'override'}`,
    capability: true,
    async assess(snapshot: AssessmentSnapshot, _packet, signal): Promise<AssessmentResponse> {
      const { store: s, plan: p } = need()
      const task = snapshot.task
      const now = new Date().toISOString()
      const extraction = await extractPending(s, client, {
        entities: [{ id: task.ticketId, type: 'task', label: task.title }],
        now,
        signal,
      })
      if (extraction.status === 'failed') throw new Error(`provider_error: memory extraction failed: ${extraction.detail ?? ''}`)
      const packet = readForDecision(s, {
        taskId: task.ticketId,
        asOf: now,
        intent: 'current',
        question: `${task.title}：${task.goal}。此刻需要用户做什么？`,
        requiredSlots: [],
        budget: { maxItems: 40, maxChars: 6000 },
      })
      const askTemplate = snapshot.actionMenu.find((item) => item.kind === 'ask_user')
      const options = (askTemplate?.options ?? []).map((option) => ({ optionId: option.id, label: option.label }))
      const capSnapshot = snapshotFromTask(task, now, options)
      const record = await capAssess(capSnapshot, packet, signal, client)
      const submit = capSubmit(record, packet, { taskRevision: task.taskRevision, assignmentId: task.assignmentId, now }, s, capSnapshot)
      p.logAssessment(record, submit, null, now)
      const raw = {
        provider: record.model?.provider ?? (cfg.ok ? cfg.config.provider : 'override'),
        model: record.model?.name ?? (cfg.ok ? cfg.config.model : 'unknown'),
        rawOutput: record.rawText ?? '',
        requestPayload: record.request,
        meta: { extraction: { status: extraction.status, detail: extraction.detail ?? null }, capabilitySubmit: submit, memoryPacket: packet, capabilityIdentity: record.identity, sessionId: record.sessionId },
      }
      if (record.failure) throw new Error(`${record.failure.code === 'parse_error' ? 'parse_error' : 'provider_error'}: capability assess ${record.failure.code}: ${record.failure.detail}`)
      const proposal = record.proposal!
      if (!submit.accepted && submit.code.startsWith('stale_')) throw new Error(`provider_error: ${submit.code} ${submit.detail}`)
      const kind = submit.accepted ? proposal.kind : submit.fallback?.kind ?? 'none'
      const why = submit.accepted ? `${proposal.reasonCode}` : `capability guard 拒绝 ${submit.code}（${submit.detail}）→ ${kind}`
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
        drafts.push({ intent: 'wait', reasonCode: `cap_${proposal.reasonCode}`, reasonText: `${why}；等待：${proposal.waitFor ?? '新证据'}`, notBefore: proposal.wakeAt, ...(proposal.deadlineAt ? { deadline: proposal.deadlineAt } : {}) })
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
    memorySummary(taskId: string, now: string) {
      const { store: s } = need()
      return readForDecision(s, { taskId, asOf: now, intent: 'current', question: '', requiredSlots: [], budget: { maxItems: 20, maxChars: 3000 } })
    },
    model: { baseUrl: cfg.ok ? cfg.config.baseUrl : 'override', name: cfg.ok ? cfg.config.model : 'override', provider: cfg.ok ? cfg.config.provider : 'override' },
  }
}
