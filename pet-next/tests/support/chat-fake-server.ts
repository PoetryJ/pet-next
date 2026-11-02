/**
 * 聊天预览 E2E 的本地假服务：可编程延迟/错误/慢回复，记录收到的 {id,text} 与连接事件。
 *
 * 协议（已同步全队；主进程 Provider 以 PET_NEXT_CHAT_FAKE_URL 指向本服务）：
 *   POST {base}/（或任意非 /__* 路径）body {"id":"chat-...","text":"..."}
 *     - ok 模式：HTTP 200，{"id":<同请求>,"text":"演示回复：已收到「<原文>」"}
 *     - error 模式：可编程状态码（默认 500），{"id":...,"error":"fake-server-error"}
 *   GET  /__health → {"ok":true}
 *   POST /__config {"mode":"ok"|"error","status":500,"delayMs":0} → 回显当前配置
 *   POST /__reset → 清空请求记录
 *   GET  /__state  → 全部观测（请求、客户端断开、响应送达结果）
 *
 * 关键行为：客户端断开（取消/关窗）不中断处理——延迟到期仍完成响应并记录送达失败，
 * 用于验证"旧请求的迟到响应即使产生也不得显示"。每个请求的行为参数在收到时快照，
 * 之后的 /__config 修改不影响已在途的请求。
 *
 * 直接运行（独立进程验收）：node --experimental-strip-types tests/support/chat-fake-server.ts --port=8901
 * @module pet-next/tests/support/chat-fake-server
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

/** ok=正常回复；error=按 status 回错误码。 */
export type ChatFakeMode = 'ok' | 'error';

export interface FakeChatRequestRecord {
  readonly id: string;
  readonly text: string;
  readonly receivedAt: number;
  /** 收到时快照的行为参数。 */
  readonly mode: ChatFakeMode;
  readonly status: number;
  readonly delayMs: number;
  /** 客户端在响应完成前断开（取消/关窗/进程死亡）。 */
  clientClosed: boolean;
  closedAt: number | null;
  /** 延迟到期、服务端产出响应的时刻（无论送达与否）。 */
  respondedAt: number | null;
  responseText: string | null;
  /** 响应写出口径失败（客户端已走）；null=写出口径上成功。 */
  deliverError: string | null;
}

export interface ChatFakeState {
  readonly mode: ChatFakeMode;
  readonly status: number;
  readonly delayMs: number;
  readonly port: number;
  readonly startedAt: number;
  readonly requests: readonly FakeChatRequestRecord[];
}

export interface ChatFakeConfig {
  mode?: ChatFakeMode;
  status?: number;
  delayMs?: number;
}

export interface ChatFakeServer {
  readonly port: number;
  readonly url: string;
  /** 进程内直读快照（不经 HTTP）。 */
  state(): ChatFakeState;
  config(patch: ChatFakeConfig): void;
  reset(): void;
  /** 轮询 state 直到谓词命中；超时抛错并带最后快照。 */
  waitFor(predicate: (state: ChatFakeState) => boolean, timeoutMs: number, label: string): Promise<ChatFakeState>;
  stop(): Promise<void>;
}

