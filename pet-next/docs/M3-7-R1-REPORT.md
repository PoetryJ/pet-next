# M3-7 R1 一页交付：兑现"真正双击 → 选陪伴 → 聊天有动作 → 退出干净"

分支 `codex/pet-next-m3-first-run`，基线 `fdd3f0a`，未合 main。完整 HEAD 与包哈希见仓库外交付清单 `M3-7-R1-DELIVERY.txt`（不写进本文件，避免自引用改变 HEAD）。

## 本轮修的三个产品缺陷（问题 / 原理 / 选法）

### 1. 选 companion 后聊天动作是空的（REVIEW 缺陷 1）
- 问题：launcher 只把 `experience=companion` 传给页面，没补 `short,behavior`，页面未创建 `holder.behavior`，反馈成功回调空转。
- 原理：既有链路 `preview=short,behavior` 决定短片/行为素材，`experience=companion` 只创建反馈控制器；两者缺一，动作无对象可调。
- 选法：新增 `electron/launcher-run-options.ts` 纯函数，companion → `preview='short,behavior'` + `experience='companion'`；standard → 两者显式 undefined。main.ts 在 launcher 启动时只用用户选择，彻底切断父 env 残留。不另造播放器、不改全局 env。
- 修前：Windows 真实窗口 + 1 次 fake POST 证实无动作。修后：真实 Electron e2e `companion → 发 1 条 fake 消息 → 回复上屏 + reaction 恰 1 + POST=1`，快/慢回复（2.5s）两例均通过。

### 2. 探测中关窗：取消未贯穿且句柄未登记（REVIEW 缺陷 2）
- 问题：`startTunnel` 成功后句柄未登记，`/models` 探测不接收取消信号；stop 时 `stops=0`、start 返回 ok、句柄存活（`launcher-stop.check.mjs` exit1）。
- 原理：资源所有权必须跟随操作对象——取消后任何晚到结果都不能再交付句柄。
- 选法：每次 probe/start 建操作对象（AbortController + 已取得句柄 + completion + 幂等 closePromise）；取得隧道立即登记；取消信号经 `AbortSignal.any` 贯穿 `/v1/models` 并保留原 5s 超时；每个 await 后检查取消/身份/存活；stop 先取消并 close 已登句柄 → 等结算 → 补 close 晚交付 → 关 parked tunnel，全程幂等。
- 修前：`launcher-stop.check.mjs` exit1（stops=0/alive=true/started.ok=true）。修后：exit0，`{"started":{"ok":false,"error":{"code":"cancelled"}},"stops":1,"alive":false,"phase":"idle"}`。真实 e2e：探测中关窗 → 退出 0、无桌宠窗口、隧道已收、归属进程全消失。

### 3. 启动.cmd 在默认代码页下解析失败（REVIEW 缺陷 3）
- 问题：UTF-8 无 BOM + LF + 中文注释，GBK 代码页下注释片段被当命令、进入 cd_fail。
- 原理：cmd.exe 按 ANSI 代码页逐字节读批处理；非 ASCII 字节与 LF 的 label/goto 解析都不可靠。
- 选法：全 ASCII 注释 + CRLF（1800 字节 / 45 CRLF / 0 非 ASCII / 无 BOM / 无 chcp），并在 `.gitattributes` 增加例外 `pet-next/启动.cmd text eol=crlf`（项目其余仍 LF），保证任何平台检出与导出都是 CRLF。
- 修前：受控 exit7 诊断下，原包装器 exit1 且没到正确子进程。修后：字节断言跨平台真跑；真实 `.cmd` exit 0/7 原样透传 3 例 **Windows-only not-run**（本机无 Windows）。

## 验收驱动补齐（REVIEW 五条）
- `gate` 改 `if (!gate(t)) return`：disabled 时 `spawned=0/listened=0/post=0`、7 skipped、零新增实例目录。
- 桌宠 target 只认 `app/page.html` + 轮询 `#pet` 挂载，拒绝 about:blank，无固定 sleep。
- 失败重试：fixture 暴露真实 `fakePort`，死端口失败 → 改到实际端口 → 再次 probe 成功；旧隧道 stopped、POST=0。
- 新增 companion 快/慢回复两例（回复 + reaction 恰 1）、探测中关窗一例（取消零残留）。
- 归属检查用 `tests/launcher/owned-processes.ts`（跨平台只读快照）：启动后 capture、退出前断言 `alive=[]`，先于 finally 清理；删除全局 pkill。
- 稳定性加固：`waitForMainBundle`（等 dist 产物稳定 1.5s，避免并发 build 假失败）、CDP 建连/命令显式超时、fillForm 改 testid 聚焦输入（消除坐标点击串位）。

