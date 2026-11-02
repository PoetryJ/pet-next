/**
 * 受控假 Provider 的行为锁定：手动驱动、调用记录、abort 观察。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createFakeChatProvider } from './fake-provider.ts';
import { createChatSession } from '../../core/chat/session.ts';

describe('createFakeChatProvider', () => {
  test('complete 挂起，手动 resolve/reject 驱动结果，调用被记录', async () => {
    const provider = createFakeChatProvider();
    const first = provider.complete({ id: 'chat-a', text: '你好', signal: new AbortController().signal });
    const call = await provider.nextCall();
    assert.deepEqual({ id: call.id, text: call.text }, { id: 'chat-a', text: '你好' });
    provider.resolve('手动回复');
    assert.equal(await first, '手动回复');

    const second = provider.complete({ id: 'chat-b', text: '再问', signal: new AbortController().signal });
    provider.reject(new Error('手动失败'));
    await assert.rejects(second, /手动失败/);
    assert.equal(provider.calls.length, 2);
    assert.equal(provider.abortedCount(), 0);
  });

  test('abort 被观察到；abort 后迟到 resolve 不被 session 采纳', async () => {
    const provider = createFakeChatProvider();
    const session = createChatSession({ complete: (input) => provider.complete(input) });
    const pending = session.send({ id: 'chat-race', text: '竞态' });
    await provider.nextCall();
    session.cancel('chat-race');
    provider.resolve('迟到的回复');
    const result = await pending;
    assert.deepEqual(result, { id: 'chat-race', status: 'cancelled' });
    assert.equal(provider.abortedCount(), 1);
    assert.equal(session.hasPending(), false);
  });
});
