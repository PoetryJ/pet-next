# M3-11 D：拖动写入预算的独立等价与成本验收

角色 D 的独占目录。**只做验收，不改产品代码、不改默认开关、不访问 18872、零真实模型 POST。**
冻结契约见 `docs/M3-11-DRAG-WRITE-BUDGET.md`（基线 `3daebc6`）。

> **本轮最终裁决（2026-11-10）：停接线。** 阶段门 1 的答案是“否”——真实/CDP 路径没有值得
> 消除的写入（60Hz 两臂 27→27 / 28→28；Chromium 按帧合并，2ms×30 的 mousemove 只到 4~5 条
> pointermove），只有页面内直接注入 PointerEvent 才有 496→125。产品侧已回退到 `3daebc6` 原样，
> `tests/drag-write-budget/` 的等价与两臂用例在候选缺席时**带原因 skip**（不假绿），
> 保留下来作为负结果的可复跑证据。

## 结论（本轮）

**不建议转正：保持默认关闭。** 理由分两层，第二层是决定性的：

1. **正确性/等价：通过。** B 的调度器 + C 的适配器上，独立等价用例 **30/30 全通过**（0 skip）：
   夹边非线性（任务书 `9 +5,-5 → 5`、RESEARCH `95 +10,-10 → 90`）、小数 `0.125/0.5`、
   零位移、首动即时、松手/取消 flush、旧 timer 不写、dispose 不写、跨拖动余数、工作区变更加
   passthrough 回退、写入不得插值（子序列门）、500Hz 纯 trace 机制门。
   正式入口两臂 e2e **6/6 通过**：两臂落点一致、点击恰 1 次 reaction 且拖动不误触、
   standard/companion 拖动后自主动作恢复（零模型 POST）、退出码 0 / 端口释放 / 无残留 / 无迟到写入。
2. **真实输入没有可消除的写入。** 真实 X11 指针在 60 / 125 / 500Hz 三档标称速率下，
   主进程写入数两臂**完全相同**（28 → 28、14 → 14）；500Hz 那档是 5 → 4，即「少 1 条」（−20%，噪声级）。原因见下面的"关键发现"：
   Chromium 把高频指针合并成每帧一条（≈60Hz 投递），写入机会本来就不密。
   机制门的 74.6% 减少只出现在**合成注入**（页面内 PointerEvent，绕过投递合并），
   属于契约第 7 节所说的"只 synthetic 变好"。
   成本侧也没有可复现收益：主进程 CPU 中位差 0ms，提交时延中位的中位差 +4.0 / +5.5 / −5.0 ms，都在同机负载波动内。

按阶段门"若真实路径没有可消除的写入，就停止 C 产品接线，交负结果与小原型，保留基线"，
本方案的结论是**保留基线、不启用开关**；候选代码可以留着（默认关闭、零开销）。

## 关键发现：真实指针在渲染层是 ≈60Hz 投递

用 xdotool 在一条命令里发 30 次 `mousemove`（间隔 2ms，标称 500Hz），
主进程基线只写出 **4** 次——即 `#pet` 只收到 4~5 条 `pointermove`。
Chromium 按帧合并指针移动，高频设备不会变成高频 `pointermove`；而写入预算合并的正是
`pointermove` 之后的那一层。所以：

- **真实输入侧没有可合并的写入**（本机 Linux/X11 + Chromium 43.3 实测）；
- 500Hz 的写入减少只在"直接往页面注入 PointerEvent"时成立；
- 这个结论与数据来源有关（Windows 的投递行为 not-run），但足以按阶段门停在这里。

## 与集成分支的差异（需负责人处理）

集成提交 `aecf745`（分支 `codex/pet-next-m3-drag-budget`）**没有提交 `pet-next/contracts/drag-budget.ts`**，
但 `electron/main.ts` 与 `app/page.ts` 已经 `import` 它 → 该分支 `pnpm build` 直接报
`TS2307: Cannot find module '../contracts/drag-budget.ts'`。

