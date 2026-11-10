# M3-11 D：拖动写入预算的独立等价与成本验收

角色 D 的独占目录。**只做验收，不改产品代码、不改默认开关、不访问 18872、零真实模型 POST。**
冻结契约见 `docs/M3-11-DRAG-WRITE-BUDGET.md`（基线 `3daebc6`）。

## 当前状态（已接线上机）

| 依赖 | 路径 | 状态 |
|---|---|---|
| C 候选适配器 | `adapters/window/drag-write-budget.ts` | 已落地（`34a77a7` 起） |
| B 纯调度器 | `core/drag-write-budget/scheduler.ts`（`experiments/drag-write-budget/scheduler.ts` re-export） | 已落地 |
| 负责人公共接线 | `electron/main.ts`/`preload.ts`/`app/page.ts` 的 `PET_NEXT_DRAG_WRITE_BUDGET` + `pet:drag-end` | 已落地（默认关闭） |

本轮实测：等价 29/29、两臂 e2e 6/6、5 轮交替成本对照完成。**测量链路先自证不是空跑**：
关闭臂用 `selfcheck-off-arm.ts` 在真实 Electron + 真实 X 指针下产出 4 条写入与正确落点。

### 两处测量假绿（本轮实修，保留过程）

1. `{event:'ready'}` 只代表窗口就绪，页面监听可能还差几秒；共享 1 核容器被外部评测压到 load 10–17 时，
   “还没接上手势”会被误判成“拖动不写宿主”。→ 加 `waitForPetWired`（`#pet` + `data-visual`）。
2. 一次 `evaluate` 连发 500 条 IPC 后主进程仍可能在排队；固定 `300ms` 会把“还没处理”当成 0 写入，
   于是候选臂 0 写也能算出 100% 减少。→ 改为连续 800ms 无新增或 20s 上限，并**强制两臂写入都 > 0**。

## 判定表

| 门 | 判据（来自契约第 7 节） | 用例 | 结果 |
|---|---|---|---|
| 等价性门 · 逐事件口径 | 稀疏输入（间隔 ≥ budget）下候选写入与参考模型**逐条相等**；贴边重复坐标按契约折叠 | `equivalence.test.ts` · 契约 3 | **pass** |
| 等价性门 · 夹边非线性 | 任务书反例 `9 +5 -5 → 5`（不得 9）、RESEARCH 反例 `95 +10 -10 → 90`（不得 95） | 同文件 · 两条反例 | **pass** |
| 等价性门 · 小数 | `0.125`/`0.5` 累加精确到 +1/+5 DIP；密集合并不丢余数 | 同上 | **pass**（跨拖动边界允许 1 次同坐标重写，见下） |
| 等价性门 · 终态 | 密集/随机输入下每条写入必须是**某一步的逐事件结果**（子序列，不得插值），收尾 flush 后末写 = 参考末态 | 同上 · 密集随机 240 步（seed `0x5eed`） | **pass** |
| 等价性门 · 生命周期 | 首动即时（不挂 timer）、松手/取消 flush、旧 timer 不写、dispose 不写、跨拖动余数不丢、工作区变更加 passthrough 回退 | 同上 · 契约 2/3 | **pass** |
| 点击语义 | 无位移不写宿主、不读几何；真实拖动不产生 reaction | `equivalence.test.ts` + `two-arm.e2e.test.ts` | **pass**（单击恰 1 次 reaction，拖动 0 次） |
| 机制门 | 500Hz 压力下主进程 `setPosition` 减少 **≥50%**（纯 trace + 合成指针两条） | `equivalence.test.ts` · 500Hz / `two-arm.e2e.test.ts` · 压力臂 | **pass**：纯 trace 不变式 + 合成 496→125（−74.8%） |
| 常规输入不退化 | 60/125Hz 真实指针：首写/末写/中位时延，开启臂不得比关闭臂**新增 >8ms 主动等待**；首/末写不等 timer | `two-arm.e2e.test.ts` · 时延用例 | **pass**（中位：60Hz 2→2ms，125Hz 2→2.5ms；末写 1.5→1 / 8→8.5ms） |
| 两臂落点一致 | 同轨迹下两臂最终窗口位置（DIP）完全相等 | `two-arm.e2e.test.ts` · 落点用例 | **pass**（128/104；压力臂 580/80） |
| 退出与残留 | 退出码 0、调试端口释放、无残留进程、拖动结束后无迟到写入（timer 不泄漏） | 同上（每个用例的 `finally`） | **pass**（5 轮 ×2 臂：alivePids=0、portOpen=0、extraWrites=0） |
| 成本结论 | 交替各 5 轮：写入数、主进程 CPU（jiffies）、首/末写时延、残留 | `cost-compare.ts` → `runs/<stamp>/summary.json` | **no-real-write-reduction**（27→27 写、30→30ms、时延中位 31→27.5ms） |

