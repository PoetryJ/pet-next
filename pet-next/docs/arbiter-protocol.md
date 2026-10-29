# 仲裁实验协议

实验回答的是：同一套规则下，最小优先级基线和手写状态机是否一致，以及等待、饥饿和耗时各是多少。数字是实验记录，不是桌宠的线上收益。是否进入产品由项目负责人看完数据再决定。

默认启动不加载 `experiments/`。命令：

| 命令 | 入口 | 谁实现 |
| --- | --- | --- |
| `pnpm experiment:arbiter` | `experiments/arbiter/runner/main.ts` | D |
| `pnpm experiment:arbiter:check` | `experiments/arbiter/check/main.ts` | F |
| `pnpm experiment:arbiter:demo` | `experiments/arbiter/demo/main.ts` | F |

占位被直接执行时退出码是 2，表示还没实现。被 import 时不得修改 `process.exitCode`，也不得启动子进程。

实现之后的退出码：

| 码 | 含义 |
| --- | --- |
| 0 | 已实现的仲裁跑完，且与规范性例子一致 |
| 1 | 跑了，但与例子不一致、中途抛错，或已实现的两边在持续负载上分叉 |
| 2 | 基线仍未实现。状态机尚未实现时，runner 可以记 `not-implemented` 并以 0 结束，只要基线本身符合例子 |

## 形状

`Arbiter` 是两边必须实现的接口。`TState` 对外不透明，日志里不比较它。可比的是每步的 `decisions` 和 `queueLength`。

事件字段：`id`、`source`、`seq`、`timeMs`、`expiresAtMs`。来源只有 `drag`、`click`、`auto`。优先级是 `ARBITER_RANK`：drag 3，click 2，auto 1。

输入要么是 `deliver`，要么是 `complete`。完成回调的 `actionId` 等于当时 `started` 的事件 `id`。时间只来自输入的 `nowMs`。

决策的 `actionId`：已经开始的动作等于事件 id；尚未开始的等待、过期、重复为 null；对不上的完成回调填写入参里的 `actionId`，`eventId` 为 null。

返回的状态不与入参共享可变引用。

## 每一步

活动中的动作不过期。过期只作用于还没 `started` 的事件。活动动作只由匹配的 `complete` 或更高优先级的抢占结束。被抢占的动作不回到队列。

字符串比较用 JavaScript 的 `<`。队列挑选和过期输出的次序都是：`seq` 升序，然后 `timeMs` 升序，然后 `id` 升序。挑选下一个要开始的动作时，先按优先级从高到低，再按这个次序。

每步开始时令 `now` 为输入的 `nowMs`：

1. 把等待队列里 `now >= expiresAtMs` 的事件按上面的次序逐条做成 `discard` / `expired`，并从队列移除。`actionId` 为 null。
2. 若输入是 `complete`：
   - `actionId` 不是当前动作：一条 `discard` / `stale-completion`。当前动作保持。本步到此结束。
   - `actionId` 匹配：一条 `execute` / `completed`，当前动作清空，然后做第 4 步。
3. 若输入是 `deliver`，按下面的次序只走一条：
   1. `id` 已经见过：`discard` / `duplicate`，状态不变。
   2. 否则记下这个 `id`。若 `now >= expiresAtMs` 或 `timeMs >= expiresAtMs`：`discard` / `expired`。
   3. 没有当前动作：`execute` / `started`，它成为当前动作。
   4. 新事件优先级高于当前动作：先对旧动作给出 `discard` / `preempted`，再 `execute` / `started`。旧动作不入队。
   5. 新事件是 `auto` 且当前动作是 `drag`：`wait` / `drag-blocks-auto`，入队。
   6. 优先级相同：`wait` / `queued-same-rank`，入队。较小的 `seq` 也不抢占已经开始的动作。
   7. 其余更低优先级：`wait` / `queued-lower-rank`，入队。拖动期间的点击走这一条，不使用 `drag-blocks-auto`。
4. 只有当前动作为空时，从等待队列挑一个开始，给出 `execute` / `started`。一步最多开始一个。过期清理已经在第 1 步做完。

`queueLength` 是本步结束后的等待数，不含当前动作。

规范性例子在 `NORMATIVE_EXAMPLES`。名字覆盖 `REQUIRED_FIXTURE_NAMES` 里除 `sustained-high-priority` 以外的六项。runner 从 `initialState()` 开始按 `inputs` 顺序调用 `step`，每步的 `decisions` 和 `queueLength` 都要与 `expected` 相同。

