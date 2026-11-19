#!/usr/bin/env node
/**
 * R7 离线语义验收：直接对“真实编译出的条件计划”求值，绕开宿主输入守卫。
 *
 * 覆盖：4 种报告组合 × 2 条相反承诺 + 单边缺报（A 到/B 未到、B 到/A 未到）。
 * 期望动作：true→问；false 且条件实际读取的来源齐备→归档；unknown→等。
 * 另检查承诺原话是否被计划引用（最早承诺可追溯）。
 *
 * 用法：node eval/commitment-pair/check-grid.mjs --run <run dir> [--out <json>]
 *       --negative：把失败/成功字面量互换，验证网格能检出语义被改写的计划。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { evaluate } from '../../capability/conditions/kernel.ts'

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] }
const flag = (name) => args.includes(`--${name}`)
const run = resolve(arg('run'))
const raw = JSON.parse(readFileSync(join(run, 'raw.json'), 'utf8'))
const handle = new DatabaseSync(join(run, 'ws', 'state', 'followup.sqlite'), { readOnly: true })
const taskRow = handle.prepare("SELECT ticket_id FROM tasks WHERE title = '主测试'").get()
const ticket = taskRow?.ticket_id
if (!ticket) throw Error('primary task not found')
const bindings = JSON.parse(handle.prepare('SELECT bindings_json FROM tasks WHERE ticket_id = ?').get(ticket).bindings_json ?? '[]')
const dep = bindings[0]?.taskId
const planRow = handle.prepare('SELECT p.json FROM cond_current AS c JOIN cond_plans AS p ON p.task_id = c.task_id AND p.compilation_key = c.compilation_key WHERE c.task_id = ?').get(ticket)
if (!planRow) throw Error('missing current condition plan')
const plan = JSON.parse(planRow.json)
const firstUser = handle.prepare("SELECT turn_id, text FROM cap_turns WHERE role='user' AND turn_id NOT LIKE 'delegate-%' AND (task_ids LIKE ?) ORDER BY seq LIMIT 1").get(`%${ticket}%`)
const lastUser = handle.prepare("SELECT turn_id, text FROM cap_turns WHERE role='user' AND turn_id NOT LIKE 'delegate-%' AND (task_ids LIKE ?) ORDER BY seq DESC LIMIT 1").get(`%${ticket}%`)
handle.close()

const sha = (text) => createHash('sha256').update(text).digest('hex')
const names = ['present', 'total', 'passed', 'failed', 'revision', 'status']

function contextFor(a, b) {
  const facts = {}, currentBindings = {}, allowedFacts = []
  const now = plan.compiledAt
  const add = (taskId, status, prefix = `task:${taskId}.`) => {
    const binding = { sourceId: `result:${taskId}`, version: '1', sha256: sha(`${taskId}:${status}`) }
    currentBindings[`result:${taskId}`] = binding
    // 未到达 = 没有事实（unknown），不是 present=false；宿主没有扫描依据时也是这样。
    if (status === 'absent') {
      for (const name of names) allowedFacts.push(`${prefix}result.${name}`)
      return
    }
    const values = { present: true, total: 4, passed: status === 'succeeded' ? 4 : 0, failed: status === 'succeeded' ? 0 : 4, revision: 1, status }
    for (const name of names) {
      const key = `${prefix}result.${name}`
      allowedFacts.push(key)
      if (name in values) facts[key] = { value: values[name], binding, observedAt: now }
    }
  }
  add(ticket, a)
  if (dep) add(dep, b)
  return { now, facts, currentBindings, allowedFacts }
}

/** 期望动作由冻结的承诺语义决定，不由计划实现反推。 */
function expected(promise, a, b) {
  const states = [a, b]
  const anyPresent = states.some((s) => s !== 'absent')
  const allPresent = states.every((s) => s !== 'absent')
  const anyFailed = states.some((s) => s === 'failed')
  const allSucceeded = allPresent && states.every((s) => s === 'succeeded')
  if (promise === 'P') {
    if (anyPresent && anyFailed) return 'ask'
    if (allPresent) return 'archive'
    return 'wait'
  }
  if (allSucceeded) return 'ask'
  // 任一份失败已经足以确定“不会再两份都成功”；此时另一份未到也按承诺归档。
  if (anyPresent && anyFailed) return 'archive'
  return 'wait'
}

