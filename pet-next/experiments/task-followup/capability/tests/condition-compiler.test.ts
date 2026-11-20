/**
 * A 臂自测：编译器的结构/来源校验、缓存身份与存储不变式。
 * 模型一律用 fixture 客户端，不抢 GPU；真实调用由集成/D 统一调度。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createConditionCompiler, buildCompileView, budgetTurns, validateDirection, inferFollowMode } from '../conditions/compiler.ts'
import { SqliteConditionStore, commitmentFingerprint } from '../conditions/store.ts'
import { evaluate } from '../conditions/kernel.ts'
import type { EvalContext, Fact } from '../conditions/kernel.ts'
import { bindingRegistrySha256, defaultFactDeclarations, taskFact } from '../conditions/plan-types.ts'
import type { CompileInput, CompileTurn } from '../conditions/plan-types.ts'
import type { ModelClient, ModelRequest } from '../model/protocol.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const NOW = '2026-11-16T02:00:00.000Z'

const turn = (id: string, text: string, role: 'user' | 'assistant' = 'user'): CompileTurn => ({
  turnId: id, role, at: '2026-11-16T01:00:00.000Z', text, sha256: sha(text),
})

const fixtureClient = (payloads: string[]): ModelClient & { calls: ModelRequest[] } => {
  const calls: ModelRequest[] = []
  return {
    kind: 'fixture',
    calls,
    async complete(request: ModelRequest) {
      calls.push(request)
      const rawText = payloads[Math.min(calls.length - 1, payloads.length - 1)]!
      return {
        ok: true as const,
        response: {
          protocol: 'pet-capability-model/v1' as const,
          requestId: request.requestId,
          sessionId: `s-${calls.length}`,
          model: { provider: 'fixture', name: 'fixture-model', version: 'fixture-1' },
          rawText,
          startedAt: NOW,
          finishedAt: NOW,
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        },
      }
    },
  }
}

const facts = defaultFactDeclarations(['T1'])
const input = (turns: readonly CompileTurn[], revision = 1): CompileInput => ({
  taskId: 'T1',
  commitmentRevision: revision,
  userTurns: turns,
  allowedFacts: facts,
  bindingRegistrySha256: bindingRegistrySha256(facts, ['T1']),
  compilerSha256: sha('compiler'),
  now: NOW,
})

/** 输出里的 span 由测试按原话算，避免手写错位。 */
const span = (t: CompileTurn, needle: string) => {
  const start = t.text.indexOf(needle)
  assert.ok(start >= 0, `needle not found: ${needle}`)
  return { turnId: t.turnId, start, end: start + needle.length }
}

const ctx = (values: Record<string, unknown>): EvalContext => {
  const binding = { sourceId: 'result:T1', version: '2', sha256: sha('result-2') }
  const entries = Object.entries(values).map(([fact, value]) => [fact, { value: value as Fact['value'], binding, observedAt: '2026-11-16T01:30:00.000Z' }])
  return {
    now: NOW,
    allowedFacts: facts.map((f) => f.id),
    facts: Object.fromEntries(entries),
    currentBindings: { 'result:T1': binding, 'user:memory': { sourceId: 'user:memory', version: '1', sha256: sha('mem') }, 'host:clock': { sourceId: 'host:clock', version: '1', sha256: sha('clock') } },
  }
}

