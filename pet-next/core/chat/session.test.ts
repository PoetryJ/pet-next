/**
 * 会话状态机单测：全部用受控 Promise 与受控时钟，唯一例外是 timeout 真实 timer
 * 用例（语义本身需要真实计时，timeoutMs 压到 20ms 且必然清理）。
 * @module pet-next/core/chat/session.test
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createChatHistory } from './history.ts';
import type { ChatHistoryEntry } from './history.ts';
import { createChatSession } from './session.ts';
import type { ChatCompleter, ChatSessionDeps, ChatSendResult } from './types.ts';

interface HeldCall {
  id: string;
  text: string;
  signal: AbortSignal;
  resolve(text: string): void;
  reject(error?: unknown): void;
}

/** 手动 provider：每次 complete 产生一个可手工 resolve/reject 的在途调用。 */
function createHeldCompleter(): { calls: HeldCall[]; deps: Pick<ChatSessionDeps, 'complete'> } {
  const calls: HeldCall[] = [];
  const complete: ChatCompleter['complete'] = (input) =>
    new Promise<string>((resolve, reject) => {
      calls.push({ ...input, resolve, reject });
    });
  return { calls, deps: { complete } };
}

/** 手动时钟：advance 只改读数，不等待真实时间。 */
function createManualClock(start = 0): { now(): number; advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

function okRequest(id = 'chat-a', text = '你好'): { id: string; text: string } {
  return { id, text };
}

describe('core/chat/session', () => {
  test('正常回复：ok、id 回显、文本原样，hasPending 归位', async () => {
    const { calls, deps } = createHeldCompleter();
    const session = createChatSession(deps);
    const sent = session.send(okRequest());
    assert.equal(session.hasPending(), true);
    calls[0]?.resolve('在呢');
    const result = await sent;
    assert.deepEqual(result, { id: 'chat-a', status: 'ok', text: '在呢' });
    assert.equal(session.hasPending(), false);
    assert.equal(calls.length, 1);
  });

  test('空输入：error/empty，不触达 provider', async () => {
    const { calls, deps } = createHeldCompleter();
    const session = createChatSession(deps);
    const result = await session.send(okRequest('chat-a', ''));
    assert.deepEqual(result, { id: 'chat-a', status: 'error', code: 'empty' });
    assert.equal(calls.length, 0);
    assert.equal(session.hasPending(), false);
  });

  test('超长输入：error/too-long，不触达 provider', async () => {
    const { calls, deps } = createHeldCompleter();
    const session = createChatSession(deps);
    const long = 'x'.repeat(501);
    const result = await session.send(okRequest('chat-a', long));
    assert.deepEqual(result, { id: 'chat-a', status: 'error', code: 'too-long' });
    assert.equal(calls.length, 0);
  });

  test('注入 maxInputChars 时按注入值判定超长，恰好等于上限不判长', async () => {
    const { calls, deps } = createHeldCompleter();
    const session = createChatSession({ ...deps, maxInputChars: 4 });
    assert.deepEqual(await session.send(okRequest('chat-a', 'abcde')), { id: 'chat-a', status: 'error', code: 'too-long' });
    const sent = session.send(okRequest('chat-b', 'abcd'));
    calls[0]?.resolve('好');
    assert.deepEqual(await sent, { id: 'chat-b', status: 'ok', text: '好' });
  });

  test('id 不匹配 CHAT_ID_PATTERN 或 text 非字符串：error/bad-request', async () => {
    const { calls, deps } = createHeldCompleter();
    const session = createChatSession(deps);
    assert.deepEqual(await session.send(okRequest('A-bad', 'x')), { id: 'A-bad', status: 'error', code: 'bad-request' });
    assert.deepEqual(await session.send(okRequest('chat-', 'x')), { id: 'chat-', status: 'error', code: 'bad-request' });
    assert.deepEqual(await session.send({ id: 'chat-a', text: 42 as unknown as string }), {
      id: 'chat-a',
      status: 'error',
      code: 'bad-request',
    });
    assert.equal(calls.length, 0);
  });

  test('重复提交：第二个 send 立即 error/busy，complete 只被调用一次', async () => {
    const { calls, deps } = createHeldCompleter();
    const session = createChatSession(deps);
    const first = session.send(okRequest('chat-a', '一'));
    const busy = await session.send(okRequest('chat-b', '二'));
    assert.deepEqual(busy, { id: 'chat-b', status: 'error', code: 'busy' });
    assert.equal(session.hasPending(), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.id, 'chat-a');
    calls[0]?.resolve('答一');
    assert.deepEqual(await first, { id: 'chat-a', status: 'ok', text: '答一' });
    assert.equal(session.hasPending(), false);
    // 首个请求结束后可再次发送。
    const retry = session.send(okRequest('chat-c', '三'));
    assert.equal(calls.length, 2);
    calls[1]?.resolve('答三');
    assert.deepEqual(await retry, { id: 'chat-c', status: 'ok', text: '答三' });
  });

  test('在途时非法输入按校验优先返回 empty（校验先于 busy 判断）', async () => {
    const { calls, deps } = createHeldCompleter();
    const session = createChatSession(deps);
    const first = session.send(okRequest('chat-a', '一'));
    const second = await session.send(okRequest('chat-b', ''));
    assert.deepEqual(second, { id: 'chat-b', status: 'error', code: 'empty' });
    assert.equal(calls.length, 1);
    calls[0]?.resolve('答一');
    await first;
  });

  test('cancel 命中在途：立即返回 cancelled，signal 已 abort，可马上发新请求', async () => {
    const { calls, deps } = createHeldCompleter();
    const session = createChatSession(deps);
    const first = session.send(okRequest('chat-a', '一'));
    session.cancel('chat-a');
    assert.deepEqual(await first, { id: 'chat-a', status: 'cancelled' });
    assert.equal(calls[0]?.signal.aborted, true);
    assert.equal(session.hasPending(), false);
    const second = session.send(okRequest('chat-b', '二'));
    assert.equal(session.hasPending(), true);
    calls[1]?.resolve('答二');
    assert.deepEqual(await second, { id: 'chat-b', status: 'ok', text: '答二' });
  });

  test('cancel 未命中 id 或无在途：无任何效果', async () => {
    const { calls, deps } = createHeldCompleter();
    const session = createChatSession(deps);
    session.cancel('chat-none');
    assert.equal(session.hasPending(), false);
    const first = session.send(okRequest('chat-a', '一'));
    session.cancel('chat-other');
    assert.equal(session.hasPending(), true);
    assert.equal(calls[0]?.signal.aborted, false);
    calls[0]?.resolve('答一');
    assert.deepEqual(await first, { id: 'chat-a', status: 'ok', text: '答一' });
    session.cancel('chat-a'); // 已结束，迟到 cancel 无效。
    assert.equal(session.hasPending(), false);
  });

  test('取消后迟到 resolve：旧请求保持 cancelled，绝不影响新请求结果', async () => {
    const { calls, deps } = createHeldCompleter();
    const session = createChatSession(deps);
    const first = session.send(okRequest('chat-a', '一'));
    session.cancel('chat-a');
    assert.deepEqual(await first, { id: 'chat-a', status: 'cancelled' });
    // 新请求已发起并完成。
    const second = session.send(okRequest('chat-b', '二'));
    calls[1]?.resolve('答二');
    assert.deepEqual(await second, { id: 'chat-b', status: 'ok', text: '答二' });
    // 旧 provider 调用此刻才成功返回：必须被丢弃。
    calls[0]?.resolve('迟到的旧答案');
    assert.deepEqual(await first, { id: 'chat-a', status: 'cancelled' });
    assert.equal(session.hasPending(), false);
    // 后续新请求不受污染。
    const third = session.send(okRequest('chat-c', '三'));
    calls[2]?.resolve('答三');
    assert.deepEqual(await third, { id: 'chat-c', status: 'ok', text: '答三' });
  });

  test('取消后立刻用同一个 id 重发：旧请求迟到结算不清掉新在途（引用隔离）', async () => {
    const { calls, deps } = createHeldCompleter();
    const session = createChatSession(deps);
    const first = session.send(okRequest('chat-x', '旧'));
    session.cancel('chat-x');
    assert.deepEqual(await first, { id: 'chat-x', status: 'cancelled' });
    const second = session.send(okRequest('chat-x', '新'));
    assert.equal(session.hasPending(), true);
    calls[0]?.resolve('旧请求迟到成功'); // 旧调用的迟到结果。
    assert.equal(session.hasPending(), true); // 新请求仍在途。
    calls[1]?.resolve('新答案');
    assert.deepEqual(await second, { id: 'chat-x', status: 'ok', text: '新答案' });
    assert.equal(session.hasPending(), false);
  });

  test('取消后迟到 reject：同样返回 cancelled，不产生 provider-error', async () => {
    const { calls, deps } = createHeldCompleter();
    const session = createChatSession(deps);
    const first = session.send(okRequest('chat-a', '一'));
    session.cancel('chat-a');
    calls[0]?.reject(new Error('late failure'));
    assert.deepEqual(await first, { id: 'chat-a', status: 'cancelled' });
    assert.equal(session.hasPending(), false);
  });

  test('provider reject：error/provider-error，失败后重试成功', async () => {
    const { calls, deps } = createHeldCompleter();
    const session = createChatSession(deps);
    const first = session.send(okRequest('chat-a', '一'));
    calls[0]?.reject(new Error('provider down'));
    assert.deepEqual(await first, { id: 'chat-a', status: 'error', code: 'provider-error' });
    assert.equal(session.hasPending(), false);
    const retry = session.send(okRequest('chat-b', '二'));
    calls[1]?.resolve('恢复');
    assert.deepEqual(await retry, { id: 'chat-b', status: 'ok', text: '恢复' });
  });

  test('结果截断：超出 maxResultChars 截到上限，等于上限不截', async () => {
    const { calls, deps } = createHeldCompleter();
    const session = createChatSession({ ...deps, maxResultChars: 5 });
    const first = session.send(okRequest('chat-a', '一'));
    calls[0]?.resolve('abcdefgh');
    assert.deepEqual(await first, { id: 'chat-a', status: 'ok', text: 'abcde' });
    const second = session.send(okRequest('chat-b', '二'));
    calls[1]?.resolve('12345');
    assert.deepEqual(await second, { id: 'chat-b', status: 'ok', text: '12345' });
  });

  test('总超时（真实 timer，小 timeoutMs）：abort provider 并返回 error/timeout', async () => {
    const { calls, deps } = createHeldCompleter();
    const session = createChatSession({ ...deps, timeoutMs: 20 }); // 不注入 now：默认真实时钟。
    const first = session.send(okRequest('chat-a', '一'));
    const result: ChatSendResult = await first; // provider 一直不返回，仅靠超时收尾。
    assert.deepEqual(result, { id: 'chat-a', status: 'error', code: 'timeout' });
    assert.equal(calls[0]?.signal.aborted, true);
    assert.equal(session.hasPending(), false);
    // 超时后 provider 迟到成功：被丢弃，且不影响下一发。
    calls[0]?.resolve('迟到');
    const retry = session.send(okRequest('chat-b', '二'));
    calls[1]?.resolve('答二');
    assert.deepEqual(await retry, { id: 'chat-b', status: 'ok', text: '答二' });
  });

  test('总超时（注入时钟的懒检查）：时钟越过 deadline 后 provider 才成功，判 timeout', async () => {
    const { calls, deps } = createHeldCompleter();
    const clock = createManualClock(0);
    const session = createChatSession({ ...deps, now: clock.now, timeoutMs: 10_000 });
    const first = session.send(okRequest('chat-a', '一'));
    clock.advance(10_000); // 时钟到点，provider 尚未返回。
    calls[0]?.resolve('迟到的成功');
    assert.deepEqual(await first, { id: 'chat-a', status: 'error', code: 'timeout' });
    assert.equal(calls[0]?.signal.aborted, true);
    assert.equal(session.hasPending(), false);
  });

  test('注入时钟未到点时 provider 成功：正常 ok（超时判定以注入时钟为准）', async () => {
    const { calls, deps } = createHeldCompleter();
    const clock = createManualClock(0);
    const session = createChatSession({ ...deps, now: clock.now, timeoutMs: 10_000 });
    const first = session.send(okRequest('chat-a', '一'));
    clock.advance(9_999);
    calls[0]?.resolve('赶上了');
    assert.deepEqual(await first, { id: 'chat-a', status: 'ok', text: '赶上了' });
    assert.equal(session.hasPending(), false);
  });

  test('timeoutMs 为 0：send 即判超时（deadline 立即到点）', async () => {
    const { calls, deps } = createHeldCompleter();
    const session = createChatSession({ ...deps, timeoutMs: 0 });
    const result = await session.send(okRequest('chat-a', '一'));
    assert.deepEqual(result, { id: 'chat-a', status: 'error', code: 'timeout' });
    assert.equal(calls[0]?.signal.aborted, true);
    assert.equal(session.hasPending(), false);
  });

  test('时钟过点后 provider 迟到 reject：判 timeout 而非 provider-error，重试仍成功', async () => {
    const { calls, deps } = createHeldCompleter();
    const clock = createManualClock(0);
    const session = createChatSession({ ...deps, now: clock.now, timeoutMs: 1_000 });
    const first = session.send(okRequest('chat-a', '一'));
    clock.advance(1_000);
    calls[0]?.reject(new Error('late failure'));
    assert.deepEqual(await first, { id: 'chat-a', status: 'error', code: 'timeout' });
    assert.equal(calls[0]?.signal.aborted, true);
    const retry = session.send(okRequest('chat-b', '二'));
    calls[1]?.resolve('答二');
    assert.deepEqual(await retry, { id: 'chat-b', status: 'ok', text: '答二' });
  });
});

describe('core/chat/session × 有界历史（M3-3）', () => {
  /** 记录每次 complete 收到的 history 载荷的手动 provider。 */
  function createRecordingCompleter(): {
    calls: HeldCall[];
    histories: Array<readonly ChatHistoryEntry[] | undefined>;
    deps: Pick<ChatSessionDeps, 'complete'>;
  } {
    const calls: HeldCall[] = [];
    const histories: Array<readonly ChatHistoryEntry[] | undefined> = [];
    const complete: ChatCompleter['complete'] = (input) => {
      histories.push(input.history);
      return new Promise<string>((resolve, reject) => {
        calls.push({ id: input.id, text: input.text, signal: input.signal, resolve, reject });
      });
    };
    return { calls, histories, deps: { complete } };
  }

  test('未注入 history（默认关闭）：complete 载荷不含 history 键，行为与旧版一致', async () => {
    const { calls, deps } = createHeldCompleter();
    const session = createChatSession(deps);
    const sent = session.send(okRequest());
    calls[0]?.resolve('在呢');
    await sent;
    assert.equal('history' in (calls[0] as unknown as object), false, '旧单轮路径不得新增 history 键');
  });

  test('成功轮入史：第一次请求 history 为空数组，第二次携带上一轮 user/assistant', async () => {
    const { calls, histories, deps } = createRecordingCompleter();
    const history = createChatHistory();
    const session = createChatSession({ ...deps, history });
    const first = session.send(okRequest('chat-a', '我叫小林'));
    calls[0]?.resolve('你好，小林！');
    assert.deepEqual(await first, { id: 'chat-a', status: 'ok', text: '你好，小林！' });
    assert.equal(history.turns(), 1);
    const second = session.send(okRequest('chat-b', '我叫什么'));
    assert.deepEqual(
      histories[1]?.map((entry) => [entry.user, entry.assistant]),
      [['我叫小林', '你好，小林！']],
      '第二问请求必须携带第一轮完整内容',
    );
    calls[1]?.resolve('你叫小林。');
    await second;
  });

  test('取消的请求不入史：取消后 provider 迟到成功也不 push', async () => {
    const { calls, deps } = createHeldCompleter();
    const history = createChatHistory();
    const session = createChatSession({ ...deps, history });
    const sent = session.send(okRequest('chat-a', '这句取消'));
    session.cancel('chat-a');
    assert.deepEqual(await sent, { id: 'chat-a', status: 'cancelled' });
    calls[0]?.resolve('迟到的回复'); // 迟到成功：结算已被隔离
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(history.turns(), 0, '取消轮绝不入史');
  });

  test('失败的请求不入史', async () => {
    const { calls, deps } = createHeldCompleter();
    const history = createChatHistory();
    const session = createChatSession({ ...deps, history });
    const sent = session.send(okRequest('chat-a', '你好'));
    calls[0]?.reject(new Error('boom'));
    assert.deepEqual(await sent, { id: 'chat-a', status: 'error', code: 'provider-error' });
    assert.equal(history.turns(), 0);
  });

  test('超时的请求不入史', async () => {
    const { calls, deps } = createHeldCompleter();
    const clock = createManualClock(0);
    const history = createChatHistory();
    const session = createChatSession({ ...deps, now: clock.now, timeoutMs: 1_000, history });
    const sent = session.send(okRequest('chat-a', '你好'));
    clock.advance(1_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    calls[0]?.resolve('迟到');
    assert.deepEqual(await sent, { id: 'chat-a', status: 'error', code: 'timeout' });
    assert.equal(history.turns(), 0);
  });

  test('截断后的文本按交付口径入史（maxResultChars 注入）', async () => {
    const { calls, deps } = createHeldCompleter();
    const history = createChatHistory();
    const session = createChatSession({ ...deps, maxResultChars: 3, history });
    const sent = session.send(okRequest('chat-a', '你好'));
    calls[0]?.resolve('一二三四五');
    assert.deepEqual(await sent, { id: 'chat-a', status: 'ok', text: '一二三' });
    assert.deepEqual(history.snapshot(), [{ user: '你好', assistant: '一二三' }]);
  });

  test('reset：取消在途、清空历史、旧结果隔离且立即可再发', async () => {
    const { calls, histories, deps } = createRecordingCompleter();
    const history = createChatHistory();
    const session = createChatSession({ ...deps, history });
    const first = session.send(okRequest('chat-a', '第一句'));
    calls[0]?.resolve('第一答');
    await first;
    const pending = session.send(okRequest('chat-b', '在途这句'));
    assert.equal(session.hasPending(), true);
    session.reset();
    assert.deepEqual(await pending, { id: 'chat-b', status: 'cancelled' }, '在途请求被取消');
    assert.equal(history.turns(), 0, '历史被清空');
    assert.equal(session.hasPending(), false);
    // 立即重发：不 busy，且请求不携带清空前的历史
    const next = session.send(okRequest('chat-c', '新开始'));
    assert.deepEqual(histories[2], [], '清空后的第一问不得携带旧历史');
    calls[2]?.resolve('新答复');
    assert.deepEqual(await next, { id: 'chat-c', status: 'ok', text: '新答复' });
    // 被 reset 取消的 chat-b 若迟到成功，也绝不入史
    calls[1]?.resolve('迟到的旧回复');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      history.snapshot().map((entry) => entry.user),
      ['新开始'],
    );
  });

  test('reset 后同 id 重发：旧引用隔离不误伤新请求（沿用既有语义）', async () => {
    const { calls, deps } = createHeldCompleter();
    const history = createChatHistory();
    const session = createChatSession({ ...deps, history });
    const first = session.send(okRequest('chat-a', '旧请求'));
    session.reset();
    assert.deepEqual(await first, { id: 'chat-a', status: 'cancelled' });
    const second = session.send(okRequest('chat-a', '新请求'));
    assert.equal(session.hasPending(), true, '同 id 重发立即占用槽位');
    calls[1]?.resolve('新回复');
    assert.deepEqual(await second, { id: 'chat-a', status: 'ok', text: '新回复' });
    calls[0]?.resolve('旧迟到');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(history.snapshot(), [{ user: '新请求', assistant: '新回复' }]);
  });

  test('历史上界在会话内生效：第 6 次请求最多见到最近 4 轮', async () => {
    const { calls, histories, deps } = createRecordingCompleter();
    const history = createChatHistory();
    const session = createChatSession({ ...deps, history });
    for (let i = 1; i <= 5; i += 1) {
      const sent = session.send(okRequest(`chat-${i}`, `第${i}句`));
      calls[i - 1]?.resolve(`第${i}答`);
      await sent;
    }
    const sixth = session.send(okRequest('chat-6', '第6句'));
    assert.equal(histories[5]?.length, 4, '第 6 问只携带最近 4 轮');
    assert.equal(histories[5]?.[0]?.user, '第2句');
    calls[5]?.resolve('第6答');
    await sixth;
  });
});
