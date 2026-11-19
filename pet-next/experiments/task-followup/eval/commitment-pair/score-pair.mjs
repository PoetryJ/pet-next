#!/usr/bin/env node
/**
 * R7 独立评分：不读运行器 ok，不读运行器 checks 作结论。
 *
 * 输入：每次 run 的真实工作区（SQLite）、attentions/notifications 表、verifyCompletion、
 *       以及冻结在 stories.mjs 里的 evaluator-only 期望。
 * 输出：per-run.csv、score.json、by-arm.json、paths.json。
 *
 * 指标（每项都带分母）：
 * - correct: 主任务在正确时刻做了正确动作（问/归档/取消后静默）
 * - missed: 应该介入却没有；应该归档却还在等
 * - unnecessary: 不该问却问了（含过早问）——主任务分母；旁支另列
 * - validAnalysis: 询问后真正产生并核验通过的分析产物
 * - sideDelivered: 旁支任务送达的提醒（主任务分母之外单列）
 * - 条件原生 / 模型兜底 / 强规则：按 cond_evals 与 assessor 身份分项
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyCompletion } from '../core-completion/verify.mjs'
import { ARMS, EXPECTATIONS } from './stories.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] }
const roots = (arg('runs', '') ?? '').split(',').map((s) => resolve(s.trim())).filter(Boolean)
if (!roots.length) throw Error('usage: --runs <dir1,dir2> [--out <dir>]')
const outDir = resolve(arg('out', join(roots[0], 'score')))
mkdirSync(outDir, { recursive: true })
const readJson = (path, fallback = null) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback)
const readJsonl = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const sum = (rows, pick) => rows.reduce((n, r) => n + (Number.isFinite(pick(r)) ? pick(r) : 0), 0)
const pct = (a, b) => b ? Number((a / b).toFixed(4)) : null

function db(path) {
  if (!existsSync(path)) return null
  return new DatabaseSync(path, { readOnly: true })
}
function rows(handle, sql, params = []) {
  try { return handle.prepare(sql).all(...params) } catch { return [] }
}

function scoreOne(dir) {
  const raw = readJson(join(dir, 'raw.json'))
  if (!raw) return { id: dir.split('/').pop(), error: 'raw_missing' }
  const trajectory = raw.trajectory
  const promise = raw.promise
  const arm = raw.arm
  const expected = EXPECTATIONS[`${trajectory}-${promise}`]
  if (!expected) return { id: `${trajectory}-${promise}-${arm}`, error: 'expectation_missing' }
  const workspace = join(dir, 'ws')
  const handle = db(join(dir, 'db', 'copy.sqlite'))
  const tasks = handle ? rows(handle, 'SELECT * FROM tasks') : []
  const primary = tasks.find((t) => t.title === '主测试') ?? null
  const ticket = primary?.ticket_id ?? raw.tasks?.A ?? null
  const attentions = handle ? rows(handle, 'SELECT * FROM attentions') : []
  const notifications = handle ? rows(handle, 'SELECT * FROM notifications') : []
  const mainAtt = attentions.filter((a) => a.ticket_id === ticket).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  // “送达的提醒”才是用户实际可能看到的打扰；未送达就被替换的 attention 只留在审计里。
  const mainVisible = mainAtt.filter((a) => a.delivered_at || a.presented_at)
  const sideAtt = attentions.filter((a) => a.ticket_id !== ticket)
  const mainNotif = notifications.filter((n) => n.ticket_id === ticket)
  const sideNotif = notifications.filter((n) => n.ticket_id !== ticket)
  const completion = primary?.completion_json ? JSON.parse(primary.completion_json) : null
  const status = primary?.status ?? raw.checks?.finalStatus ?? null
  const produced = (raw.timeline ?? []).filter((t) => t.kind === 'produce')
  const lastReport = produced.map((p) => p.at).sort().at(-1) ?? null
  const firstAsk = mainVisible[0] ?? null
  const askedAfterReport = Boolean(firstAsk && lastReport && Date.parse(firstAsk.created_at) >= Date.parse(lastReport) - 2000)
  const earlyAsk = Boolean(firstAsk && lastReport && !askedAfterReport)
  const answered = mainVisible.some((a) => a.state === 'answered')
  let verification = null
  try { verification = ticket ? verifyCompletion(workspace, ticket) : null } catch (error) { verification = { ok: false, failures: [{ name: 'verifier.error', detail: String(error) }] } }
  const analysisValid = Boolean(verification?.ok)

  const planRows = handle ? rows(handle, 'SELECT * FROM cond_plans WHERE task_id = ?', [ticket]) : []
  const current = handle ? rows(handle, 'SELECT * FROM cond_current WHERE task_id = ?', [ticket]) : []
  const evals = handle ? rows(handle, 'SELECT * FROM cond_evals WHERE task_id = ? ORDER BY at, rowid', [ticket]) : []
  const failures = handle ? rows(handle, 'SELECT * FROM cond_failures WHERE task_id = ?', [ticket]) : []
  const assessments = handle ? rows(handle, "SELECT status, assessor, raw_json, error_code, error_detail FROM assessments WHERE ticket_id = ?", [ticket]) : []
  let nativeAction = null
  for (const ev of evals) {
    try { const meta = JSON.parse(ev.json ?? '{}'); if (['ask', 'archive', 'wait', 'fallback'].includes(meta.action)) nativeAction = meta.action } catch { /* 旧行 */ }
  }
  // 旧 schema 没有 json：从列里读 action。
  if (!nativeAction && evals.length) nativeAction = evals.at(-1).action ?? null
  const decisive = mainAtt.length ? (status === 'archived' ? 'archive' : 'ask') : (status === 'archived' ? 'archive' : status === 'cancelled' ? 'cancelled' : 'none')
  const native = Boolean(nativeAction && nativeAction === decisive)
  const fallback = !native && (nativeAction === 'fallback' || failures.length > 0 || assessments.some((a) => a.error_code))
  const path = raw.path === 'rule' ? 'rule' : native ? 'native' : decisive === 'cancelled' ? 'native-cancel' : fallback ? 'fallback' : 'none'

  let correct = false
  let missed = false
  let unnecessary = false
  if (expected.action === 'ask') {
    correct = Boolean(firstAsk && askedAfterReport && answered && analysisValid)
    missed = !firstAsk || !answered
    unnecessary = Boolean(earlyAsk)
  } else if (expected.action === 'archive') {
    correct = status === 'archived' && completion?.mode === 'quiet_archive' && mainVisible.length === 0
    missed = status !== 'archived'
    unnecessary = mainVisible.length > 0
  } else if (expected.action === 'cancelled') {
    const cancelledAt = raw.checks?.cancelledAt ?? null
    const after = mainVisible.filter((a) => !cancelledAt || String(a.created_at) >= cancelledAt)
    correct = status === 'cancelled' && after.length === 0
    missed = status !== 'cancelled'
    unnecessary = after.length > 0
  }

  const producedAt = (key) => produced.find((p) => p.key === key)?.at ?? null
  const windowStart = expected.askedAfter === 'B' ? producedAt('B') : lastReport
  const visibleAt = mainAtt.map((a) => a.delivered_at ?? a.presented_at).filter(Boolean).sort()[0] ?? null
  const answeredAt = mainAtt.find((a) => a.answered_at)?.answered_at ?? null
  const completedAt = completion?.at ?? primary?.updated_at ?? null
  const reportToVisibleMs = visibleAt && windowStart ? Date.parse(visibleAt) - Date.parse(windowStart) : null
  const reportToTerminalMs = lastReport && completedAt && !analysisValid ? Date.parse(completedAt) - Date.parse(lastReport) : null
  const answerToArtifactMs = answeredAt && completedAt && analysisValid ? Date.parse(completedAt) - Date.parse(answeredAt) : null
  const gaps = []
  const tl = raw.timeline ?? []
  for (let i = 1; i < tl.length; i += 1) gaps.push({ from: tl[i - 1].kind, to: tl[i].kind, ms: Date.parse(tl[i].at) - Date.parse(tl[i - 1].at) })
  const longest = gaps.sort((a, b) => b.ms - a.ms)[0] ?? null

  return {
    id: `${trajectory}-${promise}-${arm}`,
    trajectory, promise, arm, expected: expected.action,
    correct, missed, unnecessary,
    asked: mainVisible.length > 0,
    earlyAsk,
    askedAfterReport,
    answered,
    validAnalysis: analysisValid,
    status,
    archive: completion?.mode === 'quiet_archive',
    mainAttentions: mainAtt.length,
    mainVisibleAttentions: mainVisible.length,
    mainDelivered: mainVisible.length,
    mainPresented: mainVisible.filter((a) => a.presented_at).length,
    mainNotifications: mainNotif.length,
    mainNotificationsDelivered: mainNotif.filter((n) => n.state === 'delivered' || n.state === 'presented').length,
    sideAttentions: sideAtt.length,
    sideNotifications: sideNotif.length,
    sideDelivered: sideNotif.filter((n) => n.state === 'delivered' || n.state === 'presented').length,
    sidePresented: sideNotif.filter((n) => n.state === 'presented').length,
    sideAnswered: sideAtt.filter((a) => a.state === 'answered').length,
    path,
    nativeAction,
    compile: current.length ? 'compiled' : failures.length ? 'failed' : planRows.length ? 'stored' : 'none',
    planQuotes: planRows.at(-1)?.json ? (JSON.parse(planRows.at(-1).json).sourceQuotes ?? []).map((q) => q.text) : [],
    planWhen: planRows.at(-1)?.json ? JSON.parse(planRows.at(-1).json).when : null,
    reportToVisibleMs,
    reportToTerminalMs,
    answerToArtifactMs,
    longest,
    posts: readJsonl(join(dir, 'proxy-ledger.jsonl')).filter((r) => r.phase === 'end').length,
    tokens: sum(readJsonl(join(dir, 'proxy-ledger.jsonl')).filter((r) => r.phase === 'end'), (r) => Number(r.inputTokens ?? r.usage?.prompt_tokens ?? 0) + Number(r.outputTokens ?? r.usage?.completion_tokens ?? 0)),
    failures: verification?.failures ?? [],
    error: raw.checks?.error ?? null,
  }
}