test('合取条件编译：逐字来源 + 注册字段 + 结构校验通过', async () => {
  const t1 = turn('u1', '两份报告都回来再问我，主测试和中文路径检查都要', 'user')
  const t2 = turn('u2', '对了，主测试要 64 条以上才算齐', 'user')
  const payload = JSON.stringify({
    when: { op: 'all', args: [
      { op: 'cmp', fact: taskFact('T1', 'result.present'), rel: 'eq', value: true },
      { op: 'cmp', fact: 'user.availability', rel: 'ne', value: 'busy' },
    ] },
    quotes: [span(t1, '两份报告都回来再问我'), span(t2, '主测试要 64 条以上')],
    unsupported: [],
  })
  const client = fixtureClient([payload])
  const result = await createConditionCompiler().compile(input([t1, t2]), client)
  assert.equal(result.status, 'compiled')
  if (result.status !== 'compiled') return
  assert.deepEqual(result.checks, ['quotes_verbatim', 'structure_ok', 'facts_registered'])
  assert.equal(result.plan.sourceQuotes.length, 2)
  const byId = new Map([t1, t2].map((t) => [t.turnId, t.text]))
  for (const q of result.plan.sourceQuotes) {
    assert.equal(q.text, byId.get(q.turnId)!.slice(q.start, q.end))
    assert.equal(q.sha256, sha(q.text))
  }
  assert.equal(result.rawCall.model, 'fixture-model')
  assert.deepEqual(result.rawCall.usage, { prompt_tokens: 100, completion_tokens: 20 })
  assert.equal(client.calls[0]!.purpose, 'condition-compile')
  // 结构正确 ≠ 语义正确：这里只断言结构，语义由独立评分
  assert.equal(result.plan.compilationKey.length, 64)
})

test('例外条件：not 参与合取，判定随事实变化', async () => {
  const t1 = turn('u1', '两份结果齐了再问我，除非我在出差', 'user')
  const payload = JSON.stringify({
    when: { op: 'all', args: [
      { op: 'cmp', fact: taskFact('T1', 'result.present'), rel: 'eq', value: true },
      { op: 'not', arg: { op: 'cmp', fact: 'user.availability', rel: 'eq', value: 'travel' } },
    ] },
    quotes: [span(t1, '除非我在出差')],
    unsupported: [],
  })
  const result = await createConditionCompiler().compile(input([t1]), fixtureClient([payload]))
  assert.equal(result.status, 'compiled')
  if (result.status !== 'compiled') return
  const base = { [taskFact('T1', 'result.present')]: true }
  assert.equal(evaluate(result.plan.when, ctx({ ...base, 'user.availability': 'available' })).state, 'true')
  assert.equal(evaluate(result.plan.when, ctx({ ...base, 'user.availability': 'travel' })).state, 'false')
  // 缺席的用户可用性不是 false：整体只能 unknown
  assert.equal(evaluate(result.plan.when, ctx(base)).state, 'unknown')
})

test('结果 r1→r2 不重编译：同一承诺指纹产生同一 compilationKey', async () => {
  const t1 = turn('u1', '两份报告都回来再问我', 'user')
  const payload = JSON.stringify({
    when: { op: 'cmp', fact: taskFact('T1', 'result.present'), rel: 'eq', value: true },
    quotes: [span(t1, '两份报告都回来再问我')],
    unsupported: [],
  })
  const first = await createConditionCompiler().compile(input([t1]), fixtureClient([payload]))
  const again = await createConditionCompiler().compile(input([t1]), fixtureClient([payload]))
  assert.equal(first.status, 'compiled')
  assert.equal(again.status, 'compiled')
  if (first.status !== 'compiled' || again.status !== 'compiled') return
  assert.equal(first.plan.compilationKey, again.plan.compilationKey)
  // 结果内容变化只影响求值，不影响编译身份
  assert.equal(evaluate(first.plan.when, ctx({ [taskFact('T1', 'result.present')]: false })).state, 'false')
  assert.equal(evaluate(first.plan.when, ctx({ [taskFact('T1', 'result.present')]: true })).state, 'true')
})

