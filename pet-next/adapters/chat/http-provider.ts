/**
 * M3-0 HTTP 聊天适配器：把 ChatProvider 映射到本地演示服务的一次 POST。
 * 演示安全：url 只允许 http://127.0.0.1:* / http://localhost:*，拒绝外网地址。
 * abort 传导到 fetch；非 2xx / 网络错误 / 响应缺 text 一律 reject（session 映射 provider-error）。
 * @module pet-next/adapters/chat/http-provider
 */
import type { ChatProvider } from '../../contracts/chat.ts';

/** 与全局 fetch 结构兼容的最小形状（便于注入桩）。 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpChatProviderOptions {
  /** 演示服务地址，必须形如 http://127.0.0.1:port 或 http://localhost:port。 */
  url: string;
  /** 注入 fetch 实现，默认全局 fetch。 */
  fetchImpl?: FetchLike;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 校验演示安全地址：仅本机回环、显式端口、http 协议。 */
export function assertLoopbackUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`chat url 不是合法地址: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = LOOPBACK_HOSTS.has(host) || host === '::1';
  if (parsed.protocol !== 'http:' || !loopback || parsed.port === '') {
    throw new Error(
      `chat url 仅允许 http://127.0.0.1:* 或 http://localhost:*（演示安全，拒绝外网地址）: ${url}`,
    );
  }
  return parsed;
}

export function createHttpChatProvider(options: HttpChatProviderOptions): ChatProvider {
  const target = assertLoopbackUrl(options.url);
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  return {
    async complete(input) {
      let response: Response;
      try {
        response = await doFetch(target.toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ id: input.id, text: input.text }),
          signal: input.signal,
        });
      } catch (error) {
        // abort 产生的原因原样抛出，session 依据 signal.aborted 归类为 cancelled。
        throw error;
      }
      if (!response.ok) {
        throw new Error(`chat http ${response.status}`);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new Error('chat 响应不是 JSON', { cause: error });
      }
      if (typeof payload !== 'object' || payload === null || typeof (payload as { text?: unknown }).text !== 'string') {
        throw new Error('chat 响应缺少 text 字段');
      }
      // 超长文本由 session 截断，provider 原样返回。
      return (payload as { text: string }).text;
    },
  };
}