判定口径（`cost-compare.ts` 自动给出 `verdict`）：

- `no-real-write-reduction`：真实 60Hz 轨迹下写入没有可重复减少 → 按阶段门**不建议转正**
  （此时机制门只在 500Hz/合成输入下成立，属于"只 synthetic 变好"）。
- `reduction-without-reproducible-benefit`：写入确实减少，但 CPU 或提交尾延迟没有可复现收益
  （差值落在波动内也算）→ **不建议转正**。
- `candidate`：写入可重复减少 **且** CPU 或提交时延中位有可复现收益 → **下一步候选**，正式启用由负责人定。

## 原始值

### 基础设施自检（**只跑关闭臂，不构成验收结论**）

`selfcheck-off-arm.ts`，Xvfb `:144`、1920x1080、scale=1、`--no-sandbox`、`PET_NEXT_PREVIEW=short,behavior-demo`：

| 项 | 值 |
|---|---|
| 手势 | pointerdown → 1 步 +30px（跨 5px 阈值）→ 3 步 +2px → 松手 |
| 主进程写入 | 4 条（= 4 次 drag-move，基线逐事件直写） |
| 窗口位置 | 80,80 → 116,80（+36px，与指针位移一致） |
| 首写时延 | 3 ms |
| 末写时延 | 3 ms |
| 拖动后自主动作 | `idle:idle-1` → `idle:idle-1,auto:auto-2`（demo 冷却 1600ms 后恢复） |
| 退出 | 退出码 0、端口释放、无残留进程、`writesAfterQuit == writesAtQuit` |
| 拖动结束后 200ms | 零迟到写入 |

压力臂（`dispatchPointerBurst`，页面内合成 PointerEvent，CDP `Runtime.evaluate` 注入）在关闭臂上的实测：

| 项 | 值 |
|---|---|
| 有效速率 | 500 Hz（500 条 / 1001 ms；`setTimeout(2)` 实测只有 247Hz，故改为 `performance.now()` 自旋） |
| 主进程写入 | 496 条（500 条事件 − 前 4 条未越过 5px 阈值） |
| 落点 | 80 → 580 DIP（500 步 × 1 DIP，精确） |

这组数只说明"启动 / 真实指针 / 写入计数 / 时延配对 / 压力注入 / 退出清理"这套装置可用，
**不能**当作候选臂的收益证据。

### 为什么压力臂不用 `Input.dispatchMouseEvent`

按契约要求先试过 CDP 视口事件，实测两条硬伤（已在本机复现，不是推测）：

1. **到不了 500Hz**：每条 `Input.dispatchMouseEvent` 都要一次 CDP 往返，400 条耗 **6667ms ≈ 60Hz**。
   60Hz 下 16.7ms 的间隔远大于 8ms 预算，候选根本没有可合并的写入 —— 机制门会变成假阴性。
2. **screenX 正反馈**：视口事件的 `screenX` 由（正在被产品移动的）窗口原点推出，
   而产品又按 `screenX` 再移动窗口，形成自激。实测 400 条 ×1px 的输入把窗口从 80 DIP
   一路推到工作区右边缘 **1600 DIP**，位移口径已失真。

所以压力臂改为"保留产品真实链路（`#pet` 监听 → 手势归约 → `window.pet.moveBy` → 主进程控制器 →
`setPosition`），只把指针来源换成页面内合成 PointerEvent，`screenX` 由测试给定"，
这样既有 500Hz 的可控密度，也没有窗口反馈污染。**它仍然不等于物理鼠标**，只用于机制门。

