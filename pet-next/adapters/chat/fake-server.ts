/**
 * M3-0 本地假聊天服务：node:http 实现，可编程启动（E2E 复用）或由 fake-server-main.ts 直跑。
 * 行为：POST {id,text} -> 延迟后回 {text:'【演示回复】已收到：'+摘要}；
 * 文本含 [slow] 触发慢回复（取消测试），含 [error] 触发 500（错误测试）；GET /healthz -> {status:'offline_ready'}。
 * @module pet-next/adapters/chat/fake-server
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeChatServerOptions {
  /** 监听端口，默认 0（随机）。 */
  port?: number;
  /** 监听地址，默认 127.0.0.1。 */
  host?: string;
  /** 普通回复延迟毫秒，默认 300（环境变量 PET_NEXT_FAKE_CHAT_DELAY_MS）。 */
  delayMs?: number;
  /** [slow] 标记的慢回复延迟毫秒，默认 5000（环境变量 PET_NEXT_FAKE_CHAT_SLOW_MS）。 */
  slowMs?: number;
}

export interface FakeChatServerHandle {
  port: number;
  url: string;
  /** 停止服务并断开在途连接；resolve 即已关闭。 */
  close(): Promise<void>;
}

export const FAKE_CHAT_REPLY_PREFIX = '【演示回复】已收到：';
export const FAKE_CHAT_SLOW_MARKER = '[slow]';
export const FAKE_CHAT_ERROR_MARKER = '[error]';

function summarize(text: string): string {
  const clipped = text.length > 30 ? `${text.slice(0, 30)}…(共${text.length}字)` : text;
  return clipped;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function startFakeChatServer(options: FakeChatServerOptions = {}): Promise<FakeChatServerHandle> {
  const delayMs = options.delayMs ?? envInt('PET_NEXT_FAKE_CHAT_DELAY_MS', 300);
  const slowMs = options.slowMs ?? envInt('PET_NEXT_FAKE_CHAT_SLOW_MS', 5000);
  const timers = new Set<NodeJS.Timeout>();
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'offline_ready' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let payload: { id?: unknown; text?: unknown } = {};
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: unknown; text?: unknown };
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }
      if (typeof payload.text !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'text required' }));
        return;
      }
      const text = payload.text;
      if (text.includes(FAKE_CHAT_ERROR_MARKER)) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'intentional error for tests' }));
        return;
      }
      const wait = text.includes(FAKE_CHAT_SLOW_MARKER) ? slowMs : delayMs;
      // 客户端 abort 后不再回写。注意：IncomingMessage 'close' 在请求体读完后即触发，
      // 必须监听 ServerResponse 'close'（连接真正关闭）才能正确判断客户端是否离开。
      let clientGone = false;
      res.on('close', () => {
        clientGone = true;
      });
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (clientGone || res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: `${FAKE_CHAT_REPLY_PREFIX}${summarize(text)}` }));
      }, wait);
      timers.add(timer);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const port = address.port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close() {
          for (const timer of timers) clearTimeout(timer);
          timers.clear();
          server.closeAllConnections();
          return new Promise((closed) => {
            server.close(() => closed());
          });
        },
      });
    });
  });
}
