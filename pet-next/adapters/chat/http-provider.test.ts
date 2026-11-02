/**
 * HTTP Provider 传输行为锁定：真实本地 node:http 服务上的成功 / 500 / 缺 text /
 * 回环地址白名单 / abort 断开（受控短超时模拟 session 超时时钟），并断言服务端收到的文本与次数。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createHttpChatProvider } from './http-provider.ts';

interface Received {
  method?: string;
  contentType?: string;
  body?: { id?: unknown; text?: unknown } | null;
}

type Behavior = (received: Received, res: http.ServerResponse) => void;

let behavior: Behavior = (_received, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ text: 'ok-reply' }));
};
const received: Received[] = [];
const requestClosed = { count: 0 };

const server = http.createServer((req, res) => {
  const entry: Received = { method: req.method, contentType: req.headers['content-type'] };
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('close', () => {
    requestClosed.count += 1;
  });
  req.on('end', () => {
    try {
      entry.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: unknown; text?: unknown };
    } catch {
      entry.body = null;
    }
    received.push(entry);
    behavior(entry, res);
  });
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function baseUrl(): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe('createHttpChatProvider', () => {
  test('成功：POST JSON {id,text}，返回响应 {text}', async () => {
    behavior = (_entry, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'ok-reply' }));
    };
    received.length = 0;
    const provider = createHttpChatProvider({ url: baseUrl() });
    const text = await provider.complete({
      id: 'chat-ok',
      text: '你好，桌宠',
      signal: new AbortController().signal,
    });
    assert.equal(text, 'ok-reply');
    assert.equal(received.length, 1);
    assert.deepEqual(received[0]?.body, { id: 'chat-ok', text: '你好，桌宠' });
    assert.equal(received[0]?.method, 'POST');
    assert.match(received[0]?.contentType ?? '', /application\/json/);
  });

  test('HTTP 500 -> reject（session 映射 provider-error）', async () => {
    behavior = (_entry, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    };
    received.length = 0;
    const provider = createHttpChatProvider({ url: baseUrl() });
    await assert.rejects(
      provider.complete({ id: 'chat-500', text: '触发错误', signal: new AbortController().signal }),
      /chat http 500/,
    );
    assert.equal(received.length, 1);
    assert.equal(received[0]?.body?.text, '触发错误');
  });

  test('响应缺 text 字段 -> reject', async () => {
    behavior = (_entry, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ other: 1 }));
    };
    const provider = createHttpChatProvider({ url: baseUrl() });
    await assert.rejects(
      provider.complete({ id: 'chat-no-text', text: '缺字段', signal: new AbortController().signal }),
      /缺少 text/,
    );
  });

  test('非回环地址直接拒绝（演示安全）', () => {
    assert.throws(() => createHttpChatProvider({ url: 'http://example.com:8080' }), /仅允许/);
    assert.throws(() => createHttpChatProvider({ url: 'http://127.0.0.1' }), /仅允许/);
    assert.throws(() => createHttpChatProvider({ url: 'https://127.0.0.1:9000' }), /仅允许/);
  });

  test('取消/受控短超时：abort 传导到 fetch，服务端连接断开', async () => {
    // 永不回写：模拟无响应服务，等待客户端 abort 断开。
    behavior = (_entry, _res) => {};
    const provider = createHttpChatProvider({ url: baseUrl() });
    const controller = new AbortController();
    const closedBefore = requestClosed.count;
    const inflight = provider.complete({
      id: 'chat-abort',
      text: '等不到回复',
      signal: controller.signal,
    });
    // 受控短超时：模拟 session 超时时钟到点触发 abort（不是网络模拟）。
    const timer = setTimeout(() => controller.abort(), 25);
    await assert.rejects(inflight, (error: unknown) => error instanceof Error);
    clearTimeout(timer);
    // abort 后服务端观察到请求连接断开（req close）。
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (requestClosed.count > closedBefore) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
  });
});
