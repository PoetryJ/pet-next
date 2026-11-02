/**
 * 本地假聊天服务行为锁定：/healthz、正常回复（前缀+摘要）、[error] 500、[slow] 慢回复、close 释放端口。
 * 延迟参数显式传小值，避免测试依赖真实网络等待；慢回复用时间下界断言。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FAKE_CHAT_REPLY_PREFIX, startFakeChatServer } from './fake-server.ts';

describe('startFakeChatServer', () => {
  test('/healthz 返回 offline_ready；POST 正常回复带前缀与原文', async () => {
    const server = await startFakeChatServer({ delayMs: 0 });
    try {
      assert.ok(server.port > 0);
      assert.equal(server.url, `http://127.0.0.1:${server.port}`);
      const health = await fetch(`${server.url}/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: 'offline_ready' });

      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'chat-1', text: '今天吃点什么' }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { text: `${FAKE_CHAT_REPLY_PREFIX}今天吃点什么` });
    } finally {
      await server.close();
    }
  });

  test('长文本摘要；[error] 返回 500；[slow] 至少等待 slowMs', async () => {
    const server = await startFakeChatServer({ delayMs: 0, slowMs: 120 });
    try {
      const long = '很'.repeat(60);
      const clipped = await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'chat-2', text: long }),
      });
      const { text } = (await clipped.json()) as { text: string };
      assert.ok(text.startsWith(FAKE_CHAT_REPLY_PREFIX));
      assert.match(text, /共60字/);
      assert.ok(text.length < FAKE_CHAT_REPLY_PREFIX.length + long.length);

      const failure = await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'chat-3', text: '来个 [error]' }),
      });
      assert.equal(failure.status, 500);

      const started = Date.now();
      const slow = await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'chat-4', text: '等等 [slow] 我' }),
      });
      assert.equal(slow.status, 200);
      assert.ok(Date.now() - started >= 100, '慢回复应至少等待 slowMs 附近');
    } finally {
      await server.close();
    }
  });

  test('close 后端口释放，请求被拒绝', async () => {
    const server = await startFakeChatServer({ delayMs: 0 });
    const { port } = server;
    await server.close();
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
  });
});
