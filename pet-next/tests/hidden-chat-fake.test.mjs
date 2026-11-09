/**
 * M3-9 R1 B：tests/support/hidden-chat-fake-server.mjs 的行为锁定。
 * 运行：node --experimental-strip-types --test --test-reporter spec tests/hidden-chat-fake.test.mjs
 *
 * 覆盖：ok 账本、delay 屏障（release 前不回包）、headers-sent 挂起正文、reset 断连、
 * long 2000/2001 与 length 元信息、late-ignore-abort 迟到回包、plan 校验、不落凭据。
 * 所有等待用 waitForRequest/waitForCompletion/release 屏障；不使用固定 sleep 作为主判据。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';

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

/** 在响应头到达时即 resolve；正文用 done() 等。 */
function openPost(url, payload) {
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
        const chunks = [];
        let ended = false;
        const completion = new Promise((done) => {
          const finish = () => {
            if (ended) return;
            ended = true;
            done(Buffer.concat(chunks));
          };
          res.on('end', finish);
          res.on('close', finish);
        });
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', () => {
          /* 断连由 done() 的 close 分支收尾 */
        });
        resolve({ status: res.statusCode, headers: res.headers, ended: () => ended, done: () => completion, req, res });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('ok：记录 id/时间/请求体 sha256/字节/userText，回 OpenAI 形状，且不落凭据', async () => {
  const server = await startHiddenChatFakeServer({ plan: ['ok'] });
  try {
    assert.ok(server.port > 0);
    assert.equal(server.url, `http://127.0.0.1:${server.port}`);
    assert.equal(server.baseUrl, `http://127.0.0.1:${server.port}/v1`);

    const payload = JSON.stringify({ id: 'chat-ok-1', text: '隐藏里的一次正常回复' });
    const response = await postRaw(`${server.url}/v1/chat/completions`, payload, {
      authorization: 'Bearer should-not-be-stored',
    });
    const json = JSON.parse(response.body.toString('utf8'));

    assert.equal(response.status, 200);
    assert.equal(json.choices[0].message.content, '隧道回复：隐藏里的一次正常回复');
    assert.equal(json.choices[0].finish_reason, 'stop');
    // 演示 Provider 的顶层 text 与 OpenAI 形状同源，避免为两条链路各做一份 fake。
    assert.equal(json.text, json.choices[0].message.content);

    const [record] = await server.waitForRequest(1);
    assert.equal(record.id, 'chat-ok-1');
    assert.equal(record.mode, 'ok');
    assert.equal(record.userText, '隐藏里的一次正常回复');
    assert.equal(record.bodySha256, sha256(Buffer.from(payload, 'utf8')));
    assert.equal(record.requestBytes, Buffer.byteLength(payload, 'utf8'));
    assert.ok(record.receivedAt > 0);
    assert.ok(record.parsedAt >= record.receivedAt);
    assert.equal(record.hasAuthorization, true);
    assert.equal(record.responseBodyBytes, response.body.length);
    assert.equal(record.responseBodySha256, sha256(response.body));
    assert.equal(record.finishReason, 'stop');

    const done = await server.waitForCompletion(0);
    assert.ok(['completed', 'completed-late'].includes(done.status));
    assert.ok(done.completedAt >= done.headersSentAt);
    assert.equal(server.stats().total, 1);

    // 不落凭据：任何账本输出都不应出现 Authorization 值。
    assert.equal(JSON.stringify(server.requests).includes('should-not-be-stored'), false);
    assert.equal(JSON.stringify(server.stats()).includes('should-not-be-stored'), false);
  } finally {
    await server.close();
  }
});

