/**
 * 显式可配置的 OpenAI-compatible 适配器（/chat/completions）。
 * 只按环境变量“名字”读取配置；从不打印或持久化 key。
 *   PET_MODEL_BASE_URL   例：https://host/v1
 *   PET_MODEL_API_KEY    可选；未设置时只允许 loopback（127.0.0.1 / localhost / ::1）地址，
 *                        非本机地址无 key 一律拒绝（not_configured: keyless_non_loopback_refused）
 *   PET_MODEL_NAME       模型名
 *   PET_MODEL_TIMEOUT_MS 默认 60000
 *   PET_MODEL_PROVIDER   仅作元数据标签，默认 'openai-compatible'
 */
import type { ChatMessage, ModelCallResult, ModelClient, ModelRequest } from './protocol.ts'
// 可选生成参数（负责人确认后再定）：PET_MODEL_MAX_TOKENS、PET_MODEL_TEMPERATURE（默认 0）
import { randomUUID } from 'node:crypto'

export interface OpenAICompatibleConfig {
  readonly baseUrl: string
  readonly apiKey: string | null
  readonly model: string
  readonly timeoutMs: number
  readonly provider: string
  readonly temperature: number
  readonly maxTokens?: number | null
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env):
  | { ok: true; config: OpenAICompatibleConfig }
  | { ok: false; missing: string[] } {
  const missing: string[] = []
  if (!env.PET_MODEL_BASE_URL) missing.push('PET_MODEL_BASE_URL')
  if (!env.PET_MODEL_NAME) missing.push('PET_MODEL_NAME')
  if (missing.length > 0) return { ok: false, missing }
  if (!env.PET_MODEL_API_KEY && !isLoopbackUrl(env.PET_MODEL_BASE_URL!)) return { ok: false, missing: ['PET_MODEL_API_KEY (keyless_non_loopback_refused)'] }
  const timeout = Number(env.PET_MODEL_TIMEOUT_MS ?? '60000')
  return {
    ok: true,
    config: {
      baseUrl: env.PET_MODEL_BASE_URL!.replace(/\/+$/, ''),
      apiKey: env.PET_MODEL_API_KEY ? env.PET_MODEL_API_KEY : null,
      model: env.PET_MODEL_NAME!,
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 60000,
      provider: env.PET_MODEL_PROVIDER ?? 'openai-compatible',
      temperature: Number.isFinite(Number(env.PET_MODEL_TEMPERATURE)) && env.PET_MODEL_TEMPERATURE !== undefined ? Number(env.PET_MODEL_TEMPERATURE) : 0,
      maxTokens: Number.isInteger(Number(env.PET_MODEL_MAX_TOKENS)) && Number(env.PET_MODEL_MAX_TOKENS) > 0 ? Number(env.PET_MODEL_MAX_TOKENS) : null,
    },
  }
}

export function isLoopbackUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
}

export class OpenAICompatibleClient implements ModelClient {
  readonly kind = 'openai-compatible'
  private readonly config: OpenAICompatibleConfig | null
  private readonly missing: string[]
  private readonly fetchImpl: typeof fetch

  constructor(config?: OpenAICompatibleConfig, fetchImpl: typeof fetch = fetch) {
    if (config) {
      const keylessRemote = !config.apiKey && !isLoopbackUrl(config.baseUrl)
      this.config = keylessRemote ? null : config
      this.missing = keylessRemote ? ['PET_MODEL_API_KEY (keyless_non_loopback_refused)'] : []
    } else {
      const c = configFromEnv()
      this.config = c.ok ? c.config : null
      this.missing = c.ok ? [] : c.missing
    }
    this.fetchImpl = fetchImpl
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelCallResult> {
    const fail = (code: any, detail: string): ModelCallResult => ({ ok: false, code, detail, requestId: request.requestId })
    if (!this.config) return fail('not_configured', `missing env: ${this.missing.join(', ')}`)
    const cfg = this.config
    const timeout = AbortSignal.timeout(cfg.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const startedAt = new Date().toISOString()
    let res: Response
    try {
      res = await this.fetchImpl(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: cfg.temperature,
          messages: request.messages.map((m: ChatMessage) => ({ role: m.role, content: m.content })),
          ...(cfg.maxTokens ? { max_tokens: cfg.maxTokens } : {}),
          ...(process.env.PET_MODEL_NO_RESPONSE_FORMAT === '1' ? {} : { response_format: { type: 'json_object' } }),
        }),
        signal: combined,
      })
    } catch (error) {
      if (signal?.aborted) return fail('aborted', 'caller aborted')
      if (timeout.aborted) return fail('timeout', `no response within ${cfg.timeoutMs}ms`)
      return fail('provider_error', error instanceof Error ? error.message : String(error))
    }
    let body: any
    try {
      body = await res.json()
    } catch (error) {
      return fail('http_error', `status ${res.status}; body not JSON`)
    }
    if (!res.ok) return fail('http_error', `status ${res.status}: ${String(body?.error?.message ?? '').slice(0, 300)}`)
    const choice = body?.choices?.[0]
    const text = choice?.message?.content
    if (typeof text !== 'string' || text.trim().length === 0) return fail('empty_output', 'no choices[0].message.content')
    return {
      ok: true,
      response: {
        protocol: 'pet-capability-model/v1',
        requestId: request.requestId,
        sessionId: typeof body?.id === 'string' ? body.id : `http-${randomUUID()}`,
        model: { provider: cfg.provider, name: typeof body?.model === 'string' ? body.model : cfg.model, version: typeof body?.system_fingerprint === 'string' ? body.system_fingerprint : 'unknown' },
        rawText: text,
        finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'unknown',
        usage: body?.usage ?? null,
        startedAt,
        finishedAt: new Date().toISOString(),
      },
    }
  }
}
