#!/usr/bin/env node
/**
 * R6-live 真实五臂 driver（开发 pilot / 矩阵）。
 *
 * 每个 run 都起**真实 host 进程**（真实 watcher、RealClock、SQLite、HTTP 呈现/回答），
 * 用两个真实任务与真实 producer 产物驱动：
 *   - 任务 B：中文路径检查（依赖来源）
 *   - 任务 A：主测试，显式 reportBindings 绑定 B
 *
 * 记录：host 日志、每次 HTTP 请求/响应、模型请求响应（PET_MODEL_RECORD_DIR）、
 * SQLite 导出、逐 run 结果与 cost ledger。模型未配置直接非零退出，不自动换 stub。
 *
 * 用法：
 *   node eval/condition-followup/live/run-live.mjs --arm V-C --scenario pilot-1 --out <新目录>
 *   node eval/condition-followup/live/run-live.mjs --matrix --out <新目录>      # 12×5
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { verifyCompletion } from '../../core-completion/verify.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXPERIMENT_ROOT = resolve(HERE, '..', '..', '..')
const RUN = join(EXPERIMENT_ROOT, 'run.mjs')

export const ARMS = {
  'V-R': { assessor: 'capability-need-rule', label: '版本记忆+强规则', memory: 'version' },
  'V-L': { assessor: 'capability', label: '版本记忆+逐事件模型', memory: 'version' },
  'V-C': { assessor: 'capability-conditions', label: '版本记忆+条件', memory: 'version' },
  'T-L': { assessor: 'capability', label: '强文本记忆+逐事件模型', memory: 'text' },
  'T-C': { assessor: 'capability-conditions', label: '强文本记忆+条件', memory: 'text' },
}

const nowIso = () => new Date().toISOString()
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function env() {
  const url = process.env.PET_MODEL_BASE_URL
  const name = process.env.PET_MODEL_NAME
  if (!url || !name) {
    console.error('model_not_configured: 需要 PET_MODEL_BASE_URL / PET_MODEL_NAME；不会自动换成 stub')
    process.exit(2)
  }
  return {
    url, name,
    disableThinking: process.env.PET_MODEL_DISABLE_THINKING ?? '1',
    temperature: process.env.PET_MODEL_TEMPERATURE ?? '0',
    timeoutMs: process.env.PET_MODEL_TIMEOUT_MS ?? '240000',
    maxTokens: process.env.PET_MODEL_MAX_TOKENS ?? '4096',
    recheckMs: process.env.PET_FOLLOWUP_RECHECK_MS ?? '20000',
  }
}

async function health(url) {
  try {
    const res = await fetch(`${url.replace(/\/v1$/, '')}/health`, { signal: AbortSignal.timeout(5000) })
    const body = await res.json()
    return { ok: res.ok && body.ready === true, body }
  } catch (error) {
    return { ok: false, body: { error: error instanceof Error ? error.message : String(error) } }
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

class HostClient {
  constructor(workspace, outDir) {
    this.workspace = workspace
    this.out = outDir
    this.calls = 0
  }
  async ready(timeoutMs = 60000) {
    const file = join(this.workspace, 'state', 'host.json')
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      if (existsSync(file)) {
        try {
          const info = JSON.parse(readFileSync(file, 'utf8'))
          if (info.state === 'ready' && info.port && info.token) {
            this.port = info.port
            this.token = info.token
            this.pid = info.pid
            return true
          }
        } catch { /* 写一半，重读 */ }
      }
      await sleep(250)
    }
    return false
  }
  async api(method, route, body) {
    const seq = String(++this.calls).padStart(4, '0')
    const startedAt = nowIso()
    const res = await fetch(`http://127.0.0.1:${this.port}${route}`, {
      method,
      headers: { 'x-followup-token': this.token, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON 保留原文 */ }
    writeJson(join(this.out, 'http', `${seq}-${method}-${route.replace(/[^a-z]/gi, '_')}.json`), {
      at: startedAt, method, route, request: body ?? null, status: res.status, response: json ?? text.slice(0, 4000),
    })
    return { status: res.status, json, text }
  }
}

function producer(experimentId, dir, rows, outDir) {
  const csv = join(outDir, `samples-${experimentId}.csv`)
  writeFileSync(csv, ['id,expression,expected', ...rows.map((r, i) => `${experimentId}-${i + 1},${r[0]},${r[1]}`)].join('\n') + '\n')
  const res = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', join(EXPERIMENT_ROOT, 'producer', 'run-tests.mjs'), '--input', csv, '--out', dir, '--experiment', experimentId], { encoding: 'utf8' })
  writeJson(join(outDir, 'producer', `${experimentId}.json`), { status: res.status, stdout: res.stdout?.slice(-2000), stderr: res.stderr?.slice(-2000) })
  return res.status === 0
}

async function waitFor(check, timeoutMs, intervalMs = 1000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const value = await check()
    if (value) return value
    await sleep(intervalMs)
  }
  return null
}

