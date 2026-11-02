/**
 * M3-1 Qwen 协议适配器：把 ChatProvider 映射到 OpenAI 兼容服务的一次非流式 POST /chat/completions。
 * 冻结参数全部来自 contracts/chat.ts（max_tokens / temperature / system prompt / 关闭 thinking）。
 * 只取 choices[0].message.content 作正文，绝不拼 reasoning / reasoning_content 之外的思维链字段；
 * finish_reason='length' 只标记 truncated，文本照常返回，由界面按截断处理。
 * abort 原样传给 fetch（取消必须贯穿网络）；provider 不自设超时、不重试、不换模型。
 * 演示安全：baseUrl 仅允许 http(s)://127.0.0.1[:port] 或 http(s)://localhost[:port]。
 * @module pet-next/adapters/chat/qwen-provider
 */
import {
  QWEN_MAX_TOKENS,
  QWEN_SYSTEM_PROMPT,
  QWEN_TEMPERATURE,
  type QwenCallMeta,
  type QwenChatProvider,
} from '../../contracts/chat.ts';

export interface QwenChatProviderOptions {
  /** 服务基址，形如 http(s)://127.0.0.1[:port][/v1]；末尾斜杠会被规整。 */
  baseUrl: string;
  /** 请求体里的 model；provider 不改写、不回落默认模型。 */
  model: string;
  /** 注入 fetch 实现，默认全局 fetch（单测全部注入，不真实请求）。 */
  fetchImpl?: typeof fetch;
  /** 注入时钟（毫秒），默认 Date.now；用于 latencyMs 的可控测量。 */
  now?: () => number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** 校验演示安全基址：仅本机回环 + http(s)，端口可省；返回去掉末尾斜杠的基址。 */
export function assertQwenBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`qwen baseUrl 不是合法地址: ${baseUrl}`);
  }
  const host = parsed.hostname.toLowerCase();
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `qwen baseUrl 仅允许 http(s)://127.0.0.1[:port] 或 http(s)://localhost[:port]（演示安全，拒绝外网地址）: ${baseUrl}`,
    );
  }
  return baseUrl.replace(/\/+$/, '');
}

/** 响应里只认 choices[0]；形状不对一律报错（session 映射 provider-error）。 */
function pickFirstChoice(payload: unknown): { message: Record<string, unknown>; finishReason?: string } {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('qwen 响应不是 JSON 对象');
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('qwen 响应缺少 choices');
  }
  const choice: unknown = choices[0];
  if (typeof choice !== 'object' || choice === null) {
    throw new Error('qwen 响应 choices[0] 不合法');
  }
  const message = (choice as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) {
    throw new Error('qwen 响应缺少 choices[0].message');
  }
  const finishReason = (choice as { finish_reason?: unknown }).finish_reason;
  return {
    message: message as Record<string, unknown>,
    finishReason: typeof finishReason === 'string' ? finishReason : undefined,
  };
}

/** usage 只搬运服务给到的数字字段；缺失不编造。 */
function pickUsage(payload: unknown): QwenCallMeta['usage'] {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const picked: NonNullable<QwenCallMeta['usage']> = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
    const value = (usage as Record<string, unknown>)[key];
    if (typeof value === 'number') picked[key] = value;
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

export function createQwenChatProvider(options: QwenChatProviderOptions): QwenChatProvider {
  const endpoint = `${assertQwenBaseUrl(options.baseUrl)}/chat/completions`;
  const doFetch: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const model = options.model;
  let lastMeta: QwenCallMeta | null = null;

  return {
    model,
    get lastMeta() {
      return lastMeta;
    },
    async complete(input) {
      const started = now();
      const meta: QwenCallMeta = { id: input.id, model };
      lastMeta = meta;
      try {
        const response = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: QWEN_SYSTEM_PROMPT },
              { role: 'user', content: input.text },
            ],
            stream: false,
            max_tokens: QWEN_MAX_TOKENS,
            temperature: QWEN_TEMPERATURE,
            chat_template_kwargs: { enable_thinking: false },
          }),
          signal: input.signal,
        });
        meta.status = response.status;
        if (!response.ok) {
          throw new Error(`qwen http ${response.status}`);
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch (error) {
          throw new Error('qwen 响应不是 JSON', { cause: error });
        }
        const { message, finishReason } = pickFirstChoice(payload);
        const content = message.content;
        if (typeof content !== 'string' || content.trim() === '') {
          throw new Error('qwen 响应缺少正文 content');
        }
        // 正文原样返回；reasoning / reasoning_content 一律不参与拼接。
        if (finishReason !== undefined) meta.finishReason = finishReason;
        meta.truncated = finishReason === 'length';
        const usage = pickUsage(payload);
        if (usage === undefined) meta.usageUnknown = true;
        else meta.usage = usage;
        return content;
      } catch (error) {
        // 失败也留痕；AbortError 原样抛出，session 依据 signal.aborted 归类取消。
        meta.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        // 请求发出 -> 响应文本就绪（或失败落定）；不覆盖核心的 15s 总超时。
        meta.latencyMs = Math.max(0, now() - started);
      }
    },
  };
}
