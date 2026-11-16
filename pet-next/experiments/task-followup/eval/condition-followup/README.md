# R6-D 条件跟进五臂对照

研究问题：把“何时需要我选择”的承诺编译成可执行条件，是否减少漏办 / 无用打扰 / 重复推理。
五臂定义与阈值见任务包 `EVAL.txt`；本目录只负责跑、记账与逐 run 原始记录。

## 离线重放（本轮实际执行）

```bash
cd pet-next/experiments/task-followup
node eval/condition-followup/run.mjs --out out/condition-followup --regenerate
```

- 12 条受控多会话长历史（6 类 × 开发/验证各 1）：8 会话 × 12 轮 = 96 个有内容 turn、3 个任务；
  关键承诺在第 1 会话、改口在第 5 会话（都在短期窗口外）。
- **明确标注**：`mode=offline-replay`、`capabilityResult=false`。LLM 臂用与强规则同构的确定性 stub，
  IR 臂用手写编译 fixture，记忆读取差异用确定性检索模拟。**不能当作 H2 证据**。
- 判据在 `story.expectation`（evaluator-only），运行时不读；判据不调用编译器来自证。

本轮离线数字（12 故事/臂）：

| 臂 | 漏办 | 可避免打扰 | 达标故事 | 模拟模型调用 | 物理POST |
| --- | --- | --- | --- | --- | --- |
| V-R 版本记忆+强规则 | 2 | 2 | 10 | 0 | 0 |
| V-L 版本记忆+逐事件LLM | 0 | 0 | 12 | 108 | 0 |
| V-C 版本记忆+条件IR | 0 | 0 | 12 | 0 | 0 |
| T-L 强文本记忆+逐事件LLM | 0 | 0 | 12 | 108 | 0 |
| T-C 强文本记忆+条件IR | 0 | 0 | 12 | 0 | 0 |

唯一差异来自两条“改口收窄为一份报告”的故事：静态声明的强规则仍等两份 → 漏办；
条件 IR 按改口后的条件求值 → 及时介入。这条只能说明**机制能表达改口**，不能说明模型能力或统计优势。

## 真实五臂（未运行）

见 `REAL-RUN.md`：72 跑矩阵、逐 run 必留原始文件与成本台账字段。本机无 `PET_MODEL_BASE_URL`，
按 START 记为 `not_run`，不写任何真实模型数字。

## 目录

- `gen-stories.mjs`：12 条故事生成器（确定性，输出 `out/condition-followup/stories/`）
- `harness.mjs`：五臂决策、事件重放、evaluator-only 打分、summary
- `run.mjs`：CLI 入口
- `REAL-RUN.md`：真实运行清单