const actionOf = (state) => state === 'true' ? 'ask' : state === 'false' ? 'archive' : 'wait'
const combos = ['absent', 'succeeded', 'failed']
const cases = []
for (const a of combos) for (const b of combos) {
  const ctx = contextFor(a, b)
  let state, error = null
  try { state = evaluate(plan.when, ctx).state } catch (e) { error = String(e); state = 'unknown' }
  const want = expected(raw.promise, a, b)
  const got = error ? 'error' : actionOf(state)
  cases.push({ a, b, want, got, state, pass: !error && got === want, ...(error ? { error } : {}) })
}

const oneSided = [
  { a: 'succeeded', b: 'absent' },
  { a: 'absent', b: 'succeeded' },
  { a: 'failed', b: 'absent' },
  { a: 'absent', b: 'failed' },
].map(({ a, b }) => {
  const ctx = contextFor(a, b)
  let state, error = null
  try { state = evaluate(plan.when, ctx).state } catch (e) { error = String(e); state = 'unknown' }
  const want = expected(raw.promise, a, b)
  const got = error ? 'error' : actionOf(state)
  return { a, b, want, got, state, pass: !error && got === want, ...(error ? { error } : {}) }
})

const quoteTurnIds = new Set((plan.sourceQuotes ?? []).map((q) => q.turnId))
// T2 的早期承诺被用户改口替代：应引用改口原话，其余轨迹引用最早承诺。
const target = raw.trajectory === 'T2' ? lastUser : firstUser
const citation = {
  promiseTurnId: target?.turn_id ?? null,
  promiseText: target?.text ?? null,
  firstTurnId: firstUser?.turn_id ?? null,
  lastTurnId: lastUser?.turn_id ?? null,
  quoted: Boolean(target && quoteTurnIds.has(target.turn_id)),
  quotes: (plan.sourceQuotes ?? []).map((q) => ({ turnId: q.turnId, text: q.text })),
}

let negative = null
if (flag('negative')) {
  const mutated = JSON.parse(JSON.stringify(plan.when))
  const swap = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.op === 'cmp' && typeof node.value === 'string') {
      if (node.value === 'failed') node.value = 'succeeded'
      else if (node.value === 'succeeded') node.value = 'failed'
    }
    for (const key of ['args', 'arg']) {
      const v = node[key]
      if (Array.isArray(v)) v.forEach(swap)
      else if (v) swap(v)
    }
  }
  swap(mutated)
  const changed = cases.filter((c) => {
    if (c.a === 'absent' || c.b === 'absent') return false
    const ctx = contextFor(c.a, c.b)
    try { const state = evaluate(mutated, ctx).state; return actionOf(state) !== c.want } catch { return true }
  }).length
  negative = { mutatedWhen: mutated, mismatches: changed, detected: changed > 0 }
}

const ok = cases.every((c) => c.pass) && oneSided.every((c) => c.pass) && citation.quoted && (!negative || negative.detected)
const report = {
  schema: 'pet-r7-semantic-grid/v1',
  at: new Date().toISOString(),
  run: run.split('/').pop(),
  promise: raw.promise,
  trajectory: raw.trajectory,
  ticket,
  dep,
  plan: { compilationKey: plan.compilationKey, when: plan.when, quotes: plan.sourceQuotes, unsupported: plan.unsupported },
  cases,
  oneSided,
  citation,
  ...(negative ? { negative } : {}),
  ok,
}
const out = arg('out', join(run, 'semantic-grid.json'))
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ run: report.run, promise: report.promise, cases: cases.length, oneSided: oneSided.length, citation: citation.quoted, negative: negative ?? null, ok }, null, 2))
process.exitCode = ok ? 0 : 1