const runs = []
for (const root of roots) {
  if (!existsSync(root)) continue
  const entries = readFileSync(join(root, 'runs.json'), 'utf8')
  const listed = JSON.parse(entries).rows ?? []
  for (const row of listed) {
    const dir = join(root, `${row.trajectory}-${row.promise}-${row.arm}`)
    runs.push(scoreOne(dir))
  }
}

const group = (list, key) => {
  const map = new Map()
  for (const run of list) {
    if (run.error) continue
    const k = key(run)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(run)
  }
  return [...map.entries()].map(([k, list]) => ({
    key: k,
    n: list.length,
    correct: list.filter((r) => r.correct).length,
    missed: list.filter((r) => r.missed).length,
    unnecessary: list.filter((r) => r.unnecessary).length,
    validAnalysis: list.filter((r) => r.validAnalysis).length,
    asked: list.filter((r) => r.asked).length,
    archived: list.filter((r) => r.archive).length,
    sideDelivered: sum(list, (r) => r.sideDelivered),
    mainDelivered: sum(list, (r) => r.mainDelivered),
    posts: sum(list, (r) => r.posts),
    tokens: sum(list, (r) => r.tokens),
    correctRate: pct(list.filter((r) => r.correct).length, list.length),
    validAnalysisRate: pct(list.filter((r) => r.validAnalysis).length, list.length),
  }))
}

