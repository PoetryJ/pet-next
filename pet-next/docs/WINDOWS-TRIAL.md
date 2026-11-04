# Windows 试用上手（一页）

pet-next 聊天试用：Windows 10/11 + Node 20 LTS + pnpm 9 + PowerShell。
本包是**源码试用包**（需自行安装依赖与构建），不是免安装成品。

## 1. 首次准备（一次）

```powershell
# 解压 zip 后进入目录（例如 cd C:\trial\pet-next）
corepack enable                # 或 npm i -g pnpm@9
pnpm install --frozen-lockfile
pnpm build                     # 产出 dist/（正式入口启动前必须）
```

## 2. 两条命令

```powershell
pnpm chat:trial --context=on   # 连续对话：记住本窗口内最近 4 个完整轮次
pnpm chat:trial                # 单轮（缺省 --context=off，与既有行为一致）
```

- `--context` 只接受 `on` 或 `off`；其他值会直接报用法并退出，不会误连。
- 每次启动都会打印一行 `[chat-trial] 上下文=…`；显式 `--context=off` 会清除从
  PowerShell 继承的 `PET_NEXT_CHAT_CONTEXT` 残留值（残留不会把单轮变连续）。
- 配置：`~/.pet-next/qwen-remote.json`（服务器地址与 SSH，模板见
  `config/chat-remote.example.json`；写入后 `pnpm chat:trial` 自动走 SSH 隧道到
  远端模型，与既有 chat:remote 同一条链）。

## 3. 窗口内操作

| 操作 | 方式 |
|---|---|
| 发消息 | 输入框回车 |
| 取消在途请求 | 取消按钮；再发新消息会自动清空在途并立即重发 |
| 新对话 | 新对话按钮（清空本窗口上下文；请求体回落单轮） |
| 退出 | 直接关窗（退出码与清理见下）；命令行 Ctrl+C 亦可 |

- 迟到的旧响应不会显示、不会污染后续上下文。
- 错误提示：隧道断开/模型不可用会以对话内错误消息呈现；重试即重新建链。

## 4. 会话边界（如实）

- 上下文只存在**当前窗口内存**：最多 4 个完整轮次、约 2000 个 JS 字符上界；
  重启/新对话后不保留任何历史。
- **JS 字符不是 token**：上界按 JS `.length` 计；计费 token 以服务端 `usage` 为准。

## 5. 常见误区

- “上一次设过 on，这次不带参数就是 off 了”？——不。`PET_NEXT_CHAT_CONTEXT`
  一旦在 PowerShell 会话里设置会一直存在；**不带参数=off 是缺省，但请显式
  `--context=off` 最稳**（显式 off 会强制清除继承值）。
- “chat:local 会自动连服务器”？——不会。`chat:local` 面向本机已起服务的开发
  场景（默认 `127.0.0.1:18872`，本机没有服务就连不上）。Windows 远程试用请用
  `pnpm chat:trial`（内部走 chat:remote 的 SSH 委托链）。

## 6. 退出与进程清理

- 关窗即退出；正常退出码 0。隧道子进程随入口一并清理（若强杀 PowerShell，可能在
  任务管理器看到残留 ssh.exe，手动结束即可）。
- 试用出现异常时：把 `~/.pet-next/` 下日志与窗口报错一并发给负责人。
