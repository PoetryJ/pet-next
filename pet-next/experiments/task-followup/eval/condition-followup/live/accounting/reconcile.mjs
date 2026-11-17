#!/usr/bin/env node
/**
 * 双端账本对账（B）：客户端 JSONL × 代理 JSONL。
 *
 * 规则：
 * - 以 x-pet-request-id 精确关联；未关联单列，不猜。
 * - usage 缺失记 unknown，不能当 0；unknown 也计入物理调用数。
 * - 客户端 abort 但代理侧 serverCompleted=true → 记为“中止后仍生成”，其 token 计入总消耗。
 *
 * 用法：node reconcile.mjs --client <jsonl> --proxy <jsonl> --out <json>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const arg = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? null : args[i + 1] }
if (!arg('client') || !arg('proxy') || !arg('out')) {
  console.error('usage: --client <jsonl> --proxy <jsonl> --out <json>')
  process.exit(2)
}
const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])

const clientRows = read(arg('client'))
const proxyRows = read(arg('proxy'))
const clientStart = clientRows.filter((r) => r.phase === 'start')
const clientEnd = new Map(clientRows.filter((r) => r.phase === 'end').map((r) => [r.id, r]))
const proxyEnd = new Map(proxyRows.filter((r) => r.phase === 'end').map((r) => [r.id, r]))

const runs = []
const seen = new Set()
for (const row of clientStart) {
  if (seen.has(row.id)) continue
  seen.add(row.id)
  const c = clientEnd.get(row.id) ?? null
  const p = proxyEnd.get(row.id) ?? null
  runs.push({
    id: row.id,
    purpose: row.purpose,
    wireSha256: row.wireSha256,
    clientStatus: c?.status ?? null,
    clientUsageKnown: Boolean(c?.usageKnown),
    clientError: c?.error ?? null,
    proxyStatus: p?.status ?? null,
    proxyUsageKnown: Boolean(p?.usageKnown),
    proxyInput: p?.inputTokens ?? null,
    proxyOutput: p?.outputTokens ?? null,
    wireMatch: Boolean(p && p.wireSha256 === row.wireSha256),
    clientAborted: Boolean(p?.clientAborted),
    serverCompleted: Boolean(p?.serverCompleted),
    joined: Boolean(p),
  })
}
const unjoinedProxy = [...proxyEnd.keys()].filter((id) => !seen.has(id)).map((id) => ({ id, ...proxyEnd.get(id) }))
const sum = (list, key) => list.reduce((n, r) => n + (Number.isFinite(r[key]) ? r[key] : 0), 0)
const joined = runs.filter((r) => r.joined)
const unknownProxy = runs.filter((r) => !r.proxyUsageKnown)
const report = {
  schema: 'pet-call-reconciliation/v1',
  at: new Date().toISOString(),
  client: { starts: clientStart.length, ends: clientEnd.size },
  proxy: { ends: proxyEnd.size },
  joined: joined.length,
  unjoined: runs.length - joined.length,
  unjoinedProxy: unjoinedProxy.length,
  wireMismatch: joined.filter((r) => !r.wireMatch).length,
  clientAbortedButServerCompleted: joined.filter((r) => r.clientAborted && r.serverCompleted).length,
  unknownUsage: { client: clientEnd.size - [...clientEnd.values()].filter((r) => r.usageKnown).length, proxy: unknownProxy.length },
  tokens: {
    proxyInput: sum(joined, 'proxyInput'),
    proxyOutput: sum(joined, 'proxyOutput'),
    clientUnknownCountedAsZero: false,
  },
  note: 'unknown 不并入 0；clientAborted 但 serverCompleted 的调用计入 token。',
  rows: runs,
  unjoinedProxyRows: unjoinedProxy.slice(0, 50),
}
writeFileSync(arg('out'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ joined: report.joined, unjoined: report.unjoined, unknownUsage: report.unknownUsage, tokens: report.tokens, abortedButCompleted: report.clientAbortedButServerCompleted }, null, 2))
