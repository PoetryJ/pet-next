/**
 * 拖动写入预算：调用方照旧逐事件算绝对位置，本模块只合并过密的系统位置写入。
 *
 * 纯模块：时钟（now/schedule/cancel）与写入口（write）全部注入，
 * 不 import Electron/DOM，也不碰任何全局计时器或全局时间源。
 * 因此单测里没有真实计时器，靠手动推进假时钟。
 *
 * 契约见 `docs/M3-11-DRAG-WRITE-BUDGET.md` 第 2 节。
 * @module pet-next/experiments/drag-write-budget/scheduler
 */

/** 一次系统位置写入的目标，单位 DIP；小数原样透传，不取整。 */
export interface DragPosition {
  readonly x: number;
  readonly y: number;
}

/** 注入的时钟。`schedule` 的返回值只回传给 `cancel`，本模块不解释它。 */
export interface WriteBudgetClock {
  /** 单调时钟，毫秒。 */
  now(): number;
  /** `delayMs` 后执行 `run`，返回撤销句柄。 */
  schedule(delayMs: number, run: () => void): unknown;
  cancel(handle: unknown): void;
}

export interface WriteBudgetPorts extends WriteBudgetClock {
  /** 真正的系统位置写入（宿主 `setPosition`）。 */
  write(position: DragPosition): void;
}

export interface WriteBudgetOptions extends WriteBudgetPorts {
  /** 计划排队预算，缺省 8ms。 */
  budgetMs?: number;
}

/**
 * 计数口径（每条被接受的 `submit` 只落一个结局）：
 * - `submitted`：未 `dispose` 时收到的 `submit` 次数；`dispose` 之后的 `submit` 完全忽略、不计。
 * - `written`：实际发到 `write` 端口的次数（含即时写、定时器写、flush 写）。
 * - `coalesced`：被更晚的 `submit` 取代、或被 `begin`/`dispose` 丢掉而**从未写出**的坐标条数。
 * - `duplicateDropped`：与上次已写坐标相同、且当时无 pending 的重复坐标条数。
 * - `flushes`：`end`/`cancel` 真的把 pending 写出去的次数。
 *
 * 已经写出的坐标只算 `written`，从未写出的坐标只算 `coalesced`，
 * 所以在没有 pending 的静息时刻恒有 `submitted === written + coalesced + duplicateDropped`；
 * 刚 `submit` 但 pending 尚未裁决的那一瞬间，`submitted` 会比右边多 1。
 */
export interface WriteBudgetStats {
  readonly submitted: number;
  readonly written: number;
  readonly coalesced: number;
  readonly duplicateDropped: number;
  readonly flushes: number;
}

export interface WriteBudget {
  /** 开始一次拖动：epoch++、清 pending、撤 timer、`lastWriteAt=null`（首写必然即时）。 */
  begin(): void;
  submit(position: DragPosition): void;
  /** 先 flush 本次仍有效的 pending（即使距上次 <budget），再撤 timer、epoch++。 */
  end(): void;
  /** 与 `end` 同义：flush 本次 pending 后结束 epoch。 */
  cancel(): void;
  /** 只清不写：撤 timer、丢 pending、epoch++；之后 `submit` 与旧回调都无权写。 */
  dispose(): void;
  readonly stats: WriteBudgetStats;
}

/** 缺省排队预算；计划值，不是 OS 硬保证。 */
export const DEFAULT_BUDGET_MS = 8;

export function createWriteBudget(options: WriteBudgetOptions): WriteBudget {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  if (!Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new RangeError(`budgetMs 必须是有限非负数，收到 ${String(options.budgetMs)}`);
  }

  const clockNow = options.now;
  const scheduleTimer = options.schedule;
  const cancelTimer = options.cancel;
  const writePort = options.write;

  let epoch = 0;
  let disposed = false;
  let pending: DragPosition | null = null;
  let timerArmed = false;
  let timerHandle: unknown = null;
  let lastWriteAt: number | null = null;
  let lastWritten: DragPosition | null = null;

  const counts = { submitted: 0, written: 0, coalesced: 0, duplicateDropped: 0, flushes: 0 };

  function disarmTimer(): void {
    if (!timerArmed) return;
    const handle = timerHandle;
    timerArmed = false;
    timerHandle = null;
    cancelTimer(handle);
  }

  /** 丢掉 pending：该坐标从此不会再写出，计一次 `coalesced`。 */
  function dropPending(): void {
    if (pending === null) return;
    pending = null;
    counts.coalesced += 1;
  }

  /** 唯一的 `write` 调用点：写出即更新 lastWriteAt/lastWritten 并撤 timer。 */
  function commit(position: DragPosition, at: number): void {
    writePort(position);
    counts.written += 1;
    lastWriteAt = at;
    lastWritten = position;
    disarmTimer();
  }

  /** 定时器回调只认出生时的 epoch；跨拖动或已 dispose 一律无权写。 */
  function runTimer(bornEpoch: number): void {
    if (disposed || bornEpoch !== epoch) return;
    const target = pending;
    timerArmed = false;
    timerHandle = null;
    if (target === null) return;
    pending = null;
    commit(target, clockNow());
  }

  function begin(): void {
    dropPending();
    disarmTimer();
    epoch += 1;
    lastWriteAt = null;
    lastWritten = null;
  }

  function submit(position: DragPosition): void {
    if (disposed) return;
    counts.submitted += 1;
    const at = clockNow();

    // 重复坐标不是有效位移；只有"无 pending"时才算重复，有 pending 时它仍是一次更新。
    if (pending === null && lastWritten !== null && same(lastWritten, position)) {
      counts.duplicateDropped += 1;
      return;
    }

    // 首次写或距上次写已达预算：立即写，普通低频输入不被无故延后。
    if (lastWriteAt === null || at - lastWriteAt >= budgetMs) {
      dropPending();
      commit(position, at);
      return;
    }

    // 过密：只更新 pending，且仅在无 timer 时挂一次。
    dropPending();
    pending = position;
    if (!timerArmed) {
      timerArmed = true;
      const bornEpoch = epoch;
      timerHandle = scheduleTimer(budgetMs - (at - lastWriteAt), () => runTimer(bornEpoch));
    }
  }

  /** flush 本次 pending：即使距上次 <budget 也立刻写。 */
  function flushPending(): void {
    const target = pending;
    if (target === null) return;
    pending = null;
    commit(target, clockNow());
    counts.flushes += 1;
  }

  function end(): void {
    flushPending();
    disarmTimer();
    epoch += 1;
  }

  function dispose(): void {
    dropPending();
    disarmTimer();
    epoch += 1;
    disposed = true;
  }

  return {
    begin,
    submit,
    end,
    cancel: end,
    dispose,
    get stats(): WriteBudgetStats {
      return {
        submitted: counts.submitted,
        written: counts.written,
        coalesced: counts.coalesced,
        duplicateDropped: counts.duplicateDropped,
        flushes: counts.flushes,
      };
    },
  };
}

function same(a: DragPosition, b: DragPosition): boolean {
  return a.x === b.x && a.y === b.y;
}
