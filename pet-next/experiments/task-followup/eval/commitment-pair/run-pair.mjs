#!/usr/bin/env node
/**
 * R7 真实委托 runner：3 条轨迹 × 3 臂 × 2 条相反承诺 = 18 次。
 *
 * 每次运行：新工作区 → 真实 /api/tasks 建主任务与依赖 → 96 条 /api/say 逐条 intake
 * → 真实 JUnit 报告（成功/失败）→ 主任务真实提问/静默归档/取消 → 验证分析或归档。
 *
 * 计量：客户端账本 + 代理账本；原始 HTTP、DB dump、模型请求全部留在 run 目录。
 *
 * 用法：
 *   node eval/commitment-pair/run-pair.mjs --trajectory T1 --promise P --arm V-C --out <新目录>
 *   node eval/commitment-pair/run-pair.mjs --matrix --out <新目录> [--trajectories T1] [--arms V-C] [--promises P]
 */
import { spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { runJunit } from '../../producer/test-report/run-junit.mjs'
import { importTestReport } from '../../producer/import-test-report.mjs'
import { verifyCompletion } from '../core-completion/verify.mjs'
import { ARMS, MATRIX, storyFor } from './stories.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const RUN = join(ROOT, 'run.mjs')
const PROXY = join(ROOT, 'eval/condition-followup/live/accounting/proxy.mjs')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`) }
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const FAIL_CASE = join(ROOT, 'producer/test-report/checks/ci-failure.check.mjs')
const PASS_A = join(ROOT, 'tests/runtime.test.ts')
const PASS_B = join(ROOT, 'producer/test-report/checks/cn-path.check.mjs')

function dbQuery(workspace, sql, params = []) {
  try {
    const db = new DatabaseSync(join(workspace, 'state', 'followup.sqlite'), { readOnly: true })
    const rows = db.prepare(sql).all(...params)
    db.close()
    return rows
  } catch { return [] }
}

async function startProxy(dir, port) {
  const ledger = join(dir, 'proxy-ledger.jsonl')
  const upstream = process.env.PET_MODEL_UPSTREAM ?? 'http://127.0.0.1:18882'
  const child = spawn(process.execPath, [PROXY, '--port', String(port), '--upstream', upstream, '--ledger', ledger], { stdio: ['ignore', 'pipe', 'pipe'] })
  const until = Date.now() + 10000
  while (Date.now() < until) {
    try { const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }); if (res.ok) return { child, port, ledger } } catch { /* 等就绪 */ }
    await sleep(200)
  }
  child.kill('SIGKILL')
  throw new Error('proxy_not_ready')
}

export async function runOne({ trajectory, promise, arm, outDir, port }) {
  const spec = storyFor(trajectory, promise)
  const armSpec = ARMS[arm]
  if (!armSpec) throw new Error(`unknown arm ${arm}`)
  if (existsSync(outDir)) throw new Error(`output directory already exists: ${outDir}`)
  mkdirSync(outDir, { recursive: true })
  const workspace = join(outDir, 'ws')
  mkdirSync(workspace, { recursive: true })
  const proxy = await startProxy(outDir, port)
  const clientLedger = join(outDir, 'client-ledger.jsonl')
  const startedAt = new Date().toISOString()
  const timeline = []
  const http = []
  const checks = { earlyQuestions: 0, mainQuestions: 0 }
  let info = null
  let child = null
  let exited = null
  let action = null
  const mark = (kind, detail = {}) => {
    timeline.push({ at: new Date().toISOString(), kind, ...detail })
    json(join(outDir, 'timeline.json'), timeline)
  }
  const startHost = async () => {
    child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', RUN, 'host',
      '--workspace', workspace, '--timezone', 'Etc/GMT-2', '--assessor', armSpec.assessor, '--assessor-timeout-ms', process.env.PET_ASSESSOR_TIMEOUT_MS ?? '600000'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PET_MODEL_BASE_URL: `http://127.0.0.1:${proxy.port}/v1`,
        PET_MEMORY_ADAPTER: armSpec.adapter,
        PET_CALL_LEDGER: clientLedger,
        PET_MODEL_RECORD_DIR: join(outDir, 'model-io'),
        PET_FOLLOWUP_RECHECK_MS: '20000',
        PET_MODEL_TIMEOUT_MS: process.env.PET_MODEL_TIMEOUT_MS ?? '600000',
        PET_ASSESS_SETTLE: '1',
        PET_CONDITION_MENU: '1',
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
  const waitSettled = async (timeoutMs = 180000, ticketId = null) => {
    const end = Date.now() + timeoutMs
    let stable = 0
    let last = -1
    while (Date.now() < end) {
      const rows = ticketId
        ? dbQuery(workspace, 'SELECT status, COUNT(*) AS n FROM assessments WHERE ticket_id = ? GROUP BY status', [ticketId])
        : dbQuery(workspace, 'SELECT status, COUNT(*) AS n FROM assessments GROUP BY status')
      const total = rows.reduce((n, r) => n + Number(r.n), 0)
      const pending = rows.find((r) => r.status === 'pending')?.n ?? 0
      if (pending === 0 && total === last) stable += 1
      else stable = 0
      last = total
      if (stable >= 3) return true
      await sleep(1000)
    }
    return false
  }
  const produce = (key, status) => {
    const cases = key === 'A'
      ? [status === 'failed' ? FAIL_CASE : PASS_A]
      : [status === 'failed' ? FAIL_CASE : PASS_B]
    const dir = join(outDir, `junit-${key}-${status}`)
    const invocation = runJunit({ out: dir, source: `r7-${key}-${status}-${randomUUID().slice(0, 6)}`, cases })
    const out = importTestReport({
      report: join(dir, 'junit.xml'), out: join(workspace, 'inbox', key), workspace,
      source: `r7-${key}`, experiment: `r7-${trajectory}-${promise}-${key}`, command: invocation.command,
      exitCode: invocation.exitCode, startedAt: invocation.startedAt, finishedAt: invocation.finishedAt,
    })
    mark('produce', { key, status, observed: out.status, revision: out.revision })
    return out
  }
  const mainAttention = () => dbQuery(workspace,
    "SELECT attention_id, decision_id, task_revision, question, options_json, state, created_at, delivered_at, presented_at FROM attentions WHERE ticket_id = ? ORDER BY created_at ASC",
    [tasks.A])
  const taskRow = (id) => dbQuery(workspace, 'SELECT status, stage, completion_json FROM tasks WHERE ticket_id = ?', [id])[0] ?? null
  const waitAction = async (timeoutMs) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      const row = taskRow(tasks.A)
      const open = mainAttention().filter((a) => a.state === 'open')
      if (open.length) return { kind: 'ask', attention: open[0], status: row?.status ?? null }
      if (row?.status === 'archived') return { kind: 'archive', status: row.status }
      if (row?.status === 'cancelled') return { kind: 'cancelled', status: row.status }
      if (row?.status === 'completed') return { kind: 'completed', status: row.status }
      await sleep(1500)
    }
    return { kind: 'timeout', status: taskRow(tasks.A)?.status ?? null }
  }
  const tasks = {}
  let verification = null
  try {
    await startHost()
    mark('host.ready', { pid: info.pid })
    for (const key of ['B']) {
      mkdirSync(join(workspace, 'inbox', key), { recursive: true })
      const created = await api('POST', '/api/tasks', { title: '依赖检查', dir: `inbox/${key}`, goal: '接收报告' })
      tasks[key] = created.task.ticketId
    }
    mkdirSync(join(workspace, 'inbox', 'A'), { recursive: true })
    const created = await api('POST', '/api/tasks', {
      title: '主测试', dir: 'inbox/A', goal: '跟进 CI；按用户承诺决定何时需要确认',
      analysisWhen: 'always',
      reportBindings: [{ alias: 'B 报告', taskId: tasks.B }],
    })
    if (!created.ok) throw new Error(`create_A_failed:${created.error ?? created.code}`)
    tasks.A = created.task.ticketId
    mark('tasks.created', { tasks })

    for (const turn of spec.history) {
      const res = await api('POST', '/api/say', { text: turn.text, ticketId: tasks[turn.target] })
      if (res.status !== 200) throw new Error(`say_failed:${res.code ?? res.status}`)
    }
    checks.historyTurns = spec.history.length
    mark('history.intake', { turns: spec.history.length })
    checks.historySettled = await waitSettled(90000, tasks.A)
    mark('history.settled', { ok: checks.historySettled })

    for (const step of spec.steps) {
      if (step.op === 'say') {
        const res = await api('POST', '/api/say', { text: step.text, ticketId: tasks[step.target] })
        mark('user.say', { target: step.target, status: res.status, text: step.text })
        await waitSettled(90000, tasks.A)
      } else if (step.op === 'produce') {
        produce(step.key, step.status)
        await waitSettled(30000, tasks.A)
      } else if (step.op === 'quiet-check') {
        const end = Date.now() + step.ms
        let seen = null
        while (Date.now() < end) {
          const open = mainAttention().filter((a) => a.state === 'open')
          if (open.length) { seen = open[0]; break }
          await sleep(1000)
        }
        if (seen) {
          checks.earlyQuestions += 1
          checks.earlyQuestion = seen.question
        }
        mark('check.quiet', { ms: step.ms, early: Boolean(seen), question: seen?.question ?? null })
      } else if (step.op === 'restart') {
        await stopHost()
        mark('host.restarting', {})
        await startHost()
        mark('host.restarted', { pid: info.pid })
      } else if (step.op === 'cancel') {
        const res = await api('POST', '/api/cancel', { ticketId: tasks[step.target] })
        checks.cancelled = Boolean(res.ok)
        checks.cancelledAt = new Date().toISOString()
        mark('task.cancel', { target: step.target, ok: res.ok })
        await waitSettled(60000, tasks.A)
      } else if (step.op === 'await') {
        action = await waitAction(step.timeoutMs)
        checks.action = action.kind
        mark('action', { result: action.kind, status: action.status, question: action.attention?.question ?? null })
        if (action.kind === 'ask') checks.mainQuestions += 1
      } else if (step.op === 'answer') {
        const seen = mainAttention().find((a) => a.state === 'open')
        if (seen) {
          const options = JSON.parse(seen.options_json ?? '[]')
          await api('POST', '/api/present', { ticketId: tasks.A, attentionId: seen.attention_id })
          checks.presentedAt = new Date().toISOString()
          const option = options.find((o) => o.id === step.option) ?? options[0]
          const answered = await api('POST', '/api/answer', {
            ticketId: tasks.A, attentionId: seen.attention_id, decisionId: seen.decision_id,
            taskRevision: Number(seen.task_revision), optionId: option?.id,
          })
          checks.answered = answered.status === 200 && answered.ok === true
          checks.answeredAt = new Date().toISOString()
          mark('answer', { optionId: option?.id ?? null, status: answered.status, ok: answered.ok ?? null })
        } else {
          checks.answered = false
          mark('answer.missing', {})
        }
      } else if (step.op === 'await-terminal') {
        const end = Date.now() + step.timeoutMs
        while (Date.now() < end) {
          const row = taskRow(tasks.A)
          if (row && row.status !== 'active') break
          await sleep(2000)
        }
        const row = taskRow(tasks.A)
        checks.finalStatus = row?.status ?? null
        checks.finalStage = row?.stage ?? null
        mark('terminal', { status: checks.finalStatus, stage: checks.finalStage })
      } else if (step.op === 'late-check') {
        await sleep(step.ms)
        const after = mainAttention().filter((a) => !checks.cancelledAt || String(a.created_at) >= checks.cancelledAt)
        checks.lateAttentions = after.length
        checks.finalStatus = taskRow(tasks.A)?.status ?? null
        mark('check.late', { ms: step.ms, attentionsAfterCancel: after.length, status: checks.finalStatus })
      }
    }
  } catch (error) {
    checks.error = String(error?.message ?? error)
    mark('run.error', { message: checks.error })
  } finally {
    try { await stopHost() } catch { /* 已退出 */ }
  }

  if (tasks.A) {
    try { verification = verifyCompletion(workspace, tasks.A) } catch (error) { verification = { ok: false, failures: [{ name: 'verifier.error', detail: String(error) }] } }
    json(join(outDir, 'verification.json'), verification)
  }

  const dump = (() => {
    try {
      const src = join(workspace, 'state', 'followup.sqlite')
      const dst = join(outDir, 'db', 'copy.sqlite')
      mkdirSync(dirname(dst), { recursive: true })
      cpSync(src, dst)
      const db = new DatabaseSync(dst, { readOnly: true })
      const q = (sql) => { try { return db.prepare(sql).all() } catch { return [] } }
      const data = {
        tasks: q('SELECT * FROM tasks'),
        attentions: q('SELECT * FROM attentions'),
        notifications: q('SELECT * FROM notifications'),
        receipts: q('SELECT * FROM receipts'),
        proposals: q('SELECT decision_id, ticket_id, kind, reason_code, outcome, created_at FROM proposals'),
        assessments: q('SELECT request_id, ticket_id, status, assessor, capability, round, error_code, error_detail, created_at, completed_at, raw_json, post_guard_json FROM assessments'),
        cond_plans: q('SELECT * FROM cond_plans'),
        cond_current: q('SELECT * FROM cond_current'),
        cond_evals: q('SELECT * FROM cond_evals'),
        cond_failures: q('SELECT * FROM cond_failures'),
        cap_items: q('SELECT item_id, cursor, json FROM cap_items'),
        text_state: q('SELECT task_id, seq, length(summary) AS chars FROM cap_text_state'),
        driver_log: q("SELECT at, ticket_id, kind, detail_json FROM driver_log WHERE kind LIKE 'task.%' OR kind LIKE 'proposal.%' OR kind LIKE 'assessment.%' ORDER BY at"),
      }
      db.close()
      json(join(outDir, 'db', 'dump.json'), data)
      return data
    } catch (error) { return { error: String(error) } }
  })()

  const mainAttentions = (dump.attentions ?? []).filter((a) => a.ticket_id === tasks.A)
  const sideAttentions = (dump.attentions ?? []).filter((a) => a.ticket_id !== tasks.A)
  const notifs = dump.notifications ?? []
  const mainNotifs = notifs.filter((n) => n.ticket_id === tasks.A)
  const sideNotifs = notifs.filter((n) => n.ticket_id !== tasks.A)
  const taskFinal = (dump.tasks ?? []).find((t) => t.ticket_id === tasks.A) ?? null
  const completion = taskFinal?.completion_json ? JSON.parse(taskFinal.completion_json) : null
  checks.finalStatus = taskFinal?.status ?? checks.finalStatus ?? null
  checks.finalStage = taskFinal?.stage ?? checks.finalStage ?? null
  checks.mainAttentions = mainAttentions.length
  checks.mainNotifications = mainNotifs.length
  checks.sideAttentions = sideAttentions.length
  checks.sideNotifications = sideNotifs.length
  checks.archive = completion?.mode === 'quiet_archive' ? completion : null
  checks.analysisValid = Boolean(verification?.ok)
  checks.asked = mainAttentions.length > 0
  checks.presented = mainAttentions.some((a) => a.presented_at)
  checks.delivered = mainAttentions.some((a) => a.delivered_at)
  checks.duplicates = Math.max(0, mainAttentions.length - 1)

  const produced = timeline.filter((t) => t.kind === 'produce')
  const lastProduced = produced.at(-1)?.at ?? null
  const firstAsk = mainAttentions.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0] ?? null
  checks.askedAfterLastReport = Boolean(firstAsk && lastProduced && Date.parse(firstAsk.created_at) >= Date.parse(lastProduced) - 2000)
  checks.askedBeforeLastReport = Boolean(firstAsk && lastProduced && Date.parse(firstAsk.created_at) < Date.parse(lastProduced) - 2000)

  // 可见延迟：报告落盘 → 第一次 delivered/presented；授权 → 产物。
  const delivered = mainAttentions.map((a) => a.delivered_at ?? a.presented_at).filter(Boolean).sort()[0] ?? null
  checks.reportToVisibleMs = delivered && lastProduced ? Date.parse(delivered) - Date.parse(lastProduced) : null
  const answered = timeline.find((t) => t.kind === 'answer')?.at ?? null
  const terminal = timeline.find((t) => t.kind === 'terminal')?.at ?? null
  checks.answerToArtifactMs = answered && terminal && verification?.ok ? Date.parse(terminal) - Date.parse(answered) : null

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

  const raw = {
    schema: 'pet-r7-commitment-run/v1',
    mode: 'live',
    trajectory, promise, arm, armLabel: armSpec.label, adapter: armSpec.adapter, path: armSpec.path,
    title: spec.title,
    promiseText: spec.history[0].text,
    startedAt, finishedAt: new Date().toISOString(),
    checks,
    expectation: spec.expectation,
    tasks,
    timeline: timeline.map((t) => ({ at: t.at, kind: t.kind, key: t.key ?? null, status: t.status ?? null, action: t.result ?? null, question: t.question ?? null })),
    verification: verification ? { ok: verification.ok, failures: verification.failures } : null,
    cost,
  }
  json(join(outDir, 'raw.json'), raw)
  try { proxy.child.kill('SIGKILL') } catch { /* 已退出 */ }
  return raw
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] }
const flag = (name) => args.includes(`--${name}`)
const out = arg('out')
if (!out) { console.error('usage: --out <new dir> (--trajectory T1 --promise P --arm V-C | --matrix)'); process.exit(2) }
mkdirSync(out, { recursive: true })
const only = (name) => (arg(name, '') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const trajectories = only('trajectories')
const promises = only('promises')
const arms = only('arms')
const matrix = MATRIX.filter((cell) =>
  (!trajectories.length || trajectories.includes(cell.trajectory))
  && (!promises.length || promises.includes(cell.promise)))

const rows = []
const basePort = Number(arg('base-port', '19100'))
if (flag('matrix')) {
  let index = 0
  for (const cell of matrix) for (const arm of (arms.length ? arms : Object.keys(ARMS))) {
    const dir = join(out, `${cell.id}-${arm}`)
    const port = basePort + (index % 700)
    index += 1
    if (existsSync(join(dir, 'raw.json'))) { rows.push(JSON.parse(readFileSync(join(dir, 'raw.json'), 'utf8'))); continue }
    console.error(`[r7] ${cell.id}/${arm} port=${port}`)
    try { rows.push(await runOne({ ...cell, arm, outDir: dir, port })) } catch (error) { rows.push({ trajectory: cell.trajectory, promise: cell.promise, arm, ok: false, checks: { error: String(error) } }) }
  }
  json(join(out, 'runs.json'), { at: new Date().toISOString(), rows })
  console.log(JSON.stringify(rows.map((r) => ({ id: `${r.trajectory}-${r.promise}-${r.arm}`, action: r.checks?.action ?? null, status: r.checks?.finalStatus ?? null, analysis: r.checks?.analysisValid ?? null, posts: r.cost?.clientPosts ?? null })), null, 2))
  process.exit(0)
}
const trajectory = arg('trajectory', 'T1')
const promise = arg('promise', 'P')
const arm = arg('arm', 'V-C')
const result = await runOne({ trajectory, promise, arm, outDir: join(out, `${trajectory}-${promise}-${arm}`), port: basePort })
console.log(JSON.stringify({ trajectory, promise, arm, checks: result.checks, cost: result.cost }, null, 2))
}
