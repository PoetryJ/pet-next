#!/usr/bin/env node
/**
 * R6-usable 独立评分（不改 gold，不读运行器的 ok 字段）。
 *
 * 判据全部从原始产物重算：
 * - 问题：attentions 表里主任务的行（状态 open/answered/superseded 都算“问过”）
 * - 窗口：stories.frozen 的 requiredKeys 全部产出后的第一个时间点（produce 时间戳）
 * - 早提醒：首个问题早于窗口；重复：同一 run 多于 1 个问题
 * - 有效完成：core-completion/verify.mjs（核验分析产物与输入一致性）
 * - 成本：以代理账本为准（客户端账本对账，unknown 不记 0）
 *
 * 用法：node score-usable.mjs --matrix <dir> --out <dir>
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyCompletion } from '../../core-completion/verify.mjs'
import { STORIES, ARMS } from './stories.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] }
const matrixDir = resolve(arg('matrix'))
const outDir = resolve(arg('out', join(matrixDir, 'score')))
mkdirSync(outDir, { recursive: true })

const readJson = (path, fallback = null) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback)
const sum = (rows, pick) => rows.reduce((n, r) => n + (Number.isFinite(pick(r)) ? pick(r) : 0), 0)
const readJsonl = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

function dbRows(workspace, sql, params = []) {
  const dir = join(workspace, 'state')
  if (!existsSync(dir)) return []
  const name = readdirSync(dir).find((n) => n.endsWith('.sqlite'))
  if (!name) return []
  const db = new DatabaseSync(join(dir, name), { readOnly: true })
  try { return db.prepare(sql).all(...params) } catch { return [] } finally { db.close() }
}

const primaryTicket = (workspace) => dbRows(workspace, "SELECT ticket_id FROM tasks WHERE title = '主测试' LIMIT 1")[0]?.ticket_id ?? null

export function scoreOne(dir) {
  const raw = readJson(join(dir, 'raw.json'))
  if (!raw) return { error: 'raw_missing', id: dir.split('/').pop() }
  const story = STORIES[raw.story]
  const workspace = join(dir, 'ws')
  const ticket = primaryTicket(workspace)
  const attentions = ticket
    ? dbRows(workspace, 'SELECT attention_id, state, reason, created_at, question FROM attentions WHERE ticket_id = ? ORDER BY created_at', [ticket])
    : []
  const produced = (raw.timeline ?? []).filter((t) => t.kind === 'produce')
  const need = story.expectation.requiredKeys
  const lastNeeded = produced.filter((p) => need.includes(p.key)).map((p) => p.at).sort().at(-1) ?? null
  const firstAsk = attentions[0] ?? null
  const asked = Boolean(firstAsk)
  const early = Boolean(firstAsk && lastNeeded && Date.parse(firstAsk.created_at) < Date.parse(lastNeeded) - 2000)
  const duplicates = Math.max(0, attentions.length - 1)
  let verification = null
  try { verification = ticket ? verifyCompletion(workspace, ticket) : null } catch (error) { verification = { ok: false, failures: [{ name: 'verifier.error', detail: String(error) }] } }
  const validCompletion = Boolean(verification?.ok)
  const bindingsRow = ticket ? dbRows(workspace, 'SELECT bindings_json, task_revision FROM tasks WHERE ticket_id = ?', [ticket])[0] : null
  const bindings = bindingsRow?.bindings_json ? JSON.parse(bindingsRow.bindings_json) : []
  const cancelledRows = story.expectation.cancelled
    ? dbRows(workspace, "SELECT ticket_id FROM tasks WHERE title = '干扰构建'")[0]
    : null
  // 只算取消之后的问题（取消前已有的提醒不算违约）。
  const httpLog = readJson(join(dir, 'http.json'), [])
  const cancelledAt = (raw.timeline ?? []).find((t) => t.kind === 'task.cancel')?.at
    ?? (httpLog.find((e) => e.route === '/api/cancel')?.at ?? null)
  const cancelledAttentions = cancelledRows
    ? dbRows(workspace, 'SELECT attention_id, created_at FROM attentions WHERE ticket_id = ?', [cancelledRows.ticket_id])
      .filter((a) => !cancelledAt || String(a.created_at) >= cancelledAt).length
    : null

  const clientRows = readJsonl(join(dir, 'client-ledger.jsonl'))
  const proxyRows = readJsonl(join(dir, 'proxy-ledger.jsonl'))
  const clientEnds = clientRows.filter((r) => r.phase === 'end')
  const proxyEnds = proxyRows.filter((r) => r.phase === 'end')
  const sum = (rows, pick) => rows.reduce((n, r) => n + (Number.isFinite(pick(r)) ? pick(r) : 0), 0)
  const tokensOf = (rows) => sum(rows, (r) => Number(r.usage?.prompt_tokens ?? r.inputTokens ?? 0) + Number(r.usage?.completion_tokens ?? r.outputTokens ?? 0))

  const ok = asked && !early && duplicates === 0 && validCompletion
    && (story.expectation.cancelled ? cancelledAttentions === 0 : true)
    && (story.expectation.correctionDropsB ? bindings.length === 0 : true)

  return {
    id: `${raw.story}-${raw.arm}`,
    story: raw.story,
    arm: raw.arm,
    split: story.split ?? 'dev',
    ok,
    asked,
    early,
    duplicates,
    validCompletion,
    bindingsCount: bindings.length,
    taskRevision: bindingsRow?.task_revision ?? null,
    cancelledAttentions,
    failures: verification?.failures ?? [],
    posts: proxyEnds.length,
    clientPosts: clientEnds.length,
    unknownUsage: proxyEnds.filter((r) => !r.usageKnown).length,
    clientUnknown: clientEnds.filter((r) => !r.usageKnown).length,
    tokens: tokensOf(proxyEnds),
    clientTokens: tokensOf(clientEnds),
    abortedButServerCompleted: proxyEnds.filter((r) => r.clientAborted && r.serverCompleted).length,
    question: firstAsk?.question ?? null,
  }
}

const runs = []
for (const story of Object.keys(STORIES)) {
  for (const arm of Object.keys(ARMS)) {
    const dir = join(matrixDir, `${story}-${arm}`)
    if (!existsSync(dir)) { runs.push({ id: `${story}-${arm}`, story, arm, error: 'missing' }); continue }
    runs.push(scoreOne(dir))
  }
}

const byArm = {}
for (const arm of Object.keys(ARMS)) {
  const list = runs.filter((r) => r.arm === arm && !r.error)
  const valid = list.filter((r) => r.validCompletion).length
  const ok = list.filter((r) => r.ok).length
  byArm[arm] = {
    label: ARMS[arm].label,
    runs: list.length,
    ok,
    okRate: list.length ? Number((ok / list.length).toFixed(4)) : null,
    asked: list.filter((r) => r.asked).length,
    early: list.filter((r) => r.early).length,
    duplicateRuns: list.filter((r) => r.duplicates > 0).length,
    validCompletion: valid,
    validCompletionRate: list.length ? Number((valid / list.length).toFixed(4)) : null,
    posts: sum(list, (r) => r.posts ?? 0),
    failedPosts: sum(list, (r) => r.abortedButServerCompleted ?? 0),
    tokens: sum(list, (r) => r.tokens ?? 0),
    tokensPerValidCompletion: valid > 0 ? Math.round(sum(list, (r) => r.tokens ?? 0) / valid) : null,
  }
}

const report = {
  schema: 'pet-r6-usable-score/v1',
  at: new Date().toISOString(),
  matrixDir,
  stories: Object.keys(STORIES),
  arms: Object.keys(ARMS),
  runs: runs.length,
  measured: runs.filter((r) => !r.error).length,
  byArm,
  perRun: runs,
  notes: [
    '评分不读运行器 ok 字段；问题取自 attentions 表，窗口取自 produce 时间戳，有效完成取自 core-completion/verify.mjs。',
    '成本以代理账本为准，客户端账本对账；unknown 不记 0；代理侧 clientAborted 但 serverCompleted 计入 posts。',
  ],
}
writeFileSync(join(outDir, 'score.json'), `${JSON.stringify(report, null, 2)}\n`)

const header = ['story', 'arm', 'ok', 'asked', 'early', 'duplicates', 'validCompletion', 'bindings', 'posts', 'tokens', 'unknown', 'abortedCompleted']
const csv = [header.join(','), ...runs.map((r) => [r.story, r.arm, r.ok, r.asked, r.early, r.duplicates, r.validCompletion, r.bindingsCount, r.posts, r.tokens, r.unknownUsage, r.abortedButServerCompleted].join(','))]
writeFileSync(join(outDir, 'per-run.csv'), `${csv.join('\n')}\n`)
console.log(JSON.stringify({ measured: report.measured, byArm }, null, 2))
