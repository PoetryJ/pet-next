# M3-11 A：活跃拖动的系统写入观测（基线，未接候选）

任务：先测“现有拖动链是否存在值得消除的写入工作”，**先不宣称热点**。
链路（产品原样，一行未改）：`pointermove → core/interaction/gesture.ts(相对 dx/dy) →
app/page.ts → preload(ipcRenderer.send 'pet:move-by') → electron/main.ts →
adapters/window/controller.ts(moveBy→advanceOrigin 夹边) → BrowserWindow.setPosition`。

- 基线提交：`155ca8b`（M3-11 契约冻结），应用代码与 `main` 同一份，未改。
- 唯一写入真值来源：main 在 `PET_NEXT_TEST=1` 时自己打印的
  `{"event":"bounds","bounds":…,"requested":…,"physical":…}`。bench **没有**自造写入计数器。
- 本机：Linux，容器 `nproc=1`（`os.cpus()` 报 384，实际配额 1 核），Xvfb `:141` 1920x1080，零真实模型 POST。

## 0. 一句话结论

真实（CDP 合成）路径上“同 8ms 内多次写入”**只出现在 ≥125Hz 的输入速率**：60Hz 为 0%，125Hz 时 48% 的写入
与相邻写入相隔 <8ms，但按 8ms 预算只能省 **2–3%**（输入本身就是 ~120 次/秒，预算上限 125 次/秒几乎不咬合）；
500Hz 合成压力下才有 53.3%（cdp）/70.9–72.8%（fixture）的纸面减少。单次 `setPosition` 中位 **16µs**，
相同坐标重复写 **0 次**（3,884 次写入）。
**0.1ms 相邻写配对已定因：输入成对到达（`moveBy` 与 pointermove 严格 1:1），不是产品双写**，见 §1.5。
**建议：本轮不要把这套 8ms 排队接进产品默认路径；先补一条 Windows 物理鼠标命令，确认物理到达率与单次提交成本。**

> 对“真实（CDP）路径是否存在值得消除的写入”的判定：**否**（在本机 scale=1、未触工作区边、60/125/500Hz 这三档条件下）。
> 需要留的口子：Windows 物理鼠标与物理呈帧都是 not-run（§5）。

## 1. 四个判定（给负责人做“继续/停止”依据）

### 1.1 存在同 8ms 窗口内多次写入吗？

| 输入臂 | 写入数 | 相邻写入间隔中位 | <8ms 的成对写入 | 占写入比例 | 单 8ms 桶最多几次 |
|---|---|---|---|---|---|
| cdp 60Hz（2 轮） | 480 / 480 | 16.58 / 16.56 ms | 0 / 0 | **0%** | 1（两轮都是） |
| fixture 60Hz | 451 | 16.61 ms | 0 | **0%** | 1 |
| cdp 125Hz（2 轮） | 457 / 453 | 8.41 / 8.40 ms | 220 / 218 | **48.1%** | 2 / 2 |
| fixture 125Hz | 448 | 8.42 ms | 211 | **47.1%** | 3 |
| cdp 500Hz | 255 | 3.47 ms | 241 | **94.5%** | 5 |
| fixture 500Hz（2 轮） | 416 / 444 | 2.35 / 2.31 ms | 415 / 443 | **99.8%** | 6 / 6 |

判据（**修订版**：主判据改为“独立输入序 + 8ms 定长桶”，相邻写间隔降为参考，理由见 §1.5）：

- 主判据 A（输入侧，独立序）：renderer 只读观察器记录的 pointermove，相邻间隔 <8ms 的成对比例；
- 主判据 B（写入侧，8ms 定长桶）：`bucketCount` / `multiBucketCount` / `writesInMultiBucket` / `maxPerBucket`；
- 参考判据 C（写入侧相邻写间隔 <8ms）：会被 stdout 传递抖动压缩或放大（实测 `|wGap − pGap|` 最大 0.887ms），只作参考。

