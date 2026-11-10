# M3-11 冻结契约：拖动写入预算（默认关闭）

基线 `3daebc6`。只做一个候选：**每条输入照旧算 DIP 与夹边，只合并过密的系统位置写入**。
不减少 IPC、不改 gesture/`advanceOrigin`、不引新运行库、不改默认开关、不动 GPU/模型。

先测（A）再接线（C）：若真实输入没有 8ms 内的多次写入、也没有可测开销，就停止产品接线，
交负结果 + 小原型，保留基线。**不得为“创新”强加排队。**

## 0. 为什么不是 debounce

逐事件链路是 `pointermove → reduceGesture(dx,dy) → preload → main → controller.moveBy → advanceOrigin(夹边+小数累积) → setPosition`。
夹边非线性，`sum(dx)` 或“最新指针”都不等价：

- 反例 1（任务书）：`x∈[0,10]`，初始 9，输入 `+5, -5`。逐事件：9→10（夹住）→5，终点 **5**；
  先求和 0 再夹边得到 9，错。
- 反例 2（RESEARCH）：`x∈[0,100]`，起点 95，`+10, -10`。逐事件 100→90；求和后夹边 95，错。

所以调度器只接**既有控制器逐事件算出的绝对 position**，绝不接合并后的 dx/dy。

## 1. 开关与通道（负责人独占）

| 项 | 值 |
|---|---|
| 环境开关 | `PET_NEXT_DRAG_WRITE_BUDGET=1` 才启用；未设/其他值 = 原路径 |
| 页面门 | main 在开关开时给窗口 URL 加 `dragBudget=1`；页面只在该 query 下发拖动结束信号 |
| 新 IPC | `pet:drag-end`（renderer→main，无载荷，单向）；`pet:move-by` 载荷不变 |
| preload | 仅新增 `pet.dragEnd(): void`；其余不变，不暴露 ipcRenderer |
| 默认关闭 | 关闭时：零 timer、零新 IPC、`createWindowController` 原样 |

## 2. 纯调度器（B，`experiments/drag-write-budget/`）

```ts
export interface DragPosition { readonly x: number; readonly y: number }
export interface WriteBudgetClock {
  now(): number;                                  // 注入单调时钟，ms
  schedule(delayMs: number, run: () => void): unknown;
  cancel(handle: unknown): void;
}
export interface WriteBudgetPorts extends WriteBudgetClock { write(position: DragPosition): void }
export interface WriteBudgetOptions extends WriteBudgetPorts { budgetMs?: number }  // 缺省 8
export interface WriteBudgetStats {
  readonly submitted: number; readonly written: number;
  readonly coalesced: number; readonly duplicateDropped: number; readonly flushes: number;
}
export interface WriteBudget {
  begin(): void; submit(position: DragPosition): void;
  end(): void; cancel(): void; dispose(): void;
  readonly stats: WriteBudgetStats;
}
export function createWriteBudget(options: WriteBudgetOptions): WriteBudget
```

语义（逐条冻结，单测必须覆盖）：

1. 一个 pending 目标、一个 timer 句柄、一个 epoch 计数；不排队多个目标。
2. `begin()`：epoch++、清 pending、撤 timer、`lastWriteAt=null` → 本次拖动首写必然即时。
3. `submit(p)`：
   - 已 `dispose()` → 忽略（不写、不挂 timer）。
   - `p` 与上次已写坐标相同且无 pending → `duplicateDropped++`，不写（重复坐标不是有效位移）。
   - 无 `lastWriteAt` 或 `now()-lastWriteAt >= budgetMs` → 立即 `write(p)`。
   - 否则 pending=p（`coalesced++`），**仅在无 timer 时**挂一次 `budgetMs-(now()-lastWriteAt)`。
4. 定时器回调：epoch 不匹配或已 dispose → 不写；否则写当前 pending。
5. `write` 成功即 `lastWriteAt=now()`、`lastWritten=p`、清 pending、撤 timer。
6. `end()` / `cancel()`：**先 flush 本次仍有效的 pending（即使距上次 <8ms）**，再撤 timer、epoch++。
   没有 pending 时只撤 timer；不得补写上一 epoch 的目标。
7. `dispose()`：撤 timer、清 pending、epoch++，**不写**；之后任何回调都无权写宿主。
8. 无 tick 就 `end()`（定时器从未触发）→ 仍必须写出 pending。
9. 8ms 是计划排队预算，不是 OS 硬保证；时钟由调用方注入，测试不得依赖真实 sleep。

## 3. 薄接线（C，`adapters/window/drag-write-budget.ts`）