## 分层数量与真实退出码（Node 24.22.1 / pnpm 10.33.4，Linux）
| 层 | 数量 | 退出码 |
|---|---|---|
| preflight | 全通过 | 0 |
| typecheck | — | 0 |
| lint | — | 0 |
| unit | 590（587 pass / 3 Windows-only skip） | 0 |
| cleanup | 22/22 | 0 |
| integration | 5/5 | 0 |
| build | — | 0 |
| 完整 `pnpm verify`（第 6 次，干净环境） | e2e 46 = 39 pass / 0 fail / 7 launcher 默认 skip | 0 |
| 显式真实 Electron `PET_NEXT_LAUNCHER_E2E=1` | 7/7（最终版两遍均 7/7） | 0 |
| `launcher-stop.check.mjs`（Codex 硬断言） | 红→绿 | 0 |
| 包内（中文+空格目录） | install 0 / build 0 / 串行 test 560（556 pass / 4 skip，123s 自然结束） | 0 |
| 包内 `启动.cmd` 字节 | 1800B / 45 CRLF / 0 非 ASCII / sha256 与工作树一致 | — |

e2e 场景耗时（最终版）：首次全链 2.9s、回填 2.1s、失败重试 22.8s（产品 20s 有界就绪）、探测中关窗 2.4s、直接关窗 2.1s、companion 回复 3.9s、companion 慢回复 6.3s。

## 抖动与诚实口径
前 5 次完整 verify 均出现**不同**的既有 e2e 用例失败（drag-scale xdotool、chat-trial T4 隧道、chat-context T1 fake 服务），每次失败用例单跑均 100% 通过；第 6 次在彻底清理进程/临时目录并重启 Xvfb 后一次全绿。这些用例不在本轮改动路径内，但属交付风险，已记录原始日志。

## 截图 / 请求 / 退出记录
- 截图：`tests/chat-evidence/launcher/screenshots/`（首启配置页 / 探测成功 / 桌宠运行；界面本轮未变）。
- 请求与退出：`tests/chat-evidence/launcher/{first-run-success,reopen-refill,probe-fail-retry,probe-cancel-exit,cancel-clean-exit,companion-chat,companion-chat-slow}/`（exit.txt 含 root_pid/owned_pids_before/owned_pids_alive_after、requests.ndjson、ssh.ndjson）；companion 反馈回归 `tests/chat-evidence/feedback/*`。

## 未证明（not-run）
- Windows 真机：`verify:windows`、`cmd-entry.test.ts` 真实 .cmd 3 例、`owned-processes` win32 分支、companion GUI/缩放矩阵均 not-run（本机无 Windows/pwsh）。**不把 Linux 或 Node 入口结论当作 Windows 双击通过。**
- 真实 SSH/真实模型链路未跑：零新增真实推理，GPU 未动。
- `scripts/launch-trial.mjs` 的中文提示在 Windows GBK 控制台可能乱码（REVIEW 未要求，属后续可选）。

## 建议
- Windows 复跑顺序：`pnpm install --frozen-lockfile && pnpm build && pnpm test && pnpm verify:windows`；
  再 `set PET_NEXT_LAUNCHER_E2E=1 && node --experimental-strip-types --test --test-concurrency=1 "tests/launcher/first-run.e2e.test.ts"`；
  再 `node --experimental-strip-types --test --test-reporter spec "tests/launcher/cmd-entry.test.ts"`（期望 pass 5 / skipped 0）。
- 若后续要提升完整 verify 稳定性，可让 chat-context/chat-trial 等用例也采用 `waitForMainBundle` 的产物稳定等待，或在 verify 前统一清理显示与临时实例目录。
- 新界面仍按预览体验，转正由团队评估后决定。
