/**
 * Qwen 适配器行为锁定：全部注入 fetchImpl，不真实请求任何服务。
 * 覆盖请求逐字形状（URL/method/headers/body）、HTTP 失败、畸形响应、length 截断、usage 有/无、
 * reasoning 不进入正文、abort 贯穿网络、回环地址白名单，以及注入 now() 控制的 latencyMs。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  QWEN_DEFAULT_BASE_URL,
  QWEN_DEFAULT_MODEL,
  QWEN_MAX_TOKENS,
  QWEN_SYSTEM_PROMPT,
  QWEN_TEMPERATURE,
  type QwenChatProvider,
} from '../../contracts/chat.ts';
import { assertQwenBaseUrl, createQwenChatProvider } from './qwen-provider.ts';

/** 与全局 fetch 同签名，保证注入点类型一致。 */
type FetchStub = typeof fetch;

interface Captured {
  url: string;
  init: RequestInit;
}

/** 记录每次请求的桩；respond 决定响应。 */
function stubFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>): {
  captured: Captured[];
  fetchImpl: FetchStub;
} {
  const captured: Captured[] = [];
  const fetchImpl: FetchStub = (input, init) => {
    const url = String(input);
    const requestInit = init ?? {};
    captured.push({ url, init: requestInit });
    return Promise.resolve(respond(url, requestInit));
  };
  return { captured, fetchImpl };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function okPayload(content: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id: 'resp-1',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...extra,
  };
}

function abortError(): Error {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

function build(fetchImpl: FetchStub, overrides: { now?: () => number } = {}): QwenChatProvider {
  return createQwenChatProvider({
    baseUrl: QWEN_DEFAULT_BASE_URL,
    model: QWEN_DEFAULT_MODEL,
    fetchImpl,
    ...overrides,
  });
}

function noSignal(): AbortSignal {
  return new AbortController().signal;
}

describe('createQwenChatProvider / 请求形状', () => {
  test('200 正常：URL、method、headers、完整 JSON body 逐字匹配，返回 content', async () => {
    const { captured, fetchImpl } = stubFetch(() => jsonResponse(okPayload('你好呀')));
    const provider = build(fetchImpl);
    assert.equal(provider.model, QWEN_DEFAULT_MODEL);
    // 布尔化比较：避免断言签名把 lastMeta 收窄成 null，后续字段断言才好读。
    assert.equal(provider.lastMeta === null, true);

    const signal = noSignal();
    const text = await provider.complete({ id: 'chat-a', text: '你好，桌宠', signal });

    assert.equal(text, '你好呀');
    assert.equal(captured.length, 1);
    const call = captured[0];
    assert.ok(call);

    // URL：baseUrl + /chat/completions
    assert.equal(call.url, 'http://127.0.0.1:18872/v1/chat/completions');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.signal, signal);

    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers.accept, 'application/json');

    // 逐字：键顺序与取值都冻结（含关闭 thinking 的 chat_template_kwargs）。
    const expectedBody =
      '{"model":"qwen3.8-27b","messages":[{"role":"system","content":"' +
      QWEN_SYSTEM_PROMPT +
      '"},{"role":"user","content":"你好，桌宠"}],"stream":false,"max_tokens":96,' +
      '"temperature":0.2,"chat_template_kwargs":{"enable_thinking":false}}';
    assert.equal(call.init.body, expectedBody);

    const body = JSON.parse(String(call.init.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
      max_tokens: number;
      temperature: number;
      chat_template_kwargs: { enable_thinking: boolean };
    };
    assert.equal(body.model, QWEN_DEFAULT_MODEL);
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, QWEN_MAX_TOKENS);
    assert.equal(body.temperature, QWEN_TEMPERATURE);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0]?.role, 'system');
    assert.equal(body.messages[0]?.content, QWEN_SYSTEM_PROMPT);
    assert.equal(body.messages[1]?.role, 'user');
    assert.equal(body.messages[1]?.content, '你好，桌宠');
    // 请求体只有冻结的 6 个键：id 只在 meta 里，不进模型请求。
    assert.deepEqual(Object.keys(body).sort(), [
      'chat_template_kwargs',
      'max_tokens',
      'messages',
      'model',
      'stream',
      'temperature',
    ]);

    assert.equal(provider.lastMeta?.id, 'chat-a');
    assert.equal(provider.lastMeta?.model, QWEN_DEFAULT_MODEL);
    assert.equal(provider.lastMeta?.status, 200);
    assert.equal(provider.lastMeta?.finishReason, 'stop');
    assert.equal(provider.lastMeta?.truncated, false);
    assert.equal(provider.lastMeta?.error, undefined);
  });

  test('baseUrl 末尾斜杠被规整（不产生双斜杠），非默认端口原样保留', async () => {
    const { captured, fetchImpl } = stubFetch(() => jsonResponse(okPayload('ok')));
    const provider = createQwenChatProvider({
      baseUrl: 'http://localhost:9000/v1/',
      model: 'm',
      fetchImpl,
    });
    await provider.complete({ id: 'chat-slash', text: 'x', signal: noSignal() });
    assert.equal(captured[0]?.url, 'http://localhost:9000/v1/chat/completions');
    assert.equal(provider.lastMeta?.model, 'm');
  });
});