function exportDb(workspace, outDir) {
  const stateDir = join(workspace, 'state')
  if (!existsSync(stateDir)) return null
  const sqliteName = readdirSync(stateDir).find((name) => name.endsWith('.sqlite'))
  if (!sqliteName) return null
  const dbPath = join(stateDir, sqliteName)
  const target = join(outDir, 'db', 'copy.sqlite')
  mkdirSync(dirname(target), { recursive: true })
  cpSync(dbPath, target)
  const db = new DatabaseSync(target, { readOnly: true })
  const dump = (sql) => { try { return db.prepare(sql).all() } catch { return [] } }
  const data = {
    tasks: dump('SELECT * FROM tasks'),
    attentions: dump('SELECT * FROM attentions'),
    proposals: dump('SELECT * FROM proposals'),
    receipts: dump('SELECT * FROM receipts'),
    assessments: dump('SELECT request_id, ticket_id, task_revision, event_cursor, round, status, error_code, wait_until FROM assessments'),
    cond_plans: dump('SELECT compilation_key, task_id FROM cond_plans'),
    cond_evals: dump('SELECT task_id, json FROM cond_evals'),
    cond_failures: dump('SELECT task_id, status, detail FROM cond_failures'),
    driver_log: dump('SELECT id, at, ticket_id, phase, detail_json FROM driver_log ORDER BY id'),
    wake_jobs: dump('SELECT job_id, ticket_id, reason, status, due_at FROM wake_jobs ORDER BY created_at'),
  }
  db.close()
  writeJson(join(outDir, 'db', 'dump.json'), data)
  return data
}

function ledger(outDir) {
  const dir = join(outDir, 'model-io')
  const entries = []
  let promptTokens = 0
  let completionTokens = 0
  let unknownUsage = 0
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.response.json')).sort()) {
      const body = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      const usage = body?.body?.usage ?? null
      if (usage) {
        promptTokens += Number(usage.prompt_tokens ?? 0)
        completionTokens += Number(usage.completion_tokens ?? 0)
      } else unknownUsage += 1
      entries.push({ file: name, status: body.status ?? null, usage })
    }
  }
  return { posts: entries.length, promptTokens, completionTokens, unknownUsage, entries }
}