这些例子锁住的行为包括：点击抢占自动动作，拖动再抢占点击；拖动期间自动动作等待且理由是 `drag-blocks-auto`；`nowMs === expiresAtMs` 视为过期；旧的 `complete` 不结束新动作；同一 `id` 的第二次投递是重复；先到的较大 `seq` 不被后到的较小 `seq` 抢占，结束后再按 `seq` 开始等待者。

## 持续负载

`SUSTAINED_LOAD` 是唯一的随机场景。随机函数是 `contracts/mulberry32.ts` 的 `mulberry32`。对种子 `20261029`，第一次返回值是 `0.850172859383747`。

第 `i` 个事件（`i` 从 0 到 `count - 1`）：

- 取下一个随机数 `r`
- `r < dragBelow` 为 `drag`，否则 `r < clickBelow` 为 `click`，否则为 `auto`
- `id` 为 `sustained-${i}`，`seq` 为 `i`
- `timeMs` 为 `i * timeStepMs`，`expiresAtMs` 为 `timeMs + ttlMs`
- 以 `nowMs = timeMs` 投递
- 本场景不插入 `complete`

第一条一旦开始，就会一直占着，直到更高优先级抢占它。同级和更低优先级在队列里等到过期。这是用来观察饥饿的负载，不是把基线故意做弱。两边实现都要跑同一串输入。

## 日志和指标

runner 把原始日志写到 `experiments/arbiter/out/<implementation>/<fixture>.json`，类型是 `ArbiterRunLog`。`machineElapsedMs` 只包住 `step` 调用。状态机工厂抛错且尚未实现时，写 `experiments/arbiter/out/state-machine/status.json`，内容为 `{ "status": "not-implemented" }`。这时 runner 仍以基线结果决定退出码。

核对器写出 `experiments/arbiter/out/check.json`，元素类型是 `ArbiterComparison`。指标定义：

- `ruleViolations`：一步的 `decisions` 或 `queueLength` 与规范性例子，或与 F 的独立规则核对不一致，这一步计 1。
- `expiredExecutions`：`reason` 为 `started`，且该事件 `expiresAtMs <=` 本步 `nowMs`，或 `timeMs >= expiresAtMs`。通过时为 0。
- `simulatedWaitMs`：每个事件从 `timeMs` 到它第一次出现在 `started`、`expired` 或 `duplicate` 里的那一步 `nowMs`，取不小于 0 的差，再求和。等待中的事件用最后一步的 `nowMs`。这里不加墙钟时间。
- `machineElapsedMs`：抄运行日志，单独成列。
- `starvationCount`：先有过 `wait`、最终 `expired`，并且在等待期间有严格更高优先级的事件 `started` 的事件个数。饥饿被记录，不单独作为失败。
- `queuePeak`：各步 `queueLength` 的最大值。
- `firstFailureIndex`：第一条不一致的输入下标，没有则为 null。
- `firstDivergenceIndex`：基线和状态机第一次分叉的下标。两边相同并不代替规则核对。

F 另备 `heldout/` 里的序列，这些序列不参与 D/E 的调试。报告写出第一条失败的位置。

实现复杂度用目录行数，不含测试文件：

```bash
find experiments/arbiter/baseline -name '*.ts' ! -name '*.test.ts' | xargs wc -l
find experiments/arbiter/state-machine -name '*.ts' ! -name '*.test.ts' | xargs wc -l
```

两边都满足规范性例子、持续负载和 held-out，且 `ruleViolations` 与 `expiredExecutions` 都是 0 时，集成推荐行数更少、且没有新依赖的那一个。推荐不是产品合并。

## 基线与状态机

基线实现上面的全部分支，包含点击高于自动动作、拖动高于点击、过期丢弃、重复丢弃、旧完成回调无效。不把某一级故意做丢，也不加入老化或随机。

状态机使用同一个 `Arbiter` 和同一套分支。它是纯函数：时间来自输入，不引用 Electron、DOM、`Date.now`、`performance.now`、`Math.random`。不引入状态机框架，不扩展聊天、记忆或规划。只处理本协议的场景。

## 演示

`pnpm experiment:arbiter:demo` 在基线和状态机之间切换，展示每条决策是执行、等待还是丢弃，并展示 `reason`。可以用现有 webm 作画面。演示不调用 `scripts/start.mjs`，不加载 `dist/electron/main.js`，不改默认桌宠。