```ts
export interface BudgetedWindowController extends WindowController {
  endDrag(): void;              // flush + 结束 epoch
  noteGeometryChanged(): void;  // 先 flush，再本拖动内回退逐事件直写
  dispose(): void;              // 只清，不写
  readonly stats: WriteBudgetStats;
}
export function createBudgetedWindowController(
  host: WindowHost,
  options?: { budgetMs?: number; clock?: Partial<WriteBudgetClock> },
): BudgetedWindowController
```

- `moveBy` 必须与 `adapters/window/controller.ts` 逐字等价：`getBounds()` → `advanceOrigin(tracked,...)` →
  `tracked=step.tracked`，差别只在把 `host.setPosition(x,y)` 换成 `budget.submit({x,y})`。
  **不许复制夹边/取整逻辑，直接复用 `advanceOrigin`。**
- 首次 `moveBy` 前若未 `begin()`，adapter 自行 `begin()`；`endDrag()` 后下一次 `moveBy` 再 `begin()`。
- `noteGeometryChanged()`：`budget.end()`（flush 有效 pending）后置 `passthrough=true`；passthrough 期间
  `moveBy` 直接 `host.setPosition`（原逐事件路径），直到 `endDrag()`。用于工作区/显示器/尺寸变化，
  首轮不做跨屏推断，只回退并记录原因。
- 不缓存错误的 `getBounds`；不把未提交位置当外部移动；保留小数累积（tracked 由 advanceOrigin 返回）。

## 4. 负责人公共接线（不做第二套实现）

`electron/main.ts`：开关开 → 用 `createBudgetedWindowController`；注册 `pet:drag-end` →
`endDrag()`；`screen` 的 `display-metrics-changed/added/removed` → `noteGeometryChanged()`；
`win.on('closed')` 与 `quit()` → `dispose()`。开关关 → 原样，一个分支都不多走。
`electron/preload.ts`：加 `pet.dragEnd()`。`app/page.ts`：`dragBudget=1` 时在 `setDragging(false)`
（wire/behavior 两条路径都经过）发送 `pet.dragEnd()`。`app/wire.ts`、`contracts/**`：不改。

## 5. 文件所有权（越界即返工）

| 角色 | 独占路径 |
|---|---|
| 负责人 | `electron/main.ts`、`electron/preload.ts`、`app/page.ts`、`contracts/**`、`package.json`、`tsconfig.json`、`docs/**`、`scripts/**` |
| A | `bench/drag-write-budget/**` |
| B | `experiments/drag-write-budget/**` |
| C | `adapters/window/drag-write-budget.ts`、`adapters/window/drag-write-budget.test.ts` |
| D | `tests/drag-write-budget/**` |

## 6. 分层证据（不许互相冒充）

1. **原生输入**：Windows 真实鼠标拖动；服务器无 Windows → not-run + 一条复跑命令。
2. **CDP 合成**：`Input.dispatchMouseEvent` 驱动真实 Electron；只能叫“CDP 合成”，不等于物理鼠标。
3. **纯 trace**：固定 seed 的确定性输入序列，只用于正确性/机制门（500Hz 写入减少）。
4. **软件提交 vs 物理呈帧**：`setPosition` 返回只代表软件提交；不宣称物理帧已显示或更流畅。

## 7. 阶段门

- 阶段 1（A）：真实/CDP 路径是否存在同 8ms 多次写入、相同坐标重复写、可测 setPosition 开销。
  **否 → 停 C 接线**，交负结果。
- 阶段 2（仅在有测量依据时）：逻辑终态/点击/落点全部等价；500Hz 压力臂写入减少 ≥50%（机制门）；
  真实输入不得新增超过计划 8ms 的主动等待，首写/末写不等 timer；真实写入可重复减少且 CPU 或提交
  尾延迟有可复现收益、常规 60/125Hz 无退化，才建议下一步。CPU 差在噪声内或只 synthetic 变好 → 不建议转正。

## 8. 复跑

```bash
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
Xvfb :95 -screen 0 1920x1080x24 -nolisten tcp & export DISPLAY=:95
cd pet-next
env -u NODE_OPTIONS pnpm test          # 纯单元（含 scheduler/adapter 等价）
env -u NODE_OPTIONS pnpm build
env -u NODE_OPTIONS PET_NEXT_DRAG_WRITE_BUDGET=1 node --experimental-strip-types --test \
    --test-concurrency=1 --test-reporter spec tests/drag-write-budget/*.e2e.test.ts
node bench/drag-write-budget/run.mjs --arm=baseline|baseline|...   # 见 A 的 README
```