/** 一个真实 run：宿主 + 两个任务 + 真实 producer 事件。 */
export async function runOne(options) {
  const { armId, scenario, outDir, waitSeconds = 20, correction = null, order = 'B,A' } = options
  const arm = ARMS[armId]
  if (!arm) throw new Error(`unknown arm ${armId}`)
  const cfg = env()
  const h = await health(cfg.url)
  mkdirSync(outDir, { recursive: true })
  writeJson(join(outDir, 'environment.json'), { ...cfg, env: { PET_MODEL_BASE_URL: cfg.url, PET_MODEL_NAME: cfg.name }, health: h.body, at: nowIso() })
  if (!h.ok) {
    writeJson(join(outDir, 'END-STATE.json'), { ok: false, code: 'model_not_ready', health: h.body })
    return { ok: false, code: 'model_not_ready' }
  }

  const workspace = join(outDir, 'ws')
  mkdirSync(join(workspace, 'inbox', 'A'), { recursive: true })
  mkdirSync(join(workspace, 'inbox', 'B'), { recursive: true })
  const hostLog = join(outDir, 'host.log')
  writeFileSync(hostLog, '')
  const hostEnv = {
    ...process.env,
    PET_MODEL_BASE_URL: cfg.url,
    PET_MODEL_NAME: cfg.name,
    PET_MODEL_DISABLE_THINKING: cfg.disableThinking,
    PET_MODEL_TEMPERATURE: cfg.temperature,
    PET_MODEL_TIMEOUT_MS: cfg.timeoutMs,
    PET_MODEL_MAX_TOKENS: cfg.maxTokens,
    PET_FOLLOWUP_RECHECK_MS: cfg.recheckMs,
    PET_MODEL_RECORD_DIR: join(outDir, 'model-io'),
  }
  const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', RUN, 'host',
    '--workspace', workspace, '--timezone', 'Asia/Shanghai',
    '--assessor', arm.assessor, '--assessor-timeout-ms', '240000', '--demo-short-wait'], {
    cwd: EXPERIMENT_ROOT, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logFd = { out: [], err: [] }
  child.stdout.on('data', (b) => logFd.out.push(b))
  child.stderr.on('data', (b) => logFd.err.push(b))
  const api = new HostClient(workspace, outDir)
  const startedAt = nowIso()
  const timeline = []
  let earlyAttention = null
  let answeredOk = false
  const checkpoint = (extra = {}) => writeJson(join(outDir, 'END-STATE.json'), {
    schema: 'pet-r6-live-run/v1', arm: armId, armLabel: arm.label, memory: arm.memory, scenario,
    mode: 'live', model: { baseUrl: cfg.url, name: cfg.name }, startedAt, finishedAt: nowIso(),
    timeline, answeredOk, earlyAttention, partial: true, ...extra,
  })
  const mark = (kind, detail = {}) => { timeline.push({ at: nowIso(), kind, ...detail }); checkpoint() }

  try {
    if (!(await api.ready())) {
      writeJson(join(outDir, 'END-STATE.json'), { ok: false, code: 'host_not_ready', log: logFd.err.join('').slice(-4000) })
      return { ok: false, code: 'host_not_ready' }
    }
    mark('host.ready', { pid: api.pid, port: api.port })

    const bTask = await api.api('POST', '/api/tasks', { title: '中文路径检查', dir: 'inbox/B', goal: '跟进中文路径检查报告，结果写 result.json' })
    const bId = bTask.json?.task?.ticketId
    if (!bId) throw new Error(`create B failed: ${bTask.text.slice(0, 300)}`)
    mark('task.created.B', { ticketId: bId })

    const aTask = await api.api('POST', '/api/tasks', {
      title: '主测试', dir: 'inbox/A',
      goal: '跟进主测试报告；两份报告都回来以后问我是否继续',
      reportBindings: [{ alias: '中文路径报告', taskId: bId }],
    })
    const aId = aTask.json?.task?.ticketId
    if (!aId) throw new Error(`create A failed: ${aTask.text.slice(0, 300)}`)
    mark('task.created.A', { ticketId: aId, bindings: aTask.json?.task?.reportBindings ?? null })

    // 到达顺序可交换；矩阵里两种顺序都要跑。
    const firstIsA = order.trim().toUpperCase().startsWith('A')
    if (!firstIsA && !producer('cn-path-check', join(workspace, 'inbox', 'B'), [['1+1', 2]], outDir)) throw new Error('producer B failed')
    if (firstIsA && !producer('main-tests', join(workspace, 'inbox', 'A'), [['2*3', 6], ['3*4', 12]], outDir)) throw new Error('producer A failed')
    if (firstIsA) mark('producer.A.done')
    if (!firstIsA) mark('producer.B.done')
    if (!firstIsA) {
      const bSeen = await waitFor(async () => {
        const t = await api.api('GET', `/api/task?ticket=${bId}`)
        return t.json?.task?.result ? t : null
      }, 60000)
      mark('host.observed.B', { observed: Boolean(bSeen) })
    } else {
      const aSeen = await waitFor(async () => {
        const t = await api.api('GET', `/api/task?ticket=${aId}`)
        return t.json?.task?.result ? t : null
      }, 60000)
      mark('host.observed.A', { observed: Boolean(aSeen) })
    }

    // 只有一份来源时不应该提问（V-R/V-L 可能违反，如实记录）
    await sleep(waitSeconds * 1000)
    let viewA = await api.api('GET', `/api/task?ticket=${aId}`)
    earlyAttention = viewA.json?.task?.decision ?? null
    mark('window.one_source', { attention: earlyAttention?.attentionId ?? null })

    if (correction) {
      const said = await api.api('POST', '/api/say', { text: correction, ticketId: aId })
      mark('user.say', { status: said.status, text: correction })
      await sleep(Math.max(5, Math.round(waitSeconds / 2)) * 1000)
    }

    if (!firstIsA) {
      if (!producer('main-tests', join(workspace, 'inbox', 'A'), [['2*3', 6], ['3*4', 12]], outDir)) throw new Error('producer A failed')
      mark('producer.A.done')
      const aSeen = await waitFor(async () => {
        const t = await api.api('GET', `/api/task?ticket=${aId}`)
        return t.json?.task?.result ? t : null
      }, 60000)
      mark('host.observed.A', { observed: Boolean(aSeen) })
    } else {
      if (!producer('cn-path-check', join(workspace, 'inbox', 'B'), [['1+1', 2]], outDir)) throw new Error('producer B failed')
      mark('producer.B.done')
    }

    const asked = await waitFor(async () => {
      const t = await api.api('GET', `/api/task?ticket=${aId}`)
      const d = t.json?.task?.decision
      return d?.attentionId ? { view: t.json, decision: d } : null
    }, Math.max(30, waitSeconds * 3) * 1000, 2000)
    mark('window.two_sources', { asked: Boolean(asked), question: asked?.decision?.question ?? null })

    let answered = null
    if (asked) {
      const options = asked.decision.options ?? []
      const pick = options.find((o) => ['continue_now', 'analyze_failing', 'retry_analysis'].includes(o.id))
      if (pick) {
        await api.api('POST', '/api/present', { ticketId: aId, attentionId: asked.decision.attentionId })
        answered = await api.api('POST', '/api/answer', {
          ticketId: aId, attentionId: asked.decision.attentionId, decisionId: asked.decision.decisionId,
          taskRevision: asked.decision.taskRevision, optionId: pick.id,
        })
        answeredOk = answered.status === 200 && answered.json?.ok === true
        mark('user.answer', { optionId: pick.id, status: answered.status, ok: answered.json?.ok ?? null, code: answered.json?.code ?? null })
      }
    }
    const finished = await waitFor(async () => {
      const t = await api.api('GET', `/api/task?ticket=${aId}`)
      const st = t.json?.task?.status
      return st && st !== 'active' ? t.json : null
    }, 45000, 3000)
    const finalView = await api.api('GET', `/api/task?ticket=${aId}`)
    mark('task.terminal', { completed: Boolean(finished), status: finalView.json?.task?.status ?? null })
  } catch (error) {
    mark('run.error', { message: error instanceof Error ? error.message : String(error) })
  } finally {
    try { await api.api('POST', '/api/shutdown', {}) } catch { /* 已退出 */ }
    await sleep(1500)
    if (!child.killed) child.kill('SIGTERM')
    await sleep(800)
    try { writeFileSync(join(outDir, 'host.log'), `${logFd.out.join('')}\n--- stderr ---\n${logFd.err.join('')}`) } catch { /* 保留已有日志 */ }
    let db = null
    let cost = { posts: 0 }
    try { db = exportDb(workspace, outDir) } catch (error) { writeJson(join(outDir, 'db', 'export-error.json'), { message: String(error) }) }
    try { cost = ledger(outDir) } catch { /* 账本缺失就记 0 */ }
    const aId = timeline.find((t) => t.kind === 'task.created.A')?.ticketId ?? null
    const taskRow = aId ? db?.tasks?.find((t) => t.ticket_id === aId) ?? null : null
    const completion = aId ? verifyCompletion(workspace, aId) : { ok: false, failures: ['task_missing'] }
    writeJson(join(outDir, 'independent-completion.json'), completion)
    const end = {
      schema: 'pet-r6-live-run/v1',
      arm: armId, armLabel: arm.label, memory: arm.memory, scenario,
      mode: 'live', model: { baseUrl: cfg.url, name: cfg.name },
      startedAt, finishedAt: nowIso(),
      timeline,
      task: taskRow ? { ticketId: aId, status: taskRow.status, stage: taskRow.stage, result: taskRow.result_json ? JSON.parse(taskRow.result_json) : null } : null,
      bindings: taskRow?.bindings_json ? JSON.parse(taskRow.bindings_json) : null,
      attentions: db?.attentions?.length ?? 0,
      cost,
      completion,
      ok: completion.ok && Boolean(timeline.some((t) => t.kind === 'window.two_sources' && t.asked)) && answeredOk && !earlyAttention,
    }
    writeJson(join(outDir, 'END-STATE.json'), end)
  }
  return JSON.parse(readFileSync(join(outDir, 'END-STATE.json'), 'utf8'))
}