test('用户改口必须重编译，旧 plan 立即不可行动', async () => {
  const t1 = turn('u1', '两份报告都回来再问我', 'user')
  const t2 = turn('u2', '我改口了：只要主测试回来就问，不用等中文路径', 'user')
  const payload = JSON.stringify({
    when: { op: 'cmp', fact: taskFact('T1', 'result.present'), rel: 'eq', value: true },
    quotes: [span(t1, '两份报告都回来再问我')],
    unsupported: [],
  })
  const store = new SqliteConditionStore(new DatabaseSync(':memory:'))
  const compiler = createConditionCompiler()
  const rev1 = store.revision('T1', commitmentFingerprint({ revision: 1, commitmentItemIds: ['i1'], commitmentValues: ['两份报告'], latestUserTurnSha: sha(t1.text) }), NOW)
  const first = await compiler.compile(input([t1], rev1), fixtureClient([payload]))
  assert.equal(first.status, 'compiled')
  if (first.status !== 'compiled') return
  store.put(first.plan)
  store.setCurrent('T1', first.plan.compilationKey)
  assert.equal(store.current('T1')!.compilationKey, first.plan.compilationKey)

  const rev2 = store.revision('T1', commitmentFingerprint({ revision: 1, commitmentItemIds: ['i2'], commitmentValues: ['只要主测试'], latestUserTurnSha: sha(t2.text) }), NOW)
  assert.equal(rev2, rev1 + 1)
  const second = await compiler.compile(input([t1, t2], rev2), fixtureClient([payload]))
  assert.equal(second.status, 'compiled')
  if (second.status !== 'compiled') return
  assert.notEqual(second.plan.compilationKey, first.plan.compilationKey)
  // 未切换前，当前指针仍是旧版本 —— 但调用方按 revision 比对后必须拒绝行动
  assert.equal(store.current('T1')!.commitmentRevision, rev1)
  store.put(second.plan)
  store.setCurrent('T1', second.plan.compilationKey)
  assert.equal(store.current('T1')!.commitmentRevision, rev2)
  assert.equal(store.history('T1').length, 2)
})

test('撤回/重启不会激活旧条件：历史可读，当前指针为空', async () => {
  const db = new DatabaseSync(':memory:')
  const t1 = turn('u1', '报告回来再问我', 'user')
  const payload = JSON.stringify({
    when: { op: 'cmp', fact: taskFact('T1', 'result.present'), rel: 'eq', value: true },
    quotes: [span(t1, '报告回来再问我')],
    unsupported: [],
  })
  const first = await createConditionCompiler().compile(input([t1]), fixtureClient([payload]))
  assert.equal(first.status, 'compiled')
  if (first.status !== 'compiled') return
  new SqliteConditionStore(db).put(first.plan)
  // 重启：同一数据库重新打开，未切换指针 → 不可行动
  const reopened = new SqliteConditionStore(db)
  assert.equal(reopened.current('T1'), null)
  assert.equal(reopened.history('T1').length, 1)
  // 撤回后当前指针若指向旧 plan，调用方仍需按 revision 拒绝（store 不替调用方猜语义）
  reopened.setCurrent('T1', first.plan.compilationKey)
  assert.equal(reopened.current('T1')!.compilationKey, first.plan.compilationKey)
})

test('错误来源被拒：伪造 span / assistant 轮次 / 未知字段 / 无引用', async () => {
  const t1 = turn('u1', '报告回来再问我', 'user')
  const t2 = turn('u2', '我帮你盯着', 'assistant')
  const want = (when: unknown, quotes: unknown[]) => JSON.stringify({ when, quotes, unsupported: [] })
  const atom = { op: 'cmp', fact: taskFact('T1', 'result.present'), rel: 'eq', value: true }
  const cases: { name: string; payload: string; reason: string }[] = [
    { name: '伪造引用文本', payload: want(atom, [{ turnId: 'u1', start: 0, end: 4, text: '完全没说过的话' }]), reason: 'quote_text_mismatch' },
    { name: '越界 span', payload: want(atom, [{ turnId: 'u1', start: 0, end: 999 }]), reason: 'quote_span_out_of_range' },
    { name: 'assistant 轮次', payload: want(atom, [span(t2, '我帮你盯着')]), reason: 'quote_role_not_user' },
    { name: '未知字段', payload: want({ op: 'cmp', fact: 'T9.result.passed', rel: 'gt', value: 1 }, [span(t1, '报告回来再问我')]), reason: 'invalid_expression' },
    { name: '未知轮次', payload: want(atom, [{ turnId: 'u404', start: 0, end: 2 }]), reason: 'quote_unknown_turn' },
    { name: '无引用', payload: want(atom, []), reason: 'no_source_quote' },
  ]
  for (const c of cases) {
    const result = await createConditionCompiler().compile(input([t1, t2]), fixtureClient([c.payload]))
    assert.equal(result.status, 'error', c.name)
    if (result.status !== 'error') continue
    assert.ok(result.reason.includes(c.reason), `${c.name}: ${result.reason}`)
  }
})

