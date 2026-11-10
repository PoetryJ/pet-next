/**
 * 单测夹具：手动推进的假时钟 + 记录写入的调度器。
 *
 * 只用注入端口，不 sleep、不读真实时间；旧 timer "仍然被触发" 由 `fireCancelled` 手动模拟。
 * @module pet-next/experiments/drag-write-budget/fake-clock
 */
import { createWriteBudget, type DragPosition, type WriteBudget, type WriteBudgetClock } from './scheduler.ts';

interface FakeTimer {
  readonly id: number;
  /** 绝对触发时刻（假时钟毫秒）。 */
  readonly at: number;
  readonly run: () => void;
  /** 已撤销或已触发过；两种情况都不该再动宿主。 */
  cancelled: boolean;
}

export class FakeClock implements WriteBudgetClock {
  #timeMs = 0;
  #nextId = 1;
  #timers: FakeTimer[] = [];

  /** `schedule` 被调用次数（证明"多次 submit 只挂一个 timer"）。 */
  scheduleCalls = 0;
  /** `cancel` 被调用次数。 */
  cancelCalls = 0;

  now(): number {
    return this.#timeMs;
  }

  schedule(delayMs: number, run: () => void): number {
    this.scheduleCalls += 1;
    const timer: FakeTimer = { id: this.#nextId, at: this.#timeMs + delayMs, run, cancelled: false };
    this.#nextId += 1;
    this.#timers.push(timer);
    return timer.id;
  }

  cancel(handle: unknown): void {
    this.cancelCalls += 1;
    for (const timer of this.#timers) {
      if (timer.id === handle) timer.cancelled = true;
    }
  }

  /** 推进假时钟；期间到期的 timer 按（时刻, 入队序）执行，各只执行一次。 */
  advance(ms: number): void {
    const target = this.#timeMs + ms;
    for (;;) {
      const due = this.#nextDue(target);
      if (due === null) break;
      due.cancelled = true;
      this.#timeMs = due.at;
      due.run();
    }
    this.#timeMs = target;
  }

  /** 仍会触发的 timer 数。 */
  armedCount(): number {
    return this.#timers.filter((timer) => !timer.cancelled).length;
  }

  /**
   * 把"已撤销 / 已触发过"的旧回调再跑一遍，模拟时钟或宿主违约仍调用它们。
   * 调度器必须靠 epoch 拒绝，而不是靠句柄已撤销。
   */
  fireCancelled(): number {
    let fired = 0;
    for (const timer of this.#timers) {
      if (!timer.cancelled) continue;
      timer.run();
      fired += 1;
    }
    return fired;
  }

  #nextDue(target: number): FakeTimer | null {
    let best: FakeTimer | null = null;
    for (const timer of this.#timers) {
      if (timer.cancelled || timer.at > target) continue;
      if (best === null || timer.at < best.at || (timer.at === best.at && timer.id < best.id)) best = timer;
    }
    return best;
  }
}

export interface BudgetHarness {
  readonly clock: FakeClock;
  /** 真正发到 write 端口的坐标，按顺序。 */
  readonly writes: DragPosition[];
  readonly budget: WriteBudget;
}

export function createBudgetHarness(options: { budgetMs?: number } = {}): BudgetHarness {
  const clock = new FakeClock();
  const writes: DragPosition[] = [];
  const budget = createWriteBudget({
    budgetMs: options.budgetMs,
    now: () => clock.now(),
    schedule: (delayMs, run) => clock.schedule(delayMs, run),
    cancel: (handle) => clock.cancel(handle),
    write: (position) => {
      writes.push({ x: position.x, y: position.y });
    },
  });
  return { clock, writes, budget };
}
