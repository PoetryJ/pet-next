# M3-6 R1 一页交付：慢回复仍回应、Windows 入口可用

基线 `2c3a5f3` · 分支 `codex/pet-next-m3-companion-preview` · 代码 HEAD `54a319c`（证据随 `c3acf17`）

## 1. 问题 / 原理 / 选法

- **慢回复丢失（产品缺陷）**：等待提示 1.6s 到期时 `expire` 直接把状态置 `idle`，2s 才到的
  `ok` 被归属闸门拒绝 → 无 success 提示、`reaction=0`。
- **选法（最小规则）**：`waiting` 到期只 `hint-hide` + `deadline=null`，**保留 waiting/token**；
  终态结果提示到期才回 `idle`。不调大 1600ms，不动聊天会话与播放器。
- **Windows 阻断**：CLI 夹具是 Unix shebang 脚本被直接 spawn；`verify:windows` 调 PowerShell 5
  被执行策略拒绝、UTF-8 中文解析失败。
- **选法**：注入的 `.js/.cjs/.mjs` 一律用显式 Node + argv（生产 `nvidia-smi`/`vllm` 命令原样）；
  `verify:windows` 改 Node 入口，预检 pwsh 7、仅本次进程 `-ExecutionPolicy Bypass`、脚本路径单 argv。
- **退出验收缺口**：`Browser.close` 后直接 `pkill` 兜底，没有自然零残留硬断言。
- **选法**：正式退出 → 等入口结束 → 断言本次 PID 树消失 + 调试端口关闭（`exit.txt` 留证），
  断言先于 finally 清理；另设无关哨兵进程断言不被误杀。

## 2. 修复前后证据

审查探针 `slow-feedback.check.mjs`（零 HTTP / 零 GPU / 注入时钟）：

| 版本 | 退出码 | 观测 |
|---|---|---|
| 修复前（2c3a5f3） | **1** | `late valid success must still show success` |
| 修复后 | **0** | effects=`waiting → hint-hide → success → react`，reacts=`[1]` |

正式入口两臂（fake 延迟 2.5s，同一输入）：

| 指标 | 对照臂 | companion 臂 |
|---|---|---|
| 等待提示可见→到期隐藏 | —（无节点） | 1651 ms |
| 提交→回复 | 2590 ms | 2592 ms |
| 提交→成功提示 / 回应 | —（0 次） | 2592 ms / 2593 ms，`reaction-2` 恰 1 次 |
| 推理 POST | 1 | 1 |

取消/重置后迟到：`POST=2`，迟到取消与迟到重置**零回应、零上屏**。
自然退出：退出码 0、调试端口关闭、PID 树清空、无关哨兵存活（`companion-exit-smoke/exit.txt`）。

## 3. 每层数量与真实退出码

| 层 | 数量 | 退出码 |
|---|---|---|
| `pnpm verify`（typecheck/lint 全仓） | — | **0** |
| 单测 `pnpm test` | 511 / 511 pass | 0 |
| `test:cleanup` | 22 / 22 | 0 |
| `test:integration` + `assets:check` | 5 / 5 | 0 |
| `test:e2e`（8 文件，feedback 12 条） | 39 / 39 | 0 |
| 源码包 `install` / `build` / `test`（中文+空格路径解压） | 481 / 481 pass | 0 / 0 / 0 |
| `pnpm verify:windows` | **not-run**（无 Windows 执行器） | 非 Windows 入口按设计 exit 2 |

## 4. 有效结果 / 根因修正 / 未证明

- **有效结果**：慢回复在等待提示到期后仍出成功提示并回应恰一次；两臂各 1 POST；取消/重置迟到零动作；
  正式退出无残留且不误杀树外进程。
- **根因修正**：
  1. `expire` 对 waiting 的语义错误（本轮主缺陷）；
  2. 注入夹具 shebang 在 Windows 不可执行 → 显式 Node；
  3. `verify:windows` 依赖 PowerShell 5 与长字符串路径 → pwsh7 预检 + argv 数组；
  4. `URL.pathname` 在中文/空格路径下百分号编码，导致 `cwd` 不存在（解压包实测 2 条失败）→ `fileURLToPath`。
- **未证明**：Windows 未实跑（缩放 100/125 的输入隔离问题原样保留为失败/not-run，未改产品）；
  本轮无真实模型调用；慢回复时序为单次实测，不是 P50。

## 5. 结论

**通过（有限返工范围内）**：修复与验收完成，默认开关/素材/双槽不变，未合 main，未推送。
等待 Codex 在 Windows 上复验 `pnpm verify:windows`（需 PowerShell 7）。