| 输入臂 | 输入侧 <8ms 成对（独立序） | 桶数 | 多写桶数 | 多写桶内写入 | 桶内最多 | 多写桶/桶数 | 多写桶内写入/全部写入 | 相邻写 <8ms（参考） |
|---|---|---|---|---|---|---|---|---|
| cdp 60Hz | 0/480（0%） | 480 | 0 | 0 | 1 | 0% | 0% | 0（0%） |
| cdp 60Hz r2 | 0/480（0%） | 480 | 0 | 0 | 1 | 0% | 0% | 0（0%） |
| fixture 60Hz | 0/480（0%） | 451 | 0 | 0 | 1 | 0% | 0% | 0（0%） |
| cdp 125Hz | 240/477（50.3%） | 283 | 174 | 348 | 2 | 61.5% | 76.1% | 220（48.1%） |
| cdp 125Hz r2 | 235/469（50.1%） | 285 | 168 | 336 | 2 | 58.9% | 74.2% | 218（48.1%） |
| fixture 125Hz | 240/477（50.3%） | 287 | 161 | 322 | 2 | 56.1% | 71.9% | 211（47.1%） |
| cdp 500Hz | 465/465（100%） | 117 | 87 | 225 | 4 | 74.4% | 88.2% | 241（94.5%） |
| fixture 500Hz | 437/437（100%） | 120 | 119 | 415 | 5 | 99.2% | 99.8% | 415（99.8%） |
| fixture 500Hz r2 | 470/470（100%） | 121 | 121 | 444 | 5 | 100% | 100% | 443（99.8%） |

两条主判据互相印证（125Hz：输入侧 50% vs 写入侧 48%；60Hz：两侧都是 0）→ 8ms 内成对写入是**输入本身的形状**，
不是 bench 抓 stdout 抓出来的，也不是产品把一次输入写成两次。原始时刻见 `runs/<stamp>/bounds.ndjson` 与 `pointer.ndjson`。

**但“8ms 内成对”≠“8ms 预算能省掉一半”**。把每轮真实发生的写入时刻按冻结契约的规则重放
（首写即时 / 距上次 <8ms 只留 pending / 定时器到点写一次 / 结束 flush）：

| 输入臂 | 实际写入 | 8ms 预算纸面投影 | 可减少 |
|---|---|---|---|
| cdp 60Hz | 480 / 480 | 480 / 480 | **0% / 0%** |
| fixture 60Hz | 451 | 451 | **0%** |
| cdp 125Hz | 457 / 453 | 447 / 440 | **2.2% / 2.9%** |
| fixture 125Hz | 448 | 438 | **2.2%** |
| cdp 500Hz | 255 | 119 | **53.3%** |
| fixture 500Hz | 416 / 444 | 121 / 121 | **70.9% / 72.8%** |

- 投影脚本：`node bench/drag-write-budget/reproject.mjs`（只读 `runs/*/bounds.ndjson`，不重跑 Electron）。
- 500Hz 的 50% 机制门**纸面通过**，但它是投影、不是候选实现实测；且 500Hz 只是机制压力，**不能当物理鼠标 500Hz**。
- 125Hz 这一档最值得注意：48% 的写入确实挤在 8ms 内，但那是**抖动**（成对突发），预算只是把它们挪到下一个
  8ms 槽，几乎不减少总量。**“成对比例”会高估收益，判收益要看投影这一列。**

### 1.2 存在相同坐标重复写吗？

**没有。9 轮共 3,884 次写入，相邻重复坐标 0 次**（`bounds.ndjson` 里 `requested` 的相邻比较）。

核对 team-lead 提到的“cdp-500 的 distinctCoordinates 只有 43”：以提交的 `runs/` 为准，
**cdp-500 的 distinct 是 239**（255 次写入）；**21–43 是 fixture-500 的值**（416/444 次写入）。
`distinct < writes` 的原因是轨迹周期性回到同一堆绝对坐标（正弦路径/零和循环），不是相邻重复；
`duplicateRequested=0` 表示任何相邻两条写入的 `requested` 都不相同。若出现夹边或取整导致的重复写，
这一列会是非 0 —— 纯 trace 回放（下面两条）证明了该机制**确实存在**，只是本机条件没触发。