test('不支持的条件不硬猜：unsupported 明确返回；解析失败为 error', async () => {
  const t1 = turn('u1', '如果你觉得报告看起来靠谱再问我', 'user')
  const unsupported = JSON.stringify({ when: { op: 'cmp', fact: taskFact('T1', 'result.present'), rel: 'eq', value: true }, quotes: [span(t1, '如果你觉得报告看起来靠谱再问我')], unsupported: ['判断报告“看起来靠谱”需要语义评价'] })
  const r1 = await createConditionCompiler().compile(input([t1]), fixtureClient([unsupported]))
  assert.equal(r1.status, 'unsupported')
  if (r1.status === 'unsupported') assert.ok(r1.reason.includes('unsupported_clauses'))

  const r2 = await createConditionCompiler().compile(input([t1]), fixtureClient(['这不是 JSON']))
  assert.equal(r2.status, 'error')
  if (r2.status === 'error') assert.ok(r2.reason.startsWith('parse_error'))

  const r3 = await createConditionCompiler().compile(input([]), fixtureClient(['{}']))
  assert.equal(r3.status, 'error')
})

test('4500 字符预算保留最近的更正', async () => {
  const long = Array.from({ length: 40 }, (_, i) => turn(`u${i}`, `第${i}轮：${'很长的历史内容'.repeat(30)}`))
  const recent = turn('u99', '最新更正：只要主测试回来就问我', 'user')
  const kept = budgetTurns([...long, recent])
  assert.equal(kept.at(-1)!.turnId, 'u99')
  assert.ok(kept.length < long.length + 1)
  assert.ok(kept.reduce((n, t) => n + t.text.length + 40, 0) <= 4500)
  const view = buildCompileView(input([...long, recent]))
  assert.ok(view.user.length > 0)
})

test('方向负控：把“都成功才问”编译成“失败才问”必须拒绝', async () => {
  const o = turn('u1', '这两份 CI 报告，只有两份都成功时才来问我是否继续；只要有任意一份失败，就直接安静归档，不要打扰我。', 'user')
  const inverted = JSON.stringify({
    when: { op: 'cmp', fact: taskFact('T1', 'result.status'), rel: 'eq', value: 'failed' },
    quotes: [span(o, o.text)],
    unsupported: [],
  })
  const wrong = await createConditionCompiler().compile(input([o]), fixtureClient([inverted]))
  assert.equal(wrong.status, 'error')
  if (wrong.status === 'error') assert.ok(wrong.reason.startsWith('polarity_mismatch') || wrong.reason.startsWith('direction_rejected'), wrong.reason)

  const p = turn('u1', '这两份 CI 报告，只要有任何一份失败，就马上来问我是否分析失败原因；如果两份都成功，就直接安静归档。', 'user')
  const invertedP = JSON.stringify({
    when: { op: 'cmp', fact: taskFact('T1', 'result.status'), rel: 'eq', value: 'succeeded' },
    quotes: [span(p, p.text)],
    unsupported: [],
  })
  const wrongP = await createConditionCompiler().compile(input([p]), fixtureClient([invertedP]))
  assert.equal(wrongP.status, 'error')
  if (wrongP.status === 'error') assert.ok(wrongP.reason.startsWith('polarity_mismatch') || wrongP.reason.startsWith('direction_rejected'), wrongP.reason)
})

