# R4 持续跟进桌宠（离线原型）

本目录是 R4 12 小时任务包的隔离实验：验证桌宠能否把记忆用于**真实任务状态变化**——持续跟进一件事、重启后继续、在该让用户选择时提出问题，并在拿到可核验产物后才算完成。

它不是纯记忆测试，也不是完整 DeepSeek Harness 移植。

## 边界（本目录内不变）

- 不调用模型、不探测模型端点、不使用 GPU、不发真实通知。
- 不修改产品默认、`main`、R3.1 实验目录；只改本目录。
- 本地面板只绑定 `127.0.0.1` 动态端口。
- 决策实现标注 `scripted-rule`，不声称“模型学会何时打扰”。
- 工具只有 `inspect_artifact` / `compare_metrics` / `write_analysis`，没有任意 shell。

## 目录

```
contracts.ts              冻结接口（事件、证据、提案、端口、任务状态）
runtime/                  SQLite 权威存储、上游 Engine 适配、effect 派发、恢复
memory-bridge/            R3.1 纯模块（reduce/applyPatch）投影与证据校验
decision/                 P0–P3 四种 scripted 策略
attention/                问题合并、回答版本、静默/额度/最小间隔
tools/                    受控工作区、文件工具、inbox watch、seed
upstream/                 上游 8c32a9d 的 15 个 src/core 文件 + 原 tests（字节不改）
fixtures/trajectories/    16 条冻结轨迹（8 dev + 8 heldout）
gold/                     独立期望，只被评分器读取
eval/                     运行器、评分、独立重评、H1 消融、5 个负控
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
node run.mjs status --ticket <ticketId>
node run.mjs answer --ticket <ticketId> --option analyze_failing

# 面板（127.0.0.1 动态端口）
node run.mjs serve --port 0

# 重启恢复 / 记忆修复
node run.mjs recover
node run.mjs repair-memory
```

默认工作区 `out/workspace`；可用 `--workspace <dir>` 隔离。

崩溃注入（真实进程退出 42，重启后恢复）：

```bash
PET_FOLLOWUP_CRASH_AT=ingest_persisted node run.mjs delegate --title x --goal y
PET_FOLLOWUP_CRASH_AT=pre_dispatch node run.mjs observe --ticket <id>
PET_FOLLOWUP_CRASH_AT=effect_running node run.mjs answer --ticket <id> --option analyze_failing
PET_FOLLOWUP_CRASH_AT=receipt_persisted node run.mjs answer --ticket <id> --option analyze_failing
```

## 评估

```bash
node run.mjs eval          # 4 策略 × 18 个机会，写 out/eval/raw 与 scores
node run.mjs verify-eval   # 独立重评 72 份 raw，逐项比对
node run.mjs negative      # 5 个负控，每个独立子进程；detected → exit 1
node run.mjs test          # 31 个单测
node run.mjs typecheck     # 需要 tooling/node_modules（见下）
```

工具链安装（只装开发依赖，不装 DSH）：

```bash
cd tooling && npm install
cd upstream && npm install   # vitest 4.1.8，隔离目录
cd upstream && node node_modules/vitest/vitest.mjs run   # 原 144 项
```

## 结果快照

见 `out/eval/scores/summary.json` 与交付目录的 `scores/`、`raw/`、`failures/`。要点：

- P3：14/14 必完成机会完成，17 次主动提醒，必要决策漏报 0，1 条超预算轨迹。
- P2：9/14 完成，15 次提醒，漏报 3（阈值以下的必要决策）。
- P1：14/14 完成，24 次提醒，17 次未被回答的提醒。
- P0：0/14，仅记录。
- H1 离线消融：proposal-only 泄漏 2（1 问题 + 1 通知），执行/通知前重验泄漏 0。
- H2：P3 **没有**比 P2 少打扰（+2 次），但完成 +5、必要决策漏报 −3。按任务包口径，H2“少打扰”不成立，只支持“更重要的事没漏”。

## 仍未证明

见 `LIMITS.md`。一句话：没有模型参与，没有真实远程任务，没有多用户/跨机恢复，16 条轨迹是机制测试而非泛化证据。
