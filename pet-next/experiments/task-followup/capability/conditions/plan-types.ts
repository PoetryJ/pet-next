/**
 * R6 冻结接口：条件承诺的编译产物、事实声明、求值上下文与存储契约。
 *
 * 判定语义只来自 conditions-kernel.ts（Strong Kleene 三值逻辑）；
 * 本文件只固定 I/O 形状与身份字段，不含模型调用、存储实现或行动选择。
 * A/B/D/E 各自按此文件实现，接口由集成负责人冻结后不再改语义。
 *
 * @module capability/conditions/plan-types
 */
import { createHash } from 'node:crypto'
import type { EvalContext, Expr, Fact, Binding } from './kernel.ts'
import type { ModelClient } from '../model/protocol.ts'
import type { MemoryPacket } from '../memory/types.ts'
import type { TaskSnapshot } from '../../contracts.ts'
import type { Tri } from './kernel.ts'

export const CONDITION_SCHEMA = 'pet-conditions/v1' as const
export type ConditionSchema = typeof CONDITION_SCHEMA

/** 编译输入预算：该任务选中的记忆 + 近期原话合计不超过 4500 字符（与读取预算同量级）。 */
export const COMPILE_INPUT_CHARS = 4500
/** 单条条件最多引用的原话数：够表达合取/例外，又不让模型堆引用。 */
export const MAX_SOURCE_QUOTES = 6

export type FactType = 'string' | 'number' | 'boolean'

/** 宿主注册的字段：模型只能引用，不能新增字段或任务。 */
export interface FactDeclaration {
  readonly id: string
  readonly type: FactType
  /** 该字段的事实来源（结果文件 / 用户记忆 / 宿主时钟）。 */
  readonly sourceId: string
  readonly note?: string
}

export interface ConditionQuote {
  readonly turnId: string
  /** 承诺只能来自用户原话；assistant/tool 引用一律拒绝。 */
  readonly role: 'user' | 'assistant' | 'tool'
  /** 在 turn.text 中的 UTF-16 半开区间。 */
  readonly start: number
  readonly end: number
  readonly text: string
  readonly sha256: string
}

export interface ConditionPlan {
  readonly schema: ConditionSchema
  readonly taskId: string
  readonly commitmentRevision: number
  readonly compilationKey: string
  readonly bindingRegistrySha256: string
  readonly sourceQuotes: readonly ConditionQuote[]
  readonly when: Expr
  /** 模型明确表示无法编译成有限条件的子句；非空时该 plan 不可行动。 */
  readonly unsupported: readonly string[]
  readonly compiledAt: string
  readonly compilerSha256: string
}

export interface CompileTurn {
  readonly turnId: string
  readonly role: 'user' | 'assistant' | 'tool'
  readonly at: string
  readonly text: string
  readonly sha256: string
}

export interface CompileInput {
  readonly taskId: string
  /** 用户承诺版本；更正/撤回才前进，结果变化不前进。 */
  readonly commitmentRevision: number
  readonly userTurns: readonly CompileTurn[]
  readonly allowedFacts: readonly FactDeclaration[]
  readonly bindingRegistrySha256: string
  readonly compilerSha256: string
  readonly now: string
}

/** 一次原始模型调用的可核对记录（含失败），供成本台账与复现。 */
export interface CompileCall {
  readonly requestId: string
  readonly model: string
  readonly provider: string
  readonly rawText: string
  readonly usage: unknown
  readonly latencyMs: number | null
  readonly startedAt: string
  readonly finishedAt: string
  readonly failure?: { readonly code: string; readonly detail: string } | null
}

export type CompileResult =
  | { readonly status: 'compiled'; readonly plan: ConditionPlan; readonly rawCall: CompileCall; readonly checks: readonly string[] }
  | { readonly status: 'unsupported' | 'error'; readonly reason: string; readonly rawCall: CompileCall | null; readonly checks: readonly string[] }

/** A 实现：编译 = 一次模型调用 + 本地结构/来源校验。 */
export interface ConditionCompiler {
  compile(input: CompileInput, client: ModelClient, signal?: AbortSignal): Promise<CompileResult>
}

