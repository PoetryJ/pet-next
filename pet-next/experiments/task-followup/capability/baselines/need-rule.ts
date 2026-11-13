/**
 * Strong NeedRule intervention baseline. Shares extraction, packet, host menu,
 * cancellation validation, cooldown, scheduler and execution with the candidate.
 * Only the intervention step is deterministic; model-backed extraction is NOT
 * labelled model-free. No trajectory, expected answer, future event or case ID.
 */
import type { AssessmentDraft, AssessmentResponse, AssessmentSnapshot, AsyncAssessor } from '../../runtime/assessment.ts'
import type { MemoryPacket, PacketItem } from '../memory/types.ts'
import type { CapabilityMemoryStore } from '../memory/store.ts'
import type { ModelClient } from '../model/protocol.ts'
import { extractPending } from '../memory/extract.ts'
import { readForDecision } from '../memory/read.ts'
import { timeLike } from '../memory/attributes.ts'

export const NEED_RULE_VERSION = 'strong-need-rule/v1'
export const SHARED_READ_SLOTS = ['sampleCount', 'baselineVersion', 'experimentId', 'allowedActions', 'notificationPolicy', 'waitPolicy', 'decisionDeadline'] as const
export interface NeedRuleConfig {
  /** Must equal the candidate host setting in a comparison. */
  readonly recheckMs?: number
  /** Reserve time for a user answer before a known deadline. */
  readonly answerLeadMs?: number
}
export interface RuleTrace {
  readonly rule: string
  readonly detail: string
  readonly itemIds: readonly string[]
  readonly turnIds: readonly string[]
}
export interface NeedRuleDecision {
  readonly drafts: readonly AssessmentDraft[]
  readonly taskControl?: AssessmentResponse['taskControl']
  readonly trace: readonly RuleTrace[]
  readonly config: { recheckMs: number; answerLeadMs: number }
}

const cancel = /^(cancelled|canceled|cancel|取消|已取消|终止|停止)$/i
const paused = /^(paused|pause|暂停|已暂停)$/i
const busy = /busy|unavailable|screen.?shar|meeting|忙|不可用|共享|开会/i
const available = /^(available|free|back|active|ready|空闲|可用|有空)$/i
const ms = (v: string) => Date.parse(v)
const ISO = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:\\d{2})'