原因是结构性的，不是运气：
- `core/interaction/gesture.ts` 在 **screen 坐标**层面就过滤了 `dx==0 && dy==0`，零位移不产生 `drag-move`；
- 本机 `scaleFactor=1`、`screenX/screenY` 是整数、拖动轨迹没有触碰工作区边缘 → `advanceOrigin` 的
  `Math.round` 不会把小数累积塌缩成同一个整数。

**但“会不会重复写”在别的条件下是“会”**，纯 trace 回放（`trace.test.ts`）已经证死：
- 顶到工作区右边界后继续右移：6 次写入里 ≥3 次是相同坐标；
- 0.4 DIP/次的慢速拖动：`round` 之后必然出现相邻相同坐标。

所以这一项在**本机当前条件**下不是可消除的浪费；Windows 上系统缩放 125%/150% 或拖到屏幕边时需要另测
（这是 D 的等价性用例已经覆盖的范围，不是本轮 A 的能量范围）。

### 1.3 单次提交成本 / 主进程 CPU 可测吗？

可测，但很小。

| 指标 | 值 | 口径 |
|---|---|---|
| `setPosition` 单次 | **15.8–16.5 µs**（中位，n=300/轮） | 独立 Electron 微基准（`probe-setposition-main.cjs`），主进程内 `process.hrtime.bigint()` 差值 |
| `getBounds` 单次 | 0.9–1.0 µs | 同上 |
| 空循环 control | 0.1–0.2 µs | 同上（减计时开销用） |
| `getBounds+setPosition` | 15.4–16.3 µs | 同上（≈ controller.moveBy 的宿主开销） |
| 主进程 CPU（60Hz 拖动） | **3.33% / 3.57%**（27–30 jiffies，8.0s） | `/proc/<main pid>/stat` utime+stime 差，CLK_TCK=100 |
| 主进程 CPU（125Hz） | **5.42% / 5.19%**（22–23 jiffies，3.84s） | 同上 |
| 主进程 CPU（500Hz） | **10.27%**（cdp）/ **13.21–13.22%**（fixture） | 同上 |
| 每次写入摊到的主进程 CPU | 0.41–0.63 ms | jiffies 差 / 写入数（含 IPC、事件循环、X11 提交，**不是** setPosition 本身） |
| 输入→软件提交（读到 bounds 行） | 中位 **0.205–0.405 ms**，最大 1.07–1.96 ms | renderer `performance.now()` 与 bench 单调钟两点对齐后按序号配对 |

- 不报 P95、不做显著性检验；每档 n=2（125Hz、60Hz、fixture-500Hz）或 n=1（500Hz cdp、fixture-60Hz/125Hz）。
- `setPosition` 只占“每次写入 CPU”的 ≤3%（16µs / 0.41–0.63ms）。**主进程 CPU 的增长主要不是窗口写入**，
  因此“合并写入省 CPU”在当前证据下只能省到个位数百分比里的一小撮。
- 容器配额 1 核且同机可能有其它 worktree 在跑 GUI，CPU% 应读作**量级与上限**，不是精确基准。
- **机器负载（必读）**：采集窗口内同机有 4 个 agent 并行，**本次 9 轮没有逐轮记录 loadavg**
  （`run.mjs` 已从下一轮起把 `os.loadavg()` 写进 `summary.json`，本轮数据没有这个字段）。
  收口时机器读数 `load1=22.57 / load5=18.14 / load15=13.60`（team-lead 同步的采集期读数为 11+）。
  因此 3.33%→5.42%→10.27% 这类差值**不能**作为“合并写入省 CPU”的证据，两臂 CPU 对比必须在同等负载下重跑。
- 微基准窗口是 `show:true / transparent / alwaysOnTop / 无页面播放`，比真实场景轻；真实产品上下文里
  “每事件主进程 CPU 0.41–0.63ms”远高于 16µs，说明**真正的成本在 IPC/事件循环/X11 提交与合成，不在
  `setPosition` 这一调用本身**。这一条是本轮最容易被误用的数字，请按“下界”理解。

### 1.4 结论一句话

真实（CDP）路径在 125Hz 输入下确有 48% 的写入挤在同 8ms 内，但 8ms 预算只能省 2–3%、单次提交 16µs、
重复坐标写 0 次 —— **没有值得为产品默认路径引入 8ms 排队的证据，建议停止 C 接线**，把结论先钉在
“Windows 物理鼠标未测”这一条 not-run 上（命令见第 5 节）。

