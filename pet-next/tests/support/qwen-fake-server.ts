/**
 * Qwen 真实服务的本地假替身（OpenAI 兼容 /v1/chat/completions），零真实调用。
 *
 * 用途：在花真实调用预算之前，验证 Qwen Provider 的请求体是否符合冻结契约、
 * 以及链路故障（HTTP 失败 / 慢响应超时 / 畸形 JSON / 空 content / finish_reason=length /
 * 连接被重置）在会话状态机上的映射是否符合预期。
 *
 * 协议（与契约 contracts/chat.ts 对齐）：
 *   POST {base}/chat/completions  body:
 *     { model, messages:[{role:'system'|'user',content}], stream:false,
 *       max_tokens, temperature, chat_template_kwargs:{enable_thinking:false} }
 *   GET  {base}/models             → {"object":"list","data":[{"id":"qwen3.8-27b"}]}
 *   GET  /__health                 → 当前行为参数
 *   POST /__config {behavior,status,delayMs,replyText} → 回显
 *   GET  /__state                  → 全部请求观测（请求体快照、断开、响应送达）
 *   POST /__reset                  → 清空记录
 *
 * 行为在请求到达时快照，之后的 /__config 不影响已在途请求（与 M3-0 fake 服务口径一致）。
 * 客户端断开不中断处理：延迟到期仍产出响应并记录送达失败，用于证明"取消/关窗后的迟到响应不上屏"。
 *
 * 直接运行：node --experimental-strip-types tests/support/qwen-fake-server.ts --port=8902
 * @module pet-next/tests/support/qwen-fake-server
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

/** 假服务行为：成功 / 可编程 HTTP 错误 / 慢响应 / 畸形 JSON / 空 content / 截断 / 连接重置。 */
export type QwenFakeBehavior = 'ok' | 'http-error' | 'slow' | 'bad-json' | 'empty-content' | 'truncated' | 'reset';

/** 一条请求的观测记录（请求体原样 + 生命周期时刻）。 */
export interface QwenFakeRequestRecord {
  /** 本进程内自增序号（从 1 开始）。 */
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly receivedAt: number;
  readonly rawBody: string;
  /** 请求体解析结果；非 JSON 时为 null（不编造）。 */
  readonly body: unknown;
  /** 便于断言的请求体摘要（缺字段为 null）。 */
  readonly model: string | null;
  readonly stream: boolean | null;
  readonly maxTokens: number | null;
  readonly temperature: number | null;
  readonly enableThinking: boolean | null;
  readonly systemPrompt: string | null;
  readonly userPrompt: string | null;
  readonly messageRoles: readonly string[];
  /** 到达时快照的行为。 */
  readonly behavior: QwenFakeBehavior;
  readonly status: number;
  readonly delayMs: number;
  /** 客户端在响应完成前断开（取消/关窗/进程死亡）。 */
  clientClosed: boolean;
  closedAt: number | null;
  /** 延迟到期、服务端产出响应的时刻（无论是否送达）。 */
  respondedAt: number | null;
  responseText: string | null;
  /** 响应写出口径失败；null=成功写回。 */
  deliverError: string | null;
}

export interface QwenFakeState {
  readonly behavior: QwenFakeBehavior;
  readonly status: number;
  readonly delayMs: number;
  readonly port: number;
  readonly startedAt: number;
  readonly requests: readonly QwenFakeRequestRecord[];
}

export interface QwenFakeConfig {
  behavior?: QwenFakeBehavior;
  status?: number;
  delayMs?: number;
}

export interface QwenFakeServer {
  /** 服务根地址（不含 /v1），如 http://127.0.0.1:8902 。 */
  readonly url: string;
  /** 服务根地址 + /v1（Provider 的 baseUrl 口径）。 */
  readonly baseUrl: string;
  readonly port: number;
  state(): QwenFakeState;
  config(patch: QwenFakeConfig): void;
  reset(): void;
  waitFor(predicate: (state: QwenFakeState) => boolean, timeoutMs: number, label: string): Promise<QwenFakeState>;
  stop(): Promise<void>;
}

