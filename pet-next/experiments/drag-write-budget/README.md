# 拖动写入预算（纯调度器原型，默认关闭）

M3-11 的唯一候选：**每条输入照旧算 DIP 并夹边，只合并过密的系统位置写入**。
不减少 IPC、不改 `gesture`/`advanceOrigin`、不引新运行库、不改默认开关。
契约冻结在 `docs/M3-11-DRAG-WRITE-BUDGET.md` 第 2 节；本目录只交付调度器与它的证据，不接线。

## 为什么不是 debounce（也不能合并 dx/dy）

逐事件链路是 `pointermove → reduceGesture → preload → main → controller.moveBy → advanceOrigin → setPosition`。
夹边是非线性的，`sum(dx)` 与"最新指针"都不等价于逐事件结果：

| 反例 | 工作区 / 尺寸 | 输入 | 逐事件终点 | 先求和再夹边 |
|---|---|---|---|---|
| 1 | `x∈[0,10]`，初始 `9` | `+5, -5` | `9→10`（夹住）`→5`，即 **5** | `clamp(9+0)=9` ❌ |
| 2 | `x∈[0,100]`，起点 `95` | `+10, -10` | `95→100→90`，即 **90** | `clamp(95+0)=95` ❌ |

所以调度器只接**既有控制器逐事件算出的绝对 position**，绝不接合并后的 dx/dy；
`equivalence.test.ts` 把这两条反例连同"错误实现得多少"一起断言，防止候选悄悄退化成求和。

## 语义摘要（`scheduler.ts`）

一个 pending 目标、一个 timer 句柄、一个 epoch 计数，不排队多个目标。

- `begin()`：`epoch++`、清 pending、撤 timer、`lastWriteAt=null`、`lastWritten=null`
  → **本次拖动首写必然即时**（即使坐标与上次拖动末点相同，也不当重复丢掉）。
- `submit(p)`：
  1. 已 `dispose()` → 完全忽略（不写、不挂 timer、不计数）。
  2. `p` 与上次已写坐标相同且当前无 pending → `duplicateDropped++`，不写（重复坐标不是有效位移）。
  3. `lastWriteAt === null` 或 `now()-lastWriteAt >= budgetMs` → **立即 `write(p)`**
     → 普通 60/125Hz 输入不会被无故延后。
  4. 否则 pending=p（该坐标**已写**才算 `written`，被取代/丢弃才算 `coalesced`），
     且**仅在无 timer 时**挂一次 `budgetMs-(now()-lastWriteAt)`。
- 定时器回调：`epoch` 不匹配或已 `dispose` → 不写；否则写当前 pending。
- `end()` / `cancel()`：**先 flush 本次仍有效的 pending（即使距上次 <budget）**，再撤 timer、`epoch++`。
  没有 pending 时只撤 timer；不补写上一 epoch 的目标。无 tick 松手（定时器从未触发）同样写出 pending。
- `dispose()`：撤 timer、清 pending、`epoch++`，**不写**；之后任何回调都无权写宿主。
- `budgetMs` 缺省 8；负数或非有限值在创建时抛 `RangeError`。

纯度：`now/schedule/cancel/write` 全部注入，模块内没有 `setTimeout`、`Date.now`、`performance.now`，
也不 import Electron/DOM。8ms 是**计划排队预算**，不是 OS 硬保证。

## 统计口径（`WriteBudgetStats`）

每条被接受的 `submit` 只落一个结局，因此恒等式成立：

```
submitted = written + coalesced + duplicateDropped      （静息时刻，无 pending）
```

- `submitted`：未 `dispose` 时收到的 `submit` 次数；`dispose` 之后的 `submit` 完全忽略、不计。
- `written`：实际发到 `write` 端口的次数（即时写 / 定时器写 / flush 写），等于端口被调用次数。
- `coalesced`：被更晚的 `submit` 取代、或被 `begin`/`dispose` 丢掉而**从未写出**的坐标条数。
- `duplicateDropped`：与上次已写坐标相同、且当时无 pending 的重复坐标条数。
- `flushes`：`end`/`cancel` 真的把 pending 写出去的次数（定时器写、即时写都不算 flush）。

刚 `submit` 但 pending 尚未裁决的那一瞬间，`submitted` 会比右边多 1（该坐标还没有结局）；
`timer` 触发、`end`/`cancel`、`begin`/`dispose` 之后立即恢复相等。单测按这个口径断言。

## 文件

| 文件 | 作用 |
|---|---|
| `scheduler.ts` | 冻结契约的纯调度器（`createWriteBudget` + 类型） |
| `scheduler.test.ts` | 9 条语义逐条钉住：首写即时、<8ms 只挂一个 timer、>=8ms 立即写、无 tick 松手 flush、cancel flush、end/cancel 后旧 timer 与 epoch 失效、新 begin、dispose 只清不写、重复坐标、小数透传、stats 自洽、可注入预算 |
| `equivalence.test.ts` | 参考实现是**真实** `adapters/window/track.ts#advanceOrigin`：两条夹边反例 + 3 个固定 seed 的完整序列（小数、四边往返、长距离、零位移、抖回、16ms 稀疏帧），比较逐事件 `tracked`/`position`，并断言写出是原序列的保序子序列且末写=最终 position |
| `fake-clock.ts` | 手动推进的假时钟（含 `fireCancelled()` 模拟"旧 timer 仍被触发"）；不 sleep、不读真实时间 |

已知偏差 / 未冻结处的取舍：

1. `cancel()` 与 `end()` 是同一个实现的别名（契约要求两者语义相同）。
2. `dispose()` 之后的 `submit` 不计入 `submitted`——否则静息恒等式会被"被忽略的提交"破坏。
3. `pending` 存在时，与上次已写坐标相同的 `submit` 不算重复（照契约原文），仍更新 pending。
4. 未 `begin()` 就 `submit()` 时 `lastWriteAt=null`，首条立即写；契约的 `submit` 规则本身不依赖 `begin`。

## 复跑

```bash
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
cd pet-next

# 只跑本实验
env -u NODE_OPTIONS node --experimental-strip-types --test --test-reporter spec experiments/drag-write-budget/*.test.ts

# 纯单元层（scripts/unit-tests.mjs 会自动收集 experiments/**/*.test.ts）
env -u NODE_OPTIONS pnpm test
```

`equivalence.test.ts` 不依赖真实计时器：时间只由 `FakeClock.advance(事件间隔)` 推进，
测试结束还会断言假时钟总时长等于输入间隔之和、且没有残留 timer。
