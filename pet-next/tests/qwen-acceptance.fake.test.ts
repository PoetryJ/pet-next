/**
 * M3-1 Qwen 链路故障验收（零真实调用）：真实本地 HTTP 假服务 + 真实 Provider + 真实会话状态机。
 *
 * 与 adapters/chat/qwen-provider.test.ts 的分工：那里注入 fetch 桩锁逐字请求体；
 * 这里走真实网络栈（node:http 本地假服务），因此能观察"取消/超时是否真的把连接撤掉"，
 * 并覆盖 Provider 与会话状态机的接缝：
 *   F1 成功：请求体符合冻结契约（model/stream/max_tokens/temperature/enable_thinking/system）
 *            + 正文/ finish_reason / usage / latencyMs 进 meta
 *   F2 HTTP 500：会话映射 provider-error，meta 保留 status 与 error
 *   F3 超时：会话短超时（注入 timeoutMs，不改冻结常量）→ timeout，且假服务观察到客户端断开
 *   F4 取消后重发：cancel 立即释放槽位，旧请求的迟到响应不得覆盖新请求
 *   F5 关窗收尾：在途请求被撤销后，迟到的服务端响应不产生任何状态（无泄漏、无残留 pending）
 *   F6 畸形 JSON / F7 空 content / F8 finish_reason=length / F9 连接重置
 *   F10 服务不返回 usage → usageUnknown（不编造 token 数）
 *   F11 非回环 baseUrl 拒绝（演示安全，防止真实外网调用）
 *
 * 全部指向 127.0.0.1 的本地假服务；不读取真实服务地址、不消耗真实调用预算。
 * 运行：node --experimental-strip-types --test --test-reporter spec tests/qwen-acceptance.fake.test.ts
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import {
  QWEN_DEFAULT_MODEL,
  QWEN_MAX_TOKENS,
  QWEN_SYSTEM_PROMPT,
  QWEN_TEMPERATURE,
} from '../contracts/chat.ts';
import { assertQwenBaseUrl, createQwenChatProvider } from '../adapters/chat/qwen-provider.ts';
import { createChatSession } from '../core/chat/session.ts';
import {
  startQwenFakeServer,
  type QwenFakeBehavior,
  type QwenFakeServer,
} from './support/qwen-fake-server.ts';

/** 测试期启动的假服务，统一在文件末尾收掉（每个用例自己 stop 也可以）。 */
const servers: QwenFakeServer[] = [];

after(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) await server.stop().catch(() => undefined);
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Harness {
  readonly fake: QwenFakeServer;
  readonly session: ReturnType<typeof createChatSession>;
  readonly provider: ReturnType<typeof createQwenChatProvider>;
  stop(): Promise<void>;
}