为了跑出上面的两臂数据，D 在本机临时补了一个**不入库**的占位文件（`contracts/drag-budget.ts`，
按契约第 1 节最小语义：`PET_NEXT_DRAG_WRITE_BUDGET === '1'` 才启用、query `dragBudget=1`、
通道 `pet:drag-end`、预算 8ms），跑完立即删除。产品文件也来自该集成提交的临时签出
（`runs/*/summary.json` 里的 `productRef: aecf745`）。

**负责人需要补的就是这一个文件（或把它并进 `contracts/index.ts` 并改 import）。**

## 判定表

| 门 | 判据（契约第 7 节） | 用例 | 结果 |
|---|---|---|---|
| 等价性 · 逐事件口径 | 稀疏输入（间隔 ≥ budget）下与参考模型**逐条相等**；贴边重复坐标按契约折叠 | `equivalence.test.ts` | **通过** |
| 等价性 · 夹边非线性 | `9 +5,-5 → 5`（不得 9）、`95 +10,-10 → 90`（不得 95） | 同上 | **通过** |
| 等价性 · 小数 | `0.125`/`0.5` 精确累加到 +1/+5 DIP；密集合并不丢余数 | 同上 | **通过** |
| 等价性 · 终态 | 密集/随机输入下每条写入必须是某一步的逐事件结果（子序列，禁止插值/求和），flush 后末写 = 参考末态 | 同上（240 步，seed `0x5eed`） | **通过** |
| 等价性 · 生命周期 | 首动即时、松手/取消 flush、旧 timer 不写、dispose 不写、跨拖动余数不丢、工作区变更加 passthrough 回退 | 同上 | **通过** |
| 点击语义 | 无位移不写宿主/不读几何；真实拖动不产生 reaction | `equivalence` + `two-arm.e2e` | **通过**（两臂 reaction 各 1 次） |
| 机制门 | 500Hz 压力下 `setPosition` 减少 **≥50%** | 纯 trace + 合成指针两处 | **通过：496 → 126（−74.6%）** |
| 常规输入不退化 | 60/125Hz 真实指针：首写/末写/中位不新增 >8ms 主动等待；首/末写不等 timer | `two-arm.e2e` | **通过**（差值 ≤5ms，见原始值） |
| 两臂落点一致 | 同轨迹下最终位置（DIP）完全相等 | `two-arm.e2e` + `cost-compare` | **通过** |
| 退出与残留 | 退出码 0、端口释放、无残留进程、拖动结束后无迟到写入 | 每个用例 `finally` | **通过**（11+8 次启动全 0 残留） |
| 真实写入可重复减少 | 真实输入下写入数应可重复减少 | `cost-compare` 60/125/500Hz | **未通过：28→28、14→14、5→4（−20%，1 条）** |
| CPU / 尾延迟可复现收益 | 主进程 CPU 或提交时延有可复现收益 | 同上 | **未通过：CPU 中位差 0ms，时延差落在 ±6ms 波动内** |

## 原始值

Xvfb `:144`、1920x1080、scale=1、`--no-sandbox`、`PET_NEXT_TEST=1`（只为 `{event:'bounds'}` 日志）。
机器：AMD EPYC 9K84（容器可见 384 vCPU），**采集时 load average 12–23**（`summary.json` 里有逐轮 `loadAvg`）。
每档 5 轮，关闭/开启交替、奇偶轮反序；进程内首启单列（`firstLaunch`），不进配对统计。

### 写入数 / CPU / 时延（`cost-compare.ts`，原始值 + 中位数）

