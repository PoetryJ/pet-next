/**
 * M3-3 独立回归：当前会话上下文预览。
 * 组装真实 createChatSession + createChatHistory + createQwenChatProvider（fetch 打桩），
 * 对照“单轮臂（默认关闭）”与“上下文臂（PET_NEXT_CHAT_CONTEXT 语义）”的实际 HTTP 请求体：
 * 断言消息构成/顺序、每次发送仍恰好 1 个请求、采样参数不变、请求体字节增长可记录，
 * 以及 延续/纠正/清空/在途重发/迟到隔离/失败与取消不入史/上界淘汰/重启即空。
 * 注意：fake 桩只能证明工程语义（请求确实携带前文），不能宣称模型记忆质量提升。
 * @module pet-next/tests/chat-context.test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQwenChatProvider } from '../adapters/chat/qwen-provider.ts';
import { createChatHistory } from '../core/chat/history.ts';
import { createChatSession } from '../core/chat/session.ts';
import type { ChatSession } from '../core/chat/types.ts';
import {
  QWEN_MAX_TOKENS,
  QWEN_SYSTEM_PROMPT,
  QWEN_TEMPERATURE,
} from '../contracts/chat.ts';

interface CapturedRequest {
  body: string;
  bytes: number;
}

/** 与全局 fetch 同签名，保证注入点类型一致。 */
type FetchLike = typeof fetch;

