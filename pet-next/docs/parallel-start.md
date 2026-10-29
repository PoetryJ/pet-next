# 并行开工

本轮 starting_ref 是 `cursor/pet-next-integrate-preview-22e6`。从这条分支的尖端切出。不要从 `main` 切，也不要从 `cursor/pet-next-m1-8714` 切：后者是集成 PR 的目标，不含本轮冻结。不要把 PR 开到 `main`。

各环境在前缀后加上自己要求的后缀。建议前缀：

| 谁 | 建议前缀 | 从哪分出 | PR 目标 |
| --- | --- | --- | --- |
| A 素材 | `cursor/pet-next-a-assets` | `cursor/pet-next-integrate-preview-22e6` | 该集成分支 |
| B 双槽 | `cursor/pet-next-b-two-slot` | 同上 | 同上 |
| C 行为 | `cursor/pet-next-c-behavior` | 同上 | 同上 |
| D 对照 | `cursor/pet-next-d-bench` | 同上。对照 B 的三种模式时再 rebase 到 B 的尖端 | 同上；测 B 时以 B 的分支为基线 |
| E 契约测试 | `cursor/pet-next-e-contracts` | 同上 | 同上 |
| F 平台 | `cursor/pet-next-f-platform` | 同上 | 同上 |

文件边界见 [ownership.md](ownership.md)。验收命令见 [acceptance.md](acceptance.md)。

## 现在可以同时做

A、B、C、E、F 可以同时开工。D 的样本要等 B 的三种模式都能被同一份素材跑起来；在那之前 D 只准备记录格式，不宣布收益。

- A 找 reaction 的原始 alpha 源。找不到就用现有透明待机做位移或缩放候选，并在 `limitation` 里写明这不是修复原视频。交浅色、深色、棋盘底对照、源和输出哈希、生成命令。
- B 在 `adapters/media/two-slot/` 实现双槽：旧槽显示，新槽准备，核对 generation 和槽身份，切换，暂停旧槽。保留单槽内核。
- C 在 `core/behavior/` 写注入时钟和随机数的提议器与产品调度。拖动优先，最新点击覆盖旧点击，自动动作只在空闲时开始。
- E 按冻结契约写 `tests/contracts/`，不复制实现内部。既有产品测试和 `experiments/` 下的测试都算验收。
- F 覆盖点击、拖动、透明背景、退出和进程清理。没有 Windows 执行器就交一键脚本并记 `not-run`。

预览开关默认关闭。工作分支不要改默认值。
