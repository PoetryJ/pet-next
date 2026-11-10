/**
 * 拖动写入预算的薄接线（M3-11 候选，默认关闭由主进程开关决定，本文件不含开关）。
 *
 * 逐事件的 DIP 累加、夹边、取整全部复用 `controller.ts` + `track.ts`，
 * 本文件**只**把 `host.setPosition(x, y)` 换成 `budget.submit({x, y})`：
 * 调度器接的是"每一条输入照旧算出的绝对 position"，绝不接合并后的 dx/dy
 * （夹边非线性，求和不等价）。
 *
 * @module pet-next/adapters/window/drag-write-budget
 */
import {
  createWriteBudget,
  type WriteBudget,
  type WriteBudgetClock,
  type WriteBudgetStats,
} from '../../core/drag-write-budget/scheduler.ts';
import { advanceOrigin, type TrackedOrigin } from './track.ts';
import type { WindowController, WindowHost } from './types.ts';

/** 计划排队预算（不是 OS 保证）；与契约第 2 节缺省一致。 */
const DEFAULT_BUDGET_MS = 8;

/**
 * 加了拖动结束/几何变化/清理入口的窗口控制器。
 * 其余成员与 `createWindowController` 完全一致（同一套夹边与小数累积）。
 */
export interface BudgetedWindowController extends WindowController {
  /** flush 本次仍有效的 pending（即使距上次写 < budgetMs），结束本 epoch。 */
  endDrag(): void;
  /**
   * 工作区/显示器/尺寸变化：先 flush 有效 pending，再让**本次拖动内**退回逐事件直写。
   * 首轮不做跨屏推断（不重算跨显示器目标），只回退求正确。
   * 没有拖动进行中（因而也没有 pending）时为 no-op：下一次拖动仍走候选合帧。
   */
  noteGeometryChanged(): void;
  /** 只清不写：撤定时器、丢 pending；之后 `moveBy` 不再写宿主。 */
  dispose(): void;
  readonly stats: WriteBudgetStats;
}

export interface BudgetedWindowControllerOptions {
  /** 合帧预算，缺省 8ms。 */
  budgetMs?: number;
  /** 纯单测注入；缺省 `Date.now` + `setTimeout`/`clearTimeout`。 */
  clock?: Partial<WriteBudgetClock>;
}

/** 缺省时钟：真实定时器与单调性够用的 `Date.now`。 */
const DEFAULT_CLOCK: WriteBudgetClock = {
  now: () => Date.now(),
  schedule(delayMs, run) {
    return setTimeout(run, delayMs);
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * 把平移接到"预算调度器 + 宿主"。非有限位移直接忽略（与 `createWindowController` 一致）。
 *
 * 状态机：
 * - 未开始拖动时第一条 `moveBy` 自动 `begin()`（本次拖动首写必然即时）；
 * - `endDrag()` flush 并结束 epoch，下一次 `moveBy` 再 `begin()`（新 epoch，旧定时器无权写）；
 * - `noteGeometryChanged()` 之后到 `endDrag()` 之间为 passthrough：直接 `host.setPosition`；
 * - `dispose()` 之后 `moveBy` 直接返回，绝不写宿主。
 */
export function createBudgetedWindowController(
  host: WindowHost,
  options: BudgetedWindowControllerOptions = {},
): BudgetedWindowController {
  const clock: WriteBudgetClock = {
    now: options.clock?.now ?? DEFAULT_CLOCK.now,
    schedule: options.clock?.schedule ?? DEFAULT_CLOCK.schedule,
    cancel: options.clock?.cancel ?? DEFAULT_CLOCK.cancel,
  };
  const budget: WriteBudget = createWriteBudget({
    budgetMs: options.budgetMs ?? DEFAULT_BUDGET_MS,
    ...clock,
    write(position) {
      host.setPosition(position.x, position.y);
    },
  });

  /** 已累计的 DIP；只由 `advanceOrigin` 产出，本文件不做任何取整或缓存。 */
  let tracked: TrackedOrigin | null = null;
  /** 本次拖动是否已 `begin()`（有过未结束的 moveBy）。 */
  let dragging = false;
  /** 几何变化后本拖动内退回逐事件直写。 */
  let passthrough = false;
  let disposed = false;

  return {
    moveBy(dx, dy) {
      // 已清理：不读宿主、不写宿主、不再挂 timer。
      if (disposed) return;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      const bounds = host.getBounds();
      const step = advanceOrigin(
        tracked,
        bounds,
        dx,
        dy,
        { width: bounds.width, height: bounds.height },
        host.workAreaFor(bounds),
      );
      tracked = step.tracked;
      if (passthrough) {
        // 几何刚变：本拖动内退回原逐事件路径，不做跨屏推断。
        host.setPosition(step.position.x, step.position.y);
        return;
      }
      if (!dragging) {
        budget.begin();
        dragging = true;
      }
      budget.submit({ x: step.position.x, y: step.position.y });
    },
    quit() {
      host.quit();
    },
    endDrag() {
      if (disposed) return;
      // 只有真在拖动中才需要一个 epoch 收尾；重复 drag-end 不制造空 flush。
      if (dragging) {
        budget.end();
        dragging = false;
      }
      passthrough = false;
    },
    noteGeometryChanged() {
      if (disposed) return;
      // 没有本次拖动（因而也没有 pending）：几何事件与位移无关，
      // 不能把下一次拖动静默降级成逐事件直写——保持候选合帧。
      if (!dragging) return;
      // 先把本次仍有效的 pending 落到旧几何上，再回退直写，避免目标飞出屏幕。
      budget.end();
      dragging = false;
      passthrough = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      dragging = false;
      passthrough = false;
      // 只清不写：撤 timer、丢 pending、epoch++。
      budget.dispose();
    },
    get stats() {
      return budget.stats;
    },
  };
}