interface Shared {
  mode: ChatFakeMode;
  status: number;
  delayMs: number;
  startedAt: number;
  boundPort: number;
  requests: FakeChatRequestRecord[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function replyText(text: string): string {
  return `演示回复：已收到「${text}」`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function isChatFakeConfig(value: unknown): value is ChatFakeConfig {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { mode?: unknown; status?: unknown; delayMs?: unknown };
  return (
    (record.mode === undefined || record.mode === 'ok' || record.mode === 'error') &&
    (record.status === undefined || (typeof record.status === 'number' && record.status > 0)) &&
    (record.delayMs === undefined || (typeof record.delayMs === 'number' && record.delayMs >= 0))
  );
}

function snapshot(shared: Shared): ChatFakeState {
  return {
    mode: shared.mode,
    status: shared.status,
    delayMs: shared.delayMs,
    port: shared.boundPort,
    startedAt: shared.startedAt,
    requests: shared.requests.map((entry) => ({ ...entry })),
  };
}

/** 聊天主流程：记录请求 → 按快照参数延迟 → 产出响应（客户端断开也照常产出并记录送达结果）。 */
function handleChat(shared: Shared, req: IncomingMessage, res: ServerResponse, raw: string): void {
  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  const record = parsed as { id?: unknown; text?: unknown } | undefined;
  const rawId = typeof record?.id === 'string' ? record.id : null;
  const rawText = typeof record?.text === 'string' ? record.text : null;
  const hasValidPayload = rawId !== null && rawText !== null;
  const entry: FakeChatRequestRecord = {
    id: rawId ?? '',
    text: rawText ?? '',
    receivedAt: Date.now(),
    mode: shared.mode,
    status: shared.status,
    delayMs: shared.delayMs,
    clientClosed: false,
    closedAt: null,
    respondedAt: null,
    responseText: null,
    deliverError: null,
  };
  shared.requests.push(entry);
  res.on('close', () => {
    if (!res.writableEnded) {
      entry.clientClosed = true;
      entry.closedAt = Date.now();
    }
  });
  res.on('error', (error) => {
    entry.deliverError = error.message;
  });

  void (async () => {
    await delay(entry.delayMs);
    entry.respondedAt = Date.now();
    if (entry.mode === 'ok' && hasValidPayload) {
      entry.responseText = replyText(entry.text);
      try {
        sendJson(res, 200, { id: entry.id, text: entry.responseText });
      } catch (error) {
        entry.deliverError = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    const status = hasValidPayload ? entry.status : 400;
    const payload = hasValidPayload
      ? entry.mode === 'error'
        ? { id: entry.id, error: 'fake-server-error' }
        : { id: entry.id, text: replyText(entry.text) }
      : { error: 'bad-json' };
    try {
      sendJson(res, status, payload);
    } catch (error) {
      entry.deliverError = error instanceof Error ? error.message : String(error);
    }
  })();
}

/**
 * 启动假服务。port 传 0 让系统分配；返回进程内句柄（state/config/waitFor 直读内存）。
 */
export function startChatFakeServer(options?: {
  port?: number;
  mode?: ChatFakeMode;
  status?: number;
  delayMs?: number;
}): Promise<ChatFakeServer> {
  const shared: Shared = {
    mode: options?.mode ?? 'ok',
    status: options?.status ?? 500,
    delayMs: options?.delayMs ?? 0,
    startedAt: Date.now(),
    boundPort: 0,
    requests: [],
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/__health') {
      sendJson(res, 200, { ok: true, mode: shared.mode, status: shared.status, delayMs: shared.delayMs });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/__state') {
      sendJson(res, 200, snapshot(shared));
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/__config' || url.pathname === '/__reset')) {
      void readBody(req)
        .then((raw) => {
          if (url.pathname === '/__reset') {
            shared.requests = [];
            sendJson(res, 200, { ok: true });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw) as unknown;
          } catch {
            sendJson(res, 400, { error: 'bad-json' });
            return;
          }
          if (!isChatFakeConfig(parsed)) {
            sendJson(res, 400, { error: 'bad-config' });
            return;
          }
          if (parsed.mode !== undefined) shared.mode = parsed.mode;
          if (parsed.status !== undefined) shared.status = parsed.status;
          if (parsed.delayMs !== undefined) shared.delayMs = parsed.delayMs;
          sendJson(res, 200, { ok: true, mode: shared.mode, status: shared.status, delayMs: shared.delayMs });
        })
        .catch((error: unknown) => {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }
    if (req.method === 'POST') {
      void readBody(req)
        .then((raw) => handleChat(shared, req, res, raw))
        .catch((error: unknown) => {
          try {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
          } catch {
            // 客户端已断开，送不出去也无需再记。
          }
        });
      return;
    }
    sendJson(res, 404, { error: 'not-found' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options?.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      shared.boundPort = address.port;
      const api: ChatFakeServer = {
        port: shared.boundPort,
        url: `http://127.0.0.1:${shared.boundPort}`,
        state: () => snapshot(shared),
        config: (patch) => {
          if (patch.mode !== undefined) shared.mode = patch.mode;
          if (patch.status !== undefined) shared.status = patch.status;
          if (patch.delayMs !== undefined) shared.delayMs = patch.delayMs;
        },
        reset: () => {
          shared.requests = [];
        },
        waitFor: (predicate, timeoutMs, label) => waitForState(api, predicate, timeoutMs, label),
        stop: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.closeAllConnections();
            server.close((error) => {
              if (error) closeReject(error);
              else closeResolve();
            });
          }),
      };
      resolve(api);
    });
  });
}

async function waitForState(
  api: ChatFakeServer,
  predicate: (state: ChatFakeState) => boolean,
  timeoutMs: number,
  label: string,
): Promise<ChatFakeState> {
  const deadline = Date.now() + timeoutMs;
  let last = api.state();
  while (Date.now() < deadline) {
    if (predicate(last)) return last;
    await delay(25);
    last = api.state();
  }
  if (predicate(last)) return last;
  throw new Error(`${label}\nlastState=${JSON.stringify(last)}`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const args = new Map(
    process.argv.slice(2).map((item) => {
      const [key, ...rest] = item.split('=');
      return [key ?? '', rest.join('=')] as const;
    }),
  );
  const port = Number(args.get('--port') ?? '8901');
  const mode = (args.get('--mode') === 'error' ? 'error' : 'ok') as ChatFakeMode;
  const delayMs = Number(args.get('--delay') ?? '0');
  startChatFakeServer({ port, mode, delayMs })
    .then((server) => {
      process.stdout.write(`CHAT_FAKE_URL=${server.url}\n`);
      process.stdout.write(`mode=${mode} delayMs=${delayMs}\n`);
      const shutdown = () => {
        void server.stop().finally(() => process.exit(0));
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