test('delay：收到完整请求后阻塞，release 前不回包，release 后成功结算', async () => {
  const server = await startHiddenChatFakeServer({ plan: ['delay'] });
  try {
    let settled = false;
    const pending = postRaw(`${server.url}/v1/chat/completions`, JSON.stringify({ id: 'chat-delay', text: '延迟回复' })).then(
      (value) => {
        settled = true;
        return value;
      },
    );

    const [record] = await server.waitForRequest(1);
    // 即时观察（非 sleep）：请求已到、屏障未释放，因此既未回包也未结算。
    assert.equal(record.status, 'pending');
    assert.equal(record.completedAt, null);
    assert.equal(record.headersSentAt, null);
    assert.equal(settled, false);
    assert.equal(server.stats().pending, 1);

    assert.equal(server.release(0), true);
    const response = await pending;
    assert.equal(response.status, 200);

    const done = await server.waitForCompletion(0);
    assert.ok(done.releasedAt !== null);
    assert.ok(done.completedAt >= done.releasedAt);
    assert.ok(done.headersSentAt >= done.releasedAt);
    assert.equal(done.status, 'completed');
    // 幂等：重复释放不改变结果。
    assert.equal(server.release(0), false);
    assert.equal(server.stats().total, 1);
  } finally {
    await server.close();
  }
});

test('headers-sent/body-hold：先到响应头，正文挂起，release 后逐字节完整', async () => {
  const server = await startHiddenChatFakeServer({ plan: [{ mode: 'body-hold' }] });
  try {
    const payload = JSON.stringify({ id: 'chat-hold', text: '挂起正文' });
    const client = await openPost(`${server.url}/chat/completions`, payload);

    assert.equal(client.status, 200);
    assert.equal(client.ended(), false);
    const held = server.requests[0];
    assert.equal(held.mode, 'headers-sent');
    assert.ok(held.headersSentAt !== null);
    assert.equal(held.bodySentAt, null);
    assert.equal(held.completedAt, null);
    assert.equal(held.status, 'pending');
    // 头已声明正文长度，但正文尚未发送。
    assert.equal(Number(client.headers['content-length']), held.responseBodyBytes);
    assert.equal(server.stats().completed, 0);

    assert.equal(server.release(0), true);
    const body = await client.done();
    assert.equal(sha256(body), held.responseBodySha256);
    assert.equal(body.length, held.responseBodyBytes);
    assert.equal(JSON.parse(body.toString('utf8')).choices[0].message.content, '隧道回复：挂起正文');

    const done = await server.waitForCompletion(0);
    assert.equal(done.status, 'completed');
    assert.ok(done.bodySentAt >= done.releasedAt);
  } finally {
    await server.close();
  }
});

test('reset：响应前 destroy socket，客户端拿到连接错误，账本记 reset 且不算客户端取消', async () => {
  const server = await startHiddenChatFakeServer({ plan: ['reset'] });
  try {
    await assert.rejects(
      () => postRaw(`${server.url}/v1/chat/completions`, JSON.stringify({ id: 'chat-reset', text: '重置' })),
      (error) => ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(error.code) || /socket hang up|reset/i.test(error.message),
    );

    const done = await server.waitForCompletion(0);
    assert.equal(done.status, 'reset');
    assert.equal(done.headersSentAt, null);
    assert.equal(done.bodySentAt, null);
    // 服务端主动断开不是客户端取消。
    assert.equal(done.clientAborted, false);
    // 请求体仍然完整记账。
    assert.equal(done.requestBytes > 0, true);
    assert.equal(done.bodySha256 !== null, true);
    assert.equal(server.stats().reset, 1);
  } finally {
    await server.close();
  }
});