### 1.5 0.1ms 相邻写配对：已定因 = 输入成对到达，不是产品双写

问题（team-lead）：cdp-125 的写入间隔是双峰，约每 15–16ms 出现一对 0.1–2ms 的相邻写；而输入声称 ≥6ms
一次，所以 0.1ms 两次写“不可能是两次 pointermove”。逐个假设核对：

| 假设 | 结论 | 证据（可自证，见下） |
|---|---|---|
| (a) 一次 pointermove 触发两条 setPosition（产品双写） | **否** | 每条 drag-move 恰好 1 条 bounds 行；写入数从不超输入数 |
| (b) 同一行 bounds 被计两次 / 跨窗口重复计 | **否** | 每条 bounds 行唯一；`chunksWithMultipleBoundsLines=0`；renderer 无重复时间戳 |
| (c) requested 与 bounds 两行混算 | **否** | 只认 `event:'bounds'` 且 `requested` 有限的整行；每行只贡献 1 条写入 |
| (d) 测量口径问题 | **部分成立，已修判据** | 相邻写间隔含 stdout 传递抖动（`|wGap−pGap|` 最大 0.887ms）；主判据改为独立输入序 + 8ms 桶（§1.1） |

数量链（每轮都在 summary 里）：`dispatch → pointermove → dragMoves(阈值后、位移非零) → bounds(写入)`

| 臂 | dispatch | pointermove | dragMoves | bounds=写入 | bounds/dragMoves |
|---|---|---|---|---|---|
| cdp-60 | 480 | 481（含按下前 1 条） | 480 | 480 | **1.000** |
| cdp-125 | 480 | 478 | 457 | 457 | **1.000** |
| cdp-500 | 480 | 466 | 255 | 255 | **1.000** |
| fixture-500 | 480 | 438 | 416 | 416 | **1.000** |

- `controller.moveBy` 对每个有限位移**无条件** `setPosition` 一次（`adapters/window/controller.ts`），
  所以“bounds 行数 == dragMoves 数”直接排除了一次输入两次写；反过来若有双写，bounds 必然多于 dragMoves。
- cdp-125 的 17 对 <0.6ms 写间隔，其对应输入的间隔同样是 0.1–1.7ms（配对索引见下表）；
  `|wGap − pGap|` 均值 **0.074ms**、最大 **0.887ms** → 写入只是在忠实跟随输入的到达时序。
- cdp-500 的 11 对 <0.6ms 写间隔**全部**对应输入间隔 <0.6ms。
- renderer 侧 `performance.now()` 完全相同的 move：**0 条**（同一事件被记两次会立刻暴露）。

cdp-125 连续 20 条（`k` = drag 序列序号；pointer.t 是 renderer `performance.now()`，writeAt 是 bench 单调钟，
两者只用差值）：

| k | pointer.t | 输入间隔 | screen(x,y) | writeAt | 写入间隔 | requested |
|---|---|---|---|---|---|---|
| 81 | 3921.200 | 10.6 | 271,173 | …833.387 | 10.527 | 111,53 |
| 82 | 3926.800 | 5.6 | 270,171 | …839.035 | 5.648 | 110,51 |
| 83 | 3937.300 | 10.5 | 268,170 | …849.566 | 10.531 | 108,50 |
| 84 | 3943.400 | 6.1 | 266,169 | …855.603 | 6.037 | 106,49 |
| 85 | 3952.900 | 9.5 | 265,168 | …865.144 | 9.541 | 105,48 |
| 86 | 3960.300 | 7.4 | 263,167 | …872.530 | 7.386 | 103,47 |
| 87 | 3960.600 | **0.3** | 262,166 | …872.781 | **0.251** | 102,46 |
| 88 | 3977.100 | 16.5 | 260,165 | …889.365 | 16.584 | 100,45 |
| 89 | 3977.200 | **0.1** | 258,164 | …889.467 | **0.102** | 98,44 |
| 90 | 3992.800 | 15.6 | 256,163 | …905.050 | 15.583 | 96,43 |
| 91 | 3993.300 | **0.5** | 255,163 | …905.521 | **0.471** | 95,43 |
| 92 | 4008.900 | 15.6 | 253,162 | …921.155 | 15.634 | 93,42 |
| 93 | 4010.600 | 1.7 | 251,162 | …922.705 | 1.550 | 91,42 |
| 94 | 4025.100 | 14.5 | 249,161 | …937.234 | 14.529 | 89,41 |
| 95 | 4027.100 | 2.0 | 248,161 | …939.273 | 2.039 | 88,41 |
| 96 | 4041.600 | 14.5 | 246,160 | …953.778 | 14.505 | 86,40 |
| 97 | 4043.300 | 1.7 | 244,160 | …955.456 | 1.678 | 84,40 |
| 98 | 4056.800 | 13.5 | 242,160 | …968.987 | 13.531 | 82,40 |
| 99 | 4059.800 | 3.0 | 240,160 | …972.022 | 3.035 | 80,40 |
| 100 | 4073.300 | 13.5 | 238,160 | …985.571 | 13.549 | 78,40 |

