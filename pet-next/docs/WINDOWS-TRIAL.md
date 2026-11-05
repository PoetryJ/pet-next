# Windows 试用上手（一页）

pet-next 桌宠试用：Windows 10/11 + Node 22.12+ + pnpm 10.33.4（`corepack enable` 后由仓库 `packageManager` 字段锁定）。

本包是**源码试用包**：需要自行安装依赖与构建，不是免安装成品。上手分两步——首次准备（一次），之后双击 `启动.cmd` 即用。

## 1. 首次准备（一次）

解压 zip 后在包目录（例如 `cd C:\trial\pet-next`）执行：

```powershell
corepack enable                # 让 pnpm 用仓库锁定的 10.33.4
pnpm install --frozen-lockfile
pnpm build                     # 产出 dist/；双击入口与命令入口都要求它存在
```

> 首次构建约需几分钟（含 Electron 下载）。若 Electron 下载慢，设镜像：
> `$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"`。

## 2. 双击入口（推荐）

解压根目录双击 `启动.cmd`（内部即 `node scripts\launch-trial.mjs`，不设置任何环境变量、不改 PATH）。

- 该文件以纯 ASCII + CRLF 保存（注释与提示为英文），Windows 默认代码页（GBK/437）下可直接解析，
  不执行 `chcp`；修复前的中文注释会被 cmd 当成命令执行并落进 `cd_fail`，退出码退回 1。
- 退出码原样透传：`node scripts\launch-trial.mjs` 返回 7 时窗口显示 7 并以 7 退出；0 则窗口自然关闭。

具体步骤：

- 首次启动（无 `~/.pet-next/qwen-remote.json`）出现启动向导：填服务器/SSH 连接配置 →
  测试连接（只 `GET /v1/models`，不推理、零 POST）→ 选预览选项 → 启动桌宠。
- 配置保存在 `~/.pet-next/qwen-remote.json`（字段模板见 `config/chat-remote.example.json`），
  再次启动自动回填。
- 预检失败给可读提示并退出：缺 Node 22.12+（不会自动下载）、缺 `dist/electron/main.js`
  （提示先 `pnpm install && pnpm build`）。
- 直接关窗即干净退出（正常退出码 0，无残留进程）；异常退出码显示在窗口里。

## 3. 命令入口（保留）

```powershell
pnpm chat:trial --context=on   # 连续对话：记住本窗口内最近 4 个完整轮次
pnpm chat:trial                # 单轮（缺省 --context=off，与既有行为一致）
pnpm start                     # 不走向导，直接构建并启动桌宠
```

双击入口走完向导后，主程序按所选体验启动：standard = 会话内只读当前屏（LLM 不可读）；
companion = 屏幕摘要按轮次阅后即焚，同会话内 LLM 可用（完整版预览）。PET 帧率与
全局气泡见下文「窗口内操作」。

## 4. 连续模式与窗口内操作

`--context=on` 的语义：**本窗口进程内的最近 4 个完整轮次**（user→assistant 各算一步），
关窗即清零，任何场景不落盘。

- `Esc`：隐藏/退出桌宠窗口
- `Ctrl+B`：开关全局气泡（断网时静默降级）
- `Ctrl+L`：窗口置顶开关（标准窗口粒度）
- `Ctrl+R`：手动重连当前流式推理

## 5. 会话边界（不会跨窗口/重启携带）

| 场景 | 进程 | 内容可见性 |
| --- | --- | --- |
| 关窗后重开（同会话） | 新窗口进程 | 历史内容全丢，只保留 launcher 保存的连接配置 |
| 退出登录 | 单进程 | 进程内存清零 |
| 重启电脑 | 全部 | 全部内存清零 |

## 6. 常见误区

| 误区 | 实际行为 |
| --- | --- |
| 双击 `启动.cmd` 就能跑 | 源码试用包需先完成第 1 节的 `pnpm install && pnpm build`；入口不代替构建 |
| 用 `npx pnpm` / 全局 pnpm 9 | 锁定 `pnpm@10.33.4`：`corepack enable` 后自动对齐 |
| 向导的「测试连接」会发推理请求 | 只 `GET /v1/models` 验证链路，零 POST；全向导零推理 |
| 把增量 bundle 直接 `git clone` 当完整源码 | 增量 bundle 只含增量提交，需目标已有基线；干净机器用源码 zip 或完整 bundle（见 `docs/M3-6-D-REPORT.md`） |

## 7. 退出与进程清理

- 双击入口/桌宠窗口：直接关窗即干净退出（退出码 0）；`启动.cmd` 窗口在异常码时会
  `pause` 显示码值再关。
- CLI 入口：终端窗口关闭或 Ctrl+C 结束；子进程随父进程回收。
- 残留排查：`tasklist | findstr -i electron`；有残留先等 5 秒（流收尾），再
  `taskkill /IM electron.exe /F`。
