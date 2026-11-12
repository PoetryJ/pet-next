# R4.1 持续跟进桌宠（离线原型，有限返工）

本目录验证桌宠能否把记忆用于**真实任务状态变化**：持续跟进一件事、重启后继续、
在该让用户选择时提出问题，并在拿到可核验产物后才算完成。

R4.1 只关闭 REVIEW 的三个阻断：旧来源冒充新完成、重复恢复绕过阻断、评估用户回答
自己看不到的问题。不改产品默认、不调阈值、不换 gold、不调用模型。

## 边界（本目录内不变）

- 不调用模型、不探测模型端点、不使用 GPU、不发真实通知。
- 不修改产品默认、`main`、R3.1 实验目录；只改本目录。
- 本地面板只绑定 `127.0.0.1` 动态端口。
- 决策实现标注 `scripted-rule`，不声称“模型学会何时打扰”。
- 工具只有 `inspect_artifact` / `compare_metrics` / `write_analysis`，没有任意 shell。

## R4.1 的四个硬约束

1. **同一来源**：effect、回执、分析都持久化 `InputRef`（taskId/taskRevision、assignmentId、
   sourceId/sourceRevision、runId/revision、resultFileSha、artifactSha）。派发前核对
   “当前权威结果 == effect 预期 == 磁盘字节”，工具只读内容寻址快照；
   `completionCheck` 逐项比较当前输入→执行输入→回执→分析。老回执没有身份就 fail closed。
2. **未知结果持久阻断**：`running` 跨进程恢复后转 `needs_reconciliation`；`recover` 任意次数
   都不重建 assignment、不新建 attempt/receipt。只有 `reconcile` 显式处理：
   `accept_receipt`（需合法当前来源回执）或 `abandon_attempt`（放弃后必须重新授权）。
3. **可见性**：通知有 `queued → delivered → presented` 与时间。回答只认已送达/已呈现的
   问题；主“用户离开电脑”模式靠送达，模拟用户主动看面板必须显式 `present`/`--panel`
   并留下呈现回执。写库不等于用户看过。
4. **统一时间**：quiet 配置含显式 IANA `timezone`，计入 configSha 与每份 raw；不读宿主 TZ。
   可控时钟单调，每个评估步骤只用绝对 `at` 或相对 `minutes` 之一。

## 目录

```
contracts.ts              冻结接口（事件、证据、输入身份、提案、端口、任务状态、时区）
runtime/                  SQLite 权威存储、上游 Engine 适配、effect 派发、恢复、对账
memory-bridge/            R3.1 纯模块（reduce/applyPatch）投影与证据校验
decision/                 P0–P3 四种 scripted 策略（阈值/冷却冻结）
attention/                问题合并、回答版本、静默/额度/最小间隔、通知可见性
tools/                    受控工作区、文件工具、inbox watch、seed、R4.1 验收脚本
upstream/                 上游 8c32a9d 的 15 个 src/core 文件 + 原 tests（字节不改）
fixtures/trajectories/    16 条冻结轨迹（8 dev + 8 heldout）
gold/                     独立期望，只被评分器读取
eval/                     运行器、评分、独立重评、H1 消融、10 个负控
demo/                     面板 HTML 与 3 分钟验收脚本
cli/                      CLI 实现（run.mjs 负责重开带 TS 参数的进程）
```

## 快速开始

要求 Node >= 22.12（本机验证 22.20.0）。`run.mjs` 会自动补 `--experimental-transform-types`。

```bash
# 3 分钟验收：每一步都是独立进程，读同一个 SQLite
node run.mjs demo

# 创建委托 → 写入结果 → 扫描 → 看问题 → 回答
node run.mjs delegate --title "跟进实验 E17" --goal "结果不足时分析失败样本"
node run.mjs seed --experiment E17 --status partial --revision 1
node run.mjs observe --ticket <ticketId>
node run.mjs notifications --ticket <ticketId>     # state=delivered 才算送达
node run.mjs answer --ticket <ticketId> --option analyze_failing --panel

# 面板（127.0.0.1 动态端口）；页面渲染出开放问题时会 POST /api/present
node run.mjs serve --port 0

# 重启恢复 / 显式对账 / 记忆修复
node run.mjs recover
node run.mjs reconcile --ticket <id> --option abandon_attempt
node run.mjs repair-memory
```

默认时区 `UTC`；所有命令都可加 `--timezone Asia/Shanghai`。`tick` 必须显式 `--clock`
（真实时钟拒绝逻辑前进，exit 6）。默认工作区 `out/workspace`。

崩溃注入（真实进程退出 42，重启后恢复）：

```bash
PET_FOLLOWUP_CRASH_AT=ingest_persisted node run.mjs delegate --title x --goal y
PET_FOLLOWUP_CRASH_AT=pre_dispatch node run.mjs observe --ticket <id>
PET_FOLLOWUP_CRASH_AT=effect_running node run.mjs answer --ticket <id> --option analyze_failing --panel
PET_FOLLOWUP_CRASH_AT=receipt_persisted node run.mjs answer --ticket <id> --option analyze_failing --panel
```

## 评估与验收

```bash
node run.mjs eval            # 4 策略 × 18 个机会，写 out/eval/raw 与 scores
node run.mjs verify-eval     # 独立重评 72 份 raw，逐项比对
node run.mjs negative        # 10 个负控，每个独立子进程；detected → exit 1
node run.mjs test            # 45 个单测
node run.mjs typecheck       # 需要 tooling/node_modules（见下）
node tools/r41-acceptance.mjs . out/r41-acceptance   # 真实子进程 27 项断言
node tools/audit.mjs         # 边界静态审计 + R3.1 diff + 上游指纹
```

工具链安装（只装开发依赖，不装 DSH）：

```bash
cd tooling && npm install
cd upstream && npm install   # vitest 4.1.8，隔离目录
cd upstream && node node_modules/vitest/vitest.mjs run   # 原 144 项
```

## 结果口径（不要再引用旧数字）

完成分两列：`completions`（状态）与 `validCompletions`（输入/回执当前一致且完成检查通过）。
只有后者进入 `completionRate`。必需问题分三段：已产生、已可见、已回答；隐藏问题不算触达。
运行时硬额度与 gold 参考上限分开；未回答/被替换通知单列，“实际无用提醒”另有定义。
完整计数见 `out/eval/scores/summary.json`、`STATUS.md` 与交付目录。

## 仍未证明

见 `LIMITS.md`。一句话：没有模型参与，没有真实远程任务，没有 Windows/浏览器复验，
16 条轨迹是机制测试而非泛化证据。
