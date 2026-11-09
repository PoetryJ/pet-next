/**
 * M3-9 R1 B：tests/support/counting-proxy.mjs 的行为锁定（取消传播矩阵）。
 * 运行：node --experimental-strip-types --test --test-reporter spec tests/counting-proxy.test.mjs
 *
 * 覆盖：拒绝 18872（写进 allowedPorts 也拒绝）、未注册端口、正常成功不误 abort、
 * 响应体逐字节不改写、每次只 1 POST / 每请求只转发 1 次、取消传播、挂起正文时取消、
 * 会话超时、上游 reset → 可读 502。
 *
 * 三层分开记（取消/超时用例显式标注）：
 *   层1 会话结算（core/chat/session 的 ChatSendResult）；
 *   层2 上游 HTTP 取消（代理账本 downstreamClosedEarly/abortedUpstream）；
 *   层3 fake 工作结束（fake 账本 clientAborted/completedAt）。
 * 这三层都只是回环 HTTP + 进程内 fake 的观测，不能推导真实 GPU 已停止。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';

import { createQwenChatProvider } from '../adapters/chat/qwen-provider.ts';
import { createChatSession } from '../core/chat/session.ts';
import { startCountingProxy } from './support/counting-proxy.mjs';
import { startHiddenChatFakeServer } from './support/hidden-chat-fake-server.mjs';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function postRaw(url, payload, headers = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** 响应头到达即 resolve；客户端可 destroy() 模拟“正文未完就断开”。 */
function openRaw(url, payload) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let ended = false;
        res.on('data', () => {
          /* 只关心是否结束 */
        });
        res.on('end', () => {
          ended = true;
        });
        res.on('error', () => {
          /* 取消路径 */
        });
        resolve({ status: res.statusCode, headers: res.headers, ended: () => ended, req, res });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('拒绝 18872：真实服务端口硬闸，写进 allowedPorts 也不放行', async () => {
  await assert.rejects(() => startCountingProxy({ targetPort: 18872 }), /18872/);
  await assert.rejects(
    () => startCountingProxy({ targetPort: 18872, allowedPorts: [18872], allowEphemeral: true }),
    /18872/,
  );
});

test('拒绝未注册端口与非法端口：默认只允许本次注册的 fake 端口', async () => {
  await assert.rejects(() => startCountingProxy({ targetPort: 41234 }), /未注册/);
  await assert.rejects(() => startCountingProxy({ targetPort: 41234, allowedPorts: [40001] }), /未注册/);
  await assert.rejects(() => startCountingProxy({ targetPort: 0 }), /1-65535/);
  await assert.rejects(() => startCountingProxy({ targetPort: '18872' }), /1-65535/);
});

test('正常成功：只 1 POST、每请求只转发 1 次、响应体逐字节不改写、completed=true 不误 abort', async () => {
  const fake = await startHiddenChatFakeServer({ plan: [{ mode: 'long', chars: 2001 }, 'ok'] });
  const proxy = await startCountingProxy({ targetPort: fake.port, allowedPorts: [fake.port] });
  try {
    const firstPayload = JSON.stringify({ id: 'chat-proxy-ok', text: '逐字节' });
    const first = await postRaw(proxy.url, firstPayload, { authorization: 'Bearer do-not-store' });
    assert.equal(first.status, 200);

    const fakeFirst = await fake.waitForCompletion(0);
    // 请求体逐字节转发；响应体逐字节不改写。
    assert.equal(fakeFirst.bodySha256, sha256(Buffer.from(firstPayload, 'utf8')));
    assert.equal(sha256(first.body), fakeFirst.responseBodySha256);
    assert.equal(first.body.length, fakeFirst.responseBodyBytes);
    assert.equal(first.body.equals(Buffer.from(fakeFirst.responseBody, 'utf8')), true);

    const [entry] = await proxy.waitForLedger((rows) => rows.length >= 1 && rows[0].completed === true);
    assert.equal(entry.forwarded, true);
    assert.equal(entry.forwardCount, 1);
    assert.equal(entry.upstreamStatus, 200);
    assert.equal(entry.requestSha256, sha256(Buffer.from(firstPayload, 'utf8')));
    assert.ok(entry.completedAt >= entry.upstreamStartedAt);
    // 正常读完响应：不得误记取消/abort。
    assert.equal(entry.downstreamClosedEarly, false);
    assert.equal(entry.abortedUpstream, false);
    assert.equal(entry.upstreamError, null);
    assert.equal(proxy.postCount, 1);

    const secondPayload = JSON.stringify({ id: 'chat-proxy-ok-2', text: '第二次' });
    const second = await postRaw(proxy.url, secondPayload);
    assert.equal(second.status, 200);
    await fake.waitForCompletion(1);
    await proxy.waitForLedger((rows) => rows.length >= 2 && rows[1].completed === true);

    assert.equal(proxy.postCount, 2);
    assert.deepEqual(
      proxy.requests.map((row) => row.forwardCount),
      [1, 1],
    );
    assert.equal(fake.stats().total, 2);
    // 不落凭据：账本里不能出现 Authorization 值。
    assert.equal(JSON.stringify(proxy.requests).includes('do-not-store'), false);
  } finally {
    await proxy.close();
    await fake.close();
  }
});

