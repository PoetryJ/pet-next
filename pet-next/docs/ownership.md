# 文件归属

路径相对 `pet-next/`。本轮从集成分支 `cursor/pet-next-integrate-preview-22e6` 开工。公共形状以 [`contracts/`](../contracts/) 为准。一个人只改自己的目录。需要动集成独占文件时，在 PR 里写出补丁请求，由集成合入。

## 集成独占

- `contracts/**` 的公共形状
- `app/**` 的接线，含 `app/preview-gate.ts` 和 `app/page.ts`
- `package.json`、`pnpm-lock.yaml`，以及 `pnpm test` / `pnpm verify` 的脚本字符串
- `scripts/unit-tests.mjs`、`scripts/start.mjs`、`scripts/copy-static.mjs`
- `tests/boundaries.test.ts`
- `electron/main.ts` 里把 `PET_NEXT_PREVIEW` 放进页面查询的那一段
- `docs/**`、`README.md`

默认路径继续使用现有单槽适配器 `adapters/media/adapter.ts` 和现有会话。预览令牌打开后，`app/` 才创建双槽、行为调度或候选回应。见 [preview.md](preview.md)。

## 本轮六个工作目录

| 谁 | 可改 | 公共接口 | 禁止 |
| --- | --- | --- | --- |
| A 素材 | `assets/`、`assets-pipeline/` | `contracts/asset-candidate.ts`，已有的 `contracts/assets.ts` | 改写三份成品的字节。候选写到新路径。不删现有检查器 |
| B 播放 | `adapters/media/two-slot/` | `contracts/media-slot.ts` | 重写单槽内核。槽不超过两个。预热不发出 `playing` / `ended` |
| C 行为 | `core/behavior/` | `contracts/behavior.ts` | import `contracts/`、Electron、DOM、`Date.now`、`Math.random`。不沿用实验里的同级点击排队 |
| D 对照 | `bench/` | `contracts/bench.ts` | 改播放实现来“改善”数字。收益不超过波动时建议 `stop`。原始样本全部保留 |
| E 契约测试 | `tests/contracts/` | `contracts/coverage.ts` 的 `REQUIRED_CONTRACT_CASES` | 复制实现内部步骤。不漏产品测试和 `experiments/**` 里的测试 |
| F 平台 | `tests/platform/` | `REQUIRED_PLATFORM_FLOWS`，以及已有的进程和缩放矩阵 | 没有 Windows 执行器时写 `not-run` 和一键脚本，不把未跑记成通过。系统缩放和 Chromium 强制缩放分开记 |

`core/behavior/` 不能 import 契约目录，因为 `core` 的边界只允许相对导入。C 按 `contracts/behavior.ts` 的字段实现，E 在 `tests/contracts/` 里做结构核对。B 的目录在 `adapters/` 下，可以 import `contracts/media-slot.ts`。

占位说明：

| 路径 | 内容 |
| --- | --- |
| `adapters/media/two-slot/owner.txt` | B |
| `core/behavior/owner.txt` | C |
| `bench/owner.txt` | D |
| `tests/contracts/owner.txt` | E |
| `tests/platform/owner.txt` | F |

这些目录里的实现已经由各专项合入。契约用例接到真实双槽工厂和 `createBehaviorScheduler`。默认启动仍不创建它们。

## 已并入，不要回退

上一轮 #4–#10 已经在本分支：

| 目录 | 状态 |
| --- | --- |
| `contracts/arbiter.ts`、`coordinates.ts`、`assets.ts`、`process-tracker.ts` | 形状保持。本轮只追加新文件 |
| `tests/support/`、`tests/cleanup.test.ts` | 只清理本次启动的进程树 |
| `adapters/window/` 的 DIP 跟踪 | 默认拖动路径的一部分，不放进预览开关 |
| `assets-pipeline/` 检查器 | A 可以扩展，不能删掉 alpha 保留规则 |
| `experiments/arbiter/` | 实验链。产品行为是另一份契约 |
| `tests/runner/` | 工厂仍是占位，被调用时抛「尚未实现」。保留 `runner.test.ts`，避免测试 glob 漏目录 |

`tests/electron.e2e.test.ts` 里的四条精确位移断言保持原样。

## 验收脚本

`pnpm verify` 是统一入口。`scripts/unit-tests.mjs` 收集这些目录里的 `*.test.ts`，并跳过 `*.e2e.test.ts`：

- `core/`
- `adapters/`
- `app/`
- `tests/`
- `experiments/`
- `bench/`

`assets-pipeline/` 的纯函数测试由 `tests/assets/unit-suite.test.ts` 启动，避免和产品测试互相 import。Electron 实测留在 `pnpm test:e2e`。