/** 脚本回复的 fetch 打桩：记录请求体并按脚本回复固定文本（fake，不触碰网络）。 */
function stubFetch(script: string[]): { captured: CapturedRequest[]; fetchImpl: FetchLike } {
  const captured: CapturedRequest[] = [];
  let index = 0;
  const fetchImpl: FetchLike = (input, init) => {
    const body = String(init?.body ?? '');
    captured.push({ body, bytes: Buffer.byteLength(body, 'utf8') });
    const text = script[Math.min(index, script.length - 1)] ?? '好';
    index += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { captured, fetchImpl };
}

/**
 * 受控 fetch：每个请求都挂起，测试按请求序号 release 才完成（模拟在途/迟到）。
 * M3-4 修复：resolver 按请求索引保留——旧单槽位实现里后发请求会覆盖前者的 resolver，
 * 释放“旧响应”实际是 no-op（旧请求从未收到 HTTP 响应，迟到路径根本没被触发）。
 * 修复后 release(1, ...) 能让第 1 个请求真正完成，测试可断言“迟到成功确实发生”。
 */
function heldFetch(): {
  captured: CapturedRequest[];
  fetchImpl: FetchLike;
  /** 每个请求的 fetch promise 镜像：fulfill 即证明该请求的 HTTP 确实完成。 */
  settled: Array<Promise<Response>>;
  /** 已完成的记录（index + value），供断言迟到释放真的生效。 */
  completed: Array<{ index: number; value: string }>;
  release(index: number, value: string): void;
} {
  const captured: CapturedRequest[] = [];
  const settled: Array<Promise<Response>> = [];
  const completed: Array<{ index: number; value: string }> = [];
  const resolvers: Array<((response: Response) => void) | null> = [];
  const fetchImpl: FetchLike = (_input, init) => {
    const body = String(init?.body ?? '');
    captured.push({ body, bytes: Buffer.byteLength(body, 'utf8') });
    let settle!: (response: Response) => void;
    const promise = new Promise<Response>((resolve) => {
      settle = resolve;
    });
    resolvers.push(settle);
    settled.push(promise);
    return promise;
  };
  return {
    captured,
    fetchImpl,
    settled,
    completed,
    release(index: number, value: string) {
      const settle = resolvers[index] ?? null;
      if (settle === null) {
        throw new Error(`heldFetch.release(${index})：无第 ${index} 个请求或已释放过`);
      }
      resolvers[index] = null;
      completed.push({ index, value });
      settle(
        new Response(JSON.stringify({ choices: [{ message: { content: value } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  };
}

function buildSession(fetchImpl: FetchLike, withHistory: boolean): ChatSession {
  const provider = createQwenChatProvider({ baseUrl: 'http://127.0.0.1:18872/v1', model: 'qwen3.8-27b', fetchImpl });
  return createChatSession({
    complete: (input) => provider.complete(input),
    ...(withHistory ? { history: createChatHistory() } : {}),
  });
}

function messagesOf(request: CapturedRequest): Array<{ role: string; content: string }> {
  return (JSON.parse(request.body) as { messages: Array<{ role: string; content: string }> }).messages;
}

test('对照记录：单轮臂 vs 上下文臂的三轮请求（HTTP 次数/消息数/UTF-8 字节）', async () => {
  const turns = ['我叫小林', '我喜欢蓝色', '我叫什么'];
  const replies = ['你好，小林！', '蓝色很好看。', '你叫小林。'];

  const single = stubFetch(replies);
  const singleSession = buildSession(single.fetchImpl, false);
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i] ?? assert.fail('missing turn');
    const reply = replies[i] ?? assert.fail('missing reply');
    assert.deepEqual(await singleSession.send({ id: `chat-s-${i}`, text: turn }), {
      id: `chat-s-${i}`,
      status: 'ok',
      text: reply,
    });
  }

  const context = stubFetch(replies);
  const contextSession = buildSession(context.fetchImpl, true);
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i] ?? assert.fail('missing turn');
    const reply = replies[i] ?? assert.fail('missing reply');
    assert.deepEqual(await contextSession.send({ id: `chat-c-${i}`, text: turn }), {
      id: `chat-c-${i}`,
      status: 'ok',
      text: reply,
    });
  }

  assert.equal(single.captured.length, 3, '单轮臂：每发送恰好 1 个 HTTP 请求');
  assert.equal(context.captured.length, 3, '上下文臂：每发送仍恰好 1 个 HTTP 请求（不重试/不拆分）');

  const singleMessageCounts = single.captured.map((r) => messagesOf(r).length);
  const contextMessageCounts = context.captured.map((r) => messagesOf(r).length);
  assert.deepEqual(singleMessageCounts, [2, 2, 2], '单轮臂恒为 system+当前user');
  assert.deepEqual(contextMessageCounts, [2, 4, 6], '上下文臂随轮次线性携带历史对');

  // 记录表（报告引用）：轮次 | 两臂字节数与消息数
  console.log(
    '[chat-context 对照] ' +
      turns
        .map(
          (t, i) =>
            `第${i + 1}问「${t}」: 单轮=${single.captured[i]?.bytes}B/${singleMessageCounts[i]}msg 上下文=${context.captured[i]?.bytes}B/${contextMessageCounts[i]}msg`,
        )
        .join(' | '),
  );
  for (let i = 1; i < 3; i += 1) {
    assert.ok((context.captured[i]?.bytes ?? 0) > (context.captured[i - 1]?.bytes ?? 0), '上下文臂请求体必须逐轮增长');
  }
  assert.equal(single.captured[0]?.body, context.captured[0]?.body, '第一问两臂逐字节一致（默认关闭=开启的首问）');

  // 第三问必须真的携带第一轮内容（名字延续）与第二轮内容（偏好），且顺序正确
  const third = messagesOf(context.captured[2] ?? assert.fail('missing'));
  assert.equal(third[0]?.role, 'system');
  assert.equal(third[0]?.content, QWEN_SYSTEM_PROMPT);
  assert.deepEqual(third.slice(1), [
    { role: 'user', content: '我叫小林' },
    { role: 'assistant', content: '你好，小林！' },
    { role: 'user', content: '我喜欢蓝色' },
    { role: 'assistant', content: '蓝色很好看。' },
    { role: 'user', content: '我叫什么' },
  ]);
  assert.equal(third.at(-1)?.role, 'user', '当前输入永远在最后');
});

test('采样参数与模型名不随历史改变', async () => {
  const { captured, fetchImpl } = stubFetch(['好']);
  const session = buildSession(fetchImpl, true);
  await session.send({ id: 'chat-a', text: '第一句' });
  await session.send({ id: 'chat-b', text: '第二句' });
  for (const request of captured) {
    const body = JSON.parse(request.body) as Record<string, unknown>;
    assert.equal(body.model, 'qwen3.8-27b');
    assert.equal(body.max_tokens, QWEN_MAX_TOKENS);
    assert.equal(body.temperature, QWEN_TEMPERATURE);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.stream, false);
  }
});

test('清空（reset）：下一问回到单轮形态、字节回落到首问基线', async () => {
  const arm = stubFetch(['好']);
  const session = buildSession(arm.fetchImpl, true);
  await session.send({ id: 'chat-a', text: '我叫小林' });
  await session.send({ id: 'chat-b', text: '我喜欢蓝色' });
  const beforeResetBytes = arm.captured[1]?.bytes ?? 0;
  session.reset();
  // 用与首问相同的文本发送，才能做“逐字节回到基线”的强断言。
  await session.send({ id: 'chat-c', text: '我叫小林' });
  const after = messagesOf(arm.captured[2] ?? assert.fail('missing'));
  assert.deepEqual(after, [
    { role: 'system', content: QWEN_SYSTEM_PROMPT },
    { role: 'user', content: '我叫小林' },
  ], '清空后第一问不得携带任何旧轮次');
  assert.equal(arm.captured[2]?.body, arm.captured[0]?.body, '清空后请求体回到首问基线（逐字节）');
  assert.ok((arm.captured[2]?.bytes ?? 0) < beforeResetBytes, '请求体字节必须回落');
});

test('在途清空后重发：新请求不带任何旧文本，旧请求迟到成功也不入史', async () => {
  const held = heldFetch();
  const heldProvider = createQwenChatProvider({
    baseUrl: 'http://127.0.0.1:18872/v1',
    model: 'qwen3.8-27b',
    fetchImpl: held.fetchImpl,
  });
  const session = createChatSession({
    complete: (input) => heldProvider.complete(input),
    history: createChatHistory(),
  });
  const first = session.send({ id: 'chat-a', text: '已完成的第一句' });
  held.release(0, '第一答');
  assert.deepEqual(await first, { id: 'chat-a', status: 'ok', text: '第一答' });

  const pending = session.send({ id: 'chat-b', text: '在途这句' });
  session.reset(); // 在途取消 + 清空历史
  assert.deepEqual(await pending, { id: 'chat-b', status: 'cancelled' });
  const next = session.send({ id: 'chat-c', text: '重发这句' });
  const nextMessages = messagesOf(held.captured.at(-1) ?? assert.fail('missing'));
  assert.ok(
    nextMessages.every((m) => m.content !== '在途这句' && m.content !== '已完成的第一句' && m.content !== '第一答'),
    '清空后的请求不得携带任何旧文本（含已交付回复）',
  );
  held.release(2, '新答');
  assert.deepEqual(await next, { id: 'chat-c', status: 'ok', text: '新答' });
  // 旧 chat-b（请求 1）此刻迟到成功：HTTP 必须真的完成（修复前单槽位释放是 no-op）
  held.release(1, '迟到的旧回复');
  assert.deepEqual(held.completed.at(-1), { index: 1, value: '迟到的旧回复' }, '迟到释放必须命中第 1 个请求');
  assert.equal((await held.settled[1] ?? assert.fail('missing settled[1]')).status, 200, '旧请求的 HTTP 必须确实完成');
  await new Promise((resolve) => setImmediate(resolve));
  const probe = session.send({ id: 'chat-d', text: '再看一眼' });
  const probeContents = messagesOf(held.captured.at(-1) ?? assert.fail('missing')).map((m) => m.content);
  assert.ok(!probeContents.includes('迟到的旧回复') && !probeContents.includes('在途这句'), '迟到/在途旧轮不得进入历史');
  held.release(3, '最后一答');
  await probe;
});

test('失败与取消的轮次不入史：下一问只见到成功轮', async () => {
  const arm = stubFetch(['好的']);
  let failNext = false;
  const wrappedFetch: FetchLike = (url, init) => {
    if (failNext) {
      failNext = false;
      return Promise.resolve(new Response(JSON.stringify({}), { status: 500, headers: { 'content-type': 'application/json' } }));
    }
    return arm.fetchImpl(url, init);
  };
  const session = buildSession(wrappedFetch, true);
  await session.send({ id: 'chat-a', text: '成功的一句' });
  failNext = true;
  const failed = await session.send({ id: 'chat-b', text: '会失败的一句' });
  assert.equal(failed.status, 'error');
  const cancelled = session.send({ id: 'chat-c', text: '会取消的一句' });
  session.cancel('chat-c');
  assert.deepEqual(await cancelled, { id: 'chat-c', status: 'cancelled' });
  await session.send({ id: 'chat-d', text: '下一问' });
  const contents = messagesOf(arm.captured.at(-1) ?? assert.fail('missing')).map((m) => m.content);
  assert.ok(contents.includes('成功的一句'), '成功轮保留');
  assert.ok(!contents.includes('会失败的一句'), '失败轮不入史');
  assert.ok(!contents.includes('会取消的一句'), '取消轮不入史');
});

test('历史上界：第 6 问最多携带最近 4 轮，最老轮被整轮淘汰', async () => {
  const arm = stubFetch(['答']);
  const session = buildSession(arm.fetchImpl, true);
  for (let i = 1; i <= 5; i += 1) await session.send({ id: `chat-${i}`, text: `第${i}句` });
  await session.send({ id: 'chat-6', text: '第6句' });
  const contents = messagesOf(arm.captured.at(-1) ?? assert.fail('missing')).map((m) => m.content);
  assert.ok(!contents.includes('第1句'), '最老轮必须被淘汰');
  for (const keep of ['第2句', '第3句', '第4句', '第5句']) assert.ok(contents.includes(keep), `${keep} 应保留`);
  const historyUsers = contents.filter((c) => c.startsWith('第') && c.endsWith('句') && c !== '第6句');
  assert.equal(historyUsers.length, 4, '最多 4 个历史 user');
});

test('“重启即空”：新会话（新历史实例）第一问与单轮臂逐字节一致（内存态、不落盘）', async () => {
  const first = stubFetch(['答']);
  const sessionA = buildSession(first.fetchImpl, true);
  await sessionA.send({ id: 'chat-a', text: '上一世我叫小林' });
  // 模拟重启：旧实例全部丢弃，重建 session+history（无任何持久化参与）
  const reboot = stubFetch(['答']);
  const sessionB = buildSession(reboot.fetchImpl, true);
  await sessionB.send({ id: 'chat-b', text: '上一世我叫小林' });
  assert.equal(reboot.captured[0]?.body, first.captured[0]?.body, '重启后首问不得携带任何旧会话内容');
});
