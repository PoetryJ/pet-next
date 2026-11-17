#!/usr/bin/env node
// One invocation cannot report completion after merely fixing the core.
// Matrix performance may be negative. Missing measurements may not be green.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, createWriteStream } from 'node:fs'
import { resolve, dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const arg = (key) => { const i = args.indexOf(`--${key}`); return i < 0 ? null : args[i + 1] }
const outArg = arg('out'), planArg = arg('plan')
if (!outArg || !planArg) throw new Error('--out <new directory> --plan <frozen matrix-plan.json> required')
const out = resolve(outArg), planPath = resolve(planArg)
if (existsSync(out)) throw new Error('output exists; choose a fresh directory')
mkdirSync(out, { recursive: true })
const state = { schema: 'pet-r6-round/v1', status: 'starting', steps: [], failure: null }
const save = () => writeFileSync(join(out, 'STATUS.json'), JSON.stringify(state, null, 2))
const assert = (ok, message) => { if (!ok) throw new Error(message) }
const digest = (v) => createHash('sha256').update(v).digest('hex')
function step(name, argv) {
  state.status = name; save()
  return new Promise((done, reject) => {
    const log = createWriteStream(join(out, `${name}.log`))
    const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', ...argv], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
    child.once('error', reject)
    child.once('close', (exit, signal) => {
      log.end(); state.steps.push({ name, argv, exit, signal }); save()
      exit === 0 ? done() : reject(new Error(`${name} exited ${exit ?? signal}; see raw log`))
    })
  })
}
try {
  const bytes = readFileSync(planPath), plan = JSON.parse(bytes)
  assert(plan.schema === 'pet-r6-matrix-plan/v1', 'wrong plan schema')
  const cases = plan.cases ?? [], rows = plan.runs ?? []
  assert(cases.length === 12 && new Set(cases.map((c) => c.id)).size === 12, 'need 12 unique frozen cases')
  assert(cases.filter((c) => c.split === 'dev').length === 6 && cases.filter((c) => c.split === 'heldout').length === 6, 'need 6 dev / 6 heldout')
  assert(rows.length === 72 && new Set(rows.map((r) => r.id)).size === 72, 'need 72 unique planned runs')
  for (const c of cases) for (const arm of ['V-R', 'V-L', 'V-C', 'T-L', 'T-C']) assert(rows.some((r) => r.caseId === c.id && r.arm === arm && r.repeat === 1), `missing ${c.id}/${arm}`)
  for (const c of cases.filter((c) => c.split === 'heldout')) for (const arm of ['V-L', 'V-C']) assert(rows.some((r) => r.caseId === c.id && r.arm === arm && r.repeat === 2), `missing repeat ${c.id}/${arm}`)
  const matrixEntry = join(root, 'eval/condition-followup/live/run-matrix.mjs')
  assert(existsSync(matrixEntry), 'implement the actual matrix adapter before starting this round')
  writeFileSync(join(out, 'matrix-plan.json'), bytes)
  await step('core_tests', ['--test', 'tests/r6-completion.test.ts'])
  await step('core_e2e', ['eval/core-completion/run.mjs', '--out', join(out, 'core')])
  const core = JSON.parse(readFileSync(join(out, 'core/gate.json')))
  assert(core.ok === true, 'core gate did not pass')
  await step('matrix_running', [matrixEntry, '--plan', join(out, 'matrix-plan.json'), '--out', join(out, 'matrix')])
  assert(digest(readFileSync(planPath)) === digest(bytes), 'plan changed during execution')
  const coverage = JSON.parse(readFileSync(join(out, 'matrix/coverage.json')))
  assert(coverage.planSha === digest(bytes), 'coverage belongs to a different plan')
  assert(coverage.runs?.length === 72 && new Set(coverage.runs.map((r) => r.id)).size === 72, 'matrix coverage incomplete')
  let physicalPosts = 0
  for (const row of rows) {
    const measured = coverage.runs.find((r) => r.id === row.id)
    assert(measured && typeof measured.rawPath === 'string', `missing raw ${row.id}`)
    const rawPath = resolve(out, 'matrix', measured.rawPath)
    const rel = relative(join(out, 'matrix'), rawPath)
    assert(!rel.startsWith('..') && !isAbsolute(rel), 'raw evidence must be inside matrix output')
    const raw = JSON.parse(readFileSync(rawPath))
    assert(raw.mode === 'live' && raw.arm === row.arm && raw.scenario === row.caseId && raw.finishedAt && raw.startedAt, `invalid measured identity ${row.id}`)
    assert(Number.isInteger(raw.cost?.physicalPosts) && raw.cost.physicalPosts >= 0, `missing physical POST ledger ${row.id}`)
    physicalPosts += raw.cost.physicalPosts
    // An unsuccessful strategy is valid data, not an excuse to omit the run.
    assert(typeof raw.ok === 'boolean' && Array.isArray(raw.timeline), `missing outcome ${row.id}`)
  }
  assert(physicalPosts > 0, 'zero-model matrix cannot be reported as live')
  assert(existsSync(join(out, 'matrix/comparison.json')) && existsSync(join(out, 'matrix/cost-ledger.json')), 'comparison or all-attempt cost ledger missing')
  state.status = 'ready_for_review'
} catch (error) { state.status = 'blocked'; state.failure = String(error); process.exitCode = 1 }
finally { save(); console.log(JSON.stringify(state, null, 2)) }
