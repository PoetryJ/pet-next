# 文件归属

本文件固定 Agent A–F 和集成负责人的可改路径。路径相对 `pet-next/`，除非写明是仓库根。公共形状以 [`contracts/`](../contracts/) 为准，规则见 [product-contract.md](product-contract.md) 和 [arbiter-protocol.md](arbiter-protocol.md)，完成标准见 [acceptance.md](acceptance.md)。

一个人只改自己的目录。需要动集成独占文件时，在 PR 描述里写出补丁请求，由集成合入。

## 集成独占

这些路径只由集成修改：

- `package.json`、`pnpm-lock.yaml`
- `tsconfig.json`、`tsconfig.preload.json`、`eslint.config.js`、`.gitignore`
- `README.md`、`docs/**`、`contracts/**`
- `app/**`、`electron/**`、`core/**`、`adapters/media/**`
- `scripts/start.mjs`、`scripts/copy-static.mjs`
- `tests/boundaries.test.ts`
- 成品素材 `assets/idle.webm`、`assets/reaction.webm`、`assets/placeholder.png`
- 仓库根的 `.github/workflows/hevc-alpha.yml`、`.github/workflows/release-app.yml`、根 `README.md`

`tests/boundaries.test.ts` 看守成品素材哈希、默认启动仍使用 `screenX`、实验命令不进入 `start` / `verify`、以及现有 Electron 实测里的精确位移断言。

`pnpm test` 已经用目录 glob 接住新测试，后续不必为了登记测试文件来改 `package.json`：

| glob | 会跑到 |
| --- | --- |
| `core/*/*.test.ts` | 现有 core 测试 |
| `adapters/*/*.test.ts` | 媒体、窗口，以及以后的 `adapters/pointer/*.test.ts` |
| `app/*.test.ts` | 装配单元测试 |
| `tests/boundaries.test.ts` | 边界与本轮契约锁 |
| `tests/*/*.test.ts` | `tests/runner/`、`tests/platform/`、`tests/assets/` 下的测试 |
| `tests/*.e2e.test.ts` | 现有 Electron 实测，以及以后的 `tests/pointer.e2e.test.ts` |

`experiments/**` 和 `assets-pipeline/**` 不在 `pnpm test` 里。实验走独立命令。

下面各目录里的占位在本 PR 合并后归该目录的 owner。集成只在协议要改时再动 `contracts/` 和 `docs/`。

## Agent A：测试进程与 CI

可改：

- `tests/runner/**`
- `tests/platform/**`
- `tests/electron.e2e.test.ts`
- `scripts/verify-windows.ps1`
- 新增仓库根 `.github/workflows/pet-next.yml`

`tests/electron.e2e.test.ts` 里现有的 `beforeDrag.x + 40`、`beforeDrag.y + 16`、`(beforeDrag?.x ?? 0) + 24`、`(beforeDrag?.y ?? 0) + 10` 保持原样。`--force-device-scale-factor=1` 保留为缩放对照的启动方式。清理逻辑可以换掉，位移断言的文字留在这个文件里。

禁止：集成独占路径，以及 B/C/D/E/F 的目录。不要改 `tests/pointer.e2e.test.ts`、`adapters/window/**`、`adapters/pointer/**`。不要改根上已有的 `hevc-alpha.yml` 和 `release-app.yml`。

`tests/runner/` 下要留至少一个 `*.test.ts`，否则 `tests/*/*.test.ts` 匹配不到文件，`pnpm test` 会失败。

## Agent B：窗口与指针

可改：

- `adapters/pointer/**`
- `adapters/window/**`，含现有 `window.test.ts`
- `tests/pointer.e2e.test.ts`（新建）

`createProcessTracker` 落地之前，先写注入 `PointerObservation` 的单元测试。真实输入的 Electron 用例等这个工厂可用后再提交，清理调用 A 的 runner，不另写一套 `ps` 扫描。

接线例外：B 可以改 `app/page.ts` 的指针坐标，以及 `electron/main.ts`、`electron/preload.ts` 里传递 `scaleFactor` 和单位所需要的最小部分。播放、退出、透明窗口和 IPC 频道名不动。这个 PR 与 A 的清理 PR 分开。A 先合并 `tests/electron.e2e.test.ts`，B 再 rebase。B 不改该文件里的四条位移断言；新缩放断言写在 `tests/pointer.e2e.test.ts`。

禁止：其余集成独占路径，A 的 runner / platform / Windows 脚本，C/D/E/F 的目录。

## Agent C：素材流水线

可改：

- `assets-pipeline/**`
- `tests/assets/**`（新建；会被 `tests/*/*.test.ts` 接住）

禁止：改写三份成品素材。哈希锁在 `tests/boundaries.test.ts`。也禁止改 `adapters/media/**`、实验目录和装配入口。替换成品素材要等质量报告经过集成接受后，由集成单独提交。

## Agent D：实验协议的实现侧

协议正文已经在 `contracts/` 和 [arbiter-protocol.md](arbiter-protocol.md)。D 实现夹具、基线和 runner，不再改协议文本。

可改：

- `experiments/arbiter/fixtures/**`
- `experiments/arbiter/baseline/**`
- `experiments/arbiter/runner/**`

禁止：`contracts/**`、`experiments/arbiter/state-machine/**`、`check/**`、`demo/**`、`heldout/**`、`experiments/arbiter/tests/**`，以及全部产品路径。基线不能 import 状态机。

## Agent E：状态机

可改：

- `experiments/arbiter/state-machine/**`

禁止：baseline、runner、fixtures、check、demo、heldout、契约和产品路径。状态机不能 import 基线或 runner。两边共用的数据只放在 `contracts/`。

## Agent F：核对与演示

可改：

- `experiments/arbiter/check/**`
- `experiments/arbiter/demo/**`
- `experiments/arbiter/tests/**`
- `experiments/arbiter/heldout/**`

禁止：baseline、state-machine、runner、fixtures、契约和产品路径。核对读取 runner 写出的日志和两个工厂。演示不打开桌宠主进程。

D 和 E 不往 `heldout/` 加序列。

## 占位出口

| 出口 | 以后由谁替换 |
| --- | --- |
| `tests/runner/index.ts` 的 `createProcessTracker` | A |
| `adapters/pointer/index.ts` 的 `createPointerAdapter` | B |
| `assets-pipeline/cli.ts` | C |
| `experiments/arbiter/baseline/index.ts` 的 `createBaseline` | D |
| `experiments/arbiter/runner/main.ts` | D |
| `experiments/arbiter/state-machine/index.ts` 的 `createStateMachine` | E |
| `experiments/arbiter/check/main.ts`、`demo/main.ts` | F |
| `scripts/verify-windows.ps1` | A |

这些函数被 import 时不会启动进程。直接执行对应命令时，占位以退出码 2 结束。