test('历史两份反向计划被结构负控检出', () => {
  const correction = '更正：B 那份报告失败也不用问我，只有 A 失败才需要来问我。'
  const invertedNot = {
    op: 'not', arg: { op: 'all', args: [
      { op: 'cmp', fact: taskFact('T1', 'result.status'), rel: 'eq', value: 'failed' },
      { op: 'cmp', fact: taskFact('T1', 'result.present'), rel: 'eq', value: true },
    ] },
  }
  const presentOrFailed = { op: 'any', args: [
    { op: 'cmp', fact: taskFact('T1', 'result.present'), rel: 'eq', value: true },
    { op: 'cmp', fact: taskFact('T1', 'result.status'), rel: 'eq', value: 'failed' },
  ] }
  assert.ok(validateDirection(invertedNot, correction).includes('inverted_not'))
  assert.ok(validateDirection(presentOrFailed, correction).includes('present_in_failure_ask'))

  const p = '这两份 CI 报告，只要有任何一份失败，就马上来问我是否分析失败原因；如果两份都成功，就直接安静归档。'
  const o = '这两份 CI 报告，只有两份都成功时才来问我是否继续；只要有任意一份失败，就直接安静归档。'
  assert.deepEqual(validateDirection({ op: 'any', args: [
    { op: 'cmp', fact: taskFact('T1', 'result.status'), rel: 'eq', value: 'failed' },
    { op: 'cmp', fact: taskFact('T2', 'result.status'), rel: 'eq', value: 'failed' },
  ] }, p), [])
  assert.deepEqual(validateDirection({ op: 'all', args: [
    { op: 'cmp', fact: taskFact('T1', 'result.status'), rel: 'eq', value: 'succeeded' },
    { op: 'cmp', fact: taskFact('T2', 'result.status'), rel: 'eq', value: 'succeeded' },
  ] }, o), [])
})

test('follow：成功轮继续跟下一轮，不把本轮成功当结束', async () => {
  const t = turn('u1', '任何一份 CI 失败就问我是否分析；本轮成功先安静，继续跟下一轮。', 'user')
  const payload = JSON.stringify({
    when: { op: 'cmp', fact: taskFact('T1', 'result.status'), rel: 'eq', value: 'failed' },
    follow: { mode: 'next_round', quotes: [span(t, t.text)] },
    quotes: [span(t, t.text)],
    unsupported: [],
  })
  const result = await createConditionCompiler().compile(input([t]), fixtureClient([payload]))
  assert.equal(result.status, 'compiled')
  if (result.status === 'compiled') {
    assert.equal(result.plan.follow?.mode, 'next_round')
    assert.equal(result.plan.follow?.defaulted, false)
    assert.equal(result.plan.follow?.quotes.length, 1)
  }
  assert.equal(inferFollowMode('本轮全部成功就归档。'), 'end')
  assert.equal(inferFollowMode('本轮成功先安静，继续跟进下一次重跑。'), 'next_round')
  assert.equal(inferFollowMode('失败就问我是否分析。'), 'next_round')
})

test('历史反向计划送进真实编译入口必须被拒绝（0b38ccf 反例）', async () => {
  const t = turn('u1', '更正：B 那份报告失败也不用问我，只有 A 失败才需要来问我。', 'user')
  const follow = { mode: 'end', quotes: [span(t, t.text)] }
  const plans = [
    { op: 'not', arg: { op: 'all', args: [
      { op: 'cmp', fact: taskFact('T1', 'result.status'), rel: 'eq', value: 'failed' },
      { op: 'cmp', fact: taskFact('T1', 'result.present'), rel: 'eq', value: true },
    ] } },
    { op: 'any', args: [
      { op: 'cmp', fact: taskFact('T1', 'result.present'), rel: 'eq', value: true },
      { op: 'cmp', fact: taskFact('T1', 'result.status'), rel: 'eq', value: 'failed' },
    ] },
  ]
  for (const when of plans) {
    const payload = JSON.stringify({ when, follow, quotes: [span(t, t.text)], unsupported: [] })
    const result = await createConditionCompiler().compile(input([t]), fixtureClient([payload]))
    assert.equal(result.status, 'error')
    if (result.status === 'error') assert.ok(result.reason.startsWith('direction_rejected'), result.reason)
  }
})
