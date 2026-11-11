/**
 * 捕获桩与网络哨兵。
 *
 * - `fetchImpl` 被注入产品 Qwen 适配器：只记录请求体，不碰 socket。
 * - `globalThis.fetch` 被替换成哨兵：任何漏用注入桩的调用都会抛错并计数，
 *   真实网络次数必须为 0（与 stub 调用数分开报告）。
 *
 * @module pet-next/experiments/memory-consistency/product-shadow/capture
 */
import { createHash } from 'node:crypto';

/** 捕获到的一次请求体。 */
export interface CapturedCall {
  readonly url: string;
  readonly bodyText: string;
  readonly sha256: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly utf16: number;
  readonly utf8: number;
  readonly at: string;
}

/** 捕获统计。 */
export interface CaptureStats {
  stubCalls: number;
  realNetworkCalls: number;
  sentinelErrors: string[];
}

/** 捕获桩。 */
export interface CaptureHarness {
  readonly fetchImpl: typeof fetch;
  readonly calls: CapturedCall[];
  readonly stats: CaptureStats;
  /** 安装 globalThis.fetch 哨兵，返回还原函数。 */
  installSentinel(): () => void;
  /** 最近一次请求。 */
  last(): CapturedCall | undefined;
}

/** 占位回复：固定文本，绝不根据 gold 返回答案。 */
export const STUB_REPLY = '离线占位回复';

function measure(messages: readonly { role: string; content: string }[]): { utf16: number; utf8: number } {
  let utf16 = 0;
  let utf8 = 0;
  for (const message of messages) {
    utf16 += message.role.length + message.content.length;
    utf8 += Buffer.byteLength(message.role, 'utf8') + Buffer.byteLength(message.content, 'utf8');
  }
  return { utf16, utf8 };
}

/** 建立捕获桩。`defer` 为 true 时请求在下一个宏任务才返回，便于中途取消。 */
export function createCaptureHarness(options: { defer?: boolean } = {}): CaptureHarness {
  const calls: CapturedCall[] = [];
  const stats: CaptureStats = { stubCalls: 0, realNetworkCalls: 0, sentinelErrors: [] };

  const fetchImpl = (async (input: unknown, init?: unknown) => {
    stats.stubCalls += 1;
    const url = String(input);
    const bodyText = String((init as { body?: unknown } | undefined)?.body ?? '');
    let messages: { role: string; content: string }[] = [];
    try {
      const parsed = JSON.parse(bodyText) as { messages?: { role: string; content: string }[] };
      if (parsed.messages !== undefined) messages = parsed.messages;
    } catch {
      // 非 JSON 体按空消息记录（仍保留原始体与 sha）。
    }
    const sizes = measure(messages);
    calls.push({
      url,
      bodyText,
      sha256: createHash('sha256').update(bodyText).digest('hex'),
      messages,
      utf16: sizes.utf16,
      utf8: sizes.utf8,
      at: new Date().toISOString(),
    });
    const respond = (): Response =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: STUB_REPLY }, finish_reason: 'stop' }],
        }),
      }) as unknown as Response;
    if (options.defer === true) {
      return new Promise<Response>((resolve) => {
        setTimeout(() => resolve(respond()), 0);
      });
    }
    return respond();
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    calls,
    stats,
    installSentinel(): () => void {
      const original = globalThis.fetch;
      globalThis.fetch = ((input: unknown) => {
        stats.realNetworkCalls += 1;
        stats.sentinelErrors.push(String(input));
        throw new Error(`network sentinel: real fetch blocked (${String(input)})`);
      }) as typeof fetch;
      return () => {
        globalThis.fetch = original;
      };
    },
    last(): CapturedCall | undefined {
      return calls[calls.length - 1];
    },
  };
}
