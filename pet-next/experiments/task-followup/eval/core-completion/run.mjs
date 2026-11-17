#!/usr/bin/env node
// Real host processes, watcher, wall clock, JUnit import and HTTP user actions.
// Default assessor is a mechanism baseline, not a model capability measurement.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, cpSync, unlinkSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { runJunit } from '../../producer/test-report/run-junit.mjs'
import { importTestReport } from '../../producer/import-test-report.mjs'
import { verifyCompletion } from './verify.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const arg = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1] }
if (!arg('out')) throw new Error('--out <new directory> required')
const out = resolve(arg('out'))
if (existsSync(out)) throw new Error('output directory already exists; preserve prior evidence')
mkdirSync(out, { recursive: true })
const workspace = join(out, '中文 工作区')
const assessor = arg('assessor', 'baseline-menu-first')
const checks = [], processes = [], http = []
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); if (!ok) throw new Error(name) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 60000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200) } throw new Error('wait timeout') }
let child, exited, info, aId, verification
// A real IANA fixed-offset zone puts this scheduled demonstration in daytime.
const offset = new Date().getUTCHours() - 12
const timezone = offset === 0 ? 'Etc/GMT' : `Etc/GMT${offset > 0 ? '+' : ''}${offset}`
async function api(method, route, body) {
  const response = await fetch(`http://127.0.0.1:${info.port}${route}`, {
    method, headers: { 'x-followup-token': info.token, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  })
  const value = await response.json()
  http.push({ at: new Date().toISOString(), method, route, body, status: response.status, response: value })
  json(join(out, 'http.json'), http)
  return { status: response.status, ...value }
}
async function start() {
  const args = ['--experimental-transform-types', '--no-warnings', join(root, 'run.mjs'), 'host', '--workspace', workspace,
    '--timezone', timezone, '--assessor', assessor, '--assessor-timeout-ms', '240000']
  child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, PET_MODEL_RECORD_DIR: join(out, 'model-io') }, stdio: ['ignore', 'pipe', 'pipe'] })
  const record = { pid: child.pid, args, startedAt: new Date().toISOString(), exit: null }
  processes.push(record)
  exited = new Promise((r) => child.once('exit', (code, signal) => { record.exit = { code, signal, at: new Date().toISOString() }; r(record.exit) }))
  child.stdout.on('data', (b) => appendFileSync(join(out, 'host.log'), b))
  child.stderr.on('data', (b) => appendFileSync(join(out, 'host.log'), b))
  info = await until(() => {
    try { const v = JSON.parse(readFileSync(join(workspace, 'state/host.json'))); return v.pid === child.pid && v.state === 'ready' ? v : null } catch { return null }
  })
}
async function stop() {
  if (!child || child.exitCode !== null) return
  await api('POST', '/api/shutdown', {})
  const result = await Promise.race([exited, sleep(12000).then(() => null)])
  check('host.cooperative_exit', result?.code === 0, result)
}
const view = async (id) => (await api('GET', `/api/task?ticket=${id}`)).task
async function create(name, bindings = []) {
  mkdirSync(join(workspace, 'inbox', name), { recursive: true })
  const result = await api('POST', '/api/tasks', { title: name, dir: `inbox/${name}`, goal: bindings.length ? '两份报告都到齐后，问我是否生成分析报告' : '接收测试报告', reportBindings: bindings })
  check(`create.${name}`, result.ok, result)
  return result.task.ticketId
}
function produce(name, cases) {
  const dir = join(out, `junit-${name}`)
  const invocation = runJunit({ out: dir, source: name, cases })
  check(`real_tests.${name}`, invocation.exitCode === 0, invocation)
  return importTestReport({ report: join(dir, 'junit.xml'), out: join(workspace, 'inbox', name), workspace,
    source: name, experiment: name, command: invocation.command, exitCode: invocation.exitCode, startedAt: invocation.startedAt, finishedAt: invocation.finishedAt })
}
try {
  await start()
  const bId = await create('B')
  aId = await create('A', [{ alias: 'B', taskId: bId }])
  produce('A', [join(root, 'tests/runtime.test.ts')])
  await until(async () => (await view(aId)).result)
  await sleep(1200)
  const first = await view(aId)
  check('one_source_no_completion_or_question', first.status === 'active' && !first.decision && !first.report, first)
  await stop()
  // Source arrives while host is actually stopped: restart must rescan it itself.
  produce('B', [join(root, 'producer/test-report/checks/cn-path.check.mjs')])
  await start()
  const ask = await until(async () => { const t = await view(aId); return t.decision ? t : null }, assessor === 'baseline-menu-first' ? 60000 : 300000)
  check('no_analysis_before_authorization', ask.status === 'active' && !ask.report, ask)
  const originalDecision = ask.decision
  await stop()
  await start()
  const restored = await view(aId)
  check('restart_preserves_question', restored.decision?.attentionId === originalDecision.attentionId, restored)
  const decision = restored.decision
  await api('POST', '/api/present', { ticketId: aId, attentionId: decision.attentionId })
  const option = decision.options.find((o) => ['continue_now', 'analyze_failing'].includes(o.id))
  check('action_is_analysis', !!option, decision)
  const answerBody = { ticketId: aId, attentionId: decision.attentionId, decisionId: decision.decisionId, taskRevision: decision.taskRevision, optionId: option.id }
  check('authorization.accepted', (await api('POST', '/api/answer', answerBody)).ok)
  const done = await until(async () => { const t = await view(aId); return t.status === 'completed' ? t : null })
  check('real_report_visible', done.report?.verified && done.report?.receiptId, done)
  check('duplicate_answer_rejected', (await api('POST', '/api/answer', answerBody)).status === 409)
  await stop()
  verification = verifyCompletion(workspace, aId)
  json(join(out, 'independent-verification.json'), verification)
  check('independent_artifact_check', verification.ok, verification.failures)
  await start()
  check('completion_survives_restart', (await view(aId)).status === 'completed')
  const cId = await create('cancelled', [{ alias: 'B', taskId: bId }])
  check('cancel.accepted', (await api('POST', '/api/cancel', { ticketId: cId })).ok)
  produce('cancelled', [join(root, 'producer/test-report/checks/cn-path.check.mjs')])
  await sleep(3500)
  const cancelled = await view(cId)
  check('cancel_no_late_question', cancelled.status === 'cancelled' && !cancelled.decision && !cancelled.report, cancelled)
  await stop()
  const db = new DatabaseSync(join(workspace, 'state/followup.sqlite'), { readOnly: true })
  check('restart_no_duplicate_effect', db.prepare("SELECT count(*) AS n FROM receipts WHERE ticket_id=? AND tool='write_analysis'").get(aId).n === 1)
  db.close()
  for (const kind of ['missing-artifact', 'missing-proof', 'changed-dependency']) {
    const copy = join(out, `negative-${kind}`)
    cpSync(workspace, copy, { recursive: true })
    if (kind === 'missing-artifact') unlinkSync(join(copy, verification.artifactPath))
    if (kind === 'changed-dependency') appendFileSync(join(copy, 'inbox/B/result.json'), ' ')
    if (kind === 'missing-proof') { const d = new DatabaseSync(join(copy, 'state/followup.sqlite')); d.prepare('UPDATE receipts SET analysis_evidence_json=NULL WHERE ticket_id=?').run(aId); d.close() }
    const negative = verifyCompletion(copy, aId)
    json(join(out, `${kind}.json`), negative)
    check(`negative.${kind}.detected`, !negative.ok, negative.failures)
  }
} catch (error) { checks.push({ name: 'execution', ok: false, detail: String(error) }) }
finally {
  try { await stop() } catch (error) { checks.push({ name: 'shutdown', ok: false, detail: String(error) }); if (child?.exitCode === null) child.kill() }
  const report = { schema: 'pet-core-gate/v1', ok: checks.every((c) => c.ok), mode: assessor === 'baseline-menu-first' ? 'mechanism' : 'live-model', assessor,
    platform: process.platform, node: process.version, timezone, wallClock: true, manualTicks: 0, aId, processes, checks, failures: checks.filter((c) => !c.ok) }
  json(join(out, 'gate.json'), report)
  console.log(JSON.stringify({ ok: report.ok, checks: checks.length, failures: report.failures, out }, null, 2))
  process.exitCode = report.ok ? 0 : 1
}
