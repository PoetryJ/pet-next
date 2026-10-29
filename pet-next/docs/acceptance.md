# 验收

命令都在 `pet-next/` 下执行。Node `>=22.12.0`。

## 本轮统一入口

```bash
cd pet-next
pnpm install
pnpm verify
```

`pnpm verify` 依次做类型检查、lint、`pnpm test`、构建和串行 Electron 实测。不设置 `PET_NEXT_PREVIEW` 时，`pnpm start` 走已验收路径。开关说明见 [preview.md](preview.md)。

`pnpm test` 运行 `scripts/unit-tests.mjs`。它走进 `core/`、`adapters/`、`app/`、`tests/`、`experiments/` 和 `bench/` 的子目录，跳过 `*.e2e.test.ts`。`bench/` 还没有测试时不会把空 glob 交给运行器。`assets-pipeline/*.test.ts` 仍由 `tests/assets/unit-suite.test.ts` 以子进程执行，产品测试不直接 import 流水线。`pnpm experiment:arbiter`、`pnpm experiment:arbiter:check`、`pnpm experiment:arbiter:demo` 和 `pnpm assets:check` 不写进 `verify` 的脚本字符串。

## 上一轮（已并入 #4–#10）

下面各节是上一轮的验收记录。本轮文件归属以 [ownership.md](ownership.md) 为准。

产品路径的总闸门仍是 `pnpm verify`。`pnpm experiment:*` 这些命令本身不在闸门脚本字符串里；实验目录中的单元测试已经由上面的 glob 接住。

共同要求：

- 断言保持原样。现有 Electron 实测里的四条精确位移由 `tests/boundaries.test.ts` 看守。
- 测试保持执行。不用 `skip` 换取通过，也不把精确比较放宽成区间。
- 窗口位置若需要取整，只使用现有控制器的 `Math.round`，容差为 0。
- `not-run` 写进平台矩阵，并附上证据路径。没有日志就不要写 `passed`。
- PR 分开：A、B、C 各自一个产品 PR；D、E、F 各自一个实验 PR。一个 PR 不同时改产品目录和 `experiments/`。
- 实验报告写规则违反、过期执行、模拟等待、机器耗时、饥饿、队列峰值和复杂度。这些数不是线上收益，也不要只报测试总数。

PR 描述使用这六项：解决的问题与经典原理；选择理由；有效结果；错误根因及修正；尚未证明部分；通过、返工或停止方案的建议。

## Agent A

```bash
pnpm install
pnpm verify
```

Linux 上保存 `PlatformMatrixEntry`：环境覆盖、命令、退出码、stdout、stderr。用例覆盖 `REQUIRED_PROCESS_CASES`。`foreign-pid-survives` 证明结束信号没有打到树外进程。

Windows 有执行器时运行 `pnpm verify:windows`，并保存同一矩阵。没有执行器时，矩阵四行都是 `win32` / `not-run`，`evidencePath` 为 `scripts/verify-windows.ps1`。脚本要能在 Windows 上一条命令跑完本目录验证；占位退出码 2 只表示还没替换，不能写进 `passed`。

清理实现符合 [product-contract.md](product-contract.md)。替换 `electronPids` 和负 pid 信号之后，现有点击、拖动、缺素材和退出断言仍然通过。

## Agent B

```bash
pnpm test
pnpm test:e2e
```

单元测试覆盖 `toDip` 的注入观察，包含 `identity` 与测量后的换算。Electron 用例走真实输入路径，覆盖 `REQUIRED_SCALE_CASES` 里实际跑过的行。矩阵使用 `ScaleMatrixEntry`。`simulated-100` 对照仍在原 Electron 实测中通过。新缩放的期望位移写在 `tests/pointer.e2e.test.ts`，由测量公式得出精确值。

没跑的系统缩放记 `not-run`。本轮不验收多屏。

## Agent C

```bash
pnpm assets:check
pnpm verify
```

`assets-pipeline/out/report.json` 含源哈希、argv、输出大小、三背景对照和 `verdict`。`git diff -- assets/idle.webm assets/reaction.webm assets/placeholder.png` 为空。源没有 alpha 时结论是 `source-lacks-alpha`。`backgroundColorString` 不单独决定结论。

## Agent D

```bash
pnpm experiment:arbiter
pnpm verify
```

基线跑完 `NORMATIVE_EXAMPLES` 和 `SUSTAINED_LOAD`，日志在 `experiments/arbiter/out/baseline/`。规范性例子不一致时退出码 1。状态机工厂仍会抛错时，日志记 `not-implemented`，不因此失败。`pnpm start` 的脚本保持不变。

## Agent E

```bash
node --experimental-strip-types --test experiments/arbiter/state-machine/*.test.ts
pnpm experiment:arbiter
pnpm verify
```

状态机与基线在规范性例子和持续负载上的 `decisions`、`queueLength` 一致。目录内生产代码保持纯函数。不新增依赖，不引入状态机框架。持续负载上的分叉使 `pnpm experiment:arbiter` 退出码为 1。

## Agent F

```bash
pnpm experiment:arbiter:check
pnpm experiment:arbiter:demo
pnpm verify
```

核对覆盖规范性例子、持续负载，以及 `heldout/` 中未参与 D/E 调试的序列。每条失败写出 `firstFailureIndex` 或 `firstDivergenceIndex`。指标列分开模拟等待和机器耗时。演示能切换两种实现并标出执行、等待、丢弃的 `reason`。桌宠 `pnpm start` 的行为不变。

两边都通过时，按 [arbiter-protocol.md](arbiter-protocol.md) 的行数比较给出推荐。推荐写在 PR 里，不直接改默认桌宠。

## 平台矩阵

| 平台 | 本轮要求 |
| --- | --- |
| linux | 产品 PR 跑 `pnpm verify`。实验 PR 额外跑自己的命令。保存命令、退出码和原始日志。 |
| win32 | 跑到了就保存同样的日志。没跑就 `not-run`，并给出 `pnpm verify:windows`。 |
| darwin | 不在本轮矩阵里。 |

集成合并前看 Linux 的 `pnpm verify`。Windows 行是 `not-run` 时可以合并产品修复以外的契约 PR；声称 Windows 已通过的 PR 必须带日志。
