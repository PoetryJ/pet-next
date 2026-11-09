/**
 * M3-9 R1：会传播取消的计数代理（只用于测试；不接真实模型）。
 *
 * 先导代理的问题：它把上游响应完整缓存后一次性回包，且不传播下游取消，
 * 因此只能证明“客户端不再等”，不能证明“上游 HTTP 请求被取消”。
 * 本代理只做三件可核对的事：
 *   1. 请求只转发 1 次（没有重试路径，账本记 forwardCount=1）；
 *   2. 下游在“上游响应读完”之前断开 → destroy 上游请求并记 downstreamClosedEarly + abortedUpstream；
 *      正常读完上游响应 → completed=true，绝不误 abort；
 *   3. 上游连接在响应头之前断开 → 回 502 可读 JSON（synthesizedError=true），让失败可读而不是超时挂死。
 *
 * 与 Node 语义有关的两个坑（刻意避开）：
 *   - 不把 req 'close' 当客户端取消：请求体读完后 req 也会 close。
 *     客户端是否中途走掉一律看 res 'close' + res.writableFinished。
 *   - 不把“自己 destroy 下游/上游”记成客户端取消：selfDestroyed 标记后跳过 close 记账。
 *
 * 计数与安全：
 *   - postCount 是 getter，读时取当前值；requests 每次读取返回只读快照数组。
 *   - 只允许转发到本次注册的 fake 端口（allowedPorts，或显式 allowEphemeral:true）。
 *   - targetPort === 18872（真实服务）永远拒绝，即使调用方把它写进 allowedPorts；
 *     这就是“本轮真实推理预算为 0”的硬闸，不靠调用方自觉。
 *   - 不落凭据：账本只留请求体 sha256/字节数与状态，不保存任何 header 值或原文。
 *
 * @module pet-next/tests/support/counting-proxy
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';

/** 禁止转发的真实服务端口（本轮预算 0；写进 allowedPorts 也不放行）。 */
export const FORBIDDEN_TARGET_PORTS = Object.freeze([18872]);

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function codeOf(error) {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.message : String(error);
}

/** 校验转发目标：只允许注册过的 fake 端口；18872 无条件拒绝。 */
export function assertProxyTarget(options = {}) {
  const { targetPort, allowedPorts = [], allowEphemeral = false } = options ?? {};
  if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
    throw new Error(`counting-proxy targetPort 必须是 1-65535 的整数（收到 ${String(targetPort)}）`);
  }
  if (FORBIDDEN_TARGET_PORTS.includes(targetPort)) {
    throw new Error(
      `counting-proxy 拒绝真实服务端口 ${targetPort}：本轮真实推理预算为 0，只允许注册的 fake 端口（allowedPorts 也不能放行）`,
    );
  }
  const allowed = Array.isArray(allowedPorts) ? allowedPorts : [];
  if (allowed.includes(targetPort)) return;
  if (allowEphemeral || allowedPorts === 'ephemeral') return;
  throw new Error(
    `counting-proxy targetPort ${targetPort} 未注册（allowedPorts=${JSON.stringify(allowed)}）；` +
      '请显式注册本次 fake 端口，或传 allowEphemeral:true',
  );
}

/** 只转发请求侧的必要头；hop-by-hop 与 content-length 由本代理重算。 */
function forwardHeaders(incoming, bodyLength) {
  const out = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    out[name.toLowerCase()] = value;
  }
  if (bodyLength > 0) out['content-length'] = String(bodyLength);
  return out;
}

/** 响应头原样回给下游，只去掉 hop-by-hop（正文逐字节不改写）。 */
function downstreamHeaders(upstreamHeaders) {
  const out = {};
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === 'connection' || lower === 'keep-alive' || lower === 'transfer-encoding') continue;
    out[lower] = value;
  }
  return out;
}

/**
 * 启动计数代理。
 * @param {object} options
 * @param {number} options.targetPort 上游 fake 端口（必须是注册端口）。
 * @param {number[]|'ephemeral'} [options.allowedPorts] 本次注册的 fake 端口。
 * @param {boolean} [options.allowEphemeral] 显式允许任意 ephemeral fake 端口。
 * @param {string} [options.host='127.0.0.1'] 只允许回环。
 * @returns {Promise<object>}
 */
