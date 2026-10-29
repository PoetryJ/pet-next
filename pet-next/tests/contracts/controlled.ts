/**
 * 假时钟和受控 Promise。契约用例只推进这两个，不用固定 sleep。
 * @module pet-next/tests/contracts/controlled
 */

interface Timer {
  atMs: number;
  fn: () => void;
}

/** 只在 `advance` 时跑到点的回调。 */
export class FakeClock {
  nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, Timer>();

  set(fn: () => void, delayMs: number): number {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('delayMs must be a finite number >= 0');
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { atMs: this.nowMs + delayMs, fn });
    return id;
  }

  clear(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle);
  }

  /**
   * 把时间拨到 `nowMs + ms`，按到期时刻和登记顺序执行到期回调。
   *
   * @param ms - 向前拨的毫秒。0 只跑已经到期的回调。
   */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('ms must be a finite number >= 0');
    const target = this.nowMs + ms;
    for (;;) {
      let next: { id: number; atMs: number; fn: () => void } | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.atMs > target) continue;
        if (next === null || timer.atMs < next.atMs || (timer.atMs === next.atMs && id < next.id)) {
          next = { id, atMs: timer.atMs, fn: timer.fn };
        }
      }
      if (!next) break;
      this.nowMs = next.atMs;
      this.timers.delete(next.id);
      next.fn();
    }
    this.nowMs = target;
  }

  get pending(): number {
    return this.timers.size;
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

/** 由测试决定何时兑现的 Promise。 */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 把已兑现的受控 Promise 冲进微任务队列。不是延时。 */
export async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