/** 默认回复文本：短、中文、无虚构能力。 */
const DEFAULT_REPLY_TEXT = '我在呢，今天累不累？想聊什么都可以。';

interface Shared {
  behavior: QwenFakeBehavior;
  status: number;
  delayMs: number;
  replyText: string;
  startedAt: number;
  boundPort: number;
  seq: number;
  requests: QwenFakeRequestRecord[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** 宽松解析：非法 JSON 返回 null（不抛），由调用方按"请求体不合法"处理。 */
function parseJsonOrNull(raw: string): unknown {
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** 从 messages 里取 system / user 第一条文本，用于断言契约（不猜、缺失即 null）。 */
function pickMessages(body: unknown): {
  roles: string[];
  system: string | null;
  user: string | null;
} {
  const record = asRecord(body);
  const messages = record?.messages;
  if (!Array.isArray(messages)) return { roles: [], system: null, user: null };
  const roles: string[] = [];
  let system: string | null = null;
  let user: string | null = null;
  for (const item of messages) {
    const entry = asRecord(item);
    const role = typeof entry?.role === 'string' ? entry.role : '';
    const content = typeof entry?.content === 'string' ? entry.content : null;
    if (role !== '') roles.push(role);
    if (role === 'system' && system === null && content !== null) system = content;
    if (role === 'user' && user === null && content !== null) user = content;
  }
  return { roles, system, user };
}

/** OpenAI 兼容成功响应体；usage 在 no-usage 场景下由调用方删掉。 */
function completionPayload(shared: Shared, truncated: boolean): Record<string, unknown> {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'qwen3.8-27b',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: shared.replyText },
        finish_reason: truncated ? 'length' : 'stop',
      },
    ],
    usage: { prompt_tokens: 42, completion_tokens: 18, total_tokens: 60 },
  };
}

function isConfig(value: unknown): value is QwenFakeConfig {
  const record = asRecord(value);
  if (record === null) return false;
  const behaviors = ['ok', 'http-error', 'slow', 'bad-json', 'empty-content', 'truncated', 'reset'];
  return (
    (record.behavior === undefined || (typeof record.behavior === 'string' && behaviors.includes(record.behavior))) &&
    (record.status === undefined || (typeof record.status === 'number' && record.status > 0)) &&
    (record.delayMs === undefined || (typeof record.delayMs === 'number' && record.delayMs >= 0))
  );
}

function snapshot(shared: Shared): QwenFakeState {
  return {
    behavior: shared.behavior,
    status: shared.status,
    delayMs: shared.delayMs,
    port: shared.boundPort,
    startedAt: shared.startedAt,
    requests: shared.requests.map((entry) => ({ ...entry })),
  };
}