| 标称速率 | 臂 | 写入数（5 轮） | 中位 | 主进程 CPU ms | 中位 | 首写 ms | 末写 ms | 时延中位的中位 |
|---|---|---|---|---|---|---|---|---|
| 60Hz（17ms） | 关闭 | 28,28,28,28,28 | 28 | 30,30,30,30,20 | 30 | 42,41,49,46,46 | 1,1,1,1,1 | 23.5 |
| 60Hz | 开启 | 28,28,28,28,28 | 28 | 30,30,30,30,30 | 30 | 51,42,51,49,51 | 4,1,4,1,5 | 27.5 |
| 125Hz（8ms） | 关闭 | 14,14,15,14,14 | 14 | 10,20,20,30,30 | 20 | 24,21,3,24,22 | 6,2,17,13,3 | 12.5 |
| 125Hz | 开启 | 14,14,14,15,14 | 14 | 20,30,20,20,30 | 20 | 21,25,28,20,24 | 9,14,8,19,4 | 18 |
| 500Hz（2ms） | 关闭 | 5,5,5,4,5 | 5 | 10,10,10,10,20 | 10 | 2,3,3,2,3 | 15,12,14,1,14 | 8.5 |
| 500Hz | 开启 | 4,4,4,4,5 | 4 | 10,10,20,10,10 | 10 | 20,3,4,2,3 | 8,2,3,3,17 | 3.5 |

- 两臂落点：三档全部 `finalMatch: true`（`from (80,80) → (140,80)`）。
- 残留：15 轮全部 `alivePids 0 / portOpen 0 / extraWrites 0`。
- **60Hz / 125Hz 写入数两臂完全相同**（28 vs 28、14 vs 14）：每步间隔 ≥8ms，没有任何可合并的写入。
- 500Hz 这档 `5 → 4` 是**1 条写入**的差距（−20%），机器判定 `reduction-without-reproducible-benefit`：
  减少不到 50%，CPU 中位差 0ms、时延中位差反而 −5.0ms，都在波动内。
- 125Hz 的实际投递数（14 条写入 / 30 步）再次说明渲染层按帧合并，标称速率不等于事件数。

### 500Hz 合成指针机制门（`two-arm.e2e.test.ts`）

| 臂 | 派发 | 有效速率 | 主进程写入 | 落点 |
|---|---|---|---|---|
| 关闭 | 500 | 499 Hz | **496** | 580,80 |
| 开启 | 500 | 498 Hz | **126** | 580,80 |

减少 **74.6%**，落点精确一致。三重前置守卫：两臂 `mainWrites > 0`、基线臂 `final === expected`，
任一不满足直接 fail（禁止 0/0 比较出"100% 减少"）。

### 正式入口 e2e（6/6）

- 两臂真实指针拖动：`(80,80) → (128,104)`（+48,+24），两臂一致；各 **6 次**写入（间隔 20ms > 8ms，
  按设计不该合并）；松手后 300ms 零迟到写入。
- 点击：单击恰 1 次 `reaction:click-2`（两臂各 1 次），随后拖动**不新增** reaction。
- 自主动作：standard/companion 两臂都在松手后 ≈1.6s 内出现新的 `auto:auto-N`；companion 零模型 POST。
- 时延原始值（每臂每档 6 个手势，只取手势两端）：

| 速率 | 臂 | 首写 ms | 中位 | 末写 ms | 中位 |
|---|---|---|---|---|---|
| 60Hz | 关闭 | 15,2,2,2,2,2 | 2 | 13,1,2,1,2,1 | 1.5 |
| 60Hz | 开启 | 9,2,2,2,2,2 | 2 | 8,1,1,2,2,1 | 1.5 |
| 125Hz | 关闭 | 2,2,2,2,2,2 | 2 | 9,13,17,2,6,9 | 9 |
| 125Hz | 开启 | 2,2,2,1,2,2 | 2 | 15,4,8,13,1,5 | 6.5 |

时延口径：`event.timeStamp`（事件产生时刻，换到 Date.now 时基）→ 测试进程收到 `{event:'bounds'}` 的墙钟差，
含 IPC、主进程排队与 stdout 管道，**不是物理呈帧**。只取手势两端：真实拖动时窗口自己在动，
`screenX` 与位置序列不是 1:1 对齐（按位置配对会测出整帧的负时延伪影）。

