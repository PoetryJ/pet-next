# chat:remote —— Windows 本机一键使用服务器 Qwen

一条命令把服务器上的 Qwen 经 SSH 本地转发接到本机桌宠聊天，不启动 fake、不启动模型、不开放公网端口。

## 最短准备步骤（Windows）

1. 安装 OpenSSH 客户端（Windows 10/11 自带）：PowerShell 执行 `ssh -V` 有输出即可。
2. 准备密钥并确认可无密码登录服务器（本项目不保存密码，只用密钥/ssh-agent）：
   ```text
   ssh-keygen -t ed25519            # 已有可跳过
   ssh-copy-id -p <你的SSH端口> <用户>@<服务器地址>
   ```
3. 提供连接信息（二选一，仓库不含真实地址）：
   - 环境变量：
     ```text
     set PET_NEXT_SSH_HOST=<服务器地址>
     set PET_NEXT_SSH_PORT=<SSH端口>
     set PET_NEXT_SSH_USER=<用户>
     set PET_NEXT_SSH_IDENTITY_FILE=C:\Users\你\.ssh\id_ed25519   # 可选，默认用 ssh-agent
     ```
   - 或本地配置文件 `%USERPROFILE%\.pet-next\qwen-remote.json`（参考 `config/chat-remote.example.json`；
     可用 `PET_NEXT_REMOTE_CONFIG` 指定路径）。
4. 启动：
   ```text
   pnpm install
   pnpm chat:remote
   ```
   首次会提示 `chat-remote-tunnel` 与 `chat-remote-probe` 就绪，随后弹出 320×240 宠物窗，点「聊」使用。

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

## 边界

- 不做自动重试、不静默转 fake、不自动安装 SSH、不做系统级修改。
- 聊天仍为单轮、非流式、15 秒总超时、一次一个在途；取消后立即重发。
- 真实模型质量与延迟见 M3-1 验收记录（`tests/chat-evidence/qwen/SUMMARY.txt`）。
