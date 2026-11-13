/**
 * 请求/响应文件队列：没有可用模型接口时，由外部执行方在“全新、无上下文继承”的推理会话里
 * 逐个执行请求，并把原始输出写回。
 *
 * 目录：
 *   <queue>/requests/<requestId>.json    只含该 case×arm 的 packet（messages），不含 caseId/split/gold
 *   <queue>/responses/<requestId>.json   执行方写：{protocol, requestId, sessionId, model, rawText, startedAt, finishedAt}
 *   <queue>/README.txt                   执行方规则
 * 运行方映射（requestId→case/arm）写在队列目录之外，执行方不可见。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelCallResult, ModelClient, ModelRequest, ModelResponse } from './protocol.ts'

export const QUEUE_README = `pet-capability model queue (protocol pet-capability-model/v1)

规则（执行方必须遵守）：
1. 每个 requests/<id>.json 在一个全新的推理会话中执行，不继承任何其他上下文、其他请求或其他臂。
2. 按顺序把 messages 原样发给模型（system 再 user），不得增删、改写或附加提示。
3. 不得读取 gold、其他请求的响应或评估文件；不得由编程代理自己推理并填写答案。
4. 把模型原始输出逐字写入 responses/<id>.json：
   {"protocol":"pet-capability-model/v1","requestId":"<id>","sessionId":"<该次会话id>",
    "model":{"provider":"<或unknown>","name":"<或unknown>","version":"<或unknown>"},
    "rawText":"<模型原文>","startedAt":"ISO8601","finishedAt":"ISO8601"}
   模型失败/拒答也如实写 rawText（可以为空字符串），不要补写。
5. 先写临时文件再改名为 <id>.json，避免半写入被读取。
`

export class FileQueueClient implements ModelClient {
  readonly kind = 'file-queue'
  readonly dir: string
  private readonly pollMs: number
  private readonly waitMs: number

  constructor(dir: string, options: { pollMs?: number; waitMs?: number } = {}) {
    this.dir = dir
    this.pollMs = options.pollMs ?? 500
    this.waitMs = options.waitMs ?? 0
    mkdirSync(join(dir, 'requests'), { recursive: true })
    mkdirSync(join(dir, 'responses'), { recursive: true })
    const readme = join(dir, 'README.txt')
    if (!existsSync(readme)) writeFileSync(readme, QUEUE_README, 'utf8')
  }

  /** 写入请求（幂等：同 id 已存在则不覆盖）。 */
  enqueue(request: ModelRequest): string {
    const path = join(this.dir, 'requests', `${request.requestId}.json`)
    if (!existsSync(path)) {
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(request, null, 2), 'utf8')
      renameSync(tmp, path)
    }
    return path
  }

  pending(): string[] {
    const req = readdirSync(join(this.dir, 'requests')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    const res = new Set(readdirSync(join(this.dir, 'responses')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)))
    return req.filter((id) => !res.has(id)).sort()
  }

  readResponse(request: ModelRequest): ModelCallResult | null {
    const path = join(this.dir, 'responses', `${request.requestId}.json`)
    if (!existsSync(path)) return null
    let data: any
    try {
      data = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      return { ok: false, code: 'bad_response_file', detail: 'response file is not JSON', requestId: request.requestId }
    }
    if (data?.requestId !== request.requestId) return { ok: false, code: 'request_mismatch', detail: `file requestId=${data?.requestId}`, requestId: request.requestId }
    if (typeof data.rawText !== 'string' || typeof data.sessionId !== 'string' || data.sessionId.length === 0) {
      return { ok: false, code: 'bad_response_file', detail: 'rawText/sessionId missing', requestId: request.requestId }
    }
    if (data.rawText.trim().length === 0) return { ok: false, code: 'empty_output', detail: 'model returned empty text', requestId: request.requestId }
    const m = data.model ?? {}
    const response: ModelResponse = {
      protocol: 'pet-capability-model/v1',
      requestId: request.requestId,
      sessionId: data.sessionId,
      model: { provider: String(m.provider ?? 'unknown'), name: String(m.name ?? 'unknown'), version: String(m.version ?? 'unknown') },
      rawText: data.rawText,
      startedAt: String(data.startedAt ?? 'unknown'),
      finishedAt: String(data.finishedAt ?? 'unknown'),
    }
    return { ok: true, response }
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelCallResult> {
    this.enqueue(request)
    const deadline = Date.now() + this.waitMs
    for (;;) {
      const r = this.readResponse(request)
      if (r) return r
      if (signal?.aborted) return { ok: false, code: 'aborted', detail: 'caller aborted', requestId: request.requestId }
      if (Date.now() >= deadline) return { ok: false, code: 'pending', detail: `queued at ${this.dir}`, requestId: request.requestId }
      await new Promise((r2) => setTimeout(r2, this.pollMs))
    }
  }
}
