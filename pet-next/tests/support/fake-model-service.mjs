#!/usr/bin/env node
/**
 * M3-2 fake 模型服务（只用于测试）：OpenAI 兼容 /models 与 /v1/chat/completions。
 * 不接真实模型、不消耗真实调用预算。打印 {event:'fake-model-ready',port,url}。
 * 环境：FAKE_MODEL_ID（默认 qwen3.8-27b）、FAKE_MODEL_DELAY_MS（默认 0）、FAKE_MODEL_MODE=ok|error。
 * @module pet-next/tests/support/fake-model-service
 */
import http from 'node:http';

const modelId = process.env.FAKE_MODEL_ID ?? 'qwen3.8-27b';
const delayMs = Number(process.env.FAKE_MODEL_DELAY_MS ?? '0');
const mode = process.env.FAKE_MODEL_MODE ?? 'ok';

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
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        /* ignore */
      }
      const userText = Array.isArray(body.messages)
        ? String(body.messages.find((m) => m && m.role === 'user')?.content ?? '')
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