describe('createQwenChatProvider / HTTP 与响应失败', () => {
  test('HTTP 500 -> 抛错，meta 记录 status 与 error，不重试', async () => {
    const { captured, fetchImpl } = stubFetch(() => jsonResponse({ error: 'boom' }, 500));
    const provider = build(fetchImpl);
    await assert.rejects(
      provider.complete({ id: 'chat-500', text: '触发错误', signal: noSignal() }),
      /qwen http 500/,
    );
    assert.equal(captured.length, 1);
    assert.equal(provider.lastMeta?.status, 500);
    assert.equal(provider.lastMeta?.error, 'qwen http 500');
    assert.equal(provider.lastMeta?.id, 'chat-500');
  });

  test('HTTP 400 -> 抛错并记录 status', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ error: 'bad' }, 400));
    const provider = build(fetchImpl);
    await assert.rejects(provider.complete({ id: 'chat-400', text: 'x', signal: noSignal() }), /qwen http 400/);
    assert.equal(provider.lastMeta?.status, 400);
    assert.equal(provider.lastMeta?.error, 'qwen http 400');
  });

  test('畸形 JSON -> 抛错并留 meta.error', async () => {
    const { fetchImpl } = stubFetch(() => new Response('<html>oops</html>', { status: 200 }));
    const provider = build(fetchImpl);
    await assert.rejects(
      provider.complete({ id: 'chat-bad-json', text: 'x', signal: noSignal() }),
      /不是 JSON/,
    );
    assert.equal(provider.lastMeta?.status, 200);
    assert.match(provider.lastMeta?.error ?? '', /不是 JSON/);
  });

  test('缺 choices / choices 为空 -> 抛错', async () => {
    for (const payload of [{ id: 'r' }, { choices: [] }, { choices: 'nope' }]) {
      const { fetchImpl } = stubFetch(() => jsonResponse(payload));
      const provider = build(fetchImpl);
      await assert.rejects(
        provider.complete({ id: 'chat-no-choices', text: 'x', signal: noSignal() }),
        /缺少 choices/,
      );
      assert.match(provider.lastMeta?.error ?? '', /缺少 choices/);
    }
  });

  test('content 空串/空白/非字符串 -> 抛错（不当成空回复）', async () => {
    const payloads = [okPayload(''), okPayload('   '), { choices: [{ message: { content: 123 } }] }, { choices: [{}] }];
    for (const payload of payloads) {
      const { fetchImpl } = stubFetch(() => jsonResponse(payload));
      const provider = build(fetchImpl);
      await assert.rejects(
        provider.complete({ id: 'chat-empty', text: 'x', signal: noSignal() }),
        /(缺少正文 content|缺少 choices\[0\]\.message)/,
      );
      assert.ok(provider.lastMeta?.error);
      assert.equal(provider.lastMeta?.truncated, undefined);
    }
  });
});

