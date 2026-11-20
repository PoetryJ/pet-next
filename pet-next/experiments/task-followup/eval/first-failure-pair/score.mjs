#!/usr/bin/env node
/** R8 独立评分：只读 SQLite/工作区/时间线/账本；不参与运行，不看运行器 checks 的结论。 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EXPECTATIONS } from './stories.mjs'

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : process.argv[i + 1]
}
const runsRoots = (arg('runs', '') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const outDir = resolve(arg('out', 'score'))
mkdirSync(outDir, { recursive: true })

const readJson = (path, fallback = null) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback } }
const q = (db, sql, params = []) => { try { return db.prepare(sql).all(...params) } catch { return [] } }

function usageOf(path) {
  const rows = existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
    : []
  const ends = rows.filter((r) => r.phase === 'end')
  const total = ends.reduce((n, r) => n + Number(r.usage?.prompt_tokens ?? r.inputTokens ?? 0) + Number(r.usage?.completion_tokens ?? r.outputTokens ?? 0), 0)
  return { requests: rows.filter((r) => r.phase === 'start').length, ends: ends.length, tokens: total, unknown: ends.filter((r) => !r.usageKnown).length }
}

function scoreRun(row) {
  const dir = row.dir
  const dbPath = join(dir, 'ws', 'state', 'followup.sqlite')
  const timeline = readJson(join(dir, 'timeline.json'), [])
  const expectation = EXPECTATIONS[`${row.group}-${row.promise}`]
  if (!existsSync(dbPath)) return { ...row, ok: false, error: 'db_missing', expectation }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const tasks = q(db, 'SELECT * FROM tasks')
  const main = tasks.find((t) => t.title === '主流程') ?? tasks[0]
  const dep = tasks.find((t) => t.title === '附录检查') ?? tasks.find((t) => t.ticket_id !== main?.ticket_id)
  const attention = q(db, 'SELECT * FROM attentions WHERE ticket_id = ? ORDER BY created_at', [main?.ticket_id])
  const notifications = q(db, 'SELECT * FROM notifications')
  const receipts = q(db, 'SELECT * FROM receipts WHERE ticket_id = ?', [main?.ticket_id])
  const proposals = q(db, 'SELECT decision_id, kind, reason_code, outcome, created_at FROM proposals WHERE ticket_id = ? ORDER BY created_at', [main?.ticket_id])
  const evals = q(db, 'SELECT json FROM cond_evals WHERE task_id = ? ORDER BY id', [main?.ticket_id]).map((r) => JSON.parse(r.json))
  const plans = q(db, 'SELECT json FROM cond_plans WHERE task_id = ? ORDER BY rowid', [main?.ticket_id]).map((r) => JSON.parse(r.json))
  const completed = main?.completion_json ? JSON.parse(main.completion_json) : null
  const analysis = main?.analysis_json ? JSON.parse(main.analysis_json) : null
  const visible = attention.filter((a) => a.delivered_at || a.presented_at)
  const asked = visible.length > 0
  const answeredAll = visible.filter((a) => a.state === 'answered')
  const answered = answeredAll[0] ?? null
  const lastAnswered = answeredAll.at(-1) ?? null
  const archive = completed?.mode === 'quiet_archive'
  const cancelled = main?.status === 'cancelled'
  const active = main?.status === 'active'
  const mainNotifs = notifications.filter((n) => n.ticket_id === main?.ticket_id)
  const sideNotifs = notifications.filter((n) => n.ticket_id !== main?.ticket_id)
  const sideAtt = q(db, 'SELECT * FROM attentions WHERE ticket_id <> ?', [main?.ticket_id])
  const receipt = receipts.filter((r) => r.tool === 'write_analysis').at(-1) ?? null
  let receiptEvidence = null
  if (receipt?.analysis_evidence_json) receiptEvidence = JSON.parse(receipt.analysis_evidence_json)

  const produces = timeline.filter((t) => t.kind === 'produce')
  const lastProduce = produces.at(-1)?.at ?? null
  const firstVisibleAt = visible.map((a) => a.delivered_at ?? a.presented_at).filter(Boolean).sort()[0] ?? null
  const reportToVisibleMs = lastProduce && firstVisibleAt ? Date.parse(firstVisibleAt) - Date.parse(lastProduce) : null

  const round1 = produces.find((p) => p.tag === 'r1' && p.key === 'A')?.at ?? produces.find((p) => p.tag === 'r1')?.at ?? null
  const round2 = produces.filter((p) => p.tag === 'r2').at(-1)?.at ?? null
  const lateProduce = produces.filter((p) => p.tag === 'late').at(-1)?.at ?? null
  const attentionAfter = (iso) => iso ? attention.filter((a) => String(a.created_at) >= iso).length : 0

  const partial = analysis?.scope === 'partial'
  const partialEvidenceOk = Boolean(partial && receiptEvidence?.scope === 'partial'
    && receiptEvidence.inputSet?.mode === 'partial'
    && receiptEvidence.inputSet.authorizedTaskIds?.length
    && receiptEvidence.inputSet.authorizedTaskIds.every((id) => id === analysis.sourceTaskId)
    && receipt?.inputs_verified === 1 && receipt.input_ref_json
    && JSON.parse(receipt.input_ref_json).resultFileSha === JSON.parse(receipt.input_ref_json).resultFileSha)
  const fullEvidenceOk = Boolean(!partial && analysis && receipt
    && receiptEvidence && (receiptEvidence.scope ?? 'full') === 'full'
    && receipt.inputs_verified === 1)
  const analysisFile = analysis?.artifactPath ? join(dir, 'ws', analysis.artifactPath) : null
  const analysisFileOk = Boolean(analysisFile && existsSync(analysisFile))

  const action = archive ? 'archive' : cancelled ? 'cancelled' : asked ? 'ask' : active ? 'active' : (main?.status ?? 'unknown')
  const finalOption = lastAnswered?.answer_option_id ?? null
  const firstOption = answered?.answer_option_id ?? null
  const lateAsk = expectation?.lateNoAsk ? attentionAfter(lateProduce) > 0 : null
  const round2Ask = expectation?.round2NoAsk ? attentionAfter(round2) > 0 : null
  const restartNoAsk = expectation?.restartNoAsk ? (timeline.find((t) => t.kind === 'check.quiet')?.early === false) : null
  const followContinued = expectation?.round1Quiet ? (active || asked) && !archive : null
  const shouldContinueButTerminated = expectation?.round1Quiet ? (archive || cancelled) : false
  const correct = (() => {
    if (!expectation) return false
    if (expectation.action === 'archive') return archive && !asked && !analysis
    if (expectation.action === 'cancelled') return cancelled && attention.length === 0
    if (expectation.action === 'ask') {
      if (!asked || !answered) return false
      if (expectation.option && finalOption !== expectation.option) return false
      if (expectation.waitOption && firstOption !== expectation.waitOption) return false
      if (expectation.analysis === 'partial') return partialEvidenceOk && analysisFileOk
      if (expectation.analysis === 'full') return fullEvidenceOk && analysisFileOk
      return true
    }
    return false
  })()
  const path = planPath(evals, proposals, row.arm, asked)
  const run = {
    ...row,
    id: `${row.group}-${row.promise}-${row.arm}`,
    ok: true,
    expectation,
    action,
    finalOption,
    firstOption,
    asked,
    delivered: visible.length,
    presented: visible.filter((a) => a.presented_at).length,
    answered: Boolean(answered),
    mainNotifications: mainNotifs.length,
    sideDelivered: sideNotifs.length,
    sideAsked: sideAtt.length,
    archive,
    cancelled,
    active,
    correct,
    partial,
    partialEvidenceOk,
    fullEvidenceOk,
    analysisFileOk,
    analysisSha: analysis?.artifactSha ?? null,
    analysisSource: analysis?.sourceTaskId ?? null,
    reportToVisibleMs,
    lateAsk,
    round2Ask,
    restartNoAsk,
    followContinued,
    shouldContinueButTerminated,
    path,
    duplicateMain: Math.max(0, visible.length - (asked ? 1 : 0)),
    options: visible.flatMap((a) => { try { return JSON.parse(a.options_json ?? '[]') } catch { return [] } }),
    usage: { ...usageOf(join(dir, 'client-ledger.jsonl')), proxy: usageOf(join(dir, 'proxy-ledger.jsonl')) },
  }
  db.close()
  return run
}

function planPath(evals, proposals, arm, asked) {
  if (arm === 'V-R') return 'rule'
  const last = evals.at(-1)
  if (last?.action === 'ask' && evals.some((e) => e.action === 'ask')) return 'native'
  if (proposals.some((p) => p.kind === 'ask_user' && p.reason_code === 'analysis_requested')) return 'native'
  if (asked) return 'fallback-or-native'
  return last ? `native:${last.action}` : 'none'
}

const rows = []
for (const root of runsRoots) {
  const index = readJson(join(root, 'runs.json')) ?? { rows: [] }
  for (const item of index.rows ?? []) {
    const dir = join(root, `${item.group}-${item.promise}-${item.arm}`)
    rows.push(scoreRun({ ...item, dir }))
  }
}
const by = (key) => {
  const map = new Map()
  for (const r of rows) {
    const k = r[key] ?? 'unknown'
    const cur = map.get(k) ?? { key: k, n: 0, correct: 0, asked: 0, archive: 0, partial: 0, full: 0, side: 0, missedAsk: 0, missedArchive: 0, spurious: 0, followTerminated: 0, tokens: 0 }
    cur.n += 1
    cur.correct += r.correct ? 1 : 0
    cur.asked += r.asked ? 1 : 0
    cur.archive += r.archive ? 1 : 0
    cur.partial += r.partialEvidenceOk ? 1 : 0
    cur.full += r.fullEvidenceOk ? 1 : 0
    cur.side += r.sideDelivered ?? 0
    cur.missedAsk += r.expectation?.action === 'ask' && !r.correct ? 1 : 0
    cur.missedArchive += r.expectation?.action === 'archive' && !r.archive ? 1 : 0
    cur.spurious += r.expectation?.action !== 'ask' && r.asked ? 1 : 0
    cur.followTerminated += r.shouldContinueButTerminated ? 1 : 0
    cur.tokens += r.usage?.client?.tokens ?? 0
    map.set(k, cur)
  }
  return [...map.values()]
}
const summary = {
  at: new Date().toISOString(),
  runs: rows.length,
  correct: rows.filter((r) => r.correct).length,
  expectedAsk: rows.filter((r) => r.expectation?.action === 'ask').length,
  asked: rows.filter((r) => r.asked).length,
  missedAsk: rows.filter((r) => r.expectation?.action === 'ask' && !r.asked).length,
  missedArchive: rows.filter((r) => r.expectation?.action === 'archive' && !r.archive).length,
  spurious: rows.filter((r) => r.expectation?.action !== 'ask' && r.asked).length,
  partialArtifacts: rows.filter((r) => r.partialEvidenceOk).length,
  fullArtifacts: rows.filter((r) => r.fullEvidenceOk).length,
  sideDelivered: rows.reduce((n, r) => n + (r.sideDelivered ?? 0), 0),
  followTerminated: rows.filter((r) => r.shouldContinueButTerminated).length,
  tokens: rows.reduce((n, r) => n + (r.usage?.client?.tokens ?? 0), 0),
  byArm: by('arm'),
  byGroup: by('group'),
  byPromise: by('promise'),
  rows,
}
writeFileSync(join(outDir, 'score.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify({ runs: summary.runs, correct: summary.correct, missedAsk: summary.missedAsk, missedArchive: summary.missedArchive, spurious: summary.spurious, partial: summary.partialArtifacts, full: summary.fullArtifacts, side: summary.sideDelivered, followTerminated: summary.followTerminated, tokens: summary.tokens }, null, 2))
