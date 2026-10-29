# 并行开工

契约 PR 的分支是 `cursor/m1-m2-contracts-2555`，基线是 `cursor/pet-next-m1-8714`（`e1c099359fa7d55ee3d90785ac8affc712d0692b`）。不要把这些 PR 开到 `main`。`pet-next` 还不在 `main` 上。

各 agent 使用自己环境要求的分支后缀。建议前缀：

| Agent | 建议前缀 | 从哪分出 | PR 目标 |
| --- | --- | --- | --- |
| A | `cursor/pet-next-a-process` | `cursor/m1-m2-contracts-2555` | 该分支，合并进 `cursor/pet-next-m1-8714` 之后改为后者 |
| B | `cursor/pet-next-b-pointer` | 同上 | 同上 |
| C | `cursor/pet-next-c-assets` | 同上 | 同上 |
| D | `cursor/pet-next-d-arbiter` | 同上 | 同上 |
| E | `cursor/pet-next-e-state-machine` | D 的实现分支 | D 的分支 |
| F | `cursor/pet-next-f-arbiter-check` | E 的实现分支 | E 的分支 |

文件边界见 [ownership.md](ownership.md)。

## 现在可以同时做

A、B、C、D 分四个 PR，同时开工。

- A 做 `tests/runner` 和现有 Electron 实测的清理，补四个进程用例和 Windows 脚本。
- B 先做 `adapters/pointer` 的测量和 `toDip` 单元测试。`createProcessTracker` 可用之后再提交 `tests/pointer.e2e.test.ts`。若要改页面坐标或主进程的 `scaleFactor`，等 A 的 e2e 清理合并后再 rebase。
- C 做 `assets-pipeline`，不改三份成品素材。
- D 按已冻结的协议实现 fixtures、baseline 和 runner。发现例子与规则冲突时，给集成提契约修改，不直接改 `contracts/`。

这四条之间没有写同一批文件的必要。B 的 Electron 用例依赖 A 的工厂，适配器单元测试不依赖。

## E 和 F

D 的 `pnpm experiment:arbiter` 已经能让基线对上 `NORMATIVE_EXAMPLES`，并写出持续负载日志之后，E 再开工。E 只替换 `createStateMachine`。

E 的工厂跑通、且与基线在规范性例子和持续负载上一致之后，F 再开工。F 增加 held-out 序列、指标核对和演示。

## 合并顺序

1. 本契约 PR 进入 `cursor/pet-next-m1-8714`。
2. A、C、D，以及 B 的适配器 PR，可以按审查顺序分别合并。它们不改同一文件。
3. B 若使用接线例外，排在 A 的 e2e 清理之后。
4. E 排在 D 之后。F 排在 E 之后。
5. 集成在需要时单独提交装配接线、依赖和文档。agent 的 PR 描述里留下补丁请求即可。

产品 PR 与实验 PR 不合在一起。实验退出码 2 只属于尚未替换的占位，不作为产品失败。
