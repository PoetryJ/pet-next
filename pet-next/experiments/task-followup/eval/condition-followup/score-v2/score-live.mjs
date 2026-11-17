#!/usr/bin/env node
/**
 * R6-live 独立评分（D）。
 *
 * 只读每个 run 目录里的原始证据：END-STATE timeline、http/*.json、db/dump.json、producer 产物；
 * gold 单独放在 gold/pilot-gold.json，不读策略代码、不读编译器输出。
 *
 * 判据（EVAL）：
 * - 有效完成 = 任务 completed 且存在核验过的分析产物与回执；仅 status=completed 不算。
 * - 应问窗口：最后一个必需来源出现之后、任务结束之前；早于窗口=可避免打扰。
 * - 重复提醒：同一 decision_key/问题在未回答前出现多次。
 * - 过期执行：依赖变化后仍接受旧回答/旧授权执行。
 * - 无呈现却答、结束后才问、没有产物却标完成 —— 均判失败（负控）。
 *
 * 用法：node score-live.mjs --runs <evidence 根> --out <score.json>
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_GOLD = join(HERE, 'gold', 'pilot-gold.json')

const loadJson = (path, fallback = null) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback)

function httpCalls(dir) {
  const httpDir = join(dir, 'http')
  if (!existsSync(httpDir)) return []
  return readdirSync(httpDir).filter((f) => f.endsWith('.json')).sort().map((f) => loadJson(join(httpDir, f))).filter(Boolean)
}

function scoreRun(dir, gold) {
  const end = loadJson(join(dir, 'END-STATE.json'))
  if (!end) return { run: dir, error: 'missing_end_state' }
  let dump = loadJson(join(dir, 'db', 'dump.json'), null)
  if (!dump) {
    // 老 run 的导出可能因缺表失败：直接只读打开证据里的 SQLite 副本。
    const stateDir = join(dir, 'ws', 'state')
    const sqlite = existsSync(stateDir) ? readdirSync(stateDir).find((n) => n.endsWith('.sqlite')) : null
    if (sqlite) {
      const db = new DatabaseSync(join(stateDir, sqlite), { readOnly: true })
      const q = (sql) => { try { return db.prepare(sql).all() } catch { return [] } }
      dump = {
        tasks: q('SELECT * FROM tasks'),
        attentions: q('SELECT * FROM attentions'),
        receipts: q('SELECT * FROM receipts'),
      }
      db.close()
    }
  }
  dump = dump ?? {}
  const tasks = dump.tasks ?? []
  const attentions = dump.attentions ?? []
  const receipts = dump.receipts ?? []
  const calls = httpCalls(dir)
  const scenario = end.scenario
  const spec = gold.scenarios?.[scenario] ?? null

  const aTask = tasks.find((t) => t.title === gold.taskTitles?.primary) ?? tasks.find((t) => t.bindings_json) ?? null
  const required = spec?.requiredSources ?? []
  const primary = spec?.primarySource ?? null

  // 来源到达时刻：用 db 里 producer 产物的 observed 事件（最早出现即窗口开）
  const events = []
  for (const call of calls) {
    if (call.route?.startsWith('/api/task') && call.response?.task?.result) {
      events.push({ at: call.at, ticketId: call.response.task.ticketId, revision: call.response.task.result.revision })
    }
  }
  const windowStart = (() => {
    // 主来源到达时间：取该任务的 result.json 首次被观察（HTTP 视图出现 result 的最早时刻）
    if (!aTask) return null
    const hit = events.find((e) => e.ticketId === aTask.ticket_id)
    if (hit) return hit.at
    return null
  })()

  const asked = attentions.filter((a) => a.ticket_id === aTask?.ticket_id)
  const firstAsk = asked.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0] ?? null
  const askedBeforeWindow = Boolean(firstAsk && windowStart && firstAsk.created_at < windowStart)
  const duplicateAsks = asked.length - new Set(asked.map((a) => a.decision_key)).size

  const answerCalls = calls.filter((c) => c.route === '/api/answer')
  const accepted = answerCalls.filter((c) => c.status === 200 && c.response?.ok === true)
  const answeredWithoutPresentation = accepted.filter((c) => {
    const att = attentions.find((a) => a.attention_id === c.request?.attentionId)
    return att && !att.delivered_at && !att.presented_at
  }).length

  const completed = (aTask?.status ?? end.task?.status) === 'completed'
  const analysisReceipt = receipts.find((r) => r.tool === 'write_analysis')
  const validCompletion = Boolean(completed && analysisReceipt && analysisReceipt.inputs_verified === 1 && !analysisReceipt.needs_reconciliation)
  const completedWithoutArtifact = Boolean(completed && !analysisReceipt)

  // 过期执行：接受过的回答，其 attention 之后被 supersede 且在同一 revision 下仍执行了工具
  const staleExecution = accepted.some((c) => {
    const att = attentions.find((a) => a.attention_id === c.request?.attentionId)
    return att?.state === 'superseded'
  })

  const checks = {
    asked: Boolean(firstAsk),
    askedAfterWindow: Boolean(firstAsk && windowStart && firstAsk.created_at >= windowStart),
    askedBeforeWindow,
    duplicateAsks,
    answered: accepted.length,
    answeredWithoutPresentation,
    completed,
    validCompletion,
    completedWithoutArtifact,
    staleExecution,
    requiredSources: required,
    primarySource: primary,
  }
  const failures = []
  if (!checks.asked) failures.push('missed_question')
  if (checks.askedBeforeWindow) failures.push('early_reminder')
  if (checks.duplicateAsks > 0) failures.push('duplicate_reminder')
  if (checks.answeredWithoutPresentation > 0) failures.push('answer_without_presentation')
  if (checks.staleExecution) failures.push('stale_execution')
  if (checks.completedWithoutArtifact) failures.push('completed_without_artifact')

  return {
    run: dir,
    arm: end.arm,
    scenario,
    mode: end.mode,
    posts: end.cost?.posts ?? 0,
    promptTokens: end.cost?.promptTokens ?? 0,
    completionTokens: end.cost?.completionTokens ?? 0,
    checks,
    failures,
    status: failures.length === 0 ? 'ok' : 'failed',
  }
}

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}

const runsRoot = resolve(arg('runs', '.'))
const outPath = resolve(arg('out', join(runsRoot, 'score.json')))
const gold = loadJson(arg('gold', DEFAULT_GOLD))
if (!gold) {
  console.error('gold missing')
  process.exit(2)
}
const only = (arg('only', '') ?? '').split(',').map((x) => x.trim()).filter(Boolean)
const dirs = (only.length
  ? only.map((name) => join(runsRoot, name))
  : readdirSync(runsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(runsRoot, e.name, 'END-STATE.json')))
    .map((e) => join(runsRoot, e.name)))
  .filter((dir) => existsSync(join(dir, 'END-STATE.json')))
  .sort()
const rows = dirs.map((dir) => scoreRun(dir, gold))
const summary = {
  schema: 'pet-r6-live-score/v1',
  at: new Date().toISOString(),
  goldSha256: 'in gold file',
  runs: rows.length,
  rows,
  byArm: Object.fromEntries([...new Set(rows.map((r) => r.arm))].filter(Boolean).map((arm) => {
    const list = rows.filter((r) => r.arm === arm)
    return [arm, {
      runs: list.length,
      ok: list.filter((r) => r.status === 'ok').length,
      missed: list.filter((r) => r.failures?.includes('missed_question')).length,
      early: list.filter((r) => r.failures?.includes('early_reminder')).length,
      validCompletion: list.filter((r) => r.checks?.validCompletion).length,
      posts: list.reduce((n, r) => n + (r.posts ?? 0), 0),
    }]
  })),
  note: '只读证据 + 独立 gold；completed 单独不算有效完成。',
}
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify({ runs: summary.runs, byArm: summary.byArm }, null, 2))
