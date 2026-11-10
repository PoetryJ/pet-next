# M3-10 A：隐藏聊天生命周期 E2E 的跨平台入口

只改 `tests/chat-hidden-lifecycle.e2e.test.ts` 的环境/构建入口；8 条业务断言、正式入口
（`scripts/chat-local.mjs`）、`TOTAL_TIMEOUT_MS = 15_000`、POST 计数、自然退出与归属清理全部未动。
不改媒体/会话内核，不访问 `127.0.0.1:18872`，真实 POST = 0。

## 改了什么

| 原问题 | 修法 |
|---|---|
| `before` 无条件 `spawn('Xvfb', [':131', ...])`，Windows 没有 Xvfb，8 例在进入业务断言前共同失败 | `REAL_DESKTOP = process.platform !== 'linux'`：win32/macOS 直接 return，用真实桌面；只有 Linux 无 socket 时才起本次 Xvfb（已在跑则复用，只 kill 自己的） |
| 入口子进程无条件注入 `DISPLAY`（空串也会被 X 相关路径误判） | 真实桌面平台不注入 `DISPLAY` |
| `spawnSync('pnpm', ['build'])` 猜 shell；Windows 只有 `pnpm.cmd`，直接 ENOENT | 统一走 `tests/feedback/pnpm-entry.ts` 的 `resolvePnpmEntry()`：当前 Node + pnpm CLI 的 `.cjs/.js` 文件 argv，退出码/stdout 原样透传 |

`resolvePnpmEntry` 解析顺序：`PET_NEXT_PNPM_CLI` → 项目内 `node_modules/pnpm/bin/pnpm.cjs`
（源码包布局还有 `tools/node_modules/...`）→ 由当前 Node 可执行文件推导的全局前缀 →
非 Windows 保留原 `spawn('pnpm')`；Windows 找不到就明确报错，不静默回退。

## Linux 实测：8/8 pass（2026-11-09，基线 8eac712 + 本轮 A 提交）

```bash
cd pet-next
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
env -u NODE_OPTIONS PET_NEXT_E2E_DISPLAY=:131 node --experimental-strip-types --test \
    --test-concurrency=1 --test-reporter spec tests/chat-hidden-lifecycle.e2e.test.ts
```

结果：`tests 8 / pass 8 / fail 0 / skipped 0`，总时长 50.9 s（原始日志
`m310-delivery/logs/hidden8.log`）。

## Windows：not-run（无机器，不用 Linux 顶替）

前提：Node ≥ 22.12（实测 24.14.0）、pnpm 10.33.4、**交互式桌面会话**（不是 Session 0 服务）。
不要安装/启动 Xvfb——win32 分支既不找 `/tmp/.X11-unix` 也不 spawn Xvfb，也不注入 `DISPLAY`。

PowerShell（在 `pet-next\` 目录下，Node 在 PATH；不要设 `DISPLAY` / `PET_NEXT_E2E_DISPLAY`）：

```powershell
# 仅当项目内没有 node_modules\pnpm\bin\pnpm.cjs（例如用的是全局 pnpm）时设置；
# 必须指向 .cjs/.js CLI 文件，不能是 .cmd/.ps1 包装器。
$env:PET_NEXT_PNPM_CLI = 'C:\dev\pet-next\node_modules\pnpm\bin\pnpm.cjs'

node --experimental-strip-types --test --test-concurrency=1 --test-reporter spec `
     tests/chat-hidden-lifecycle.e2e.test.ts
```

判定标准与 Linux 相同，不得用 skip / 删断言 / 调大业务 deadline 过关：

- `tests 8 / pass 8 / fail 0 / skipped 0`；每例 `timeout: 180_000`，业务 deadline 仍为 15 s。
- 覆盖：①2s 延迟成功 + 2000/2001 字符、①′idle-pause 关闭对照、②隐藏取消后旧结果晚到、
  ③隐藏期到 15s deadline 后恢复重发（0 POST）、④隐藏 reset 与按 id 隔离、⑤上游重置可读错误
  与手动重发、⑥在途隐藏关窗自然退出（exit 0，PID/调试端口消失，上游断开）、对照 context=off。
- 失败先看 `logs/platform-runs/<ts>-hidden-*/`（exit.txt、请求 ndjson）与 fake 统计。

## 未证明

- Windows 真机 8/8 未跑（本节 not-run）；Windows 上的自然退出/端口清理只能由该机复跑确认。
- 真实 GPU 停算、物理可见帧不在本文件断言范围（由会话结算/fake 统计分层证明，互相不冒充）。