读法：`16.5 + 0.1 = 16.6`、`15.6 + 0.5 = 16.1`、`15.6 + 1.7 = 17.3` —— **输入本来就是“等一个刷新周期，再一次投两条”**，
两条的 screen 坐标不同（260,165 → 258,164），各自触发一次 `moveBy`，所以相邻写必然也是 0.1ms 级。
成因在 CDP 注入侧（合成器按批次投递），不在产品侧；`getCoalescedEvents()` 每条只给 1 个也说明没被合并。

**因此这不构成“先修重复写”的理由**：产品没有重复写。0.1ms 配对只影响“用相邻写间隔当判据”的统计方式，
已按 team-lead 要求在 §1.1 把主判据改成独立输入序 + 8ms 定长桶。

## 2. 原始数值表（9 轮，全部字段来自 `runs/<stamp>/summary.json`）

| run | layer | hz | pointermove | 输入间隔中位 | 写入 | 写入间隔中位 | 写入间隔最大 | <8ms 对 | 比例 | 投影8 | 减少 | 重复坐标 | 主进程CPU% | jiffies | CPU秒 | 秒/写入 | setPos中位 | getBounds中位 | 输入→提交中位 | 最大 | 注入速率 | CDP回包中位 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cdp-60 | cdp | 60 | 481 | 16.60 | 480 | 16.579 | 23.853 | 0 | 0 | 480 | 0 | 0 | 3.33 | 28 | 0.28 | 0.00058 | 0.0165 | 0.0009 | 0.365 | 1.242 | 59.99 | 7.082 |
| cdp-60-r2 | cdp | 60 | 481 | 16.60 | 480 | 16.557 | 21.082 | 0 | 0 | 480 | 0 | 0 | 3.57 | 30 | 0.30 | 0.00063 | 0.0160 | 0.0009 | 0.405 | 1.316 | 59.99 | 3.536 |
| cdp-125 | cdp | 125 | 478 | 7.70 | 457 | 8.409 | 17.677 | 220 | 0.4814 | 447 | 0.0219 | 0 | 5.42 | 23 | 0.23 | 0.00050 | 0.0159 | 0.0009 | 0.313 | 1.221 | 124.97 | 7.406 |
| cdp-125-r2 | cdp | 125 | 470 | 7.90 | 453 | 8.398 | 16.722 | 218 | 0.4812 | 440 | 0.0287 | 0 | 5.19 | 22 | 0.22 | 0.00049 | 0.0162 | 0.0009 | 0.343 | 1.115 | 125.02 | 7.390 |
| cdp-500 | cdp | 500 | 466 | 2.30 | 255 | 3.472 | 12.497 | 241 | 0.9451 | 119 | 0.5333 | 0 | 10.27 | 14 | 0.14 | 0.00055 | 0.0164 | 0.0009 | 0.341 | 1.223 | 499.72 | 2.443 |
| fixture-60 | fixture | 60 | 481 | 16.60 | 451 | 16.612 | 34.100 | 0 | 0 | 451 | 0 | 0 | 3.33 | 28 | 0.28 | 0.00062 | 0.0165 | 0.0010 | 1.096 | 1.957 | 60.00 | 5.494 |
| fixture-125 | fixture | 125 | 478 | 7.90 | 448 | 8.423 | 23.793 | 211 | 0.4710 | 438 | 0.0223 | 0 | 5.19 | 22 | 0.22 | 0.00049 | 0.0165 | 0.0010 | 0.288 | 1.160 | 124.99 | 7.391 |
| fixture-500 | fixture | 500 | 438 | 2.30 | 416 | 2.347 | 6.719 | 415 | 0.9976 | 121 | 0.7091 | 0 | 13.21 | 18 | 0.18 | 0.00043 | 0.0160 | 0.0009 | 0.300 | 1.103 | 500.08 | 2.360 |
| fixture-500-r2 | fixture | 500 | 471 | 2.15 | 444 | 2.308 | 4.994 | 443 | 0.9977 | 121 | 0.7275 | 0 | 13.22 | 18 | 0.18 | 0.00041 | 0.0158 | 0.0009 | 0.205 | 1.072 | 500.16 | 1.780 |