describe('createQwenChatProvider / 截断与 usage', () => {
  test('finish_reason=length -> 文本仍返回且 truncated=true', async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({
        choices: [{ message: { content: '这是被截断的回复' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 96, total_tokens: 106 },
      }),
    );
    const provider = build(fetchImpl);
    const text = await provider.complete({ id: 'chat-len', text: 'x', signal: noSignal() });
    assert.equal(text, '这是被截断的回复');
    assert.equal(provider.lastMeta?.finishReason, 'length');
    assert.equal(provider.lastMeta?.truncated, true);
  });

  test('usage 存在 -> 记录三个 token 数且不标 usageUnknown', async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      }),
    );
    const provider = build(fetchImpl);
    await provider.complete({ id: 'chat-usage', text: 'x', signal: noSignal() });
    assert.deepEqual(provider.lastMeta?.usage, { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 });
    assert.equal(provider.lastMeta?.usageUnknown, undefined);
  });

  test('usage 缺失 -> usageUnknown=true（不编造数字）', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(okPayload('ok')));
    const provider = build(fetchImpl);
    await provider.complete({ id: 'chat-no-usage', text: 'x', signal: noSignal() });
    assert.equal(provider.lastMeta?.usage, undefined);
    assert.equal(provider.lastMeta?.usageUnknown, true);
  });

  test('reasoning / reasoning_content 绝不拼进正文', async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              reasoning_content: '用户问的是天气，我应该简短回答……',
              reasoning: '另一份思维链',
              content: '今天适合散步。',
            },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    const provider = build(fetchImpl);
    const text = await provider.complete({ id: 'chat-reasoning', text: '天气如何', signal: noSignal() });
    assert.equal(text, '今天适合散步。');
    assert.equal(text.includes('思维链'), false);
    assert.equal(text.includes('用户问的是'), false);
  });

  test('lastMeta 每次调用覆盖为最近一次', async () => {
    let attempt = 0;
    const { fetchImpl } = stubFetch(() => {
      attempt += 1;
      return attempt === 1 ? jsonResponse(okPayload('一')) : jsonResponse(okPayload('二'));
    });
    const provider = build(fetchImpl);
    await provider.complete({ id: 'chat-1', text: 'a', signal: noSignal() });
    await provider.complete({ id: 'chat-2', text: 'b', signal: noSignal() });
    assert.equal(provider.lastMeta?.id, 'chat-2');
  });
});

describe('createQwenChatProvider / 取消与地址白名单', () => {
  test('abort 贯穿网络：fetch 收到的 signal.aborted=true，调用抛 AbortError', async () => {
    const seen = { aborted: false };
    const fetchImpl: FetchStub = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal instanceof AbortSignal);
        signal.addEventListener('abort', () => {
          seen.aborted = signal.aborted;
          reject(abortError());
        });
      });
    const provider = build(fetchImpl);
    const controller = new AbortController();
    const inflight = provider.complete({ id: 'chat-abort', text: '等不到回复', signal: controller.signal });
    controller.abort();
    await assert.rejects(
      inflight,
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(seen.aborted, true);
    assert.match(provider.lastMeta?.error ?? '', /abort/i);
    assert.equal(provider.lastMeta?.id, 'chat-abort');
  });

  test('非 loopback baseUrl 直接拒绝', () => {
    for (const baseUrl of [
      'http://example.com:8080/v1',
      'https://example.com/v1',
      'http://127.0.0.1.evil.com/v1',
      'file:///tmp/v1',
      'ftp://127.0.0.1/v1',
      'not-a-url',
    ]) {
      assert.throws(() => createQwenChatProvider({ baseUrl, model: 'm' }), /baseUrl/);
    }
  });

  test('http(s)://localhost 与 127.0.0.1（端口可省）都允许', () => {
    for (const baseUrl of [
      'http://127.0.0.1:18872/v1',
      'http://localhost:18872/v1',
      'http://127.0.0.1/v1',
      'https://localhost:8443/v1',
      'https://127.0.0.1:8443',
    ]) {
      assert.equal(assertQwenBaseUrl(baseUrl), baseUrl);
    }
  });

  test('注入 now()：latencyMs = 文本就绪 - 请求发出', async () => {
    let clock = 5_000;
    const fetchImpl: FetchStub = () => {
      clock += 175; // 服务处理耗时，由测试时钟显式推进
      return Promise.resolve(jsonResponse(okPayload('ok')));
    };
    const provider = build(fetchImpl, { now: () => clock });
    await provider.complete({ id: 'chat-latency', text: 'x', signal: noSignal() });
    assert.equal(provider.lastMeta?.latencyMs, 175);
  });

  test('失败路径同样记录 latencyMs 与 error', async () => {
    let clock = 1_000;
    const fetchImpl: FetchStub = () => {
      clock += 40;
      return Promise.resolve(jsonResponse({ error: 'boom' }, 502));
    };
    const provider = build(fetchImpl, { now: () => clock });
    await assert.rejects(provider.complete({ id: 'chat-lat-fail', text: 'x', signal: noSignal() }), /502/);
    assert.equal(provider.lastMeta?.latencyMs, 40);
    assert.equal(provider.lastMeta?.status, 502);
    assert.equal(provider.lastMeta?.error, 'qwen http 502');
  });
});