### 候选臂（开关 `PET_NEXT_DRAG_WRITE_BUDGET=1`）

真实指针两臂（xdotool，6 步 ×{8,4}px、步间隔 20ms）：

| 臂 | 写入条数 | 最终位置 | 首写/末写/中位时延 ms | 退出 |
|---|---|---|---|---|
| 关闭 | 6 | 128,104 | 见下（60/125Hz 采样） | 0，无残留 |
| 开启 | 6 | 128,104 | 见下 | 0，无残留 |

500Hz 页面内合成指针（`#pet` 上 dispatch，`screenX` 由测试给定）：关闭 **496** 写 →
开启 **125** 写（**−74.8%**），两臂落点同为 580/80。这就是机制门；它不是物理鼠标的数据。

60/125Hz 真实指针时延（6 个手势的首写/末写中位，ms）：

| Hz | 关闭（首/末/中位） | 开启（首/末/中位） |
|---|---|---|
| 60 | 2 / 1.5 / 2 | 2 / 1 / 1.5 |
| 125 | 1 / 8 / 2 | 2 / 8.5 / 2.5 |

5 轮交替成本（`runs/2026-11-10T06-10-21-784Z/summary.json`，60Hz 真实轨迹）：

| 项 | 关闭（原始值） | 开启（原始值） | 中位 |
|---|---|---|---|
| `setPosition` 条数 | 27,27,27,27,27 | 27,28,27,27,27 | 27 → 27 |
| 主进程 CPU（ms，jiffies） | 30,30,30,30,40 | 30,30,20,30,40 | 30 → 30 |
| 首写时延 ms | 51,41,50,37,48 | 47,37,44,38,49 | 48 → 44 |
| 末写时延 ms | 16,7,16,2,14 | 11,18,10,3,14 | 14 → 11 |
| 残留 | 0 进程 / 0 端口 / 0 迟到写 | 同左 | — |

**结论（`no-real-write-reduction`）**：常规 60Hz 真实拖动下两臂写入数完全相同（27 vs 27），
CPU 与提交时延差异落在波动内（首启单列：27 写、40ms，不称 OS 冷缓存）。
收益只出现在 ≥125Hz（尤其 500Hz 合成输入）——属于“只有 synthetic 变好”，
按阶段门**不建议转正**；候选保持默认关闭。

已知代价与偏差：
- 拖动边界的第一条 moveBy 即使位置没变也会写一次（契约“首写即时” + `begin()` 重置去重状态），
  每次拖动最多多 1 次写入；`equivalence.test.ts` 用显式用例记录，不隐藏在 collapse 里。
- 本机是 1 核共享容器，实测期间 load 10–17；所有时延为软件口径（读到 stdout 的时刻），不是物理呈帧。

## 证据分层（不许互相冒充）

1. **真实指针**：`xdotool` 驱动 X11 → 真实 Chromium 输入、真实窗口移动。落点/点击/自主动作/时延只用这一层。
2. **合成指针**：页面内 `PointerEvent`（由 CDP `Runtime.evaluate` 注入，500Hz，`screenX` 由测试给定）
   → **只用于 500Hz 写入条数机制门**。`Input.dispatchMouseEvent` 已实测不可用（速率只有 60Hz、
   `screenX` 随窗口正反馈），见上一节。
3. **纯 trace**：固定 seed 的确定性输入序列 → 正确性/机制门，不依赖真实负载。
4. **软件提交 ≠ 物理呈帧**：`{event:'bounds'}` 只证明 `setPosition` 已返回。

## not-run

- **Windows 真实鼠标拖动**：本机无 Windows。复跑：
  `pnpm verify:windows`，或 `node scripts/record-platform-run.mjs -- pnpm test`，
  再在 Windows 上执行 `tests/drag-write-budget/two-arm.e2e.test.ts`（需要真实鼠标或 xdotool 等价通道）。