每轮固定参数：`--moves=480`、`--arm=baseline`、`Xvfb :141 1920x1080x24`、窗口 320x240 起始 (80,80)、
拖动阈值 5px、`BUDGET_MS=8`；`posts=0`、`productExit=0`、`failures=[]`（9/9）。

补充事实：
- **写入 ≤ 输入**：cdp-500 只写 255 次而收到 466 次 pointermove，差的那些是**screen 坐标没变的位移**
  （500Hz 正弦路径每步只有 0.2–0.9px，整数 screenX 把它们吃掉了 → gesture 认为没动 → 不写）。
  fixture-500（每步 1.5–6px）就基本 1:1（438→416、471→444）。这也是“CDP 500Hz 正弦”不能当写入压力臂的原因。
- **Chromium 在 CDP 路径上没有把 pointermove 合帧到刷新率**：注入 480 条 → renderer 收到 438–481 条，
  间隔中位 2.3ms（500Hz 档），且 `getCoalescedEvents().length` 每条都是 1（无合并负载）。
  这条**不能外推**到物理鼠标：50Hz 档 60Hz 输入的到达率与注入率一致（60.00 vs 59.99）只说明 CDP 注入是
  “发多少到多少”，不说明 OS 层会不会合并。
- stdout 传递抖动很小：60Hz 档写入行间距中位 16.579ms vs 输入中位 16.60ms，差 0.02ms 量级；
  9 轮 `chunksWithMultipleBoundsLines=0`（没有一次读到含两条 bounds 的块）→ 行级时间戳可用。

## 3. 口径与分层（别把三层互相冒充）

1. **native（not-run）**：Windows 物理鼠标拖动。本机没有 Windows，本轮**没有**这条数据。
   `tests/platform/cursor.ps1`（`SetCursorPos`+`mouse_event`）与 CDP `Input.dispatchMouseEvent` 都是
   **合成**输入，不能冒充物理鼠标的到达率。复跑命令见第 5 节。
2. **cdp（本机执行）**：`Input.dispatchMouseEvent` 驱动真实 Electron 产品入口。屏幕目标由“起点屏幕坐标 +
   累计位移 − 当前窗口原点”换算成页面坐标，等价真实鼠标的 `screenX` 语义（否则窗口跟随会形成正反馈）。
   派发**不逐条 await**：`Input.dispatchMouseEvent` 会等 renderer/合成器处理完才回包，逐条 await 会把注入
   速率钉死在 ~60Hz（本轮第一次试跑就是这么错的，已丢弃那两轮数据）。`drag.dispatchAckMs` 记录了这个回包延迟。
3. **pure-trace（本机执行）**：`lib/trace.mjs` 固定 seed（`20261110`）的确定性位移序列；`--source=fixture`
   用它驱动真实产品链，`trace.test.ts` 用同一条序列回放产品原样的 gesture+controller（不经 Electron）。
   只用于正确性/机制门，**不当真实输入**。
