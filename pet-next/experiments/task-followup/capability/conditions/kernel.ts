/** Reference kernel only: Strong Kleene logic, evidence validity, compile identity.
 * It does NOT select actions, interpret prose, read files, schedule, or authorize tools.
 * Copy unchanged into capability/conditions/kernel.ts before implementing adapters. */
import { createHash } from 'node:crypto'

export type Tri = 'true' | 'false' | 'unknown'
export type Scalar = string | number | boolean
export type Expr =
  | { op: 'all' | 'any'; args: readonly Expr[] }
  | { op: 'not'; arg: Expr }
  | { op: 'cmp'; fact: string; rel: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'; value: Scalar }
export interface Binding { sourceId: string; version: string; sha256: string }
export interface Fact { value: Scalar; binding: Binding; observedAt: string; validUntil?: string }
export interface EvalContext {
  now: string
  allowedFacts: readonly string[]
  facts: Readonly<Record<string, Fact | undefined>>
  currentBindings: Readonly<Record<string, Binding | undefined>>
}
export interface ReadTrace { fact: string; state: Tri; reason?: string; binding?: Binding }
export interface Evaluation { state: Tri; watch: readonly string[]; reads: readonly ReadTrace[] }
const own = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key)
const scalar = (x: unknown): x is Scalar => typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex')
const sh = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/i.test(x)
const sameBinding = (a: Binding, b: Binding) => a.sourceId === b.sourceId && a.version === b.version && a.sha256 === b.sha256
export function triNot(v: Tri): Tri { return v === 'unknown' ? v : v === 'true' ? 'false' : 'true' }
export function triAll(xs: readonly Tri[]): Tri { return xs.includes('false') ? 'false' : xs.includes('unknown') ? 'unknown' : 'true' }
export function triAny(xs: readonly Tri[]): Tri { return xs.includes('true') ? 'true' : xs.includes('unknown') ? 'unknown' : 'false' }

export function validateExpr(input: unknown, allowedFacts: readonly string[]): asserts input is Expr {
  const allowed = new Set(allowedFacts)
  let count = 0
  const walk = (v: any, depth: number) => {
    if (++count > 64 || depth > 8 || !v || typeof v !== 'object' || Array.isArray(v)) throw Error('invalid_or_oversize_expression')
    if (v.op === 'all' || v.op === 'any') {
      if (!Array.isArray(v.args) || v.args.length < 1 || v.args.length > 8) throw Error('invalid_boolean_args')
      v.args.forEach((x: unknown) => walk(x, depth + 1)); return
    }
    if (v.op === 'not') { walk(v.arg, depth + 1); return }
    if (v.op !== 'cmp' || typeof v.fact !== 'string' || !allowed.has(v.fact) || !['eq','ne','lt','le','gt','ge'].includes(v.rel) || !scalar(v.value)) throw Error('invalid_atom')
    if (!['eq','ne'].includes(v.rel) && typeof v.value !== 'number') throw Error('ordered_comparison_requires_numeric_literal')
  }
  walk(input, 0)
}

export function evaluate(expr: Expr, ctx: EvalContext): Evaluation {
  validateExpr(expr, ctx.allowedFacts)
  const now = Date.parse(ctx.now)
  if (!Number.isFinite(now)) throw Error('invalid_now')
  const watch = new Set<string>(), reads: ReadTrace[] = []
  const walk = (e: Expr): Tri => {
    if (e.op === 'all') return triAll(e.args.map(walk))
    if (e.op === 'any') return triAny(e.args.map(walk))
    if (e.op === 'not') return triNot(walk(e.arg))
    // TypeScript's union member with op:'all'|'any' needs this explicit narrowing.
    if (e.op !== 'cmp') throw Error('invalid_op')
    watch.add(e.fact)
    const f = own(ctx.facts, e.fact) ? ctx.facts[e.fact] : undefined
    const unknown = (reason: string): Tri => { reads.push({fact:e.fact,state:'unknown',reason}); return 'unknown' }
    if (!f) return unknown('missing')
    if (!scalar(f.value) || !f.binding || !sh(f.binding.sha256) || !f.binding.version) return unknown('invalid_fact')
    const active = own(ctx.currentBindings, f.binding.sourceId) ? ctx.currentBindings[f.binding.sourceId] : undefined
    if (!active || !sameBinding(f.binding, active)) return unknown('stale_or_retracted')
    const observed = Date.parse(f.observedAt)
    if (!Number.isFinite(observed) || observed > now) return unknown('future_or_invalid_time')
    if (f.validUntil !== undefined && (!Number.isFinite(Date.parse(f.validUntil)) || Date.parse(f.validUntil) <= now)) return unknown('expired_or_invalid_time')
    if (typeof f.value !== typeof e.value) return unknown('type_mismatch')
    let yes: boolean
    if (e.rel === 'eq') yes = f.value === e.value
    else if (e.rel === 'ne') yes = f.value !== e.value
    else {
      if (typeof f.value !== 'number' || typeof e.value !== 'number') return unknown('type_mismatch')
      yes = e.rel === 'lt' ? f.value < e.value : e.rel === 'le' ? f.value <= e.value : e.rel === 'gt' ? f.value > e.value : f.value >= e.value
    }
    const state = yes ? 'true' : 'false'
    reads.push({fact:e.fact,state,binding:{...f.binding}})
    return state
  }
  return {state:walk(expr),watch:[...watch].sort(),reads}
}

export interface CompileIdentity {
  taskId: string
  commitmentRevision: number
  userSources: readonly { turnId: string; sha256: string }[]
  schemaVersion: 'pet-conditions/v1'
  /** Host digest of sorted field IDs/types and declared task/source dependencies, excluding result revisions. */
  bindingRegistrySha256: string
  /** Digest of prompt, model/revision, settings, validator and fact-registry version. */
  compilerSha256: string
}
export function compilationKey(x: CompileIdentity): string {
  if (!x.taskId || !Number.isSafeInteger(x.commitmentRevision) || x.commitmentRevision < 1 || x.schemaVersion !== 'pet-conditions/v1' || !sh(x.compilerSha256) || !sh(x.bindingRegistrySha256) || !x.userSources.length) throw Error('invalid_compile_identity')
  const sources = x.userSources.map(s => {
    if (!s.turnId || !sh(s.sha256)) throw Error('invalid_user_source')
    return JSON.stringify([s.turnId,s.sha256])
  })
  return hash({taskId:x.taskId,commitmentRevision:x.commitmentRevision,userSources:[...new Set(sources)].sort(),schemaVersion:x.schemaVersion,compilerSha256:x.compilerSha256,bindingRegistrySha256:x.bindingRegistrySha256})
}
