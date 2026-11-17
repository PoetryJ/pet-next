#!/usr/bin/env node
/**
 * 物理调用账本代理（B）：客户端 → 本代理 → 本地推理服务。
 *
 * 解决的问题（复核）：
 * - 客户端“请求文件”不是最终 wire body（曾先记后用 max_tokens 补参数）；
 * - 客户端 abort 不等于服务端停止生成，服务端仍消耗 GPU；
 * - 只靠客户端 cost 字段无法核对 unknown usage。
 *
 * 本代理给每个请求分配/沿用 x-pet-request-id，记录：
 *   start/end、最终请求体 SHA256、状态、usage（缺失记 unknown）、
 *   客户端是否断开（clientAborted）以及服务端是否仍完成（serverCompleted）。
 * 客户端也写自己的账本；离线用 account/reconcile.mjs 按 id 对账。
 *
 * 用法：node proxy.mjs --port 18884 --upstream http://127.0.0.1:18882 --ledger <jsonl>
 */
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] }
const port = Number(arg('port', '18884'))
const upstream = String(arg('upstream', 'http://127.0.0.1:18882')).replace(/\/$/, '')
const ledger = String(arg('ledger', ''))
if (!ledger) { console.error('usage: --ledger <jsonl>'); process.exit(2) }
mkdirSync(dirname(ledger), { recursive: true })
const write = (row) => appendFileSync(ledger, `${JSON.stringify(row)}\n`)

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    try {
      const r = await fetch(`${upstream}/health`)
      const body = await r.text()
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(body)
    } catch (error) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ready: false, error: String(error) }))
    }
    return
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/')) {
    res.writeHead(404).end()
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)
  const id = String(req.headers['x-pet-request-id'] ?? '') || `proxy-${randomUUID()}`
  const startedAt = new Date().toISOString()
  let clientAborted = false
  res.on('close', () => { if (!res.writableEnded) clientAborted = true })
  write({ schema: 'pet-physical-call/v1', side: 'proxy', phase: 'start', id, path: req.url, wireSha256: sha(raw), bytes: raw.length, at: startedAt })

  let status = null
  let text = ''
  let serverCompleted = false
  try {
    const upstreamRes = await fetch(`${upstream}${req.url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pet-request-id': id },
      body: raw,
    })
    status = upstreamRes.status
    text = await upstreamRes.text()
    serverCompleted = true
  } catch (error) {
    text = JSON.stringify({ error: { message: String(error) } })
    status = 599
  }
  let usage = null
  try { usage = JSON.parse(text)?.usage ?? null } catch { usage = null }
  write({
    schema: 'pet-physical-call/v1', side: 'proxy', phase: 'end', id, path: req.url,
    wireSha256: sha(raw), status, at: new Date().toISOString(), startedAt,
    clientAborted, serverCompleted, usage, usageKnown: usage !== null,
    inputTokens: usage?.prompt_tokens ?? null, outputTokens: usage?.completion_tokens ?? null,
  })
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status ?? 599, { 'content-type': 'application/json', 'x-pet-request-id': id })
  res.end(text)
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`PROXY_READY ${JSON.stringify({ port, upstream, ledger })}\n`)
})
