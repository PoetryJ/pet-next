#!/usr/bin/env node
/**
 * R6-comparison 正式矩阵驱动（B）。
 *
 * 每个 run：真实宿主进程（真 watcher / RealClock / SQLite / HTTP）+ 真实 JUnit 报告导入 +
 * 真实模型调用（PET_MODEL_RECORD_DIR 留证）。故事历史预置进记忆（见 seed-history.mjs），
 * 当轮 1–3 轮走 /api/say；五臂只由 --assessor 与 PET_MEMORY_ADAPTER 区分（V=版本记忆，T=摘要+检索）。
 *
 * 输出（<out>）：
 * - runs/<id>/：raw.json、http.json、host.log、db/、model-io/、junit 目录
 * - coverage.json：{planSha, runs:[{id, rawPath}]}
 * - comparison.json / cost-ledger.json：由 compare.mjs 只读 raw 生成
 *
 * 失败处理：策略失败不算基础设施失败（照常记录 ok=false 并继续）；基础设施失败保留原文，
 * 同一 run 最多重试 2 次（重试也计入账本），仍失败则非零退出并保留已完成结果。
 *
 * 用法：
 *   node eval/condition-followup/live/run-matrix.mjs --plan <plan.json> --out <新目录>
 *     [--only-case id] [--only-arm V-C] [--only-dev]
 */
import { spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { runJunit } from '../../../producer/test-report/run-junit.mjs'
import { importTestReport } from '../../../producer/import-test-report.mjs'
import { verifyCompletion } from '../../core-completion/verify.mjs'
import { seedHistory } from './seed-history.mjs'
import { compare } from './compare.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const RUN = join(ROOT, 'run.mjs')
const STORY_DIR = join(ROOT, 'eval/condition-followup/stories-v2')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`) }
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

export const ARMS = {
  'V-R': { assessor: 'capability-need-rule', adapter: 'versioned', label: '版本记忆+强规则' },
  'V-L': { assessor: 'capability', adapter: 'versioned', label: '版本记忆+逐事件模型' },
  'V-C': { assessor: 'capability-conditions', adapter: 'versioned', label: '版本记忆+条件' },
  'T-L': { assessor: 'capability', adapter: 'text', label: '文本摘要检索+逐事件模型' },
  'T-C': { assessor: 'capability-conditions', adapter: 'text', label: '文本摘要检索+条件' },
}

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1] }
const flag = (name) => argv.includes(`--${name}`)

if (!arg('out') || !arg('plan')) {
  console.error('usage: node run-matrix.mjs --plan <plan.json> --out <new dir> [--only-case id] [--only-arm V-C] [--only-dev]')
  process.exit(2)
}
const DRY = flag('dry-run')
const outRoot = resolve(arg('out'))
if (existsSync(outRoot) && readdirSync(outRoot).length > 0) { console.error('refusing existing non-empty output'); process.exit(2) }
mkdirSync(outRoot, { recursive: true })
const planBytes = readFileSync(resolve(arg('plan')))
const plan = JSON.parse(planBytes)
const planSha = sha(planBytes)

async function healthOk() {
  const url = process.env.PET_MODEL_BASE_URL
  if (!url) return { ok: false, detail: 'PET_MODEL_BASE_URL missing' }
  try {
    const res = await fetch(`${url.replace(/\/v1$/, '')}/health`, { signal: AbortSignal.timeout(4000) })
    const body = await res.json().catch(() => ({}))
    return { ok: res.ok && body.ready === true, detail: body }
  } catch (error) { return { ok: false, detail: String(error) } }
}

function readModelIo(dir) {
  const entries = []
  if (!existsSync(dir)) return { physicalPosts: 0, failedPosts: 0, retries: 0, promptTokens: 0, completionTokens: 0, entries }
  const files = readdirSync(dir).sort()
  const requests = files.filter((f) => f.endsWith('.request.json'))
  const responses = new Map(files.filter((f) => f.endsWith('.response.json')).map((f) => [f.replace('.response.json', ''), f]))
  for (const file of requests) {
    const req = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    const stem = file.replace('.request.json', '')
    const respFile = responses.get(stem)
    const resp = respFile ? JSON.parse(readFileSync(join(dir, respFile), 'utf8')) : null
    const usage = resp?.body?.usage ?? null
    const status = resp?.status ?? null
    const failed = !resp || (typeof status === 'number' && status !== 200) || Boolean(resp?.error)
    entries.push({
      purpose: req.body?.messages ? (req.body.metadata?.purpose ?? null) : null,
      status, failed,
      at: req.sentAt ?? null,
      receivedAt: resp?.receivedAt ?? null,
      prompt: Number(usage?.prompt_tokens ?? 0),
      completion: Number(usage?.completion_tokens ?? 0),
    })
  }
  const latency = entries.map((e) => (e.at && e.receivedAt ? Date.parse(e.receivedAt) - Date.parse(e.at) : null)).filter((x) => Number.isFinite(x))
  return {
    physicalPosts: entries.length,
    failedPosts: entries.filter((e) => e.failed).length,
    retries: entries.filter((e) => String(e.purpose ?? '').includes('condition-repair')).length,
    promptTokens: entries.reduce((n, e) => n + e.prompt, 0),
    completionTokens: entries.reduce((n, e) => n + e.completion, 0),
    latencyMs: latency.length ? { min: Math.min(...latency), max: Math.max(...latency), avg: Math.round(latency.reduce((a, b) => a + b, 0) / latency.length) } : null,
    entries,
  }
}

function dumpDb(workspace, dir) {
  const stateDir = join(workspace, 'state')
  const sqliteName = existsSync(stateDir) ? readdirSync(stateDir).find((n) => n.endsWith('.sqlite')) : null
  if (!sqliteName) return null
  const source = join(stateDir, sqliteName)
  const target = join(dir, 'db', 'copy.sqlite')
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target)
  const db = new DatabaseSync(target, { readOnly: true })
  const q = (sql) => { try { return db.prepare(sql).all() } catch { return [] } }
  const data = {
    tasks: q('SELECT * FROM tasks'),
    attentions: q('SELECT * FROM attentions'),
    receipts: q('SELECT * FROM receipts'),
    effects: q('SELECT effect_id, ticket_id, kind, state, detail FROM effects'),
    assessments: q('SELECT request_id, ticket_id, status, error_code, round FROM assessments'),
    cond_plans: q('SELECT compilation_key, task_id FROM cond_plans'),
    cond_failures: q('SELECT task_id, status, detail FROM cond_failures'),
    cap_items: q('SELECT item_id, cursor, json FROM cap_items'),
  }
  db.close()
  json(join(dir, 'db', 'dump.json'), data)
  return data
}

async function runOne(planRow, story, outDir, attempt) {
  const arm = ARMS[planRow.arm]
  if (!arm) throw new Error(`unknown arm ${planRow.arm}`)
  // dry-run 只验证管线：用机制基线、不产生 live 证据、不可计入对照。
  const assessor = DRY ? 'baseline-menu-first' : arm.assessor
  const adapter = DRY ? 'versioned' : arm.adapter
  mkdirSync(outDir, { recursive: true })
  const workspace = join(outDir, 'ws')
  mkdirSync(workspace, { recursive: true })
  const http = []
  const timeline = []
  const mark = (kind, detail = {}) => { timeline.push({ at: new Date().toISOString(), kind, ...detail }); json(join(outDir, 'http.json'), http) }
  const modelDir = join(outDir, 'model-io')
  const startedAt = new Date().toISOString()
  let child = null
  let exited = null
  let info = null
  const started = () => {
    const args = ['--experimental-transform-types', '--no-warnings', RUN, 'host', '--workspace', workspace,
      '--timezone', 'Etc/GMT-14', '--assessor', assessor, '--assessor-timeout-ms', '240000']
    child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        PET_MEMORY_ADAPTER: adapter,
        PET_MODEL_RECORD_DIR: modelDir,
        PET_FOLLOWUP_RECHECK_MS: '20000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })))
    child.stdout.on('data', (b) => appendFileSync(join(outDir, 'host.log'), b))
    child.stderr.on('data', (b) => appendFileSync(join(outDir, 'host.log'), b))
  }
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${info.port}${route}`, {
      method, headers: { 'x-followup-token': info.token, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
    })
    const value = await response.json().catch(() => null)
    http.push({ at: new Date().toISOString(), method, route, body, status: response.status, response: value })
    json(join(outDir, 'http.json'), http)
    return { status: response.status, ...(value ?? {}) }
  }
  const waitReady = async () => {
    const end = Date.now() + 60000
    while (Date.now() < end) {
      try {
        const v = JSON.parse(readFileSync(join(workspace, 'state', 'host.json'), 'utf8'))
        if (v.state === 'ready' && v.port && v.token) { info = v; return true }
      } catch { /* 写一半 */ }
      await sleep(200)
    }
    throw new Error('host_not_ready')
  }
  const until = async (fn, ms) => {
    const end = Date.now() + ms
    while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(500) }
    return null
  }
  const stop = async () => {
    if (!child || child.exitCode !== null) return
    try { await api('POST', '/api/shutdown', {}) } catch { /* 强制结束 */ }
    const result = await Promise.race([exited, sleep(10000).then(() => null)])
    if (!result) child.kill('SIGTERM')
    await sleep(300)
  }
  const produce = (key, cases, tag = '') => {
    const junitDir = join(outDir, `junit-${key}${tag}`)
    const invocation = runJunit({ out: junitDir, source: `${key}${tag}`, cases })
    json(join(outDir, `junit-${key}${tag}`, 'invocation.json'), invocation)
    const out = importTestReport({
      report: join(junitDir, 'junit.xml'), out: join(workspace, 'inbox', key), workspace,
      source: `${key}${tag}`, experiment: `story-${story.id}-${key}`, command: invocation.command,
      exitCode: invocation.exitCode, startedAt: invocation.startedAt, finishedAt: invocation.finishedAt,
    })
    mark('produce', { key, tag, exitCode: invocation.exitCode, status: out.status, resultSha: out.resultSha })
    return out
  }
  const tasks = {}
  let verification = null
  let primaryId = null
  const checks = {}
  try {
    started()
    await waitReady()
    mark('host.ready', { pid: info.pid, arm: planRow.arm, adapter, assessor })
    // 建任务：依赖/干扰先建，主任务最后带 bindings
    for (const task of story.tasks.filter((t) => t.key !== 'A')) {
      mkdirSync(join(workspace, task.dir), { recursive: true })
      const res = await api('POST', '/api/tasks', { title: task.title, dir: task.dir, goal: task.goal })
      if (!res.ok) throw new Error(`create_${task.key}_failed:${res.error ?? res.code}`)
      tasks[task.key] = res.task.ticketId
    }
    const primary = story.tasks.find((t) => t.key === 'A')
    mkdirSync(join(workspace, primary.dir), { recursive: true })
    const bindings = (primary.bindings ?? []).map((b) => ({ alias: b.alias, taskId: tasks[b.key] }))
    const created = await api('POST', '/api/tasks', {
      title: primary.title, dir: primary.dir, goal: primary.goal,
      ...(primary.analysisWhen ? { analysisWhen: primary.analysisWhen } : {}),
      ...(bindings.length ? { reportBindings: bindings } : {}),
    })
    if (!created.ok) throw new Error(`create_A_failed:${created.error ?? created.code}`)
    primaryId = created.task.ticketId
    tasks.A = primaryId
    mark('tasks.created', { tasks })

    // 单写者约束：预置历史必须在宿主停止时写（否则 database is locked）。
    await stop()
    let seeded = null
    try { seeded = seedHistory(workspace, story, tasks, new Date().toISOString()) } finally {
      started()
      await waitReady()
    }
    json(join(outDir, 'seed.json'), seeded)
    mark('history.seeded', { turns: story.turns.length, items: seeded?.items ?? 0 })

    for (const say of story.live.livesays ?? []) {
      const res = await api('POST', '/api/say', { text: say.text, ticketId: tasks[say.target] })
      mark('user.say', { target: say.target, status: res.status, text: say.text })
      await sleep(1500)
    }

    if (story.live.cancel) {
      const cancelled = await api('POST', '/api/cancel', { ticketId: tasks.C })
      checks.cancelAccepted = Boolean(cancelled.ok)
      mark('task.cancel', { key: 'C', ok: cancelled.ok })
      produce('C', [join(ROOT, 'producer/test-report/checks/cn-path.check.mjs')])
      await sleep(2500)
      const viewC = await api('GET', `/api/task?ticket=${tasks.C}`)
      checks.cancelNoQuestion = viewC.task?.status === 'cancelled' && !viewC.task?.decision
      mark('cancel.checked', { status: viewC.task?.status, decision: viewC.task?.decision?.attentionId ?? null })
    }

    const order = (story.live.order ?? 'B,A').split(',').map((s) => s.trim())
    const casesByKey = {
      A: [join(ROOT, 'tests/runtime.test.ts')],
      B: [join(ROOT, 'producer/test-report/checks/cn-path.check.mjs')],
      C: [join(ROOT, 'producer/test-report/checks/cn-path.check.mjs')],
    }
    let produced = 0
    for (const key of order) {
      if (story.live.restart && produced === 1) {
        await stop()
        mark('host.stopped', { reason: 'restart_with_missing_source' })
        produce(key, casesByKey[key])
        started()
        await waitReady()
        mark('host.restarted', { pid: info.pid })
      } else {
        produce(key, casesByKey[key])
        if (story.live.duplicate && key === 'B') {
          await sleep(1500)
          produce(key, casesByKey[key], '-dup')
          mark('produce.duplicate', { key })
        }
      }
      produced += 1
      await sleep(2500)
      mark('source.arrived', { key, ticketId: tasks[key] })
    }

    const ask = await until(async () => {
      const view = await api('GET', `/api/task?ticket=${primaryId}`)
      return view.task?.decision ? view : null
    }, 150000)
    checks.asked = Boolean(ask)
    mark('question.window', { asked: Boolean(ask), question: ask?.task?.decision?.question ?? null, attention: ask?.task?.decision?.attentionId ?? null })

    if (ask) {
      const decision = ask.task.decision
      await api('POST', '/api/present', { ticketId: primaryId, attentionId: decision.attentionId })
      const option = decision.options.find((o) => ['continue_now', 'analyze_failing'].includes(o.id)) ?? decision.options[0]
      const answer = await api('POST', '/api/answer', {
        ticketId: primaryId, attentionId: decision.attentionId, decisionId: decision.decisionId,
        taskRevision: decision.taskRevision, optionId: option.id,
      })
      checks.answered = answer.status === 200 && answer.ok === true
      mark('answer', { optionId: option.id, status: answer.status, ok: answer.ok ?? null, code: answer.code ?? null })
    }

    const done = await until(async () => {
      const view = await api('GET', `/api/task?ticket=${primaryId}`)
      return view.task?.status === 'completed' ? view : null
    }, 240000)
    checks.completed = Boolean(done)
    mark('task.terminal', { status: done?.task?.status ?? (await api('GET', `/api/task?ticket=${primaryId}`)).task?.status ?? null })
  } catch (error) {
    checks.error = String(error?.message ?? error)
    mark('run.error', { message: checks.error })
  } finally {
    try { await stop() } catch { /* 已退出 */ }
  }

  let db = null
  try { db = dumpDb(workspace, outDir) } catch (error) { checks.dbExportError = String(error) }
  if (primaryId) {
    try { verification = verifyCompletion(workspace, primaryId) } catch (error) { verification = { ok: false, failures: [{ name: 'verifier.error', detail: String(error) }] } }
    json(join(outDir, 'verification.json'), verification)
  }

  const attentions = db?.attentions ?? []
  const primaryAttentions = attentions.filter((a) => a.ticket_id === primaryId)
  const expected = story.expectation
  const producedAt = (key) => timeline.filter((t) => t.kind === 'produce' && t.key === key).map((t) => t.at)
  const neededKeys = expected.needSources
  const windowStart = producedAt(neededKeys.at(-1)?.[0] ?? 'B')?.[0]
    ?? timeline.filter((t) => t.kind === 'produce').map((t) => t.at).sort().at(-1)
  const firstAsk = primaryAttentions.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0] ?? null
  checks.askedAfterWindow = Boolean(firstAsk && windowStart && Date.parse(firstAsk.created_at) >= Date.parse(windowStart) - 2000)
  checks.askedBeforeWindow = Boolean(firstAsk && windowStart && Date.parse(firstAsk.created_at) < Date.parse(windowStart) - 2000)
  checks.duplicateReminders = Math.max(0, primaryAttentions.length - 1)
  checks.validCompletion = Boolean(verification?.ok)
  checks.noLateQuestionAfterCancel = story.live.cancel ? checks.cancelNoQuestion !== false : true

  const cost = readModelIo(modelDir)
  const ok = Boolean(checks.asked && checks.askedAfterWindow && !checks.askedBeforeWindow
    && checks.duplicateReminders === 0 && checks.answered && checks.validCompletion && checks.noLateQuestionAfterCancel)

  const raw = {
    schema: 'pet-r6-live-run/v2',
    id: planRow.id, mode: DRY ? 'dry-run' : 'live', arm: planRow.arm, armLabel: arm.label, adapter,
    scenario: planRow.caseId, caseSplit: story.split, repeat: planRow.repeat ?? 1, attempt,
    model: { baseUrl: process.env.PET_MODEL_BASE_URL ?? null, name: process.env.PET_MODEL_NAME ?? null },
    startedAt, finishedAt: new Date().toISOString(),
    timeline, ok, checks,
    cost: {
      physicalPosts: cost.physicalPosts, failedPosts: cost.failedPosts, retries: cost.retries,
      promptTokens: cost.promptTokens, completionTokens: cost.completionTokens, latencyMs: cost.latencyMs,
      requests: cost.entries,
    },
    verification: verification ? { ok: verification.ok, failures: verification.failures } : null,
    artifacts: {
      http: 'http.json', hostLog: 'host.log', db: 'db/copy.sqlite', dump: 'db/dump.json', modelIo: 'model-io',
    },
  }
  json(join(outDir, 'raw.json'), raw)
  return raw
}

