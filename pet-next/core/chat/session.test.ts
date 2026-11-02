/**
 * 会话状态机单测：全部用受控 Promise 与受控时钟，唯一例外是 timeout 真实 timer
 * 用例（语义本身需要真实计时，timeoutMs 压到 20ms 且必然清理）。
 * @module pet-next/core/chat/session.test
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
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
