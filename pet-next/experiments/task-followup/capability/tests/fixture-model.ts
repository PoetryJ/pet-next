/**
 * 仅测试用：确定性夹具“模型”。它返回测试作者手写的 JSON，用来验证管线机制
 * （解析、校验、更正链、版本校验、介入持久化）。它不是被测模型，任何能力结论都不得引用它。
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ModelCallResult, ModelClient, ModelRequest } from '../model/protocol.ts'

export class FixtureClient implements ModelClient {
  readonly kind = 'test-fixture'
  readonly seen: ModelRequest[] = []
  private readonly reply: (req: ModelRequest) => string
  constructor(reply: (req: ModelRequest) => string) {
    this.reply = reply
  }
  async complete(request: ModelRequest): Promise<ModelCallResult> {
    this.seen.push(request)
    return {
      ok: true,
      response: { protocol: 'pet-capability-model/v1', requestId: request.requestId, sessionId: `fixture-${this.seen.length}`, model: { provider: 'test-fixture', name: 'test-fixture', version: 'n/a' }, rawText: this.reply(request), startedAt: 'n/a', finishedAt: 'n/a' },
    }
  }
}

/** 本机 loopback 上的假 OpenAI-compatible 服务，用于走真实 HTTP 协议路径。 */
export async function fakeOpenAI(handler: (body: any) => { status: number; body: unknown; delayMs?: number }): Promise<{ url: string; close: () => Promise<void>; bodies: any[] }> {
  const bodies: any[] = []
  const server = createServer((req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      const body = JSON.parse(data || '{}')
      bodies.push({ path: req.url, headers: req.headers, body })
      const r = handler(body)
      setTimeout(() => {
        res.writeHead(r.status, { 'content-type': 'application/json' })
        res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
      }, r.delayMs ?? 0)
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}/v1`, bodies, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(() => ok()) }) }
}