### 两个会制造假绿的坑（都已修，记录在此）

1. **页面未就绪就注入**：主进程 `ready-to-show` 早于 `page.ts` 绑定 `#pet` 监听。此时按下去，
   事件全打空 → `mainWrites = 0`、退出码 0、trace 正常，看起来像"100% 减少"。
   现在 `openSession()` 统一等首帧 `idle`（`data-visual`）再返回；修复前 e2e 首例约 50% 概率踩中。
2. **靠窗口 id 判断"是不是本会话的窗口"**：X 会复用窗口 id（实测两臂都是 `2097155`）。
   现在按 `xdotool search --onlyvisible --pid <child.pid>` 绑定，并断言 `getwindowpid`
   等于本会话 pid、且上一臂退出后其窗口已消失（`windowGone`，有界 2s）。

### 为什么本目录用"页面内 PointerEvent"做压力臂

`Input.dispatchMouseEvent` 试过，两处硬伤（实测，非推测）：

1. **到不了 500Hz**：每条一次 CDP 往返，400 条耗 **6667ms ≈ 60Hz**；
2. **screenX 正反馈**：视口事件的 `screenX` 由正在被产品移动的窗口原点推出，产品又按 `screenX` 移动窗口，
   400 条 ×1px 把窗口从 80 DIP 一路推到工作区右边缘 **1600 DIP**。

所以压力臂保留产品真实链路（`#pet` 监听 → 手势归约 → `window.pet.moveBy` → 主进程控制器 → `setPosition`），
只把指针来源换成页面内 `PointerEvent`（`performance.now()` 自旋控节拍，`setTimeout(2)` 实测只有 247Hz），
`screenX` 由测试给定。**它仍然不等于物理鼠标**，只用于机制门。

## 已知口径差（不影响写行为）

1. `coalesced`：契约 2.3 字面是"pending=p 时 coalesced++"；实现按
   "被更晚 submit 取代、或 begin/dispose 丢掉而**从未写出**的坐标条数"计。
   `2.3/2.4` 用例现在断言**精确值**：`written === 2`、`coalesced === 1`、`duplicateDropped === 0`，
   外加静息守恒式 `submitted === written + coalesced + duplicateDropped`。
2. 拖动边界同坐标多写 1 次：契约 2.2（`begin()` → `lastWriteAt=null` → 首写即时）与
   2.6（`end()` 无条件 flush）组合的结果，**每次拖动边界至多 1 次**，不随拖动次数增长。
   已单独立例 `拖动边界同坐标会多写 1 次（已知冗余，上限 1）` 把它钉住：
   候选写入序列恰为 `[80,80,81]`、参考为 `[80,80,80,81]`、末态同为 81/81，不再靠 collapse 掩盖。

## 证据分层（不许互相冒充）

1. **真实指针**：xdotool 驱动 X11 → 真实 Chromium 输入、真实窗口移动。落点/点击/自主动作/时延/成本只用这一层。
2. **合成指针**：页面内 `PointerEvent`（CDP `Runtime.evaluate` 注入，500Hz）→ 只用于写入条数机制门。
3. **纯 trace**：固定 seed 的确定性输入序列 → 正确性/机制门。
4. **软件提交 ≠ 物理呈帧**：`{event:'bounds'}` 只证明 `setPosition` 已返回。

## not-run

- **Windows 真实鼠标拖动**：本机无 Windows。复跑：
  `node scripts/record-platform-run.mjs -- pnpm test`，并在 Windows 上执行
  `tests/drag-write-budget/two-arm.e2e.test.ts`（需 xdotool 等价通道；Windows 的指针投递是否也按帧合并
  未见数据，**不用 Linux 数据替代**）。