const args = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = arg('out')
  if (!out) {
    console.error('usage: --out <new dir> [--arm V-C] [--scenario pilot-1] [--wait-seconds 20] [--matrix]')
    process.exit(2)
  }
  if (existsSync(out) && readdirSync(out).length > 0) {
    console.error(`refusing existing non-empty output: ${out}`)
    process.exit(2)
  }
  const waitSeconds = Number(arg('wait-seconds', '20'))
  if (flag('matrix')) {
    const arms = (arg('arms', 'V-R,V-L,V-C,T-L,T-C') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const scenarios = (arg('scenarios', 'pilot-1,pilot-2') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const results = []
    for (const scenario of scenarios) {
      for (const armId of arms) {
        const dir = join(out, `${scenario}-${armId}-${Date.now()}`)
        console.error(`[r6-live] ${scenario} ${armId} -> ${dir}`)
        results.push(await runOne({ armId, scenario, outDir: dir, waitSeconds }))
      }
    }
    writeJson(join(out, 'matrix-summary.json'), { at: nowIso(), runs: results.map((r) => ({ arm: r.arm, scenario: r.scenario, ok: r.ok, cost: r.cost })) })
    console.log(JSON.stringify(results.map((r) => ({ arm: r.arm, scenario: r.scenario, ok: r.ok, posts: r.cost?.posts ?? 0 })), null, 2))
    process.exit(results.every((r) => r.ok) ? 0 : 1)
  }
  const armId = arg('arm', 'V-C')
  const scenario = arg('scenario', 'pilot-1')
  const correction = arg('correction')
  const order = arg('order', 'B,A')
  const result = await runOne({ armId, scenario, outDir: out, waitSeconds, correction, order })
  console.log(JSON.stringify({ arm: result.arm, scenario: result.scenario, ok: result.ok, cost: result.cost }, null, 2))
  process.exit(result.ok ? 0 : 1)
}