/** Pure paired-intervention entry: feed the exact candidate snapshot and packet. */
export function decideNeedRule(snapshot: AssessmentSnapshot, packet: MemoryPacket, options: NeedRuleConfig = {}): NeedRuleDecision {
  if (packet.taskId !== snapshot.task.ticketId) throw new Error('NeedRule packet/task mismatch')
  const now = ms(snapshot.now)
  if (!Number.isFinite(now)) throw new Error('NeedRule invalid snapshot.now')
  const config = { recheckMs: options.recheckMs ?? 30 * 60_000, answerLeadMs: options.answerLeadMs ?? 20_000 }
  if (!(config.recheckMs > 0) || !(config.answerLeadMs >= 0)) throw new Error('NeedRule invalid configuration')
  const trace: RuleTrace[] = []
  const note = (rule: string, detail: string, items: readonly PacketItem[] = [], turnIds: readonly string[] = []) => trace.push({ rule, detail, itemIds: items.map((i) => i.itemId), turnIds: [...new Set([...items.flatMap((i) => i.evidenceTurnIds), ...turnIds])] })
  const items = [...packet.currentFacts, ...packet.preferences, ...packet.commitments, ...packet.outcomes].filter((i) => i.status === 'active' && ms(i.validFrom) <= now && (!i.validUntil || ms(i.validUntil) > now) && (i.scope.level === 'global' || i.scope.id === packet.taskId))
  const current = (key: string, userOnly = true) => items.filter((i) => i.key === key && (!userOnly || i.authority === 'user')).sort((a, b) => ms(b.validFrom) - ms(a.validFrom))
  const result = (drafts: readonly AssessmentDraft[], taskControl?: AssessmentResponse['taskControl']): NeedRuleDecision => ({ drafts, ...(taskControl ? { taskControl } : {}), trace, config })
  const none = (code: string, why: string) => { note(code, why); return result([{ intent: 'none', reasonCode: code, reasonText: why }]) }
  if (snapshot.task.status !== 'active' || snapshot.goalSatisfied) return none('task_finished', 'Current task is closed or its completion condition is verified')
  const ask = snapshot.actionMenu.find((m) => m.kind === 'ask_user' && m.options?.length)
  const askNow = (code: string, why: string) => {
    note(code, why)
    if (!ask) return result([{ intent: 'none', reasonCode: 'no_legal_question', reasonText: `${why}; host has no current question menu` }])
    return result([{ intent: 'ask_now', actionId: ask.actionId, question: ask.question, options: ask.options, reasonCode: code, reasonText: why }])
  }
  const statuses = current('taskStatus')
  const status = statuses[0]
  const ambiguousStatus = statuses.some((i) => String(i.value) !== String(status?.value)) || packet.conflicts.some((c) => c.key === 'taskStatus')
  if (status && !ambiguousStatus && cancel.test(String(status.value))) {
    const newerRaw = packet.context.recentTurns.some((t) => t.role === 'user' && ms(t.at) >= ms(status.validFrom) && !status.evidenceTurnIds.includes(t.turnId))
    if (!newerRaw) {
      note('user_cancelled', 'Current user-origin task status cancels the task; host must revalidate before applying', [status])
      return result([], { kind: 'cancel', itemId: status.itemId, reason: `用户取消：${status.statement}` })
    }
    note('cancel_needs_refresh', 'A newer user turn may reverse the stored cancellation', [status])
  }
  const deadlineItem = current('decisionDeadline').find((i) => timeLike(i.value, null, []))
  const deadline = deadlineItem ? ms(String(deadlineItem.value)) : null
  const imminent = deadline !== null && deadline <= now + config.answerLeadMs
  if (deadlineItem) note('deadline_known', `Decision deadline ${String(deadlineItem.value)}`, [deadlineItem])
  const wait = (code: string, why: string, at?: number) => {
    let due = at ?? now + config.recheckMs
    if (deadline !== null && deadline > now) due = Math.min(due, Math.max(now + 1, deadline - config.answerLeadMs))
    due = Math.max(now + 1, due)
    note(code, `${why}; bounded recheck ${new Date(due).toISOString()}`)
    return result([{ intent: 'wait', notBefore: new Date(due).toISOString(), ...(deadline !== null && deadline > now ? { deadline: new Date(deadline).toISOString() } : {}), reasonCode: code, reasonText: why }])
  }
  if (status && !ambiguousStatus && paused.test(String(status.value))) { note('user_paused', 'Pause is a user commitment, not a deadline override', [status]); return none('user_paused', 'Wait for the user to resume; no new question') }
  if (snapshot.openAttention?.status === 'open' && snapshot.openAttention.taskRevision === snapshot.task.taskRevision) return none('current_question_exists', 'The current question remains open; delivery and cooldown belong to the host')

  // Recognized public availability grammar is explicit, logged, and shared across
  // all tasks. Unknown text is not silently interpreted as an availability change.
  const av = current('availability')[0]
  let unavailable = !!av && busy.test(String(av.value)) && !available.test(String(av.value))
  if (av) note('availability', `Current availability=${String(av.value)}`, [av])
  const rawAvailability = packet.context.recentTurns.filter((r) => r.role === 'user' && (!av || ms(r.at) >= ms(av.validFrom))).sort((a, b) => b.seq - a.seq).find((r) => /我回来了|现在有空|共享(?:屏幕)?(?:已)?结束|\b(?:I am back|I['’]m back|available now)\b/i.test(r.quote) && !/没回来|还没|并非|不是|not available|not back/i.test(r.quote))
  if (rawAvailability) { unavailable = false; note('explicit_return', 'New user turn explicitly reports availability', [], [rawAvailability.turnId]) }
  if (imminent && ask) return askNow('deadline_risk', 'Known decision deadline leaves no room for another wait')
  if (unavailable) return wait('user_unavailable', 'User is temporarily unavailable; retain the needed decision', av?.validUntil ? ms(av.validUntil) : undefined)

  const etaItem = current('expectedUpdateAt', false).find((i) => i.authority !== 'assistant' && timeLike(i.value, null, []))
  let eta = etaItem ? ms(String(etaItem.value)) : null
  if (etaItem) note('expected_update', `Referenced update time ${String(etaItem.value)}`, [etaItem])
  // Tool note is the exact current verified result visible to the candidate too.
  const match = snapshot.task.result?.note?.match(new RegExp(`(?:ETA|expected(?: at)?|预计(?:在|于)?)[\\s:：]*(${ISO})`, 'i'))
  if (match && timeLike(match[1], null, [])) { eta = ms(match[1]!); note('current_result_eta', `Current verified result publishes ETA ${match[1]}; resultFileSha=${snapshot.task.result!.resultFileSha}`) }
  const waitPolicies = current('waitPolicy')
  if (waitPolicies.length) note('wait_policy', waitPolicies.map((i) => String(i.value)).join('; '), waitPolicies)
  const doNotWait = waitPolicies.some((i) => /^(do_not_wait|never_wait|ask_immediately|不要等)$/i.test(String(i.value)))
  if (!doNotWait && eta !== null && eta > now && (deadline === null || eta + config.answerLeadMs < deadline)) return wait('useful_update_before_decision', 'Known pending evidence can resolve the decision before its deadline', eta)
  if (eta !== null && eta <= now) note('eta_elapsed', 'Past ETA cannot renew a wait; evaluate the current verified result')
  if (eta !== null && deadline !== null && eta + config.answerLeadMs >= deadline && ask) return askNow('update_too_late', 'The expected update does not leave time for the necessary user decision')
  if (ask) return askNow('current_choice_needed', 'Current host menu requires a user choice and no timely pending evidence or availability constraint justifies delaying it')
  const defer = snapshot.actionMenu.find((m) => m.kind === 'defer')
  if (defer) return wait('await_result', 'No current choice; wait for external evidence', defer.notBefore && ms(defer.notBefore) > now ? ms(defer.notBefore) : undefined)
  const actionable = snapshot.actionMenu.find((m) => m.kind === 'notify_result' || m.kind === 'continue_local')
  if (actionable) { note('host_menu_continuation', `Only existing host action ${actionable.actionId}`); return result([{ intent: 'act', actionId: actionable.actionId, reasonCode: 'host_menu_continuation', reasonText: actionable.reasonText }]) }
  return none('no_current_action', 'No current question or executable host action')
}

export interface NeedRuleAssessorOptions extends NeedRuleConfig {
  /** The same host-owned SQLite connection/store as the candidate. */
  readonly store: CapabilityMemoryStore
  /** Supply for online shared extraction. Omit only for paired fixed-packet/replay. */
  readonly extractionClient?: ModelClient
  readonly now?: () => string
}

/** Product AsyncAssessor adapter; host controls cancellation validation and I/O. */
export function createNeedRuleAssessor(options: NeedRuleAssessorOptions): AsyncAssessor {
  return {
    id: `${NEED_RULE_VERSION}:${options.extractionClient ? 'shared-model-extraction' : 'precompiled-memory'}`,
    capability: false,
    async assess(snapshot, _runtimePacket, signal) {
      if (signal.aborted) throw signal.reason ?? new Error('aborted')
      const now = options.now?.() ?? new Date().toISOString()
      const extraction = options.extractionClient ? await extractPending(options.store, options.extractionClient, { entities: [{ id: snapshot.task.ticketId, type: 'task', label: snapshot.task.title }], now, signal, maxTurns: 3, roles: ['user', 'assistant'], maxTokens: 1536, taskId: snapshot.task.ticketId }) : null
      if (extraction && extraction.status !== 'nothing' && extraction.status !== 'applied') throw new Error(`provider_error: shared extraction ${extraction.status}: ${extraction.detail ?? ''}`)
      if (signal.aborted) throw signal.reason ?? new Error('aborted')
      const packet = readForDecision(options.store, { taskId: snapshot.task.ticketId, asOf: now, intent: 'current', question: `${snapshot.task.title} 当前结果、授权范围、通知偏好与等待条件`, requiredSlots: SHARED_READ_SLOTS, budget: { maxItems: 24, maxChars: 4500 } })
      const decision = decideNeedRule({ ...snapshot, now }, packet, options)
      return {
        drafts: decision.drafts, ...(decision.taskControl ? { taskControl: decision.taskControl } : {}),
        raw: { provider: 'deterministic-intervention', model: 'none (intervention only; extraction may use model)', rawOutput: JSON.stringify(decision), requestPayload: { snapshot: { ...snapshot, now }, memory: packet }, meta: { baseline: NEED_RULE_VERSION, extraction: extraction ? { status: extraction.status, requestId: extraction.request?.requestId ?? null, model: extraction.response?.model ?? null } : 'precompiled-memory', trace: decision.trace, config: decision.config } },
      }
    },
  }
}