4. **软件提交 ≠ 物理呈帧**：`bounds` 行只代表 `win.setPosition` 已被调用并返回，不代表 OS 已合成、
   更不代表显示器已经画出。本轮所有时间都是**软件时间**。
5. **写入时刻是上界**：产品 `electron/main.ts` 的 bounds 行**没有时间戳**（任务书假设有，实际没有）。
   bench 记录的是“读到这一行的时刻”，含 IPC + stdout + 入口链（`chat-local-core` 会加 `[electron] ` 前缀
   并逐行转发）的跳数。因此 1.1 的“同 8ms”判定是软件口径；抖动上界由 60Hz 档的 0.02ms 偏差给出量级。
   要在 main 内取真时间戳必须改产品文件（本轮禁止），留给 D 或后续。

## 4. 复跑

```bash
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
cd pet-next

# Xvfb 由 run.mjs 自己保证（显示号 :141 专用于本目录；不碰别人的 :94/:95）
env -u NODE_OPTIONS node bench/drag-write-budget/run.mjs --arm=baseline --source=cdp     --hz=60  --stamp=cdp-60     --display=:141
env -u NODE_OPTIONS node bench/drag-write-budget/run.mjs --arm=baseline --source=cdp     --hz=125 --stamp=cdp-125    --display=:141
env -u NODE_OPTIONS node bench/drag-write-budget/run.mjs --arm=baseline --source=cdp     --hz=500 --stamp=cdp-500    --display=:141
env -u NODE_OPTIONS node bench/drag-write-budget/run.mjs --arm=baseline --source=fixture --hz=60  --stamp=fixture-60 --display=:141
env -u NODE_OPTIONS node bench/drag-write-budget/run.mjs --arm=baseline --source=fixture --hz=125 --stamp=fixture-125 --display=:141
env -u NODE_OPTIONS node bench/drag-write-budget/run.mjs --arm=baseline --source=fixture --hz=500 --stamp=fixture-500 --display=:141

# 不重跑 Electron，只从已落盘的 bounds.ndjson 重算“同 8ms”与 8ms 预算投影
env -u NODE_OPTIONS node bench/drag-write-budget/reproject.mjs

# 自证“一次输入是否只写一次”：对齐 dispatch/pointer/bounds，打印数量链与连续事件表（§1.5）
env -u NODE_OPTIONS node bench/drag-write-budget/align-forensic.mjs --run=cdp-125 --limit=20

# 纯单元（trace 生成器 + 分析函数 + 纯 trace 回放；被 pnpm test 自动收集）
env -u NODE_OPTIONS node --experimental-strip-types --test bench/drag-write-budget/trace.test.ts
```

- 单核机器：**必须串行**，`runs/.lock` 会在有别的 bench 在跑时退 3。
- `--arm=candidate` 会被拒绝：本轮产品入口没有接线，硬跑只会得到假数据。
- 每轮固定动作：`--moves=480`，60Hz=8.0s、125Hz=3.84s、500Hz=0.96s；单轮总耗时 12–21s（含构建检查、
  fake 模型、CDP 注入、关窗、微基准）。
- 约 3 分之一的启动时间花在 `pnpm build` 的 mtime 检查上；构建过期会自动重建（只写 `dist/`）。

## 5. Windows 物理鼠标（not-run，单条命令）

为什么要单独一条：本仓库现有的 Windows 脚本只有 `tests/platform/cursor.ps1`（`SetCursorPos`+`mouse_event`）
和 `verify-windows.ps1`，两者都是**程序合成**输入；合成输入测不出“物理鼠标 125/1000Hz 的到达率是否被
Windows/Chromium 合帧”。这条命令让人用真鼠标拖，只采集 main 自己打印的 bounds 行。

在 Windows 的 `pet-next` 目录（PowerShell，先 `pnpm install; pnpm build` 一次），**一条命令**：

```powershell
cd pet-next; $env:PET_NEXT_TEST='1'; node scripts/demo.mjs --max-duration=25 2>&1 | ForEach-Object { "{0:HH:mm:ss.fff} {1}" -f (Get-Date), $_ } | Tee-Object -FilePath ..\drag-native-win32.log
```