// ---- 主流程 ----
const health = DRY ? { ok: true, detail: 'dry-run: mechanism baseline, no model' } : await healthOk()
json(join(outRoot, 'preflight.json'), { at: new Date().toISOString(), planSha, dryRun: DRY, health, env: { model: process.env.PET_MODEL_NAME ?? null, baseUrl: process.env.PET_MODEL_BASE_URL ?? null } })
if (!health.ok) {
  json(join(outRoot, 'STATUS.json'), { status: 'blocked', reason: 'model_not_ready', health })
  console.error(`model_not_ready: ${JSON.stringify(health.detail)}`)
  process.exit(3)
}

const onlyCase = arg('only-case')
const onlyArm = arg('only-arm')
const onlyDev = flag('only-dev')
const stories = new Map()
for (const name of readdirSync(STORY_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json')) {
  const story = JSON.parse(readFileSync(join(STORY_DIR, name), 'utf8'))
  stories.set(story.id, story)
}
const rows = plan.runs.filter((r) => (!onlyCase || r.caseId === onlyCase) && (!onlyArm || r.arm === onlyArm)
  && (!onlyDev || stories.get(r.caseId)?.split === 'dev'))

const coverage = []
const failures = []
for (const row of rows) {
  const story = stories.get(row.caseId)
  if (!story) { failures.push({ id: row.id, reason: 'story_missing' }); continue }
  const dir = join(outRoot, 'runs', row.id)
  let raw = null
  let attempt = 0
  for (attempt = 1; attempt <= 3; attempt += 1) {
    try {
      raw = await runOne(row, story, attempt === 1 ? dir : join(dir, `retry-${attempt}`), attempt)
      if (raw.checks.error && attempt < 3) { console.error(`[retry] ${row.id}: ${raw.checks.error}`); continue }
    } catch (error) {
      raw = null
      console.error(`[retry] ${row.id}: ${String(error)}`)
      continue
    }
    break
  }
  if (!raw) { failures.push({ id: row.id, reason: 'infra_failure_after_retries' }); continue }
  coverage.push({ id: row.id, rawPath: relative(outRoot, join(attempt === 1 ? dir : join(dir, `retry-${attempt}`), 'raw.json')) })
  json(join(outRoot, 'coverage.json'), { schema: 'pet-r6-matrix-coverage/v1', planSha, runs: coverage })
  console.error(`[run] ${row.id} arm=${row.arm} ok=${raw.ok} posts=${raw.cost.physicalPosts}`)
  await sleep(500)
}

json(join(outRoot, 'coverage.json'), { schema: 'pet-r6-matrix-coverage/v1', planSha, runs: coverage })
const summary = compare({ outRoot, plan, stories })
json(join(outRoot, 'comparison.json'), summary.comparison)
json(join(outRoot, 'cost-ledger.json'), summary.costLedger)
json(join(outRoot, 'STATUS.json'), {
  status: failures.length === 0 && coverage.length === rows.length ? 'matrix_complete' : 'matrix_incomplete',
  planned: rows.length, measured: coverage.length, failures,
  posts: summary.costLedger.totals.physicalPosts,
})
console.log(JSON.stringify({ planned: rows.length, measured: coverage.length, failures, summar: summary.comparison.totals }, null, 2))
process.exit(failures.length === 0 && coverage.length === rows.length ? 0 : 1)
