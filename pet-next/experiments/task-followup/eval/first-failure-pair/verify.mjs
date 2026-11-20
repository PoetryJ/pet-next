#!/usr/bin/env node
/** R8 独立核验：24 格齐全、数据库/账本/模型请求在、编译输入无 oracle、局部产物可核验。 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1] }
const roots = (arg('runs', '') ?? '').split(',').filter(Boolean)
const out = resolve(arg('out', 'verify.json'))
const before = arg('before')
const after = arg('after')
const readJson = (p, fallback = null) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback } }
const checks = []
const fail = []
const add = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); if (!ok) fail.push(name) }

let rows = []
for (const root of roots) rows.push(...(readJson(join(root, 'runs.json'))?.rows ?? []))
add('runs.count24', rows.length === 24, rows.length)
add('runs.unique', new Set(rows.map((r) => `${r.group}-${r.promise}-${r.arm}`)).size === rows.length, rows.length)

let partial = 0
let full = 0
for (const row of rows) {
  const dir = join(roots.find((root) => existsSync(join(root, `${row.group}-${row.promise}-${row.arm}`))) ?? roots[0], `${row.group}-${row.promise}-${row.arm}`)
  const id = `${row.group}-${row.promise}-${row.arm}`
  add(`run.${id}.raw`, existsSync(join(dir, 'raw.json')), dir)
  add(`run.${id}.db`, existsSync(join(dir, 'ws/state/followup.sqlite')), 'sqlite')
  add(`run.${id}.client`, existsSync(join(dir, 'client-ledger.jsonl')), 'client ledger')
  add(`run.${id}.proxy`, existsSync(join(dir, 'proxy-ledger.jsonl')), 'proxy ledger')
  const io = join(dir, 'model-io')
  const requests = existsSync(io) ? readdirSync(io).filter((f) => f.endsWith('.request.json')) : []
  add(`run.${id}.calls`, requests.length > 0, requests.length)
  let leaked = false
  for (const f of requests) {
    const req = readJson(join(io, f), {})
    const text = JSON.stringify(req)
    if (/expectation|oracle|storyFor|G1-F|G2-W|G3-C|G4-AF/.test(text)) leaked = true
    if (f.includes('condition-compile')) {
      const user = req?.body?.messages?.find((m) => m.role === 'user')?.content ?? ''
      try {
        const parsed = JSON.parse(user)
        if (!Array.isArray(parsed.turns) || !parsed.turns.length) leaked = true
      } catch { leaked = true }
    }
  }
  add(`run.${id}.compile_no_oracle`, !leaked, 'only turns/facts')
  if (!existsSync(join(dir, 'ws/state/followup.sqlite'))) continue
  const db = new DatabaseSync(join(dir, 'ws/state/followup.sqlite'), { readOnly: true })
  const task = db.prepare("SELECT * FROM tasks WHERE title='主流程'").get()
  if (task?.analysis_json) {
    const a = JSON.parse(task.analysis_json)
    if (a.scope === 'partial') partial += 1
    else full += 1
    const abs = join(dir, 'ws', a.artifactPath)
    add(`run.${id}.analysis_file`, existsSync(abs), a.artifactPath)
  }
  db.close()
}
add('artifacts.partial', partial >= 1, partial)
add('artifacts.full', full >= 1, full)

let code = null
if (before && after) {
  const b = readJson(before, null)
  const a = readJson(after, null)
  code = { before: b, after: a, same: JSON.stringify(b) === JSON.stringify(a) }
  add('code.same_tree', code.same, code)
}
const report = { ok: fail.length === 0, checks: checks.length, failed: fail, partial, full, code, at: new Date().toISOString() }
mkdirSync(resolve(out, '..'), { recursive: true })
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