- `$env:PET_NEXT_TEST='1'` 是必须的：只有它让 main 打印 `{"event":"bounds",…}` 行；`--max-duration` 本身不设这个开关
  （`--record` 会设，但它在 Windows 上没有 xdotool，录制序列直接 `not-run` 并立刻收尾，抓不到人工拖动）。
- 跑起来后**用真鼠标按住桌宠拖动 5–10 秒**，建议各来一次慢速（~30px/s）与快速（~500px/s），然后等 25s 自动收尾。
- 前缀 `{0:HH:mm:ss.fff}` 是 PowerShell 记录的**行到达时刻**（ms 分辨率）；`parse-native-log.mjs` 依赖这个前缀。

判读（Linux/Windows 都能跑，只解析不合成）：

```bash
node bench/drag-write-budget/parse-native-log.mjs drag-native-win32.log
```

会输出与第 1 节同一套指标（写入数、间隔中位、`<8ms` 成对比例、重复坐标、8ms 投影）。需要提交什么：
把 `drag-native-win32.log` 和这条命令的输出贴回证据目录即可，**不要**用 CDP/cursor.ps1 的结果代替。

## 6. 产物、原始数据与本次环境处理

```
bench/drag-write-budget/
  run.mjs                     # CLI：--arm=baseline --source=cdp|fixture --hz=60|125|500 --stamp= --display=
  reproject.mjs               # 只读重算：<8ms 成对 + 8ms 预算纸面投影
  align-forensic.mjs          # 只读自证：输入↔写入按序号对齐，排除“一次输入两次写”
  parse-native-log.mjs        # 解析 Windows 物理鼠标日志（第 5 节）
  inject-observe.js           # renderer 侧只读 pointer 观察器（CDP 注入，不改产品文件）
  probe-setposition-main.cjs  # 独立 Electron 微基准：setPosition/getBounds 单次耗时
  lib/trace.mjs               # 固定 seed 的 trace 生成/解析 + cdp 屏幕轨迹
  lib/analysis.mjs            # 纯分析函数（间隔/8ms 成对/重复坐标/投影/CPU/jiffies）
  trace.test.ts               # 15 个纯单元（含纯 trace 回放：每条非零位移一次写、夹边与取整会产生重复坐标）
  runs/<stamp>/               # 每轮原始数据
```

`runs/<stamp>/` 内容：
- `summary.json` — 本轮全部指标（README 表格即取自它）
- `bounds.ndjson` — **每一条** main 打印的写入，带 bench 侧单调时刻与 chunk 序号（写入真值来源）
- `pointer.ndjson` — renderer 只读观察器记录的全部 pointer 事件（`performance.now()`、screen 坐标、coalesced 数）
- `dispatch.ndjson` — bench 实际派发的每一条 mouseMoved（时刻、页面坐标、窗口原点估计）
- `probe-setposition.ndjson` — 微基准每条原始样本（µs）
- `input-plan.ndjson` / `input-trace.ndjson` — 本轮输入序列（fixture 那份可复现，seed 写在文件名旁的表头）
- `product-stdout.log`、`fake-ssh.ndjson`、`requests.ndjson`、`exit.txt` — 入口日志、fake SSH 记录、
  fake 模型请求（**应为空**）、退出码
- `user-data/` — 本轮 Electron profile（**已从提交中删除**，可由复跑重建，无证据价值）

环境处理（如实记录，不影响产品）：
- 本 worktree `pnpm install --frozen-lockfile --prefer-offline` 成功，但 `electron` 的 postinstall 没有把
  二进制下载下来（`node_modules/electron/dist` 缺失）。为让 GUI 能起，从**已完成轮次**的 worktree
  `m310-wt-a` 复制了同版本（43.3.0）`dist/` 与 `path.txt` 到本 worktree 的 `node_modules/electron/`。
  这只动本 worktree 的依赖产物，**没有**改产品文件、没有碰 `m38-wt-lead`。
- 未访问 `127.0.0.1:18872`；`posts=0` 是每轮从 `requests.ndjson` 行数核对的。
- 本轮没有修改 `app/ core/ adapters/ electron/ tests/ contracts/ package.json`，也没有 `push/reset/clean`。