export async function startCountingProxy(options = {}) {
  const { targetPort, allowedPorts = [], allowEphemeral = false, host = '127.0.0.1' } = options ?? {};

  assertProxyTarget({ targetPort, allowedPorts, allowEphemeral });
  if (host !== '127.0.0.1') {
    throw new Error(`counting-proxy 只允许监听 127.0.0.1（收到 ${String(host)}）`);
  }

  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const records = [];
  const upstreams = new Set();
  let postCount = 0;
  let closed = false;
  let closePromise = null;

  function notify() {
    emitter.emit('update');
  }

  function snapshot(record) {
    return { ...record };
  }

  function stats() {
    return {
      postCount,
      total: records.length,
      forwarded: records.filter((record) => record.forwarded).length,
      completed: records.filter((record) => record.completed).length,
      downstreamClosedEarly: records.filter((record) => record.downstreamClosedEarly).length,
      abortedUpstream: records.filter((record) => record.abortedUpstream).length,
      upstreamErrors: records.filter((record) => record.upstreamError !== null).length,
      synthesizedErrors: records.filter((record) => record.synthesizedError).length,
      closed,
    };
  }

  function waitForLedger(predicate, timeoutMs = 5_000) {
    if (typeof predicate !== 'function') throw new TypeError('waitForLedger(predicate) 需要函数');
    const current = records.map(snapshot);
    if (predicate(current)) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        emitter.off('update', onUpdate);
        emitter.off('closed', onClosed);
      };
      const onUpdate = () => {
        const value = records.map(snapshot);
        if (predicate(value)) {
          cleanup();
          resolve(value);
        }
      };
      const onClosed = () => {
        cleanup();
        reject(new Error(`waitForLedger：代理已关闭；当前账本 ${JSON.stringify(stats())}`));
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`waitForLedger 超时（${timeoutMs}ms）；当前账本 ${JSON.stringify(stats())}`));
      }, timeoutMs);
      emitter.on('update', onUpdate);
      emitter.on('closed', onClosed);
    });
  }

  const server = http.createServer((req, res) => {
    if (closed) {
      res.destroy();
      return;
    }

    const record = {
      index: records.length,
      method: req.method ?? '',
      path: req.url ?? '',
      receivedAt: Date.now(),
      forwarded: false,
      forwardCount: 0,
      requestBytes: 0,
      requestSha256: null,
      upstreamStartedAt: null,
      upstreamHeadersAt: null,
      upstreamStatus: null,
      upstreamCompletedAt: null,
      completed: false,
      completedAt: null,
      requestIncomplete: false,
      downstreamClosedEarly: false,
      downstreamClosedAt: null,
      abortedUpstream: false,
      upstreamError: null,
      synthesizedError: false,
      responseBytes: 0,
      responseSha256: null,
    };
    if (record.method === 'POST') postCount += 1;
    records.push(record);
    notify();

    const chunks = [];
    let bodyDone = false;
    let selfDestroyed = false;
    let upstreamReq = null;
    let upstreamRes = null;

    res.on('error', () => {
      /* 断开的写错误记在账本；这里只防未处理 error 崩进程 */
    });
    req.on('error', () => {
      /* 同上 */
    });

    /** 下游中途走掉：abort 上游（只在上游响应尚未读完时）。 */
    const abortUpstreamIfInFlight = () => {
      if (upstreamReq === null) return;
      if (record.upstreamCompletedAt !== null) return; // 上游已读完，没有可取消的 HTTP 请求
      record.abortedUpstream = true;
      try {
        upstreamReq.destroy();
      } catch {
        /* 已断开 */
      }
      if (upstreamRes !== null) {
        try {
          upstreamRes.destroy();
        } catch {
          /* 已断开 */
        }
      }
    };

    res.on('close', () => {
      if (res.writableFinished) return; // 正常写完，不是取消
      if (selfDestroyed) return; // 本代理自己断的（上游错误），不是客户端取消
      if (closed) return;
      record.downstreamClosedEarly = true;
      record.downstreamClosedAt = Date.now();
      if (!bodyDone) record.requestIncomplete = true;
      if (!record.completed) abortUpstreamIfInFlight();
      notify();
    });

    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    req.on('close', () => {
      // 请求体读完后 req 也会 close：不能用它判定客户端取消。
      if (bodyDone) return;
      bodyDone = true;
      record.requestIncomplete = true;
      record.downstreamClosedEarly = true;
      record.downstreamClosedAt = Date.now();
      notify();
    });
    req.on('end', () => {
      if (bodyDone) return;
      bodyDone = true;
      const body = Buffer.concat(chunks);
      record.requestBytes = body.length;
      record.requestSha256 = sha256(body);
      forward(body);
    });

    /** 唯一转发路径：没有重试、没有降级；forwardCount 恒为 1。 */
    function forward(body) {
      record.forwarded = true;
      record.forwardCount += 1;
      record.upstreamStartedAt = Date.now();

      upstreamReq = http.request(
        {
          host: '127.0.0.1',
          port: targetPort,
          method: req.method,
          path: req.url ?? '/',
          headers: forwardHeaders(req.headers, body.length),
          agent: false,
        },
        (response) => {
          upstreamRes = response;
          record.upstreamHeadersAt = Date.now();
          record.upstreamStatus = response.statusCode ?? null;

          const hash = createHash('sha256');
          response.on('data', (chunk) => {
            record.responseBytes += chunk.length;
            hash.update(chunk);
          });
          response.on('end', () => {
            record.responseSha256 = hash.digest('hex');
            record.upstreamCompletedAt = Date.now();
            record.completed = true;
            record.completedAt = record.upstreamCompletedAt;
            notify();
          });
          response.on('error', (error) => {
            record.upstreamError = codeOf(error);
            notify();
          });

          try {
            res.writeHead(response.statusCode ?? 502, downstreamHeaders(response.headers));
            // 上游可能先发头再挂正文：必须立刻把已收到的头转给下游，
            // 否则下游看不到“headers-sent”这个可观测状态（也会让挂起正文用例无法判定）。
            res.flushHeaders();
          } catch (error) {
            record.upstreamError = codeOf(error);
            selfDestroyed = true;
            res.destroy();
            notify();
            return;
          }
          // 直接 pipe：不缓存、不改写任何一个字节。
          response.pipe(res);
        },
      );

      upstreamReq.on('error', (error) => {
        record.upstreamError = codeOf(error);
        if (record.downstreamClosedEarly) {
          // 这个 error 是自己 abort 上游引起的，不是上游故障。
          notify();
          return;
        }
        if (res.headersSent) {
          selfDestroyed = true;
          try {
            res.destroy();
          } catch {
            /* 已断开 */
          }
          notify();
          return;
        }
        if (res.destroyed) {
          notify();
          return;
        }
        // 响应头之前上游就断了：给下游一个可读错误（不是超时挂死），仍只有 1 次转发。
        const payload = JSON.stringify({
          error: 'upstream-error',
          code: record.upstreamError,
          proxy: 'counting-proxy',
        });
        record.synthesizedError = true;
        record.completedAt = Date.now();
        try {
          res.writeHead(502, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(Buffer.byteLength(payload, 'utf8')),
          });
          res.end(payload);
        } catch (writeError) {
          record.upstreamError = `${record.upstreamError}; write: ${codeOf(writeError)}`;
        }
        notify();
      });

      upstreams.add(upstreamReq);
      upstreamReq.on('close', () => upstreams.delete(upstreamReq));
      upstreamReq.end(body);
    }
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
    server.listen(0, host);
  });

  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;
  if (port === targetPort) {
    server.close();
    throw new Error(`counting-proxy 监听端口与 targetPort 相同（${port}），会自环`);
  }

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    targetPort,
    /** getter：每次读都取当前计数，不要解构后长期缓存。 */
    get postCount() {
      return postCount;
    },
    get requests() {
      return records.map(snapshot);
    },
    stats,
    waitForLedger,
    close() {
      if (closePromise !== null) return closePromise;
      closed = true;
      for (const upstreamReq of upstreams) {
        try {
          upstreamReq.destroy();
        } catch {
          /* 已断开 */
        }
      }
      upstreams.clear();
      emitter.emit('closed');
      closePromise = new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      return closePromise;
    },
  };
}
