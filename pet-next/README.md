# pet-next

单宠物、单屏的透明置顶桌宠。待机循环，点击播一次回应后回到待机；拖动时不误触点击，窗口留在当前工作区。素材失败时显示静态占位，仍可拖动和退出。

## 启动

需要 Node `>=22.12.0` 和 pnpm。Windows 与 Linux 都是：

```bash
cd pet-next
pnpm install
pnpm start
```

`pnpm start` 会先构建再打开窗口。按 Esc 或调用预加载桥的 `quit()` 退出。

`pnpm verify` 依次做类型检查、lint、单元测试、构建和 Electron 实测，任一步失败都会返回非零。

分工、验收和实验协议在 [`docs/ownership.md`](docs/ownership.md)。公共形状在 [`contracts/`](contracts/)。`pnpm experiment:arbiter`、`pnpm experiment:arbiter:check`、`pnpm experiment:arbiter:demo` 和 `pnpm assets:check` 不进入 `pnpm start`，也不进入 `pnpm verify`。

本轮实测平台是 **Linux**（`DISPLAY` 上的 Electron 43.3.0）。没有在 Windows 上跑过同一套 Electron 测试，也没有在 Windows 上跑过清理测试；不能把未跑写成通过。Windows 启动命令仍是 `pnpm start`。清理测试的一键记录命令在 Windows 和 Linux 上相同，见下文。

## 模块

```
core/playback       迁入的 reducePlayback。只吃事件，不碰 DOM / Electron / 文件 / 网络
core/interaction    点击与拖动判定、回应结束或失败后回待机
adapters/media      唯一的加载、播放、取消和回调
adapters/window     窗口平移、工作区夹紧、退出
app                 把上面几块接到页面事件
electron            主进程和 preload。preload 只暴露 moveBy 与 quit
tests/support       测试进程树、运行记录和一键脚本。只清理本次启动的进程树
tests/cleanup.test.ts  启动失败、超时、正常退出的清理
```

## 测试进程清理

测试运行器记下自己 `spawn` 的根 PID，再沿父子关系收集后代。结束时只信号这些正 PID。Linux 读 `/proc/<pid>/task/<tid>/children`，发信号前核对 `/proc/<pid>/stat` 的 starttime，避免 PID 复用后误伤。Windows 用 `Win32_Process` 的 `ParentProcessId` 认孩子，再用 `taskkill /PID <pid> /F`（根进程加 `/T`）结束。darwin 才用 `ps` 取 pid 和 ppid。不调用 `ps` 扫描 Electron，也不使用负 PID（那会打到整个进程组）。

每次运行把下面几份分开写到 `logs/platform-runs/<platform>/<时间>-<标签>-<pid>/`：

| 文件 | 内容 |
| --- | --- |
| `environment.json` | 传给子进程的环境。凭据键的值是 `[redacted]` |
| `command.json` | 可执行文件、参数数组、工作目录、平台 |
| `exit-code.txt` | 退出码；被信号结束、没有退出码时是 `null` |
| `stdout.log` / `stderr.log` | 原始输出，不混在一起 |

在 `pet-next` 目录下，Windows 和 Linux 用同一条命令。它会把上述记录写到 `logs/platform-runs/<当前平台>/`：

```bash
node scripts/record-platform-run.mjs -- node --experimental-strip-types --test --test-reporter spec tests/cleanup.test.ts tests/support/process-tree.test.ts tests/support/process-table.test.ts tests/support/run-record.test.ts tests/support/record-cli.test.ts
```

`pnpm test:cleanup` 和 `pnpm record:platform -- node ...` 是同一套测试的入口。一键脚本还会把本次每个清理场景的记录放在同一次的 `*-cases/` 目录里。当前环境只跑了 Linux。Windows 没有执行器，所以没有 Windows 日志，也不能记成通过。

### 给集成负责人

`package.json` 里本目录动过的脚本：

| 脚本 | 变化 |
| --- | --- |
| `test` | 契约目录 glob 保留，并显式加上 `tests/cleanup.test.ts`。`tests/support/*.test.ts` 由 `tests/*/*.test.ts` 接住 |
| `test:cleanup` | 新增。只跑进程树、运行记录和清理用例 |
| `record:platform` | 新增。转到 `scripts/record-platform-run.mjs` |

`test:e2e`、`build`、`start`、`typecheck`、`lint`、`verify` 的语义没改。`verify` 会因为 `test` 的追加而跑到清理用例。

`core` 不引用适配器。`pet-next` 不引用 `dsh-pet`。

## 素材

| 文件 | 来源 | 限制 |
| --- | --- | --- |
| `assets/idle.webm` | 从本仓库 `dsh-pet/assets/webm/待机呼吸休闲.webm` 裁约 2 秒，VP9 | 形象是社区二创「大肥鱼」，[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)，禁止商用。公开衍生须署名 <https://github.com/PC2005-cloud/dsh-pet> |
| `assets/reaction.webm` | 从 `dsh-pet/assets/webm/点击回应-元气挥手.webm` 约 2.6 秒起裁 2 秒，纯黑底抠成透明后重编码为 VP9 | 同上 |
| `assets/placeholder.png` | 本目录生成的静态图 | 无外部授权 |

启动只读这些本地文件，不依赖原仓库路径、DSH、API Key 或远程下载。待机片段是流复制，保留源文件的 `ALPHA_MODE`。回应片段落在两个关键帧之间，所以重新编码，并把纯黑底抠成透明；抠像可能吃掉少量深色边缘。窗口按透明置顶创建；素材失败时显示占位图。