/** 组装：本地假服务 → Qwen Provider（baseUrl 指向假服务）→ 会话状态机（可注入短超时）。 */
async function harness(options?: {
  behavior?: QwenFakeBehavior;
  delayMs?: number;
  status?: number;
  /** 会话总超时；默认用冻结常量（不传）。 */
  timeoutMs?: number;
}): Promise<Harness> {
  const fake = await startQwenFakeServer({
    behavior: options?.behavior ?? 'ok',
    delayMs: options?.delayMs ?? 0,
    status: options?.status ?? 500,
  });
  servers.push(fake);
  const provider = createQwenChatProvider({ baseUrl: fake.baseUrl, model: QWEN_DEFAULT_MODEL });
  const session = createChatSession({
    complete: provider.complete,
    ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return {
    fake,
    session,
    provider,
    async stop() {
      await fake.stop();
      servers.splice(servers.indexOf(fake), 1);
    },
  };
}

/** 等第一条请求到达假服务（不发任何真实请求，只等内存记录）。 */
async function waitForRequest(fake: QwenFakeServer, label: string): Promise<void> {
  await fake.waitFor((state) => state.requests.length > 0, 5000, label);
}

test('F1 成功：请求体符合冻结契约，正文/finish_reason/usage/latencyMs 进 meta', { timeout: 20000 }, async () => {
  const h = await harness({ behavior: 'ok' });
  try {
    const prompt = '你好呀';
    const result = await h.session.send({ id: 'chat-f001', text: prompt });
    assert.equal(result.status, 'ok', `应成功：${JSON.stringify(result)}`);
    assert.equal(result.text, '我在呢，今天累不累？想聊什么都可以。');

    const state = h.fake.state();
    assert.equal(state.requests.length, 1, '应只有一条请求');
    const record = state.requests[0]!;
    // 冻结契约逐项核对（真实服务会按这些字段解释请求）。
    assert.equal(record.path, '/v1/chat/completions', `路径应为 /v1/chat/completions，实际 ${record.path}`);
    assert.equal(record.method, 'POST');
    assert.equal(record.model, QWEN_DEFAULT_MODEL);
    assert.equal(record.stream, false, 'stream 必须为 false');
    assert.equal(record.maxTokens, QWEN_MAX_TOKENS, `max_tokens 应为 ${QWEN_MAX_TOKENS}`);
    assert.equal(record.temperature, QWEN_TEMPERATURE, `temperature 应为 ${QWEN_TEMPERATURE}`);
    assert.equal(record.enableThinking, false, 'chat_template_kwargs.enable_thinking 必须为 false');
    assert.equal(record.systemPrompt, QWEN_SYSTEM_PROMPT, 'system prompt 必须与冻结文本一致');
    assert.equal(record.userPrompt, prompt, 'user 消息原文透传');
    assert.deepEqual([...record.messageRoles], ['system', 'user'], '只允许 system+user 两条');

    const meta = h.provider.lastMeta;
    assert.ok(meta !== null, 'lastMeta 应记录');
    assert.equal(meta?.status, 200);
    assert.equal(meta?.model, QWEN_DEFAULT_MODEL);
    assert.equal(meta?.finishReason, 'stop');
    assert.equal(meta?.truncated, false);
    assert.deepEqual(meta?.usage, { prompt_tokens: 42, completion_tokens: 18, total_tokens: 60 });
    assert.equal(meta?.usageUnknown, undefined, '服务给了 usage 就不该标 unknown');
    assert.equal(typeof meta?.latencyMs, 'number', '应测到完整回复延迟');
    assert.ok((meta?.latencyMs ?? -1) >= 0);
  } finally {
    await h.stop();
  }
});

test('F2 HTTP 500：会话映射 provider-error，meta 保留状态与错误', { timeout: 20000 }, async () => {
  const h = await harness({ behavior: 'http-error', status: 500 });
  try {
    const result = await h.session.send({ id: 'chat-f002', text: '这句会失败' });
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.equal(result.code, 'provider-error');
    assert.equal(result.text, undefined, '失败不得带文本');
    const meta = h.provider.lastMeta;
    assert.equal(meta?.status, 500);
    // 固定契约：provider 在 !response.ok 时直接 throw、不读响应体，
    // 所以错误文案恒为 `qwen http 500`——不会因为服务端 500 页是非 JSON 而变成"响应不是 JSON"。
    assert.equal(meta?.error, 'qwen http 500');
    assert.equal(h.session.hasPending(), false, '失败后不得残留 pending');
  } finally {
    await h.stop();
  }
});

test('F3 超时：会话短超时 → timeout，且假服务观察到客户端断开', { timeout: 20000 }, async () => {
  const h = await harness({ behavior: 'slow', delayMs: 1500, timeoutMs: 300 });
  try {
    const startedAt = Date.now();
    const result = await h.session.send({ id: 'chat-f003', text: '慢到超时的一句' });
    const elapsed = Date.now() - startedAt;
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.equal(result.code, 'timeout');
    assert.ok(elapsed < 1400, `应在注入的超时附近返回，实际 ${elapsed}ms`);
    // 超时必须真的撤销网络请求：假服务应记录客户端断开。
    const state = await h.fake.waitFor((snapshot) => snapshot.requests.some((row) => row.clientClosed), 5000, '超时后假服务未观察到客户端断开');
    assert.equal(state.requests[0]?.clientClosed, true);
    assert.equal(h.session.hasPending(), false);
  } finally {
    await h.stop();
  }
});

test('F4 取消后立即重发：槽位立刻释放，旧请求的迟到响应不覆盖新请求', { timeout: 20000 }, async () => {
  const h = await harness({ behavior: 'slow', delayMs: 600 });
  try {
    const first = h.session.send({ id: 'chat-f004-a', text: '慢的第一句' });
    await waitForRequest(h.fake, '取消用例：慢请求未到达假服务');
    h.session.cancel('chat-f004-a');
    const firstResult = await first;
    assert.equal(firstResult.status, 'cancelled', JSON.stringify(firstResult));

    // 立刻重发（同一时刻第二个请求必须被接受，不是 busy）。
    const second = await h.session.send({ id: 'chat-f004-b', text: '第二句立刻回' });
    assert.equal(second.status, 'ok', JSON.stringify(second));
    assert.equal(second.text, '我在呢，今天累不累？想聊什么都可以。');

    // 等旧请求的迟到响应真的产出，再断言它没有改变任何状态。
    await h.fake.waitFor(
      (state) => state.requests.some((row) => row.userPrompt === '慢的第一句' && row.respondedAt !== null),
      5000,
      '旧慢请求的迟到响应未产出',
    );
    await delay(100);
    assert.equal(firstResult.status, 'cancelled', '旧请求不得因迟到响应改判');
    assert.equal(h.session.hasPending(), false, '两次请求后不得残留 pending');

    const state = h.fake.state();
    const oldRecord = state.requests.find((row) => row.userPrompt === '慢的第一句');
    assert.ok(oldRecord !== undefined, '假服务应记录到被取消的旧请求');
    assert.equal(oldRecord?.clientClosed, true, '取消必须撤销连接（客户端断开）');
    assert.ok(
      (oldRecord?.closedAt ?? 0) <= (oldRecord?.respondedAt ?? Number.MAX_SAFE_INTEGER),
      '断开应发生在服务端产出响应之前',
    );
  } finally {
    await h.stop();
  }
});

/**
 * 时序前提（别改成"fake 秒回 200 再 abort"）：假服务延迟 700ms，撤销发生在 ~150ms，
 * 此时 fetch 尚未 resolve，provider 还没来得及赋值 meta.status，所以 status 必然是 undefined。
 * 若哪天让 fake 先回 200 再 abort，合法结果会变成 status=200 且 error 有值，断言需同步改。
 */
test('F5 关窗收尾：在途撤销后迟到的服务端响应不产生任何状态（无泄漏）', { timeout: 20000 }, async () => {
  const h = await harness({ behavior: 'slow', delayMs: 700 });
  try {
    const inFlight = h.session.send({ id: 'chat-f005-a', text: '关窗前在途的一句' });
    await waitForRequest(h.fake, '关窗用例：在途请求未到达假服务');
    // 关窗语义：撤销在途请求（主进程在窗口销毁时取消）。
    h.session.cancel('chat-f005-a');
    const result = await inFlight;
    assert.equal(result.status, 'cancelled', JSON.stringify(result));
    assert.equal(result.text, undefined, '取消不得带文本');

    // 等迟到的服务端响应产出：会话不得有任何后续动作（无 pending、无新状态）。
    await h.fake.waitFor(
      (state) => state.requests.every((row) => row.respondedAt !== null),
      6000,
      '迟到的服务端响应未产出',
    );
    await delay(150);
    assert.equal(h.session.hasPending(), false, '关窗收尾后不得残留 pending');
    // 撤销发生在响应到达前：meta 应留下中止痕迹（无 200 状态），而不是伪造成成功。
    const meta = h.provider.lastMeta;
    assert.equal(meta?.status, undefined, `中止时不应记到 HTTP 状态，实际 ${String(meta?.status)}`);
    assert.ok(meta?.error !== undefined, 'meta 应记录中止原因');
    assert.equal(meta?.finishReason, undefined, '中止不得带 finish_reason');

    // 关窗后重新打开再发一条必须正常（状态机未被污染的实测）。
    h.fake.config({ behavior: 'ok', delayMs: 0 });
    const afterReopen = await h.session.send({ id: 'chat-f005-b', text: '重开后再发一句' });
    assert.equal(afterReopen.status, 'ok', JSON.stringify(afterReopen));
  } finally {
    await h.stop();
  }
});

test('F6 畸形 JSON：会话映射 provider-error（不猜测正文）', { timeout: 20000 }, async () => {
  const h = await harness({ behavior: 'bad-json' });
  try {
    const result = await h.session.send({ id: 'chat-f006', text: '畸形响应' });
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.equal(result.code, 'provider-error');
    assert.equal(result.text, undefined);
    assert.equal(h.provider.lastMeta?.status, 200, 'HTTP 是 200，解析失败记在 error');
    assert.match(String(h.provider.lastMeta?.error), /JSON/i);
  } finally {
    await h.stop();
  }
});

test('F7 空 content：按失败处理，不返回空回复', { timeout: 20000 }, async () => {
  const h = await harness({ behavior: 'empty-content' });
  try {
    const result = await h.session.send({ id: 'chat-f007', text: '空回复' });
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.equal(result.code, 'provider-error');
    assert.equal(result.text, undefined, '空正文不得当成功回复显示');
  } finally {
    await h.stop();
  }
});

test('F8 finish_reason=length：文本照常返回但 meta.truncated=true（不冒充完整回复）', { timeout: 20000 }, async () => {
  const h = await harness({ behavior: 'truncated' });
  try {
    const result = await h.session.send({ id: 'chat-f008', text: '给我一段超长的话' });
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.ok((result.text ?? '').length > 0);
    const meta = h.provider.lastMeta;
    assert.equal(meta?.finishReason, 'length');
    assert.equal(meta?.truncated, true, 'finish_reason=length 必须标记截断');
  } finally {
    await h.stop();
  }
});

test('F9 连接被重置：会话映射 provider-error（不重试、不假装成功）', { timeout: 20000 }, async () => {
  const h = await harness({ behavior: 'reset' });
  try {
    const result = await h.session.send({ id: 'chat-f009', text: '连接会断' });
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.equal(result.code, 'provider-error');
    assert.equal(h.fake.state().requests.length, 1, '不得自动重试（只允许一次请求）');
  } finally {
    await h.stop();
  }
});

test('F10 服务不返回 usage：记 usageUnknown，不编造 token 数', { timeout: 20000 }, async () => {
  const h = await harness({ behavior: 'no-usage' });
  try {
    const result = await h.session.send({ id: 'chat-f010', text: '没有 usage 的响应' });
    assert.equal(result.status, 'ok', JSON.stringify(result));
    const meta = h.provider.lastMeta;
    assert.equal(meta?.usage, undefined, '服务没给 usage 就不能有 usage 对象');
    assert.equal(meta?.usageUnknown, true, '缺失必须显式标 unknown');
    assert.equal(meta?.finishReason, 'stop');
  } finally {
    await h.stop();
  }
});

test('F11 非回环 baseUrl 一律拒绝（真实外网地址不被接受）', () => {
  for (const bad of ['https://api.example.com/v1', 'http://10.0.0.5:8080/v1', 'http://192.168.1.2/v1']) {
    assert.throws(() => assertQwenBaseUrl(bad), /仅允许/, `应拒绝 ${bad}`);
  }
  assert.equal(assertQwenBaseUrl('http://127.0.0.1:18872/v1/'), 'http://127.0.0.1:18872/v1', '末尾斜杠应规整');
  assert.equal(assertQwenBaseUrl('http://localhost:18872/v1'), 'http://localhost:18872/v1');
});
