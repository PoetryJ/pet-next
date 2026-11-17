/**
 * 求值上下文：只用宿主已核验的输入构造 EvalContext，不读模型摘要。
 *
 * 事实来源（第一批）：
 * - task:<id>.result.present/total/passed/failed/revision/status —— 来自宿主已发布的结果文件
 * - user.availability —— 来自用户有效记忆（偏好/事实）
 * - clock.nowMs —— 宿主时钟，日期由宿主换算成毫秒
 *
 * 未在委托中声明的任务不产生任何字段：字段不可见，条件无法引用。
 * 缺失 ≠ false：没有 currentBinding 的事实一律 unknown（内核负责判定）。
 *
 * @module capability/conditions/context
 */
import { createHash } from 'node:crypto'
import {
  CLOCK_NOW_FACT, USER_AVAILABILITY_FACT, defaultFactDeclarations, taskFact,
} from './plan-types.ts'
import type { Binding, EvalContext, Fact } from './kernel.ts'
import type { VerifiedInputs, VerifiedResult } from './plan-types.ts'
import type { MemoryPacket, PacketItem } from '../memory/types.ts'
import type { TaskSnapshot } from '../../contracts.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** 宿主扫描过目录但没有结果文件时，才允许给出带扫描依据的 present=false。 */
export interface ResultScan {
  readonly at: string
  /** 扫描目录/清单的来源摘要，证明“确实找过”而不是漏看。 */
  readonly listingSha256: string
  readonly sourceId: string
}

export interface ContextInputs extends VerifiedInputs {
  readonly scan?: ResultScan | null
  /** R6-live：每个已声明来源各自的最新核验结果；缺省时退回单来源 inputs.result。 */
  readonly resultsByTask?: Readonly<Record<string, VerifiedResult | null>> | null
}

const AVAILABILITY_KEYS = /^(availability|useravailability|user_availability|可用性|在线状态)$/i

function availabilityFact(packet: MemoryPacket, now: string, taskId: string): Fact | null {
  const candidates = [...packet.preferences, ...packet.currentFacts]
    .filter((i: PacketItem) => i.authority === 'user' && i.status === 'active' && AVAILABILITY_KEYS.test(i.key))
    // 作用域：只接受 global 或本任务；别的任务的“忙”不能代表这个任务
    .filter((i: PacketItem) => i.scope.level === 'global' || (i.scope.level === 'task' && i.scope.id === taskId))
    // 有效期：已过期的可用性不再生效，交给未知
    .filter((i: PacketItem) => !i.validUntil || Date.parse(i.validUntil) > Date.parse(now))
  const values = new Set(candidates.map((i: PacketItem) => String(i.value ?? '')))
  if (values.size > 1) return null // 冲突 → unknown，不猜哪条对
  const item = candidates.at(-1)
  if (!item) return null
  const quote = item.evidenceTurnIds.length > 0 ? item.evidenceTurnIds.join('|') : item.itemId
  const binding: Binding = { sourceId: 'user:memory', version: String(item.evidenceTurnIds.length), sha256: sha(quote) }
  return {
    value: String(item.value ?? ''),
    binding,
    observedAt: item.validFrom <= now ? item.validFrom : now,
    ...(item.validUntil ? { validUntil: item.validUntil } : {}),
  }
}

/** 结果事实：present 只有在宿主已核验结果、或宿主完整扫描后确认不存在时才给出。 */
function resultFacts(taskId: string, inputs: ContextInputs): { facts: Record<string, Fact>; bindings: Record<string, Binding> } {
  const facts: Record<string, Fact> = {}
  const bindings: Record<string, Binding> = {}
  if (!inputs.declaredTasks.includes(taskId)) return { facts, bindings }
  const result = inputs.resultsByTask
    ? inputs.resultsByTask[taskId] ?? null
    : taskId === inputs.taskId ? inputs.result : null
  if (result) {
    const binding: Binding = { sourceId: `result:${taskId}`, version: String(result.revision), sha256: result.resultFileSha }
    bindings[binding.sourceId] = binding
    const put = (name: Parameters<typeof taskFact>[1], value: Fact['value'], validUntil?: string) => {
      facts[taskFact(taskId, name)] = { value, binding, observedAt: result.observedAt, ...(validUntil ? { validUntil } : {}) }
    }
    put('result.present', true)
    put('result.total', result.metrics.total)
    put('result.passed', result.metrics.passed)
    put('result.failed', result.metrics.failed)
    put('result.revision', result.revision)
    put('result.status', result.status)
    return { facts, bindings }
  }
  const scan = inputs.scan
  if (scan) {
    // 完整扫描且文件不存在：present=false 有扫描依据；其它字段仍然缺失（unknown），不能当成 0。
    const binding: Binding = { sourceId: scan.sourceId, version: '0', sha256: scan.listingSha256 }
    bindings[binding.sourceId] = binding
    facts[taskFact(taskId, 'result.present')] = { value: false, binding, observedAt: scan.at }
  }
  return { facts, bindings }
}

/**
 * 构造求值上下文。`snapshot` 只用于确认任务身份与当前时钟，不从中取“模型摘要”。
 * 未声明任务：不产生字段，条件若引用会被内核按未知字段拒绝。
 */
export function makeContext(snapshot: TaskSnapshot, packet: MemoryPacket, inputs: ContextInputs, now: string): EvalContext {
  const declared = [...new Set(inputs.declaredTasks)]
  const allowedFacts = defaultFactDeclarations(declared).map((f) => f.id)
  const facts: Record<string, Fact> = {}
  const currentBindings: Record<string, Binding> = {}

  const taskIds = declared
  for (const taskId of taskIds) {
    const r = resultFacts(taskId, inputs)
    Object.assign(facts, r.facts)
    Object.assign(currentBindings, r.bindings)
  }

  if (declared.length > 0) {
    const availability = inputs.userAvailability
      ? {
        value: inputs.userAvailability.value,
        binding: { sourceId: 'user:memory', version: inputs.userAvailability.turnId, sha256: inputs.userAvailability.sha256 } satisfies Binding,
        observedAt: inputs.userAvailability.observedAt,
      }
      : availabilityFact(packet, now, snapshot.ticketId)
    if (availability) {
      facts[USER_AVAILABILITY_FACT] = availability
      currentBindings[availability.binding.sourceId] = availability.binding
    }
    const clockMs = Date.parse(now)
    if (Number.isFinite(clockMs)) {
      const clockBinding: Binding = { sourceId: inputs.clockSourceId ?? 'host:clock', version: '1', sha256: sha(now) }
      facts[CLOCK_NOW_FACT] = { value: clockMs, binding: clockBinding, observedAt: now }
      currentBindings[clockBinding.sourceId] = clockBinding
    }
  }

  return { now, allowedFacts, facts, currentBindings }
}

/** 同一字段名在不同任务下互不可见：用任务前缀隔离，测试里固定这条不变量。 */
export function fieldOwner(factId: string): string | null {
  const m = /^task:([^.]+)\.result\./.exec(factId)
  return m ? m[1]! : null
}
