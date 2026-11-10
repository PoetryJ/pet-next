/**
 * 注入用的假时钟：契约要求"测试不得依赖真实 sleep"，所有 8ms 判定都由这里推进。
 *
 * `resurrectAll()` 故意无视 `cancel()` 强制触发已撤销的回调：这是唯一能验证
 * "旧 timer 即使真的跑到也不得写宿主"（epoch 守卫）的办法，不需要白盒读内部状态。
 * @module pet-next/tests/drag-write-budget/support/fake-clock
 */
import type { WriteBudgetClock } from './contract.ts';

export interface FakeTimer {
  readonly id: number;
  readonly at: number;
  readonly delayMs: number;
  readonly run: () => void;
}

export interface FakeClock extends WriteBudgetClock {
  /** 已推进到的时刻。 */
  readonly nowMs: number;
  now(): number;
  /** 仍挂着的定时器（按到期时间排序）。 */
  pending(): readonly FakeTimer[];
  /** 已撤销、但保留回调的定时器个数。 */
  retiredCount(): number;
  /** 推进时间并顺序触发到期回调（回调执行时 now() 恰为到期时刻）。 */
  advance(ms: number): readonly FakeTimer[];
  /** 无视 cancel 强制触发全部已撤销回调，返回触发条数。 */
  resurrectAll(): number;
}

export function createFakeClock(start = 0): FakeClock {
  let now = start;
  let nextId = 1;
  const live = new Map<number, FakeTimer>();
  const retired: FakeTimer[] = [];

  const ordered = (): FakeTimer[] => [...live.values()].sort((left, right) => left.at - right.at || left.id - right.id);

  return {
    get nowMs() {
      return now;
    },
    now: () => now,
    schedule(delayMs: number, run: () => void): unknown {
      const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
      const timer: FakeTimer = { id: nextId, at: now + delay, delayMs: delay, run };
      nextId += 1;
      live.set(timer.id, timer);
      return timer;
    },
    cancel(handle: unknown): void {
      if (typeof handle !== 'object' || handle === null) return;
      const id = (handle as { id?: unknown }).id;
      if (typeof id !== 'number') return;
      const timer = live.get(id);
      if (timer === undefined) return;
      live.delete(id);
      retired.push(timer);
    },
    pending: ordered,
    retiredCount: () => retired.length,
    advance(ms: number): readonly FakeTimer[] {
      const end = now + Math.max(0, ms);
      const fired: FakeTimer[] = [];
      for (;;) {
        const due = ordered().find((timer) => timer.at <= end);
        if (due === undefined) break;
        live.delete(due.id);
        now = Math.max(now, due.at);
        due.run();
        fired.push(due);
      }
      now = end;
      return fired;
    },
    resurrectAll(): number {
      const batch = retired.splice(0, retired.length);
      for (const timer of batch) timer.run();
      return batch.length;
    },
  };
}
