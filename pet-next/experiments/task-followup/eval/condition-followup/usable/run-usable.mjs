#!/usr/bin/env node
/**
 * R6-usable 真实工作 runner：真实 intake（逐条 /api/say）→ 真实报告 → 必要提问 → 授权分析 → 核验。
 *
 * 不写 seed、不预标抽取/摘要、不在停机时注入历史；重启只在故事要求时发生。
 * 计量：客户端账本（PET_CALL_LEDGER）+ 代理账本（x-pet-request-id），逐 run 双端对账。
 *
 * 用法：
 *   node eval/condition-followup/usable/run-usable.mjs --story S1 --arm V-C --out <新目录>
 *   node eval/condition-followup/usable/run-usable.mjs --matrix --out <新目录> [--stories S1,S2,S3] [--arms V-C]
 */
import { spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { runJunit } from '../../../producer/test-report/run-junit.mjs'
import { importTestReport } from '../../../producer/import-test-report.mjs'
import { verifyCompletion } from '../../core-completion/verify.mjs'
import { STORIES, ARMS } from './stories.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const RUN = join(ROOT, 'run.mjs')
const PROXY = join(HERE, '../live/accounting/proxy.mjs')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`) }
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function dbQuery(workspace, sql, params = []) {
  try {
    const db = new DatabaseSync(join(workspace, 'state', 'followup.sqlite'), { readOnly: true })
    const rows = db.prepare(sql).all(...params)
    db.close()
    return rows
  } catch { return [] }
}

async function startProxy(dir) {
  const port = 19000 + Math.floor(Math.random() * 800)
  const ledger = join(dir, 'proxy-ledger.jsonl')
  const child = spawn(process.execPath, [PROXY, '--port', String(port), '--upstream', process.env.PET_MODEL_UPSTREAM ?? 'http://127.0.0.1:18882', '--ledger', ledger], { stdio: ['ignore', 'pipe', 'pipe'] })
  const until = Date.now() + 10000
  while (Date.now() < until) {
    try { const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }); if (res.ok) return { child, port, ledger } } catch { /* 等就绪 */ }
    await sleep(200)
  }
  child.kill('SIGKILL')
  throw new Error('proxy_not_ready')
}

async function runOne({ story, arm, outDir }) {
  const spec = STORIES[story]
  const armSpec = ARMS[arm]
  if (!spec || !armSpec) throw new Error(`unknown story/arm ${story}/${arm}`)
  mkdirSync(outDir, { recursive: true })
  const workspace = join(outDir, 'ws')
  mkdirSync(workspace, { recursive: true })
  const proxy = await startProxy(outDir)
  const clientLedger = join(outDir, 'client-ledger.jsonl')
  const startedAt = new Date().toISOString()
  const timeline = []
  const http = []
  const checks = {}
  const mark = (kind, detail = {}) => { timeline.push({ at: new Date().toISOString(), kind, ...detail }); json(join(outDir, 'http.json'), http) }
  let info = null
  let child = null
  let exited = null
  const startHost = async () => {
    child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', RUN, 'host',
      '--workspace', workspace, '--timezone', 'Etc/GMT-14', '--assessor', armSpec.assessor, '--assessor-timeout-ms', '240000'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PET_MODEL_BASE_URL: `http://127.0.0.1:${proxy.port}/v1`,
        PET_MEMORY_ADAPTER: armSpec.adapter,
        PET_CALL_LEDGER: clientLedger,
        PET_MODEL_RECORD_DIR: join(outDir, 'model-io'),
        PET_FOLLOWUP_RECHECK_MS: '20000',
        PET_MODEL_TIMEOUT_MS: process.env.PET_MODEL_TIMEOUT_MS ?? '600000',
        // 长历史真实运行：同一身份判过就等新证据，避免每秒重判（见 engine 注释）。
        PET_ASSESS_SETTLE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })))
    child.stdout.on('data', (b) => appendFileSync(join(outDir, 'host.log'), b))
    child.stderr.on('data', (b) => appendFileSync(join(outDir, 'host.log'), b))
    const until = Date.now() + 60000
    while (Date.now() < until) {
      try {
        const v = JSON.parse(readFileSync(join(workspace, 'state', 'host.json'), 'utf8'))
        if (v.state === 'ready' && v.port && v.token) { info = v; return }
      } catch { /* 写一半 */ }
      await sleep(200)
    }
    throw new Error('host_not_ready')
  }
  const stopHost = async () => {
    if (!child || child.exitCode !== null) return
    try { await api('POST', '/api/shutdown', {}) } catch { /* 强制 */ }
    let r = await Promise.race([exited, sleep(8000).then(() => null)])
    if (!r) { child.kill('SIGTERM'); r = await Promise.race([exited, sleep(4000).then(() => null)]) }
    if (!r) { child.kill('SIGKILL'); await Promise.race([exited, sleep(2000).then(() => null)]) }
    await sleep(400)
  }
  const api = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${info.port}${route}`, {
      method, headers: { 'x-followup-token': info.token, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
    })
    const value = await res.json().catch(() => null)
    http.push({ at: new Date().toISOString(), method, route, body: body ?? null, status: res.status, response: value })
    json(join(outDir, 'http.json'), http)
    return { status: res.status, ...(value ?? {}) }
  }
  const waitSettled = async (timeoutMs = 120000) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      const rows = dbQuery(workspace, "SELECT status, COUNT(*) AS n FROM assessments GROUP BY status")
      const pending = rows.find((r) => r.status === 'pending')?.n ?? 0
      if (!pending && rows.length > 0) return true
      await sleep(300)
    }
    return false
  }
  const produce = (key) => {
    const cases = key === 'A' ? [join(ROOT, 'tests/runtime.test.ts')] : [join(ROOT, 'producer/test-report/checks/cn-path.check.mjs')]
    const dir = join(outDir, `junit-${key}`)
    const invocation = runJunit({ out: dir, source: `usable-${key}-${randomUUID().slice(0, 6)}`, cases })
    const out = importTestReport({
      report: join(dir, 'junit.xml'), out: join(workspace, 'inbox', key), workspace,
      source: `usable-${key}`, experiment: `usable-${spec.id}-${key}`, command: invocation.command,
      exitCode: invocation.exitCode, startedAt: invocation.startedAt, finishedAt: invocation.finishedAt,
    })
    mark('produce', { key, status: out.status, revision: out.revision })
    return out
  }
  const tasks = {}
  let primaryId = null
  let verification = null
  try {
    await startHost()
    mark('host.ready', { pid: info.pid })
    for (const key of ['C', 'B']) {
      mkdirSync(join(workspace, 'inbox', key), { recursive: true })
      const created = await api('POST', '/api/tasks', { title: key === 'B' ? '依赖检查' : '干扰构建', dir: `inbox/${key}`, goal: '接收报告' })
      tasks[key] = created.task.ticketId
    }
    mkdirSync(join(workspace, 'inbox', 'A'), { recursive: true })
    const created = await api('POST', '/api/tasks', {
      title: '主测试', dir: 'inbox/A', goal: '跟进主测试；按用户承诺决定何时需要确认', analysisWhen: 'always',
      reportBindings: [{ alias: 'B 报告', taskId: tasks.B }],
    })
    if (!created.ok) throw new Error(`create_A_failed:${created.error ?? created.code}`)
    tasks.A = created.task.ticketId
    primaryId = tasks.A
    mark('tasks.created', { tasks })

    // 真实 intake：96 条逐条按时间到达（不写库、不预标）
    for (const turn of spec.history) {
      const res = await api('POST', '/api/say', { text: turn.text, ticketId: tasks[turn.target] })
      if (res.status !== 200) throw new Error(`say_failed:${res.code ?? res.status}`)
    }
    checks.historyTurns = spec.history.length
    mark('history.intake', { turns: spec.history.length })
    checks.historySettled = await waitSettled(180000)
    mark('history.settled', { ok: checks.historySettled })

    for (const step of spec.steps) {
      if (step.op === 'say') {
        const res = await api('POST', '/api/say', { text: step.text, ticketId: tasks[step.target] })
        mark('user.say', { target: step.target, status: res.status, text: step.text })
        await waitSettled(180000)
      } else if (step.op === 'produce') {
        produce(step.key)
        await waitSettled(120000)
      } else if (step.op === 'wait-for-question-check') {
        const waited = Date.now() + 30000
        let decision = null
        while (Date.now() < waited) {
          const view = await api('GET', `/api/task?ticket=${primaryId}`)
          decision = view.task?.decision ?? null
          if (decision) break
          await sleep(1000)
        }
        checks.questionBeforeAllSources = Boolean(decision)
        mark('check.early', { decision: decision?.attentionId ?? null })
      } else if (step.op === 'restart') {
        await stopHost()
        mark('host.restarting', {})
        await startHost()
        mark('host.restarted', { pid: info.pid })
      } else if (step.op === 'cancel') {
        const res = await api('POST', '/api/cancel', { ticketId: tasks[step.target] })
        checks.cancelled = Boolean(res.ok)
        mark('task.cancel', { target: step.target, ok: res.ok })
      } else if (step.op === 'await-question') {
        const until = Date.now() + 180000
        let seen = null
        while (Date.now() < until) {
          const view = await api('GET', `/api/task?ticket=${primaryId}`)
          seen = view.task?.decision ?? null
          if (seen) break
          await sleep(1500)
        }
        checks.asked = Boolean(seen)
        checks.question = seen?.question ?? null
        mark('question', { asked: checks.asked, question: checks.question, attention: seen?.attentionId ?? null })
        if (seen) {
          await api('POST', '/api/present', { ticketId: primaryId, attentionId: seen.attentionId })
          const option = (seen.options ?? []).find((o) => o.id === step.option) ?? seen.options?.[0]
          const answered = await api('POST', '/api/answer', {
            ticketId: primaryId, attentionId: seen.attentionId, decisionId: seen.decisionId,
            taskRevision: seen.taskRevision, optionId: option.id,
          })
          checks.answered = answered.status === 200 && answered.ok === true
          mark('answer', { optionId: option?.id ?? null, status: answered.status, ok: answered.ok ?? null, code: answered.code ?? null })
        }
      } else if (step.op === 'await-completion') {
        const until = Date.now() + 240000
        while (Date.now() < until) {
          const view = await api('GET', `/api/task?ticket=${primaryId}`)
          if (view.task?.status && view.task.status !== 'active') break
          await sleep(2000)
        }
        const final = await api('GET', `/api/task?ticket=${primaryId}`)
        checks.finalStatus = final.task?.status ?? null
        mark('task.terminal', { status: checks.finalStatus })
      } else if (step.op === 'assert') {
        if (step.what === 'no-question-before-a') checks.noQuestionBeforeA = !checks.askedBeforeA
        if (step.what === 'cancelled-silent') {
          const attentions = dbQuery(workspace, 'SELECT attention_id, ticket_id FROM attentions WHERE ticket_id = ?', [tasks.C])
          const st = dbQuery(workspace, 'SELECT status FROM tasks WHERE ticket_id = ?', [tasks.C])[0]?.status ?? null
          checks.cancelledStatus = st
          checks.cancelledAttentions = attentions.length
          checks.cancelSilent = st === 'cancelled' && attentions.length === 0
          mark('assert.cancel', { status: st, attentions: attentions.length })
        }
      }
    }
  } catch (error) {
    checks.error = String(error?.message ?? error)
    mark('run.error', { message: checks.error })
  } finally {
    try { await stopHost() } catch { /* 已退出 */ }
  }

  try { verification = primaryId ? verifyCompletion(workspace, primaryId) : null } catch (error) { verification = { ok: false, failures: [{ name: 'verifier.error', detail: String(error) }] } }
  if (verification) json(join(outDir, 'verification.json'), verification)

  // 依赖证据：改口后 bindings 是否真的变（S2）
  const taskRow = primaryId ? dbQuery(workspace, 'SELECT * FROM tasks WHERE ticket_id = ?', [primaryId])[0] ?? null : null
  const bindings = taskRow?.bindings_json ? JSON.parse(taskRow.bindings_json) : []
  checks.bindings = bindings
  checks.taskRevision = taskRow?.task_revision ?? null
  if (spec.expectation.correctionDropsB) checks.bindingNarrowed = bindings.length === 0
  if (spec.expectation.cancelled) checks.cancelSilent = checks.cancelSilent === true

  const dump = (() => {
    try {
      const src = join(workspace, 'state', 'followup.sqlite')
      const dst = join(outDir, 'db', 'copy.sqlite')
      mkdirSync(dirname(dst), { recursive: true })
      cpSync(src, dst)
      const db = new DatabaseSync(dst, { readOnly: true })
      const q = (sql) => { try { return db.prepare(sql).all() } catch { return [] } }
      const data = { tasks: q('SELECT * FROM tasks'), attentions: q('SELECT * FROM attentions'), receipts: q('SELECT * FROM receipts'), assessments: q('SELECT request_id, ticket_id, status, error_code, round FROM assessments'), cond_plans: q('SELECT compilation_key, task_id FROM cond_plans'), cond_failures: q('SELECT task_id, status, detail FROM cond_failures'), cap_items: q('SELECT item_id, cursor, json FROM cap_items'), text_state: q('SELECT task_id, seq, length(summary) AS chars FROM cap_text_state') }
      db.close()
      json(join(outDir, 'db', 'dump.json'), data)
      return data
    } catch (error) { return { error: String(error) } }
  })()

  const attentions = (dump.attentions ?? []).filter((a) => a.ticket_id === primaryId)
  const producedAt = timeline.filter((t) => t.kind === 'produce')
  const needed = spec.expectation.requiredKeys
  const windowStart = producedAt.filter((p) => needed.includes(p.key)).map((p) => p.at).sort().at(-1) ?? null
  const firstAsk = attentions.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0] ?? null
  checks.askedAfterWindow = Boolean(firstAsk && windowStart && Date.parse(firstAsk.created_at) >= Date.parse(windowStart) - 2000)
  checks.askedBeforeWindow = Boolean(firstAsk && windowStart && Date.parse(firstAsk.created_at) < Date.parse(windowStart) - 2000)
  checks.duplicateReminders = Math.max(0, attentions.length - 1)
  checks.validCompletion = Boolean(verification?.ok)

  const cost = (() => {
    const rows = existsSync(clientLedger) ? readFileSync(clientLedger, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    const ends = rows.filter((r) => r.phase === 'end')
    const proxyRows = existsSync(proxy.ledger) ? readFileSync(proxy.ledger, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    const proxyEnds = proxyRows.filter((r) => r.phase === 'end')
    const usage = (list) => list.reduce((n, r) => n + Number(r.usage?.prompt_tokens ?? r.inputTokens ?? 0) + Number(r.usage?.completion_tokens ?? r.outputTokens ?? 0), 0)
    return {
      clientPosts: ends.length,
      clientUnknown: ends.filter((r) => !r.usageKnown).length,
      proxyPosts: proxyEnds.length,
      proxyUnknown: proxyEnds.filter((r) => !r.usageKnown).length,
      clientTokens: usage(ends),
      proxyTokens: usage(proxyEnds),
      abortedButServerCompleted: proxyEnds.filter((r) => r.clientAborted && r.serverCompleted).length,
    }
  })()

  const ok = Boolean(checks.asked && checks.askedAfterWindow && !checks.askedBeforeWindow && checks.duplicateReminders === 0
    && checks.answered && checks.validCompletion && checks.cancelSilent !== false && checks.bindingNarrowed !== false)
  const raw = {
    schema: 'pet-r6-usable-run/v1', mode: 'live', story, arm, armLabel: armSpec.label, adapter: armSpec.adapter,
    startedAt, finishedAt: new Date().toISOString(), ok, checks,
    history: { turns: spec.history.length, settled: checks.historySettled },
    verification: verification ? { ok: verification.ok, failures: verification.failures } : null,
    cost,
  }
  json(join(outDir, 'raw.json'), raw)
  try { proxy.child.kill('SIGKILL') } catch { /* 已退出 */ }
  return raw
}

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] }
const flag = (name) => args.includes(`--${name}`)
const out = arg('out')
if (!out) { console.error('usage: --out <new dir> (--story S1 --arm V-C | --matrix)'); process.exit(2) }
mkdirSync(out, { recursive: true })
const onlyStories = (arg('stories', '') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const onlyArms = (arg('arms', '') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const stories = onlyStories.length ? onlyStories : Object.keys(STORIES)
const arms = onlyArms.length ? onlyArms : Object.keys(ARMS)
const rows = []
if (flag('matrix')) {
  for (const story of stories) for (const arm of arms) {
    const dir = join(out, `${story}-${arm}`)
    if (existsSync(join(dir, 'raw.json'))) { rows.push(JSON.parse(readFileSync(join(dir, 'raw.json'), 'utf8'))); continue }
    console.error(`[usable] ${story}/${arm}`)
    try { rows.push(await runOne({ story, arm, outDir: dir })) } catch (error) { rows.push({ story, arm, ok: false, checks: { error: String(error) } }) }
  }
  json(join(out, 'runs.json'), { at: new Date().toISOString(), rows })
  console.log(JSON.stringify(rows.map((r) => ({ story: r.story, arm: r.arm, ok: r.ok, posts: r.cost?.clientPosts })), null, 2))
  process.exit(rows.every((r) => r.ok) ? 0 : 1)
}
const story = arg('story', 'S1')
const arm = arg('arm', 'V-C')
const result = await runOne({ story, arm, outDir: join(out, `${story}-${arm}`) })
console.log(JSON.stringify({ story, arm, ok: result.ok, checks: result.checks, cost: result.cost }, null, 2))
process.exit(result.ok ? 0 : 1)
