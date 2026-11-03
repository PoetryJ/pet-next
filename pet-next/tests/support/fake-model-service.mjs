#!/usr/bin/env node
/**
 * M3-2 fake 模型服务（只用于测试）：OpenAI 兼容 /models 与 /v1/chat/completions。
 * 不接真实模型、不消耗真实调用预算。打印 {event:'fake-model-ready',port,url}。
 * 环境：FAKE_MODEL_ID（默认 qwen3.8-27b）、FAKE_MODEL_DELAY_MS（默认 0）、FAKE_MODEL_MODE=ok|error。
 * @module pet-next/tests/support/fake-model-service
 */
import http from 'node:http';
import { appendFileSync } from 'node:fs';

const modelId = process.env.FAKE_MODEL_ID ?? 'qwen3.8-27b';
const delayMs = Number(process.env.FAKE_MODEL_DELAY_MS ?? '0');
const mode = process.env.FAKE_MODEL_MODE ?? 'ok';
/** 可选 NDJSON 观测：完整请求体落盘（M3-3 E2E 断言历史注入用；未设置不写文件）。 */
const logFile = process.env.FAKE_MODEL_LOG ?? '';

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/models' || req.url === '/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: modelId, object: 'model' }] }));
    return;
  }
  if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      if (logFile !== '') {
        try {
          appendFileSync(logFile, `${JSON.stringify({ event: 'chat-request', at: Date.now(), bytes: Buffer.byteLength(raw, 'utf8'), body })}\n`);
        } catch {
          /* 观测失败不影响服务 */
        }
      }
      // 回显“最后一条” user 消息：带历史时 messages 里有多个 user（M3-3），当前问才是最后一条。
      const userText = Array.isArray(body.messages)
        ? String([...body.messages].reverse().find((m) => m && m.role === 'user')?.content ?? '')
        : '';
      const respond = () => {
        if (mode === 'error') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'fake-model-error' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'fake-chat',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: `隧道回复：${userText.slice(0, 24)}` },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
          }),
        );
      };
      if (delayMs > 0) setTimeout(respond, delayMs);
      else respond();
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  console.log(JSON.stringify({ event: 'fake-model-ready', port, url: `http://127.0.0.1:${port}` }));
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
