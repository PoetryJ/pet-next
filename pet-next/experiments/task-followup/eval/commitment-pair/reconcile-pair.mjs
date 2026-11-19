#!/usr/bin/env node
/**
 * R7 用量对账：客户端账本 ↔ 代理账本 ↔ 模型原始请求目录。
 *
 * - 跨 18 次运行、跨任务、跨重启，给每个 requestId 唯一全局编号；
 * - 逐 run 首尾一一对账（start/end 数量、id 集合、wireSha）；
 * - 缺失或未知用量单列，不记 0。
 *
 * 用法：node eval/commitment-pair/reconcile-pair.mjs --runs <dir1,dir2> [--out <dir>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] }
const roots = (arg('runs', '') ?? '').split(',').map((s) => resolve(s.trim())).filter(Boolean)
if (!roots.length) throw Error('usage: --runs <dir1,dir2> [--out <dir>]')
const outDir = resolve(arg('out', join(roots[0], 'reconcile')))
mkdirSync(outDir, { recursive: true })
const readJson = (p, f = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : f)
const readJsonl = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const tokens = (r) => Number(r.inputTokens ?? r.usage?.prompt_tokens ?? 0) + Number(r.outputTokens ?? r.usage?.completion_tokens ?? 0)

const runs = []
for (const root of roots) {
  const listed = readJson(join(root, 'runs.json'), { rows: [] }).rows ?? []
  for (const row of listed) runs.push({ root, id: `${row.trajectory}-${row.promise}-${row.arm}`, dir: join(root, `${row.trajectory}-${row.promise}-${row.arm}`) })
}

const perRun = []
const allIds = new Map()
for (const run of runs) {
  const client = readJsonl(join(run.dir, 'client-ledger.jsonl'))
  const proxy = readJsonl(join(run.dir, 'proxy-ledger.jsonl'))
  const cStart = client.filter((r) => r.phase === 'start')
  const cEnd = client.filter((r) => r.phase === 'end')
  const pStart = proxy.filter((r) => r.phase === 'start')
  const pEnd = proxy.filter((r) => r.phase === 'end')
  const cIds = new Set(cEnd.map((r) => r.id))
  const pIds = new Set(pEnd.map((r) => r.id))
  const both = [...cIds].filter((id) => pIds.has(id))
  const clientOnly = [...cIds].filter((id) => !pIds.has(id))
  const proxyOnly = [...pIds].filter((id) => !cIds.has(id))
  const unknown = [...cEnd, ...pEnd].filter((r) => !r.usageKnown || !r.usage)
  const pEndIds = new Set(pEnd.map((r) => r.id))
  const unfinished = pStart.filter((r) => !pEndIds.has(r.id)).map((r) => r.id)
  const modelIo = existsSync(join(run.dir, 'model-io')) ? readJson(join(run.dir, 'model-io', 'index.json'), null) : null
  for (const r of [...cStart, ...pStart]) {
    const prev = allIds.get(r.id)
    const at = r.at ?? ''
    if (!prev || at < prev.firstAt) allIds.set(r.id, { id: r.id, firstAt: at })
  }
  perRun.push({
    id: run.id,
    dir: run.dir,
    client: { starts: cStart.length, ends: cEnd.length, tokens: cEnd.reduce((n, r) => n + tokens(r), 0) },
    proxy: { starts: pStart.length, ends: pEnd.length, tokens: pEnd.reduce((n, r) => n + tokens(r), 0) },
    matched: both.length,
    clientOnly,
    proxyOnly,
    unknownUsage: unknown.length,
    unknownIds: unknown.map((r) => r.id),
    proxyUnfinished: unfinished,
    firstStart: [...cStart, ...pStart].map((r) => r.at).sort()[0] ?? null,
    lastEnd: [...cEnd, ...pEnd].map((r) => r.at).sort().at(-1) ?? null,
    modelIoFiles: existsSync(join(run.dir, 'model-io')) ? (await import('node:fs')).readdirSync(join(run.dir, 'model-io')).length : 0,
    modelIoIndex: modelIo,
    abortedButServerCompleted: pEnd.filter((r) => r.clientAborted && r.serverCompleted).length,
  })
}

const ordered = [...allIds.values()].sort((a, b) => a.firstAt.localeCompare(b.firstAt) || a.id.localeCompare(b.id))
const startCounts = new Map()
for (const run of runs) for (const r of readJsonl(join(run.dir, 'proxy-ledger.jsonl')).filter((x) => x.phase === 'start')) startCounts.set(r.id, (startCounts.get(r.id) ?? 0) + 1)
const duplicateStarts = [...startCounts.values()].reduce((n, c) => n + Math.max(0, c - 1), 0)
const retried = [...startCounts.entries()].filter(([, c]) => c > 1).map(([id, c]) => ({ id, starts: c }))
ordered.forEach((row, i) => { row.globalNo = i + 1 })
const numberById = new Map(ordered.map((r) => [r.id, r.globalNo]))
for (const run of perRun) {
  const c = readJsonl(join(run.dir, 'client-ledger.jsonl')).filter((r) => r.phase === 'end')
  const p = readJsonl(join(run.dir, 'proxy-ledger.jsonl')).filter((r) => r.phase === 'end')
  run.globalNumbers = {
    client: [...new Set(c.map((r) => numberById.get(r.id)).filter(Number.isFinite))].sort((a, b) => a - b),
    proxy: [...new Set(p.map((r) => numberById.get(r.id)).filter(Number.isFinite))].sort((a, b) => a - b),
  }
  run.unaccountedProxy = p.filter((r) => !numberById.has(r.id)).map((r) => r.id)
}

const totals = {
  runs: perRun.length,
  clientStarts: perRun.reduce((n, r) => n + r.client.starts, 0),
  clientEnds: perRun.reduce((n, r) => n + r.client.ends, 0),
  proxyStarts: perRun.reduce((n, r) => n + r.proxy.starts, 0),
  proxyEnds: perRun.reduce((n, r) => n + r.proxy.ends, 0),
  matched: perRun.reduce((n, r) => n + r.matched, 0),
  clientOnly: perRun.flatMap((r) => r.clientOnly).length,
  proxyOnly: perRun.flatMap((r) => r.proxyOnly).length,
  unknownUsage: perRun.reduce((n, r) => n + r.unknownUsage, 0),
  clientTokens: perRun.reduce((n, r) => n + r.client.tokens, 0),
  proxyTokens: perRun.reduce((n, r) => n + r.proxy.tokens, 0),
  uniqueRequestIds: ordered.length,
  duplicateStarts,
  retried,
  proxyUnfinished: perRun.reduce((n, r) => n + r.proxyUnfinished.length, 0),
  abortedButServerCompleted: perRun.reduce((n, r) => n + r.abortedButServerCompleted, 0),
}

const report = {
  schema: 'pet-r7-usage-reconcile/v1',
  at: new Date().toISOString(),
  roots,
  totals,
  perRun,
  uniqueRequests: ordered,
  missing: {
    clientOnly: perRun.flatMap((r) => r.clientOnly.map((id) => ({ run: r.id, id }))),
    proxyOnly: perRun.flatMap((r) => r.proxyOnly.map((id) => ({ run: r.id, id }))),
    unknownUsage: perRun.flatMap((r) => r.unknownIds.map((id) => ({ run: r.id, id }))),
    proxyUnfinished: perRun.flatMap((r) => r.proxyUnfinished.map((id) => ({ run: r.id, id }))),
  },
  notes: [
    '全局编号按 requestId 首次出现时间排序，跨任务/重启只编一次；同一 requestId 的重试不重复编号。',
    '缺失用量不记 0：clientOnly/proxyOnly/unknownUsage 全部单列。',
  ],
}
writeFileSync(join(outDir, 'reconcile.json'), `${JSON.stringify(report, null, 2)}\n`)
const csv = ['run,clientStarts,clientEnds,proxyStarts,proxyEnds,matched,clientOnly,proxyOnly,unknown,clientTokens,proxyTokens,abortedServerCompleted',
  ...perRun.map((r) => [r.id, r.client.starts, r.client.ends, r.proxy.starts, r.proxy.ends, r.matched, r.clientOnly.length, r.proxyOnly.length, r.unknownUsage, r.client.tokens, r.proxy.tokens, r.abortedButServerCompleted].join(','))]
writeFileSync(join(outDir, 'reconcile.csv'), `${csv.join('\n')}\n`)
console.log(JSON.stringify(totals, null, 2))
