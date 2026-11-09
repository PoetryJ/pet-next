/**
 * M3-9 R1：隐藏聊天故障链的受控 fake 服务（只用于测试；不接真实模型、不消耗真实预算）。
 *
 * 与 tests/support/fake-model-service.mjs 并列新增，不改旧文件；旧服务只能按环境变量做“固定延迟/固定错误”，
 * 本模块把“回包时机”变成显式屏障：每个请求可按 plan 指定模式，支持
 *   收到请求 → 阻塞 → 释放/断连/挂正文/迟到回包 的顺序化故障矩阵。
 *
 * 协议（同时兼容两种既有 Provider，便于 C 直接接正式入口）：
 *   POST /  |  /chat/completions  |  /v1/chat/completions （任意以 /chat/completions 结尾的路径也接受）
 *     - 演示 http-provider 只读顶层 text；qwen-provider 只读 choices[0].message.content。
 *     - 两者在同一份 JSON 里给出（多出的字段对被忽略方无害），同一个 fake 可同时服务两条链路。
 *   GET /models | /v1/models → OpenAI 兼容模型列表（不计入 requests；不是聊天 POST）。
 *   其余路径 404 JSON（不计入 requests）。
 *
 * 每请求模式（plan 条目，字符串或对象；缺省按 defaultMode='ok'）：
 *   ok               立即 200 + OpenAI 形状（finish_reason='stop'）
 *   delay            收到完整请求体后阻塞，直到 release(index)；可用 {delayMs} 自动释放
 *   headers-sent     先发响应头（含 content-length）再挂起正文，直到 release(index)；可用 {delayMs}
 *                    （任何模式都可加 {chars} 指定长正文，例如“2s 延迟 + 2001 字符”）
 *   body-hold        headers-sent 的别名
 *   reset            写响应前 destroy socket（模拟上游连接重置）
 *   long             正文恰好 {chars} 个字符（默认 2000；C 用 2000/2001 覆盖截断边界）
 *   length           finish_reason='length'（截断元信息）
 *   late-ignore-abort 忽略客户端 abort，{ignoreAbortMs}（默认 120ms）后仍尝试回包，用于模块负控
 *
 * 账本（requests 快照）记录：序号、id、收到/解析/释放/完成时间、模式、请求体 sha256 与字节数、
 * userText、状态、客户端是否在响应完成前断开、响应正文 sha256 与字节数、finish_reason、写入错误。
 * 不落凭据：只记 hasAuthorization 布尔，不保存任何 header 值。
 *
 * 等待一律用事件/屏障（waitForRequest / waitForCompletion / release），不以固定 sleep 作主判据。
 * 安全：默认且仅允许监听 127.0.0.1:0（端口 0 = 内核分配），不暴露外网。
 * @module pet-next/tests/support/hidden-chat-fake-server
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';

/** 可编程模式清单（供 C/文档引用；body-hold 是 headers-sent 的别名）。 */
export const HIDDEN_CHAT_FAKE_MODES = Object.freeze([
  'ok',
  'delay',
  'headers-sent',
  'body-hold',
  'reset',
  'long',
  'length',
  'late-ignore-abort',
]);

const MODES = new Set(HIDDEN_CHAT_FAKE_MODES);
const GATED_MODES = new Set(['delay', 'headers-sent']);
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_LONG_CHARS = 2_000;
const DEFAULT_IGNORE_ABORT_MS = 120;
const DEFAULT_MODEL_ID = 'qwen3.8-27b';

/** 请求体 sha256（只留哈希，不落原文与凭据）。 */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function codeOf(error) {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.message : String(error);
}

/** 去掉查询串，只按路径匹配。 */
function pathnameOf(rawUrl) {
  const value = typeof rawUrl === 'string' ? rawUrl : '/';
  const cut = value.indexOf('?');
  return cut === -1 ? value : value.slice(0, cut);
}

function isChatPath(pathname) {
  return pathname === '/' || pathname.endsWith('/chat/completions');
}

/** 演示 Provider 用 {text}、qwen Provider 用 messages[]；两种都抽最后一条 user 文本。 */
function extractUserText(payload) {
  if (payload !== null && typeof payload === 'object') {
    if (Array.isArray(payload.messages)) {
      const last = [...payload.messages]
        .reverse()
        .find((message) => message !== null && typeof message === 'object' && message.role === 'user');
      if (last !== undefined && typeof last.content === 'string') return last.content;
    }
    if (typeof payload.text === 'string') return payload.text;
  }
  return '';
}