- **物理呈帧 / 屏幕实际帧**：不在本轮范围。
- **n=5 的 P95 与统计显著性**：样本量不足，只报原始值 + 中位。
- **companion 聊天发送链路**：本轮只验证"自主动作恢复且零模型 POST"。

## 文件

```
tests/drag-write-budget/
├── equivalence.test.ts     # 纯单元：调度器语义 + 适配器 vs 产品 controller.ts 等价（不需 Xvfb）
├── two-arm.e2e.test.ts     # 正式入口两臂（真实 Electron + 真实指针 + 合成指针压力臂）
├── cost-compare.ts         # 交替各 5 轮成本对照 → runs/<stamp>/raw.ndjson + summary.json
├── selfcheck-off-arm.ts    # 基础设施自检（只跑关闭臂）
├── support/
│   ├── contract.ts         # 候选公开面 + 动态加载（缺失时带原因 skip）
│   ├── scheduler.ts        # 纯调度器公开面 + 路径探测
│   ├── harness.ts          # 参考模型/候选驱动/匹配器（不复制夹边逻辑）
│   ├── fake-clock.ts       # 注入时钟；resurrectAll() 验证旧 timer 不得写
│   └── app.ts              # 启动/CDP/xdotool/写入计数/时延/退出残留
└── runs/<stamp>/           # 原始 json/ndjson + summary.json（含 productRef）
                            # 本轮 3 个目录 = 60/125/500Hz 各一档，均为 status: ok
                            # 接线未落地时的 status: blocked 记录在 git 历史 11012f2 里
```

设计要点：

- **参考模型就是产品现有代码** `adapters/window/controller.ts`（逐事件 `advanceOrigin` + 每次直写），
  不另写一份夹边/取整逻辑。
- 候选**只经公开 API**（`moveBy`/`endDrag`/`noteGeometryChanged`/`dispose`/`stats`）驱动，
  不 import 内部私有函数、不读内部字段。
- 密集输入不要求逐条相等（合并是设计意图），改为三条硬约束：写入必须是某一步的逐事件结果、
  顺序不倒置、flush 后末写 = 参考末态。

## 复跑

```bash
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
cd pet-next
pnpm install --frozen-lockfile --prefer-offline
# Electron 二进制缺失时（安装脚本未跑）：从同版本 dist 补齐，或设 ELECTRON_OVERRIDE_DIST_PATH

# 1) 纯单元（不需要显示号）
node --experimental-strip-types --test --test-reporter spec tests/drag-write-budget/equivalence.test.ts

# 2) 正式入口两臂
Xvfb :144 -screen 0 1920x1080x24 -nolisten tcp &
export DISPLAY=:144
pnpm build
node --experimental-strip-types --test --test-concurrency=1 --test-reporter spec \
    tests/drag-write-budget/two-arm.e2e.test.ts

# 3) 成本对照（三档速率；交替各 5 轮）
for hz in 60 125 500; do
  node --experimental-strip-types tests/drag-write-budget/cost-compare.ts --rounds=5 --hz=$hz
done
#    产物：tests/drag-write-budget/runs/<stamp>/raw.ndjson + summary.json

# 4) 基础设施自检（只跑关闭臂，非验收）
node --experimental-strip-types tests/drag-write-budget/selfcheck-off-arm.ts
```

`cost-compare.ts` 退出码：`0` = 有测量；`2` = `status: blocked`（接线或显示号缺失）。blocked 不是"通过"。
`PET_NEXT_COST_PRODUCT_REF=<ref>` 只用于在 summary.json 里记下"产品文件取自哪个 ref"。

## 约束自检

- 未修改 `app/`、`electron/`、`adapters/`、`experiments/`、`bench/`、`contracts/`、`package.json`（验证时临时签出的产品文件已还原）。
- 未改默认开关：关闭时走 `createWindowController`，零 timer、零新通道（e2e 关闭臂覆盖）。
- 本轮零真实模型 POST：companion 用例只连本地 `tests/support/fake-model-service.mjs`，并断言 POST 数 = 0。
