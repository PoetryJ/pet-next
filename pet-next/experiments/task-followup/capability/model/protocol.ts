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
  /** 可选：本次调用的输出上限（与 PET_MODEL_MAX_TOKENS 取较小者） */
  readonly maxTokens?: number
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

/** 从第一个 { 开始取括号平衡的对象（考虑字符串转义）；不修补内容。 */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 接受顺序：整段 JSON → 唯一 ```json 代码块 → 去掉空 <think></think> 后的整段 → 唯一的平衡对象（前后有说明文字）。
 * 不改写对象内容、不补全截断输出；截断/多对象一律 parse_error。
 */
export function parseModelJson(raw: string): ParseResult {
  const text = raw.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '').trim()
  if (text.length === 0) return { ok: false, code: 'parse_error', detail: 'empty output' }
  const candidates: string[] = [text]
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n?```/g)]
  if (fences.length === 1) candidates.push(fences[0]![1]!.trim())
  const balanced = firstBalancedObject(text)
  if (balanced && fences.length <= 1) candidates.push(balanced)
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
