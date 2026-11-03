# chat:remote —— Windows 本机一键使用服务器 Qwen

一条命令把服务器上的 Qwen 经 SSH 本地转发接到本机桌宠聊天：不启动 fake、不启动模型、不开放公网端口。

`chat:remote` 自带 `pnpm build`，所以 `pnpm install` 之后一条命令即可启动（空 `dist` 也能直接跑）。

## 最短准备步骤（Windows PowerShell）

1. 安装 OpenSSH 客户端（Windows 10/11 自带）。在 **PowerShell** 里确认：
   ```powershell
   ssh -V
   ```
2. 准备密钥并确认可无密码登录服务器（本项目不保存密码，只用密钥或 ssh-agent）：
   ```powershell
   # 已有密钥可跳过这两行
   ssh-keygen -t ed25519
   # Windows 没有 ssh-copy-id，用下面这行把公钥追加到服务器（只需一次）
   type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh -p <SSH端口> <用户>@<服务器地址> "cat >> ~/.ssh/authorized_keys"
   ```
   已有密钥但需要每次免输密码时，用 Windows 的 ssh-agent（管理员 PowerShell，一次即可）：
   ```powershell
   Set-Service ssh-agent -StartupType Automatic
   Start-Service ssh-agent
   ssh-add $env:USERPROFILE\.ssh\id_ed25519
   ```
3. 提供连接信息（二选一，仓库只含占位符示例）：
   - 环境变量（当前 PowerShell 会话有效）：
     ```powershell
     $env:PET_NEXT_SSH_HOST = '<服务器地址>'
     $env:PET_NEXT_SSH_PORT = '<SSH端口>'
     $env:PET_NEXT_SSH_USER = '<用户>'
     $env:PET_NEXT_SSH_IDENTITY_FILE = "$env:USERPROFILE\.ssh\id_ed25519"  # 可选，缺省用 ssh-agent
     ```
   - 或本地配置文件 `%USERPROFILE%\.pet-next\qwen-remote.json`（参考 `config/chat-remote.example.json`；
     可用 `PET_NEXT_REMOTE_CONFIG` 指定路径）。文件优先于环境变量。
4. 启动（需要 Node 22.12+，与 `package.json` 的 engines 一致）：
   ```powershell
   pnpm install
   pnpm chat:remote
   ```
   看到 `chat-remote-tunnel` → `chat-remote-probe` → `chat-remote-ready` 后弹出 320×240 宠物窗，点「聊」使用。

## 验收与自测

Windows 一键验收（默认零推理，只验证 隧道 → /models → 面板 → 关窗收尾 → 本次 PID/端口清理）：
```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-windows-chat-remote.ps1
```

- 发送/取消/重发等交互验收只允许搭配 fake 服务（零推理）：
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts\verify-windows-chat-remote.ps1 -Fake -Interact
  ```
- 指定负路径（认证失败/缺模型/隧道不就绪/端口占用）：
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts\verify-windows-chat-remote.ps1 -Fake -Expect auth-failed
  ```
- 真实推理只在显式 `-AllowRealInference` 时发生，**恰好一次**、不可循环，默认关闭。
- Linux 同一套实现：`bash scripts/verify-linux-chat-remote.sh`（参数相同，默认零推理）。

脚本每次把 `env.txt / stdout.ndjson / stderr.txt / models.json / 截图 / owned-pids.txt / SUMMARY.txt`
写进 `tests/chat-evidence/remote/auto-<stamp>/`，任何断言失败都以非零退出。

## 端口与安全

- 默认本地转发 `127.0.0.1:18873` → 服务器 `127.0.0.1:18872`（模型服务只监听服务器本机）。
- 端口冲突会明确报错，可设置 `PET_NEXT_TUNNEL_LOCAL_PORT` 换端口；不会抢占已有进程。
- 不使用 `-g`，不把模型端口暴露到公网；退出只关闭本次 Electron 与本次 ssh。

## 失败排查

| 现象 | 提示 | 处理 |
| --- | --- | --- |
| 认证失败 | `auth-failed` | 确认密钥已加载（`ssh-add`）或 `PET_NEXT_SSH_IDENTITY_FILE` 正确，服务器已授权公钥 |
| 本地端口被占 | `port-conflict` | 关闭占用进程，或设置 `PET_NEXT_TUNNEL_LOCAL_PORT=其他端口` |
| 隧道未就绪 | `not-ready` | 检查网络、SSH 端口、服务器模型服务是否在监听 |
| 找不到 ssh | `ssh-missing` | 安装 OpenSSH 客户端，或用 `PET_NEXT_SSH_BIN` 指定路径 |
| 转发端无模型 | `probe-failed` | 服务器 `/models` 应含 `qwen3.8-27b`；检查服务状态 |
| 使用中断开 | `chat-remote-tunnel-lost` | 窗口会关闭并退出非零；恢复网络后重新 `pnpm chat:remote` |
| 启动阶段按 Ctrl-C | `chat-remote-cancelled` | 退出码 130；本次 ssh 已关闭，不会留下半启动的窗口 |

## 边界

- 不做自动重试、不静默转 fake、不自动安装 SSH、不做系统级修改；启动阶段（预检/建隧道/探测）
  与运行阶段都响应 Ctrl-C，只清理本次进程。
- 聊天仍为单轮、非流式、15 秒总超时、一次一个在途；取消后立即重发。
- 真实模型质量与延迟见 M3-1 验收记录（`tests/chat-evidence/qwen/SUMMARY.txt`）。
- Windows 高 DPI 缩放、无边框窗口点击仍属未运行项（not-run），由 Codex 在 Windows 复验。