test('取消传播（三层）：会话结算 cancelled → 上游 HTTP 被 abort → fake 观察到断连', async () => {
  const fake = await startHiddenChatFakeServer({ plan: ['delay'] });
  const proxy = await startCountingProxy({ targetPort: fake.port, allowedPorts: [fake.port] });
  try {
    const provider = createQwenChatProvider({ baseUrl: `${proxy.url}/v1`, model: 'qwen3.8-27b' });
    const session = createChatSession({ complete: (input) => provider.complete(input) });

    const outcome = session.send({ id: 'chat-cancel', text: '隐藏中取消' });
    await fake.waitForRequest(1);
    assert.equal(session.hasPending(), true);
    assert.equal(fake.stats().pending, 1);

    session.cancel('chat-cancel');
    const settled = await outcome;

    // 层1：会话结算（立即释放槽位，不等 provider）。
    assert.equal(settled.status, 'cancelled');
    assert.equal(settled.id, 'chat-cancel');
    assert.equal(session.hasPending(), false);

    // 层2：上游 HTTP 取消（代理账本，不是靠时间猜）。
    const [entry] = await proxy.waitForLedger((rows) => rows.length === 1 && rows[0].abortedUpstream === true);
    assert.equal(entry.downstreamClosedEarly, true);
    assert.equal(entry.completed, false);
    assert.equal(entry.forwardCount, 1);
    assert.equal(proxy.postCount, 1);

    // 层3：fake 工作结束（连接断开观测，服务端不再等待该请求）。
    const fakeDone = await fake.waitForCompletion(0, 3000);
    assert.equal(fakeDone.clientAborted, true);
    assert.ok(fakeDone.abortedAt !== null);
    // 没有重试/第二次 POST。
    assert.equal(fake.stats().total, 1);
  } finally {
    await proxy.close();
    await fake.close();
  }
});

test('挂起正文时下游断开：abort 上游并记 downstreamClosedEarly，fake 观察到断连', async () => {
  const fake = await startHiddenChatFakeServer({ plan: ['headers-sent'] });
  const proxy = await startCountingProxy({ targetPort: fake.port, allowedPorts: [fake.port] });
  try {
    const client = await openRaw(proxy.url, JSON.stringify({ id: 'chat-hold-proxy', text: '挂起' }));
    assert.equal(client.status, 200);
    assert.equal(client.ended(), false);
    // 响应头已到、正文未完：此时断开才叫“响应完成前断开”。
    client.req.destroy();

    const [entry] = await proxy.waitForLedger((rows) => rows.length === 1 && rows[0].abortedUpstream === true);
    assert.equal(entry.downstreamClosedEarly, true);
    assert.equal(entry.completed, false);
    assert.equal(entry.responseBytes, 0);

    const fakeDone = await fake.waitForCompletion(0, 3000);
    assert.equal(fakeDone.clientAborted, true);
    assert.equal(proxy.postCount, 1);
    assert.equal(fake.stats().total, 1);
  } finally {
    await proxy.close();
    await fake.close();
  }
});

test('超时：会话按总 deadline 结算 timeout，上游被取消，fake 工作结束（三层分开记）', async () => {
  const fake = await startHiddenChatFakeServer({ plan: ['delay'] });
  const proxy = await startCountingProxy({ targetPort: fake.port, allowedPorts: [fake.port] });
  try {
    const provider = createQwenChatProvider({ baseUrl: `${proxy.url}/v1`, model: 'qwen3.8-27b' });
    // 用会话自己的单调 deadline（注入较短 timeoutMs），不靠测试 sleep 判定。
    const session = createChatSession({ complete: (input) => provider.complete(input), timeoutMs: 120 });

    const outcome = session.send({ id: 'chat-timeout', text: '超时' });
    await fake.waitForRequest(1);
    const settled = await outcome;

    // 层1：会话结算为 timeout，槽位释放。
    assert.equal(settled.status, 'error');
    assert.equal(settled.code, 'timeout');
    assert.equal(session.hasPending(), false);

    // 层2：上游 HTTP 请求被取消。
    const [entry] = await proxy.waitForLedger((rows) => rows.length === 1 && rows[0].abortedUpstream === true);
    assert.equal(entry.downstreamClosedEarly, true);
    assert.equal(entry.completed, false);
    assert.equal(entry.forwardCount, 1);

    // 层3：fake 工作结束（连接断开），且没有重试。
    const fakeDone = await fake.waitForCompletion(0, 3000);
    assert.equal(fakeDone.clientAborted, true);
    assert.equal(proxy.postCount, 1);
    assert.equal(fake.stats().total, 1);
  } finally {
    await proxy.close();
    await fake.close();
  }
});

test('上游连接重置：可读 502、只 1 次转发、不重试', async () => {
  const fake = await startHiddenChatFakeServer({ plan: ['reset'] });
  const proxy = await startCountingProxy({ targetPort: fake.port, allowedPorts: [fake.port] });
  try {
    const response = await postRaw(proxy.url, JSON.stringify({ id: 'chat-upstream-reset', text: '重置' }));
    assert.equal(response.status, 502);
    const payload = JSON.parse(response.body.toString('utf8'));
    assert.equal(payload.error, 'upstream-error');
    assert.equal(payload.proxy, 'counting-proxy');

    const [entry] = await proxy.waitForLedger((rows) => rows.length === 1 && rows[0].upstreamError !== null);
    assert.equal(entry.synthesizedError, true);
    assert.equal(entry.completed, false);
    assert.equal(entry.forwardCount, 1);
    // 上游自己断的，不是我们因下游取消而 abort。
    assert.equal(entry.abortedUpstream, false);
    assert.equal(proxy.postCount, 1);

    const fakeDone = await fake.waitForCompletion(0);
    assert.equal(fakeDone.status, 'reset');
    assert.equal(fake.stats().total, 1);
  } finally {
    await proxy.close();
    await fake.close();
  }
});