function normalizeEntry(entry, position) {
  const raw = typeof entry === 'string' ? { mode: entry } : entry;
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError(`plan[${position}] 必须是模式字符串或对象`);
  }
  if (typeof raw.mode !== 'string' || !MODES.has(raw.mode)) {
    throw new TypeError(`plan[${position}] 未知模式: ${String(raw.mode)}；可选 ${HIDDEN_CHAT_FAKE_MODES.join('|')}`);
  }
  const normalized = { mode: raw.mode === 'body-hold' ? 'headers-sent' : raw.mode };
  if (raw.chars !== undefined) {
    if (!Number.isInteger(raw.chars) || raw.chars < 1) throw new TypeError(`plan[${position}].chars 必须是正整数`);
    normalized.chars = raw.chars;
  } else if (normalized.mode === 'long') {
    normalized.chars = DEFAULT_LONG_CHARS;
  }
  if (raw.delayMs !== undefined) {
    if (typeof raw.delayMs !== 'number' || !Number.isFinite(raw.delayMs) || raw.delayMs < 0) {
      throw new TypeError(`plan[${position}].delayMs 必须是非负数`);
    }
    normalized.delayMs = raw.delayMs;
  }
  if (raw.ignoreAbortMs !== undefined) {
    if (typeof raw.ignoreAbortMs !== 'number' || !Number.isFinite(raw.ignoreAbortMs) || raw.ignoreAbortMs < 0) {
      throw new TypeError(`plan[${position}].ignoreAbortMs 必须是非负数`);
    }
    normalized.ignoreAbortMs = raw.ignoreAbortMs;
  } else if (normalized.mode === 'late-ignore-abort') {
    normalized.ignoreAbortMs = DEFAULT_IGNORE_ABORT_MS;
  }
  if (raw.responseId !== undefined) normalized.responseId = String(raw.responseId);
  return normalized;
}

/**
 * 启动受控 fake 服务。
 * @param {object} [options]
 * @param {number} [options.port=0] 监听端口；0 = 内核分配（默认，测试互相隔离）。
 * @param {string} [options.host='127.0.0.1'] 只允许回环。
 * @param {string} [options.modelId] /models 与响应体里的 model。
 * @param {string} [options.defaultMode='ok'] plan 耗尽后的模式。
 * @param {Array<string|object>|string|object} [options.plan] 初始请求模式队列。
 * @param {string} [options.responseId] 响应体 id。
 * @returns {Promise<object>} HiddenChatFakeServer
 */