/** 宿主已核验的输入：只来自结果文件、用户记忆与宿主时钟，不来自模型摘要。 */
export interface VerifiedInputs {
  readonly taskId: string
  /** 委托中已声明的任务（可读取其字段），未声明任务的字段不可见。 */
  readonly declaredTasks: readonly string[]
  readonly result?: {
    readonly runId: string
    readonly revision: number
    readonly status: string
    readonly metrics: { readonly total: number; readonly passed: number; readonly failed: number; readonly score?: number }
    readonly resultFileSha: string
    readonly artifactSha: string
    readonly observedAt: string
  } | null
  readonly userAvailability?: {
    readonly value: string
    readonly itemId: string
    readonly turnId: string
    readonly sha256: string
    readonly observedAt: string
  } | null
  /** 宿主时钟来源摘要；缺省时用 now 计算，但仍给出稳定 binding。 */
  readonly clockSourceId?: string
}

export interface ConditionEvalRecord {
  readonly taskId: string
  readonly compilationKey: string
  readonly evidenceKey: string
  readonly state: Tri
  readonly watch: readonly string[]
  readonly reads: readonly { fact: string; state: Tri; reason?: string }[]
  readonly action: 'ask' | 'wait' | 'fallback' | 'skip' | 'none'
  readonly at: string
}

/** 字段注册表摘要：排序后的字段 ID/类型 + 已声明任务/来源。不含结果 revision/SHA。 */
export function bindingRegistrySha256(declarations: readonly FactDeclaration[], declaredTasks: readonly string[]): string {
  const facts = [...declarations]
    .map((d) => JSON.stringify([d.id, d.type, d.sourceId]))
    .sort()
  const tasks = [...new Set(declaredTasks)].sort()
  return createHash('sha256').update(JSON.stringify({ facts, tasks })).digest('hex')
}

/** 字段名携带任务身份：`task:<taskId>.result.passed` / `user.availability` / `clock.nowMs`。 */
export function taskFact(taskId: string, name: 'result.present' | 'result.total' | 'result.passed' | 'result.failed' | 'result.revision' | 'result.status'): string {
  return `task:${taskId}.${name}`
}
export const USER_AVAILABILITY_FACT = 'user.availability'
export const CLOCK_NOW_FACT = 'clock.nowMs'

export function declareFact(taskId: string, name: 'result.present' | 'result.total' | 'result.passed' | 'result.failed' | 'result.revision' | 'result.status'): FactDeclaration {
  const type: FactType = name === 'result.status' ? 'string' : name === 'result.present' ? 'boolean' : 'number'
  return { id: taskFact(taskId, name), type, sourceId: `result:${taskId}` }
}

/** 首批允许字段：已声明任务的 result.* + user.availability + clock.nowMs。 */
export function defaultFactDeclarations(declaredTasks: readonly string[]): FactDeclaration[] {
  const names = ['result.present', 'result.total', 'result.passed', 'result.failed', 'result.revision', 'result.status'] as const
  const facts: FactDeclaration[] = []
  for (const taskId of [...new Set(declaredTasks)].sort()) for (const n of names) facts.push(declareFact(taskId, n))
  facts.push({ id: USER_AVAILABILITY_FACT, type: 'string', sourceId: 'user:memory' })
  facts.push({ id: CLOCK_NOW_FACT, type: 'number', sourceId: 'host:clock' })
  return facts
}

export interface ConditionStore {
  get(compilationKey: string): ConditionPlan | null
  /** 先写新完整版本，再切换当前指针；历史编译保留。 */
  put(plan: ConditionPlan): void
  current(taskId: string): ConditionPlan | null
  setCurrent(taskId: string, compilationKey: string): void
  history(taskId: string): readonly ConditionPlan[]
  /** 承诺指纹变化时前进版本（单调），未变化返回原版本。 */
  revision(taskId: string, fingerprint: string, at: string): number
  /** 同一证据版本上的同一个干预只做一次；返回 false 表示已做过。 */
  markOnce(taskId: string, key: string, at: string): boolean
  wasDone(taskId: string, key: string): boolean
  recordEval(row: ConditionEvalRecord): void
  lastEval(taskId: string): ConditionEvalRecord | null
  evals(taskId: string): readonly ConditionEvalRecord[]
}

export type { EvalContext, Expr, Fact, Binding, Tri }
export type { MemoryPacket, TaskSnapshot }
