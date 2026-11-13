/**
 * 模型调用协议：OpenAI-compatible 适配器与文件队列共用同一请求/响应形状。
 * 失败一律返回 ok:false 和非空 code，绝不返回成功占位。
 */
import { createHash } from 'node:crypto'

export type ModelPurpose = 'memory-extract' | 'assess' | 'eval-answer' | 'eval-summary'

export interface ChatMessage {
  readonly role: 'system' | 'user'
  readonly content: string
}

export interface ModelRequest {
  readonly protocol: 'pet-capability-model/v1'
  readonly requestId: string
  readonly purpose: ModelPurpose
  readonly createdAt: string
  readonly messages: readonly ChatMessage[]
  /** 期望模型输出单个 JSON 对象 */
  readonly responseFormat: 'json_object'
}

export interface ModelMeta {
  readonly provider: string
  readonly name: string
  readonly version: string
}

export interface ModelResponse {
  readonly protocol: 'pet-capability-model/v1'
  readonly requestId: string
  /** 推理会话 id；队列模式由执行方填写，每个请求一个全新会话 */
  readonly sessionId: string
  readonly model: ModelMeta
  readonly rawText: string
  readonly finishReason?: string
  readonly usage?: unknown
  readonly startedAt: string
  readonly finishedAt: string
}

export type ModelFailureCode =
  | 'not_configured'
  | 'timeout'
  | 'aborted'
  | 'provider_error'
  | 'http_error'
  | 'empty_output'
  | 'pending'
  | 'bad_response_file'
  | 'request_mismatch'

export type ModelCallResult =
  | { readonly ok: true; readonly response: ModelResponse }
  | { readonly ok: false; readonly code: ModelFailureCode; readonly detail: string; readonly requestId: string }

export interface ModelClient {
  readonly kind: string
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelCallResult>
}

export function requestId(purpose: ModelPurpose, messages: readonly ChatMessage[], salt = ''): string {
  const h = createHash('sha256').update(purpose).update('\0').update(salt).update('\0').update(JSON.stringify(messages)).digest('hex')
  return `req-${h.slice(0, 20)}`
}

export function makeRequest(purpose: ModelPurpose, messages: readonly ChatMessage[], createdAt: string, salt = ''): ModelRequest {
  return { protocol: 'pet-capability-model/v1', requestId: requestId(purpose, messages, salt), purpose, createdAt, messages, responseFormat: 'json_object' }
}

export type ParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: 'parse_error'; readonly detail: string }

/** 只接受：整段是 JSON，或唯一一个 ```json 代码块。不做“猜测修补”。 */
export function parseModelJson(raw: string): ParseResult {
  const text = raw.trim()
  if (text.length === 0) return { ok: false, code: 'parse_error', detail: 'empty output' }
  const candidates: string[] = [text]
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n?```/g)]
  if (fences.length === 1) candidates.push(fences[0]![1]!.trim())
  for (const c of candidates) {
    try {
      const value = JSON.parse(c)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, code: 'parse_error', detail: 'top-level JSON is not an object' }
      }
      return { ok: true, value }
    } catch {
      /* try next */
    }
  }
  return { ok: false, code: 'parse_error', detail: fences.length > 1 ? 'multiple fenced blocks' : 'not valid JSON' }
}