export async function startHiddenChatFakeServer(options = {}) {
  const {
    port: requestedPort = 0,
    host = '127.0.0.1',
    modelId = DEFAULT_MODEL_ID,
    defaultMode = 'ok',
    plan: initialPlan,
    responseId = 'hidden-fake-chat',
  } = options ?? {};

  if (host !== '127.0.0.1') {
    throw new Error(`hidden-chat-fake-server 只允许监听 127.0.0.1（收到 ${String(host)}）：不得暴露外网`);
  }
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error(`hidden-chat-fake-server port 必须是 0-65535 的整数（收到 ${String(requestedPort)}）`);
  }
  if (typeof defaultMode !== 'string' || !MODES.has(defaultMode)) {
    throw new Error(`hidden-chat-fake-server defaultMode 未知: ${String(defaultMode)}`);
  }

  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  /** 每请求账本（内部记录，对外只给快照）。 */
  const records = [];
  const timers = new Set();
  let planned = [];
  let cursor = 0;
  let closed = false;
  let closePromise = null;

  function notify() {
    emitter.emit('update');
  }

  function snapshot(record) {
    const copy = {};
    for (const [key, value] of Object.entries(record)) {
      if (!key.startsWith('__')) copy[key] = value;
    }
    return copy;
  }

  function plan(entries) {
    const list = Array.isArray(entries) ? entries : [entries];
    planned = list.map((entry, index) => normalizeEntry(entry, index));
    cursor = 0;
    return planned.length;
  }

  if (initialPlan !== undefined) plan(initialPlan);

  function nextEntry() {
    if (cursor < planned.length) {
      const entry = planned[cursor];
      cursor += 1;
      return entry;
    }
    cursor += 1;
    return { mode: defaultMode };
  }

  function buildResponse(record, entry) {
    const finishReason = entry.mode === 'length' ? 'length' : 'stop';
    let content;
    if (typeof entry.chars === 'number') {
      // 任意模式都可加 chars：便于“延迟/挂起 + 长正文”组合（C 的第①类）。
      content = '长'.repeat(entry.chars);
    } else if (entry.mode === 'length') {
      content = `截断回复：${record.userText.slice(0, 8)}`;
    } else {
      content = `隧道回复：${record.userText.slice(0, 24)}`;
    }
    const payload = {
      id: entry.responseId ?? responseId,
      object: 'chat.completion',
      model: modelId,
      created: Math.floor(Date.now() / 1000),
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: finishReason,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      // 兼容演示 http-provider（只认顶层 text 字段）；OpenAI 解析器忽略该额外字段。
      text: content,
    };
    const body = JSON.stringify(payload);
    return { payload, content, finishReason, body, bytes: Buffer.byteLength(body, 'utf8') };
  }

  function finish(record, status, extra = {}) {
    Object.assign(record, extra);
    record.status = status;
    if (record.completedAt === null) record.completedAt = Date.now();
    notify();
  }

  function responseHeaders(bytes) {
    return { 'content-type': 'application/json; charset=utf-8', 'content-length': String(bytes) };
  }

  /** 写响应头 + 正文（ok/long/length/delay 释放后/迟到回包）。 */
  function writeHeadAndBody(record, built, res) {
    if (res.destroyed || res.writableEnded) {
      record.skippedWrite = 'client-closed';
      finish(record, record.clientAborted ? 'aborted' : 'write-failed');
      return;
    }
    try {
      res.writeHead(200, responseHeaders(built.bytes));
      record.headersSentAt = Date.now();
      res.end(built.body);
      record.bodySentAt = Date.now();
      finish(record, record.clientAborted ? 'completed-late' : 'completed');
    } catch (error) {
      record.writeError = codeOf(error);
      finish(record, 'write-failed');
    }
  }

  /** 只发响应头，正文留到 release（body-hold）。 */
  function writeHeadersOnly(record, built, res) {
    try {
      res.writeHead(200, responseHeaders(built.bytes));
      res.flushHeaders();
      record.headersSentAt = Date.now();
      notify();
      return true;
    } catch (error) {
      record.writeError = codeOf(error);
      finish(record, 'write-failed');
      return false;
    }
  }

  /** 已发头、release 后补正文（body-hold）。 */
  function writeHeldBody(record, built, res) {
    if (res.destroyed || res.writableEnded) {
      record.skippedWrite = 'client-closed';
      finish(record, record.clientAborted ? 'aborted' : 'write-failed');
      return;
    }
    try {
      res.end(built.body);
      record.bodySentAt = Date.now();
      finish(record, record.clientAborted ? 'completed-late' : 'completed');
    } catch (error) {
      record.writeError = codeOf(error);
      finish(record, 'write-failed');
    }
  }


  function releaseRecord(record) {
    const gate = record.__gate;
    if (gate === undefined || gate.released) return false;
    gate.released = true;
    if (gate.timer !== null) {
      clearTimeout(gate.timer);
      timers.delete(gate.timer);
      gate.timer = null;
    }
    record.releasedAt = Date.now();
    const waiters = gate.waiters.splice(0);
    for (const waiter of waiters) waiter();
    notify();
    return true;
  }

  function createGate(record, entry) {
    const gate = { released: false, waiters: [], timer: null };
    record.__gate = gate;
    if (typeof entry.delayMs === 'number') {
      const timer = setTimeout(() => {
        timers.delete(timer);
        gate.timer = null;
        releaseRecord(record);
      }, entry.delayMs);
      gate.timer = timer;
      timers.add(timer);
    }
    return gate;
  }

  /** 不给序号=释放全部等待中的请求；给序号=只释放该请求（非屏障模式返回 false）。 */
  function release(index) {
    if (index === undefined) {
      if (records.length === 0) {
        throw new Error('release() 尚无任何请求：请先 await waitForRequest(n)，或用 plan 中的 delayMs');
      }
      let released = 0;
      for (const record of records) {
        if (record.__gate !== undefined && releaseRecord(record)) released += 1;
      }
      return released;
    }
    if (!Number.isInteger(index) || index < 0) throw new TypeError(`release(${String(index)}) 需要非负整数序号`);
    const record = records[index];
    if (record === undefined) {
      throw new Error(`release(${index}) 没有对应请求：当前已收到 ${records.length} 个（先用 waitForRequest 等屏障）`);
    }
    if (record.__gate === undefined) return false;
    return releaseRecord(record);
  }

  function stats() {
    const byMode = {};
    let completed = 0;
    let completedLate = 0;
    let aborted = 0;
    let reset = 0;
    let writeFailed = 0;
    let pending = 0;
    let requestBytes = 0;
    let responseBytes = 0;
    let clientAborted = 0;
    for (const record of records) {
      byMode[record.mode] = (byMode[record.mode] ?? 0) + 1;
      if (record.status === 'completed') completed += 1;
      else if (record.status === 'completed-late') completedLate += 1;
      else if (record.status === 'aborted') aborted += 1;
      else if (record.status === 'reset') reset += 1;
      else if (record.status === 'write-failed') writeFailed += 1;
      else pending += 1;
      if (record.clientAborted) clientAborted += 1;
      requestBytes += record.requestBytes;
      responseBytes += record.responseBodyBytes;
    }
    return {
      total: records.length,
      parsed: records.filter((record) => record.parsedAt !== null).length,
      pending,
      completed,
      completedLate,
      aborted,
      reset,
      writeFailed,
      clientAborted,
      requestBytes,
      responseBytes,
      byMode,
      closed,
    };
  }

  function waitFor(predicate, timeoutMs, label) {
    const immediate = predicate();
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        emitter.off('update', onUpdate);
        emitter.off('closed', onClosed);
      };
      const onUpdate = () => {
        const value = predicate();
        if (value) {
          cleanup();
          resolve(value);
        }
      };
      const onClosed = () => {
        cleanup();
        reject(new Error(`${label}：fake 服务已关闭；当前状态 ${JSON.stringify(stats())}`));
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${label} 超时（${timeoutMs}ms）；当前状态 ${JSON.stringify(stats())}`));
      }, timeoutMs);
      emitter.on('update', onUpdate);
      emitter.on('closed', onClosed);
    });
  }

  /** 等至少 count 个请求“完整收到”（请求头 + 请求体解析完成），返回全部请求快照。 */
  function waitForRequest(count, timeoutMs = DEFAULT_WAIT_MS) {
    if (!Number.isInteger(count) || count < 1) throw new TypeError(`waitForRequest(count) 需要正整数（收到 ${String(count)}）`);
    return waitFor(
      () => {
        const parsed = records.filter((record) => record.parsedAt !== null);
        return parsed.length >= count ? parsed.map(snapshot) : null;
      },
      timeoutMs,
      `waitForRequest(${count})`,
    );
  }

  /** 等某个请求进入终态（completed/completed-late/aborted/reset/write-failed）。 */
  function waitForCompletion(index, timeoutMs = DEFAULT_WAIT_MS) {
    if (!Number.isInteger(index) || index < 0) {
      throw new TypeError(`waitForCompletion(index) 需要非负整数（收到 ${String(index)}）`);
    }
    return waitFor(
      () => {
        const record = records[index];
        return record !== undefined && record.status !== 'pending' ? snapshot(record) : null;
      },
      timeoutMs,
      `waitForCompletion(${index})`,
    );
  }

  function startResponse(record, entry, res) {
    res.on('close', () => {
      if (res.writableFinished) return;
      // reset 是服务端主动断开，不能记成客户端取消。
      if (record.mode === 'reset' && record.status === 'reset') return;
      if (record.status !== 'pending') return;
      record.clientAborted = true;
      record.abortedAt = Date.now();
      record.downstreamClosedEarly = true;
      if (entry.mode !== 'late-ignore-abort') {
        record.status = 'aborted';
        record.completedAt = record.abortedAt;
      }
      notify();
    });

    if (entry.mode === 'reset') {
      record.completedAt = Date.now();
      finish(record, 'reset');
      try {
        res.destroy();
      } catch {
        /* 目的就是断开；忽略 */
      }
      return;
    }

    if (entry.mode === 'late-ignore-abort') {
      const timer = setTimeout(() => {
        timers.delete(timer);
        record.lateAttemptAt = Date.now();
        record.lateAfterAbort = record.clientAborted === true;
        writeHeadAndBody(record, buildResponse(record, entry), res);
      }, entry.ignoreAbortMs);
      timers.add(timer);
      return;
    }

    const built = buildResponse(record, entry);
    // 服务端产出的正文（无论是否送达）：逐字节核对用 sha256/字节数。
    record.responseBody = built.body;
    record.responseBodySha256 = sha256(Buffer.from(built.body, 'utf8'));
    record.responseBodyBytes = built.bytes;
    record.responseText = built.content;
    record.finishReason = built.finishReason;

    if (GATED_MODES.has(entry.mode)) {
      const gate = createGate(record, entry);
      if (entry.mode === 'headers-sent' && !writeHeadersOnly(record, built, res)) return;
      gate.waiters.push(() => {
        if (entry.mode === 'headers-sent') writeHeldBody(record, built, res);
        else writeHeadAndBody(record, built, res);
      });
      return;
    }

    writeHeadAndBody(record, built, res);
  }

  function handleChat(req, res) {
    const entry = nextEntry();
    const index = records.length;
    const record = {
      index,
      id: '',
      receivedAt: Date.now(),
      parsedAt: null,
      mode: entry.mode,
      bodySha256: null,
      requestBytes: 0,
      userText: '',
      model: '',
      hasAuthorization: req.headers.authorization !== undefined,
      releasedAt: null,
      headersSentAt: null,
      bodySentAt: null,
      completedAt: null,
      abortedAt: null,
      lateAttemptAt: null,
      lateAfterAbort: null,
      clientAborted: false,
      downstreamClosedEarly: false,
      requestIncomplete: false,
      skippedWrite: null,
      writeError: null,
      responseBody: null,
      responseText: null,
      responseBodySha256: null,
      responseBodyBytes: 0,
      finishReason: null,
      status: 'pending',
    };
    records.push(record);
    notify();

    const chunks = [];
    let bodyDone = false;

    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    req.on('close', () => {
      // 注意：请求体读完后 req 也会 close，不能用它判定客户端取消；这里只处理“体没读完就断”。
      if (bodyDone) return;
      bodyDone = true;
      record.requestIncomplete = true;
      record.clientAborted = true;
      record.abortedAt = Date.now();
      record.downstreamClosedEarly = true;
      finish(record, 'aborted');
    });
    req.on('end', () => {
      if (bodyDone) return;
      bodyDone = true;
      const raw = Buffer.concat(chunks);
      record.requestBytes = raw.length;
      record.bodySha256 = sha256(raw);
      record.parsedAt = Date.now();
      try {
        const payload = JSON.parse(raw.toString('utf8'));
        if (payload !== null && typeof payload === 'object') {
          if (typeof payload.id === 'string') record.id = payload.id;
          if (typeof payload.model === 'string') record.model = payload.model;
          record.userText = extractUserText(payload);
        }
      } catch {
        /* 非 JSON 也照常记账，正文按空串处理 */
      }
      notify();
      startResponse(record, entry, res);
    });
  }

  function respondJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body, 'utf8')),
    });
    res.end(body);
  }

  const server = http.createServer((req, res) => {
    res.on('error', () => {
      /* 连接断开的写错误由账本记录，这里只防未处理 error 崩进程 */
    });
    req.on('error', () => {
      /* 同上 */
    });
    const pathname = pathnameOf(req.url);
    if (req.method === 'GET' && (pathname === '/models' || pathname === '/v1/models')) {
      respondJson(res, 200, { object: 'list', data: [{ id: modelId, object: 'model' }] });
      return;
    }
    if (req.method === 'POST' && isChatPath(pathname)) {
      handleChat(req, res);
      return;
    }
    respondJson(res, 404, { error: 'not-found', path: pathname });
  });

  server.on('error', () => {
    /* listen 失败由下面的 Promise 捕获；运行期错误不崩进程 */
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, host);
  });

  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    /** 便于 qwen-provider 直接使用：baseUrl 指向 /v1。 */
    baseUrl: `http://127.0.0.1:${port}/v1`,
    get requests() {
      return records.map(snapshot);
    },
    plan,
    release,
    waitForRequest,
    waitForCompletion,
    stats,
    close() {
      if (closePromise !== null) return closePromise;
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const record of records) {
        if (record.__gate !== undefined) releaseRecord(record);
      }
      emitter.emit('closed');
      closePromise = new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      return closePromise;
    },
  };
}