- **物理呈帧 / 屏幕上的实际帧**：不在本轮范围，不用 `setPosition` 数据替代。
- **n=5 的 P95 与统计显著性**：样本量不足，报中位数与原始值，不做显著性检验。
- **companion 的聊天 POST 路径**：本轮只验证"自主动作恢复且零模型 POST"，
  不验证聊天发送链路（与拖动写入预算无关）。

## 文件

```
tests/drag-write-budget/
├── equivalence.test.ts        # 纯单元：调度器语义 + 适配器 vs 产品控制器等价（不需要 Xvfb）
├── two-arm.e2e.test.ts        # 正式入口两臂（真实 Electron + 真实指针 + 500Hz 合成指针臂）
├── cost-compare.ts            # 交替各 N 轮成本对照 → runs/<stamp>/raw.ndjson + summary.json
├── selfcheck-off-arm.ts       # 基础设施自检（只跑关闭臂）
├── support/
│   ├── contract.ts            # 候选公开面 + 动态加载（带 skip 原因）
│   ├── scheduler.ts           # 纯调度器公开面 + 路径探测
│   ├── harness.ts             # 参考模型/候选驱动/匹配器（不复制夹边逻辑）
│   ├── fake-clock.ts          # 注入时钟；resurrectAll() 验证旧 timer 不得写
│   └── app.ts                 # 启动/CDP/xdotool/写入计数/时延/退出残留
└── runs/<stamp>/              # 原始 json/ndjson + summary.json
```

设计要点：

- **参考模型就是产品现有代码** `adapters/window/controller.ts`（逐事件 `advanceOrigin` + 每次直写），
  不另写一份夹边/取整逻辑。
- 候选**只经公开 API**（`moveBy`/`endDrag`/`noteGeometryChanged`/`dispose`/`stats`）驱动，
  不 import 任何内部私有函数，不读内部字段。
- 密集输入下不要求逐条相等（合并是设计意图），改为三条硬约束：
  写入必须是**某一步的逐事件结果**（子序列，禁止插值/求和）、顺序不倒置、收尾 flush 后末写 = 参考末态。
- 时延只取**手势两端**（越阈值那一下 / 松手 flush）：真实指针拖动时窗口本身在动，
  `screenX` 与位置序列不是 1:1 对齐，按位置反解会把提交配到更晚的输入上，测出整帧的负时延伪影。

## 复跑

```bash
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
cd pet-next
pnpm install --frozen-lockfile --prefer-offline
# Electron 二进制缺失时（安装脚本未跑）：从同版本 dist 补齐，或用 ELECTRON_OVERRIDE_DIST_PATH

# 1) 纯单元（不需要显示号）
node --experimental-strip-types --test --test-reporter spec tests/drag-write-budget/equivalence.test.ts

# 2) 正式入口两臂（需要 Xvfb；Electron 需 --no-sandbox，脚手架已加）
Xvfb :144 -screen 0 1920x1080x24 -nolisten tcp &
export DISPLAY=:144
pnpm build
node --experimental-strip-types --test --test-concurrency=1 --test-reporter spec \
    tests/drag-write-budget/two-arm.e2e.test.ts

# 3) 成本对照（交替各 5 轮）
node --experimental-strip-types tests/drag-write-budget/cost-compare.ts --rounds=5
#    产物：tests/drag-write-budget/runs/<stamp>/raw.ndjson + summary.json

# 4) 基础设施自检（只跑关闭臂，非验收）
node --experimental-strip-types tests/drag-write-budget/selfcheck-off-arm.ts
```

`cost-compare.ts` 的退出码：`0` = 有测量；`2` = `status: blocked`（接线或显示号缺失）。
blocked 不是"通过"，也不写任何测量值。

## 约束自检

- 未修改 `app/`、`electron/`、`adapters/`、`experiments/`、`bench/`、`contracts/`、`package.json`。
- 未改默认开关：关闭时 `main.ts` 原样，一个分支都不多走（由 e2e 关闭臂的"无迟到写入/退出码 0"覆盖）。
- 本轮零真实模型 POST：companion 用例只连本地 `tests/support/fake-model-service.mjs`，且断言 POST 数 = 0。