const report = {
  schema: 'pet-r7-commitment-score/v1',
  at: new Date().toISOString(),
  roots,
  runs: runs.length,
  measured: runs.filter((r) => !r.error).length,
  primaryMetrics: {
    askExpected: runs.filter((r) => r.expected === 'ask').length,
    correctInterventions: runs.filter((r) => r.expected === 'ask' && r.correct).length,
    quietExpected: runs.filter((r) => r.expected !== 'ask').length,
    correctQuiet: runs.filter((r) => r.expected !== 'ask' && r.correct).length,
    missed: runs.filter((r) => r.missed).length,
    unnecessary: runs.filter((r) => r.unnecessary).length,
    validAnalysis: runs.filter((r) => r.validAnalysis).length,
    validAnalysisAskedDenominator: runs.filter((r) => r.asked).length,
    answeredAsks: runs.filter((r) => r.asked && r.answered).length,
    validAnalysisAmongAsked: runs.filter((r) => r.asked && r.validAnalysis).length,
    validAnalysisAmongAnswered: runs.filter((r) => r.asked && r.answered && r.validAnalysis).length,
    validAnalysisDenominator: runs.filter((r) => r.expected === 'ask').length,
    sideDelivered: sum(runs, (r) => r.sideDelivered ?? 0),
  },
  byArm: group(runs, (r) => r.arm),
  byTrajectory: group(runs, (r) => r.trajectory),
  byPromise: group(runs, (r) => r.promise),
  byPath: group(runs, (r) => r.path),
  byCell: group(runs, (r) => r.id),
  perRun: runs,
  notes: [
    '主任务正确性只看真实 SQLite/工作区：问 = attention 在最后一份报告后创建且已送达/呈现/回答，且 verifyCompletion 通过；归档 = status=archived 且 completion.mode=quiet_archive 且零 attention；取消 = status=cancelled 且取消后零 attention。',
    '旁支提醒单独计入 sideDelivered，不与主任务分母混算；它们仍是用户实际收到的提醒。',
    '条件原生/兜底/规则按主任务 cond_evals 的最终动作与 assessor 身份分项；缺失计划不计原生。',
  ],
}
writeFileSync(join(outDir, 'score.json'), `${JSON.stringify(report, null, 2)}\n`)
const header = ['run', 'expected', 'correct', 'missed', 'unnecessary', 'asked', 'early', 'answered', 'analysis', 'status', 'archive', 'mainAtt', 'mainDelivered', 'sideDelivered', 'path', 'reportToVisibleMs', 'answerToArtifactMs', 'posts', 'tokens']
const csv = [header.join(','), ...runs.map((r) => [r.id, r.expected, r.correct, r.missed, r.unnecessary, r.asked, r.earlyAsk, r.answered, r.validAnalysis, r.status, r.archive, r.mainAttentions, r.mainDelivered, r.sideDelivered, r.path, r.reportToVisibleMs, r.answerToArtifactMs, r.posts, r.tokens].join(','))]
writeFileSync(join(outDir, 'per-run.csv'), `${csv.join('\n')}\n`)
writeFileSync(join(outDir, 'by-arm.json'), `${JSON.stringify({ byArm: report.byArm, byTrajectory: report.byTrajectory, byPromise: report.byPromise, byPath: report.byPath, byCell: report.byCell }, null, 2)}\n`)
writeFileSync(join(outDir, 'paths.json'), `${JSON.stringify({ byPath: report.byPath, perRun: runs.map((r) => ({ id: r.id, path: r.path, nativeAction: r.nativeAction, compile: r.compile, planWhen: r.planWhen })) }, null, 2)}\n`)
console.log(JSON.stringify({ measured: report.measured, byArm: report.byArm, byPath: report.byPath }, null, 2))
