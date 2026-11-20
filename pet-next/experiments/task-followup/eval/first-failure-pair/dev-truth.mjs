#!/usr/bin/env node
/**
 * 开发用九格真值表（人工预写，不是模型生成）：
 * 3 条开发承诺 × 3 种 CI 组合。只用用户原话 + 通用字段调真实编译器；
 * 不发送故事名、评分 oracle 或任何未见承诺的目标 AST。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createConditionCompiler, compilerSha256 } from '../../capability/conditions/compiler.ts'
import { OpenAICompatibleClient, configFromEnv } from '../../capability/model/openai-compatible.ts'
import { evaluate } from '../../capability/conditions/kernel.ts'
import { defaultFactDeclarations, bindingRegistrySha256 } from '../../capability/conditions/plan-types.ts'
import { createHash } from 'node:crypto'

const sha = (text) => createHash('sha256').update(text).digest('hex')
const now = '2026-11-20T09:00:00.000Z'
const tasks = ['T1', 'T2']
const facts = defaultFactDeclarations(tasks)
const bindingSha = bindingRegistrySha256(facts, tasks)

const DEV = [
  {
    id: 'D1', text: '任何一份 CI 失败就马上问我是否分析；两份都成功就直接归档，不用再跟。',
    expected: { both_success: 'archive', a_failed: 'ask', b_failed: 'ask' },
  },
  {
    id: 'D2', text: '只有两份 CI 都成功才来问我是否继续；任何一份失败就安静归档，不用再跟。',
    expected: { both_success: 'ask', a_failed: 'archive', b_failed: 'archive' },
  },
  {
    id: 'D3', text: '任何一份 CI 失败就问我是否分析；本轮两份都成功就先安静，继续跟进下一次重跑。',
    expected: { both_success: 'wait', a_failed: 'ask', b_failed: 'ask' },
  },
]

const contextFor = (aStatus, bStatus) => {
  const entry = (taskId, status) => {
    const binding = { sourceId: `result:${taskId}`, version: '1', sha256: sha(`result-${taskId}`) }
    const factsOut = {}
    const base = `task:${taskId}.result`
    factsOut[`${base}.present`] = { value: true, binding, observedAt: now }
    factsOut[`${base}.status`] = { value: status, binding, observedAt: now }
    factsOut[`${base}.total`] = { value: 2, binding, observedAt: now }
    factsOut[`${base}.passed`] = { value: status === 'succeeded' ? 2 : 0, binding, observedAt: now }
    factsOut[`${base}.failed`] = { value: status === 'succeeded' ? 0 : 2, binding, observedAt: now }
    factsOut[`${base}.revision`] = { value: 1, binding, observedAt: now }
    return factsOut
  }
  return {
    now,
    allowedFacts: facts.map((f) => f.id),
    facts: { ...entry('T1', aStatus), ...entry('T2', bStatus) },
    currentBindings: {
      'result:T1': { sourceId: 'result:T1', version: '1', sha256: sha('result-T1') },
      'result:T2': { sourceId: 'result:T2', version: '1', sha256: sha('result-T2') },
    },
  }
}

const cfg = configFromEnv(process.env)
if (!cfg.ok) {
  console.error(`model_not_configured:${cfg.missing.join(',')}`)
  process.exit(2)
}
const client = new OpenAICompatibleClient(cfg.config)
const compiler = createConditionCompiler()
const csha = compilerSha256({ name: cfg.config.model, provider: cfg.config.provider })
const out = process.argv[2] ?? join(process.cwd(), 'eval/first-failure-pair/dev-out')
mkdirSync(out, { recursive: true })

const results = []
for (const dev of DEV) {
  const turn = { turnId: `dev-${dev.id}`, role: 'user', at: now, text: dev.text, sha256: sha(dev.text) }
  const compiled = await compiler.compile({
    taskId: `dev-${dev.id}`,
    commitmentRevision: 1,
    userTurns: [turn],
    allowedFacts: facts,
    bindingRegistrySha256: bindingSha,
    compilerSha256: csha,
    now,
  }, client)
  const plan = compiled.status === 'compiled' ? compiled.plan : null
  const cells = {}
  for (const [key, [a, b]] of Object.entries({
    both_success: ['succeeded', 'succeeded'],
    a_failed: ['failed', 'succeeded'],
    b_failed: ['succeeded', 'failed'],
  })) {
    let actual = 'no_plan'
    if (plan) {
      const evaluation = evaluate(plan.when, contextFor(a, b))
      actual = evaluation.state === 'true' ? 'ask'
        : evaluation.state === 'false' ? (plan.follow?.mode === 'next_round' ? 'wait' : 'archive')
        : 'wait'
    }
    cells[key] = { actual, expected: dev.expected[key], ok: actual === dev.expected[key] }
  }
  results.push({ id: dev.id, text: dev.text, compile: compiled.status, reason: compiled.status === 'error' ? compiled.reason : null, rawText: compiled.rawCall?.rawText ?? null, follow: plan?.follow ?? null, when: plan?.when ?? null, cells })
  console.log(`${dev.id} ${compiled.status} ${JSON.stringify(cells)}`)
}

const summary = {
  at: new Date().toISOString(),
  model: cfg.config.model,
  compilerSha256: csha,
  cells: results.reduce((n, r) => n + Object.keys(r.cells).length, 0),
  ok: results.reduce((n, r) => n + Object.values(r.cells).filter((c) => c.ok).length, 0),
  results,
}
writeFileSync(join(out, 'dev-grid.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify({ out, ok: summary.ok, cells: summary.cells }, null, 2))