/** 处理一次 /chat/completions：先记录到达快照，再按行为产出（客户端断开照常产出）。 */
function handleCompletion(shared: Shared, req: IncomingMessage, res: ServerResponse, raw: string): void {
  const parsed = parseJsonOrNull(raw);
  const record = asRecord(parsed);
  const template = asRecord(record?.chat_template_kwargs);
  const messages = pickMessages(parsed);
  shared.seq += 1;
  const entry: QwenFakeRequestRecord = {
    seq: shared.seq,
    method: req.method ?? '',
    path: req.url ?? '',
    receivedAt: Date.now(),
    rawBody: raw,
    body: parsed,
    model: typeof record?.model === 'string' ? record.model : null,
    stream: typeof record?.stream === 'boolean' ? record.stream : null,
    maxTokens: typeof record?.max_tokens === 'number' ? record.max_tokens : null,
    temperature: typeof record?.temperature === 'number' ? record.temperature : null,
    enableThinking:
      template !== null && typeof template.enable_thinking === 'boolean' ? template.enable_thinking : null,
    systemPrompt: messages.system,
    userPrompt: messages.user,
    messageRoles: messages.roles,
    behavior: shared.behavior,
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
  res.on('error', (error: Error) => {
    entry.deliverError = error.message;
  });

  void (async () => {
    await delay(entry.delayMs);
    entry.respondedAt = Date.now();
    try {
      switch (entry.behavior) {
        case 'reset':
          // 模拟连接被对端重置：不发任何响应直接销毁 socket。
          res.destroy();
          entry.deliverError = 'socket-reset';
          return;
        case 'bad-json':
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"choices":[{"message":');
          return;
        case 'http-error':
          sendJson(res, entry.status, { error: { message: 'fake-upstream-error', type: 'server_error' } });
          return;
        case 'empty-content': {
          const payload = completionPayload(shared, false);
          const choices = payload.choices as Array<Record<string, unknown>>;
          (choices[0] ?? {}).message = { role: 'assistant', content: '' };
          entry.responseText = '';
          sendJson(res, 200, payload);
          return;
        }
        case 'truncated': {
          entry.responseText = shared.replyText;
          sendJson(res, 200, completionPayload(shared, true));
          return;
        }
        case 'slow':
        case 'ok':
        default: {
          entry.responseText = shared.replyText;
          sendJson(res, 200, completionPayload(shared, false));
          return;
        }
      }
    } catch (error) {
      entry.deliverError = error instanceof Error ? error.message : String(error);
    }
  })();
}

/**
 * 启动假 Qwen 服务。port 传 0 让系统分配；返回进程内句柄（state/config/waitFor 直读内存）。
 */
export function startQwenFakeServer(options?: {
  port?: number;
  behavior?: QwenFakeBehavior;
  status?: number;
  delayMs?: number;
  replyText?: string;
}): Promise<QwenFakeServer> {
  const shared: Shared = {
    behavior: options?.behavior ?? 'ok',
    status: options?.status ?? 500,
    delayMs: options?.delayMs ?? 0,
    replyText: options?.replyText ?? DEFAULT_REPLY_TEXT,
    startedAt: Date.now(),
    boundPort: 0,
    seq: 0,
    requests: [],
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/__health') {
      sendJson(res, 200, { ok: true, behavior: shared.behavior, status: shared.status, delayMs: shared.delayMs });
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
            shared.seq = 0;
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
          if (!isConfig(parsed)) {
            sendJson(res, 400, { error: 'bad-config' });
            return;
          }
          if (parsed.behavior !== undefined) shared.behavior = parsed.behavior;
          if (parsed.status !== undefined) shared.status = parsed.status;
          if (parsed.delayMs !== undefined) shared.delayMs = parsed.delayMs;
          sendJson(res, 200, { ok: true, behavior: shared.behavior, status: shared.status, delayMs: shared.delayMs });
        })
        .catch((error: unknown) => {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      sendJson(res, 200, { object: 'list', data: [{ id: 'qwen3.8-27b', object: 'model', owned_by: 'fake' }] });
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      void readBody(req)
        .then((raw) => handleCompletion(shared, req, res, raw))
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
      const api: QwenFakeServer = {
        port: shared.boundPort,
        url: `http://127.0.0.1:${shared.boundPort}`,
        baseUrl: `http://127.0.0.1:${shared.boundPort}/v1`,
        state: () => snapshot(shared),
        config: (patch) => {
          if (patch.behavior !== undefined) shared.behavior = patch.behavior;
          if (patch.status !== undefined) shared.status = patch.status;
          if (patch.delayMs !== undefined) shared.delayMs = patch.delayMs;
        },
        reset: () => {
          shared.requests = [];
          shared.seq = 0;
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
  api: QwenFakeServer,
  predicate: (state: QwenFakeState) => boolean,
  timeoutMs: number,
  label: string,
): Promise<QwenFakeState> {
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
  const port = Number(args.get('--port') ?? '8902');
  const behavior = (args.get('--behavior') ?? 'ok') as QwenFakeBehavior;
  const delayMs = Number(args.get('--delay') ?? '0');
  startQwenFakeServer({ port, behavior, delayMs })
    .then((server) => {
      process.stdout.write(`QWEN_FAKE_BASE_URL=${server.baseUrl}\n`);
      process.stdout.write(`behavior=${behavior} delayMs=${delayMs}\n`);
      const shutdown = (): void => {
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
