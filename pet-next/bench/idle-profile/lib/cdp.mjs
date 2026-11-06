/**
 * M3-8 C：最小 CDP 客户端（只用于 bench 侧观测/注入，不碰产品源码）。
 *
 * 与 tests/platform/session.ts 同一套原生 WebSocket 用法；这里额外提供
 * evaluate（可带超时）与 Input 合成点击，供隐藏态实验与回应延迟测量。
 * @module pet-next/bench/idle-profile/lib/cdp
 */
import net from 'node:net';

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('no port'));
      server.close(() => resolve(address.port));
    });
  });
}

/** 等页面 target：只取 type=page 的第一个（产品窗只有一个页面）。 */
export async function waitForPageSocket(debugPort, isDead, deadlineMs, onTick) {
  let lastError = 'no targets';
  while (Date.now() < deadlineMs) {
    if (isDead()) throw new Error('入口提前退出');
    try {
      const list = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) ?? [];
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
      lastError = JSON.stringify(list.map((item) => item.type));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (onTick) await onTick();
    else await delay(250);
  }
  throw new Error(`CDP 页面 ${debugPort} 未就绪：${lastError}`);
}

export async function connectCdp(url) {
  const ws = new WebSocket(url);
  let next = 0;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cdp connect timeout: ${url}`)), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`cdp connect failed: ${url}`));
    });
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? 'cdp error'));
    else waiter.resolve(message.result);
  });
  const closed = new Promise((resolve) => ws.addEventListener('close', resolve));
  return {
    /** 所有调用都带超时：renderer 卡死时必须留失败记录，不能把整轮挂住。 */
    send(method, params, timeoutMs = 8000) {
      const id = next + 1;
      next = id;
      const call = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
      const timer = delay(timeoutMs).then(() => {
        pending.delete(id);
        throw new Error(`cdp ${method} timeout ${timeoutMs}ms`);
      });
      return Promise.race([call, timer]);
    },
    /** Runtime.evaluate，返回 JSON 值；超时抛错（renderer 被冻结时必须能退出）。 */
    async evaluate(expression, timeoutMs = 5000) {
      const result = await Promise.race([
        this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
        delay(timeoutMs).then(() => {
          throw new Error(`cdp evaluate timeout ${timeoutMs}ms`);
        }),
      ]);
      if (result && result.exceptionDetails) {
        const detail = result.exceptionDetails;
        const description = detail.exception?.description ?? detail.exception?.value;
        throw new Error(
          `cdp evaluate exception: ${JSON.stringify(detail.text ?? detail)}${description === undefined ? '' : ` | ${String(description)}`}`,
        );
      }
      return result?.result?.value;
    },
    /** 合成点击（与 product-observe 同口径：mouseMove → mouseDown → 60ms → mouseUp）。 */
    async click(x, y) {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await delay(60);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    async drag(x, y, dx, steps = 4) {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      for (let step = 1; step <= steps; step += 1) {
        await this.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: x + Math.round((dx * step) / steps),
          y,
          button: 'left',
          buttons: 1,
        });
        await delay(20);
      }
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: x + dx,
        y,
        button: 'left',
        clickCount: 1,
      });
    },
    async escape() {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await this.send('Input.dispatchKeyEvent', {
          type,
          key: 'Escape',
          code: 'Escape',
          windowsVirtualKeyCode: 27,
          nativeVirtualKeyCode: 27,
        });
      }
    },
    close() {
      try {
        ws.close();
      } catch {
        /* 已关闭 */
      }
      return closed;
    },
  };
}
