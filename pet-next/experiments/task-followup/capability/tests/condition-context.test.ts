/**
 * B 臂自测：证据上下文与字段索引。数字是机制证据，不代表模型能力。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { makeContext, fieldOwner } from '../conditions/context.ts'
import type { ContextInputs } from '../conditions/context.ts'
import { WatchIndex } from '../conditions/watch-index.ts'
import { evaluate } from '../conditions/kernel.ts'
import { taskFact } from '../conditions/plan-types.ts'
import type { Expr } from '../conditions/kernel.ts'
import type { TaskSnapshot } from '../../contracts.ts'
import type { MemoryPacket } from '../memory/types.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const NOW = '2026-11-16T02:00:00.000Z'

const snapshot = (taskId = 'T1'): TaskSnapshot => ({
  ticketId: taskId, title: 'T1', goal: 'g', goalCondition: {} as TaskSnapshot['goalCondition'],
  taskRevision: 1, assignmentId: null, stage: 'running', status: 'running',
  createdAt: NOW, updatedAt: NOW, eventCursor: 1, memoryCursor: 1, evidence: [], attempt: 0,
} as unknown as TaskSnapshot)

const packet = (extra: Partial<MemoryPacket> = {}): MemoryPacket => ({
  schema: 'pet-capability-memory-packet/v1', taskId: 'T1', asOf: NOW, evaluatedAt: NOW, intent: 'current',
  memoryCursor: 1, currentFacts: [], preferences: [], commitments: [], outcomes: [], evidenceRefs: [],
  missing: [], conflicts: [],
  context: { nonActionable: [], recentTurns: [], slotResolution: [], budgetUsed: { items: 0, chars: 0 }, truncated: false, diagnostics: [] },
  ...extra,
} as MemoryPacket)

const resultInputs = (over: Partial<ContextInputs> = {}): ContextInputs => ({
  taskId: 'T1',
  declaredTasks: ['T1'],
  result: {
    runId: 'run-2', revision: 2, status: 'succeeded', metrics: { total: 64, passed: 61, failed: 3 },
    resultFileSha: sha('result-2'), artifactSha: sha('artifact-2'), observedAt: '2026-11-16T01:30:00.000Z',
  },
  ...over,
})

const atom = (fact = taskFact('T1', 'result.present')): Expr => ({ op: 'cmp', fact, rel: 'eq', value: true })

test('结果事实来自已核验结果字节，判定与绑定同源', () => {
  const ctx = makeContext(snapshot(), packet(), resultInputs(), NOW)
  assert.equal(evaluate(atom(), ctx).state, 'true')
  assert.equal(evaluate({ op: 'cmp', fact: taskFact('T1', 'result.passed'), rel: 'ge', value: 61 }, ctx).state, 'true')
  assert.equal(evaluate({ op: 'cmp', fact: taskFact('T1', 'result.failed'), rel: 'gt', value: 3 }, ctx).state, 'false')
  const read = evaluate(atom(), ctx).reads[0]!
  assert.equal(read.binding!.version, '2')
  assert.equal(read.binding!.sha256, sha('result-2'))
})

test('缺失 ≠ false：没有扫描依据的 present 只能是 unknown，not 也不会变 true', () => {
  const ctx = makeContext(snapshot(), packet(), { taskId: 'T1', declaredTasks: ['T1'], result: null }, NOW)
  assert.equal(evaluate(atom(), ctx).state, 'unknown')
  assert.equal(evaluate({ op: 'not', arg: atom() }, ctx).state, 'unknown')
  const scan = makeContext(snapshot(), packet(), { taskId: 'T1', declaredTasks: ['T1'], result: null, scan: { at: '2026-11-16T01:59:00.000Z', listingSha256: sha('[]'), sourceId: 'result:T1' } }, NOW)
  assert.equal(evaluate(atom(), scan).state, 'false')
  assert.equal(evaluate({ op: 'not', arg: atom() }, scan).state, 'true')
  // 只确认“没有结果文件”，不能把 total/passed 当成 0
  assert.equal(evaluate({ op: 'cmp', fact: taskFact('T1', 'result.total'), rel: 'eq', value: 0 }, scan).state, 'unknown')
})

test('旧结果迟到 / 撤回 / 重启都回到 unknown', () => {
  const ctx = makeContext(snapshot(), packet(), resultInputs(), NOW)
  const newer = { sourceId: 'result:T1', version: '3', sha256: sha('result-3') }
  assert.equal(evaluate(atom(), { ...ctx, currentBindings: { 'result:T1': newer } }).state, 'unknown')
  assert.equal(evaluate(atom(), { ...ctx, currentBindings: {} }).state, 'unknown')
  // 重启：用当前证据重建，旧 plan 不会因为历史求值结果继续为 true
  const restarted = makeContext(snapshot(), packet(), resultInputs({ result: null }), NOW)
  assert.equal(evaluate(atom(), restarted).state, 'unknown')
})

test('未来与过期证据保持 unknown，时区归一后按绝对时间比较', () => {
  const future = makeContext(snapshot(), packet(), resultInputs({ result: { ...resultInputs().result!, observedAt: '2026-11-16T10:30:00+08:00' } }), NOW)
  assert.equal(evaluate(atom(), future).state, 'unknown')
  const boundary = makeContext(snapshot(), packet(), resultInputs({ result: { ...resultInputs().result!, observedAt: '2026-11-16T09:00:00+08:00' } }), NOW)
  assert.equal(evaluate(atom(), boundary).state, 'true')
  const expired = makeContext(snapshot(), packet(), resultInputs({ result: { ...resultInputs().result!, observedAt: '2026-11-16T01:00:00.000Z' } }), NOW)
  const expr = { op: 'cmp', fact: taskFact('T1', 'result.present'), rel: 'eq', value: true } as Expr
  assert.equal(evaluate(expr, { ...expired, facts: { [taskFact('T1', 'result.present')]: { ...expired.facts[taskFact('T1', 'result.present')]!, validUntil: '2026-11-16T01:30:00.000Z' } } }).state, 'unknown')
})

test('多任务隔离：未声明任务的字段不可见，同名字段不串', () => {
  const ctx = makeContext(snapshot('T1'), packet(), resultInputs({ declaredTasks: ['T1', 'T2'] }), NOW)
  assert.equal(fieldOwner(taskFact('T1', 'result.passed')), 'T1')
  assert.equal(evaluate(atom(taskFact('T2', 'result.present')), ctx).state, 'unknown')
  // watch 记录被引用字段（含未知），但没有事实就是 unknown，不会把别的任务结果借过来
  assert.deepEqual(evaluate(atom(taskFact('T2', 'result.present')), ctx).watch, [taskFact('T2', 'result.present')])
  assert.equal(taskFact('T1', 'result.passed') in ctx.facts, true)
  assert.equal(taskFact('T2', 'result.passed') in ctx.facts, false)
  // 未声明任务：字段根本不注册，条件会被内核拒绝
  const undeclared = makeContext(snapshot('T1'), packet(), resultInputs({ declaredTasks: [] }), NOW)
  assert.throws(() => evaluate(atom(), undeclared))
})

test('user.availability 来自用户有效记忆，不来自模型摘要', () => {
  const item = {
    itemId: 'i1', kind: 'preference' as const, key: 'availability', value: 'travel', statement: '我在出差',
    scope: { level: 'global' as const, id: null }, validFrom: '2026-11-16T00:00:00.000Z', validUntil: '2026-11-17T00:00:00.000Z',
    status: 'active' as const, authority: 'user' as const, confidence: 1, evidenceTurnIds: ['u9'], supersedes: [], supersededBy: [],
  }
  const ctx = makeContext(snapshot(), packet({ preferences: [item] }), resultInputs(), NOW)
  const expr: Expr = { op: 'cmp', fact: 'user.availability', rel: 'eq', value: 'travel' }
  assert.equal(evaluate(expr, ctx).state, 'true')
  assert.equal(ctx.facts['user.availability']!.binding.sourceId, 'user:memory')
})

test('100 个重复事件只重算受影响计划一次', () => {
  const index = new WatchIndex()
  index.add('plan-A', [taskFact('T1', 'result.present'), taskFact('T1', 'result.passed')])
  index.add('plan-B', [taskFact('T2', 'result.present')])
  let evaluations = 0
  for (let i = 0; i < 100; i += 1) {
    const evidence = `ev-1` // 同一证据版本（重复事件，含 now 变化不构成新证据）
    for (const key of index.affected([taskFact('T1', 'result.present')])) {
      if (index.admit(key, evidence, [taskFact('T1', 'result.present')])) evaluations += 1
    }
  }
  assert.equal(evaluations, 1)
  assert.deepEqual(index.affected([taskFact('T2', 'result.present')]), ['plan-B'])
  assert.deepEqual(index.affected(['clock.nowMs']), [])
  assert.equal(index.stats().skipped, 99)
  // 证据版本变化才重新评估
  assert.equal(index.admit('plan-A', 'ev-2', [taskFact('T1', 'result.present')]), true)
  assert.equal(index.admit('plan-A', 'ev-2', [taskFact('T1', 'result.present')]), false)
  index.remove('plan-A')
  assert.deepEqual(index.affected([taskFact('T1', 'result.present')]), [])
})