test('long/length：2000 与 2001 字符正文精确，finish_reason 分别为 stop/length', async () => {
  const server = await startHiddenChatFakeServer({
    plan: [
      { mode: 'long', chars: 2000 },
      { mode: 'long', chars: 2001 },
      { mode: 'length' },
      { mode: 'ok', chars: 5 },
      { mode: 'headers-sent', chars: 4, delayMs: 0 },
    ],
  });
  try {
    for (const chars of [2000, 2001]) {
      const response = await postRaw(`${server.url}/v1/chat/completions`, JSON.stringify({ id: `chat-long-${chars}`, text: '长' }));
      const json = JSON.parse(response.body.toString('utf8'));
      const record = server.requests.find((entry) => entry.id === `chat-long-${chars}`);
      assert.equal(json.choices[0].message.content.length, chars);
      // 每个“长”是 3 字节 UTF-8：字节数必须与字符数严格对应。
      assert.equal(Buffer.byteLength(json.choices[0].message.content, 'utf8'), chars * 3);
      assert.equal(json.choices[0].finish_reason, 'stop');
      assert.equal(record.responseBodyBytes, response.body.length);
      assert.equal(record.responseBodySha256, sha256(response.body));
      await server.waitForCompletion(record.index);
    }

    const truncated = await postRaw(`${server.url}/v1/chat/completions`, JSON.stringify({ id: 'chat-length', text: '截断' }));
    const json = JSON.parse(truncated.body.toString('utf8'));
    assert.equal(json.choices[0].finish_reason, 'length');
    const done = await server.waitForCompletion(2);
    assert.equal(done.finishReason, 'length');
    assert.equal(server.stats().total, 3);

    // 任意模式加 chars：同一份逻辑支持“长正文 + 其它故障组合”。
    const combined = await postRaw(`${server.url}/v1/chat/completions`, JSON.stringify({ id: 'chat-chars-ok', text: '组合' }));
    assert.equal(JSON.parse(combined.body.toString('utf8')).choices[0].message.content.length, 5);
    await server.waitForCompletion(3);

    // 挂起正文 + 长正文：延迟到期自动释放，正文长度不变（C 的第①类组合）。
    const heldLong = await postRaw(`${server.url}/v1/chat/completions`, JSON.stringify({ id: 'chat-chars-held', text: '挂起长文' }));
    assert.equal(JSON.parse(heldLong.body.toString('utf8')).choices[0].message.content.length, 4);
    const heldDone = await server.waitForCompletion(4);
    assert.equal(heldDone.mode, 'headers-sent');
    assert.ok(heldDone.bodySentAt >= heldDone.releasedAt);
    assert.equal(server.stats().total, 5);
  } finally {
    await server.close();
  }
});

test('late-ignore-abort：客户端 abort 后仍尝试回包，只留痕、不产生第二次请求', async () => {
  const server = await startHiddenChatFakeServer({ plan: [{ mode: 'late-ignore-abort', ignoreAbortMs: 80 }] });
  try {
    const controller = new AbortController();
    const pending = fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'chat-late', text: '迟到' }),
      signal: controller.signal,
    });

    const [record] = await server.waitForRequest(1);
    assert.equal(record.status, 'pending');
    controller.abort();
    await assert.rejects(pending);

    const done = await server.waitForCompletion(0, 3000);
    assert.equal(done.clientAborted, true);
    assert.ok(done.abortedAt !== null);
    // 模块负控的关键证据：abort 之后仍发起过一次回包尝试。
    assert.ok(done.lateAttemptAt !== null);
    assert.equal(done.lateAfterAbort, true);
    assert.ok(['aborted', 'completed-late', 'write-failed'].includes(done.status));
    // 没有重试/第二次请求：迟到回包不等于重发。
    assert.equal(server.stats().total, 1);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('plan 校验：未知模式与非法参数立刻抛错；plan 可替换队列', async () => {
  const server = await startHiddenChatFakeServer();
  try {
    assert.throws(() => server.plan([{ mode: 'nope' }]), /未知模式/);
    assert.throws(() => server.plan([{ mode: 'long', chars: 0 }]), /chars/);
    assert.throws(() => server.plan([{ mode: 'delay', delayMs: -1 }]), /delayMs/);
    assert.equal(server.plan(['ok', 'reset', { mode: 'long', chars: 3 }]), 3);
  } finally {
    await server.close();
  }
});
