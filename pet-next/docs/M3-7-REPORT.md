# M3-7 一页交付：首次启动体验预览（含 R1 两处 Windows 入口修复）

分支 `codex/pet-next-m3-first-run`，基线 `b8eaf23`，本轮 HEAD 见文末。未合 main。

## 解决什么
双击 → 看见配置页 → 只 GET 测试连接 → 选预览选项 → 启动桌宠 → 关窗干净退出；再次打开能读取上次配置。
这是源码试用入口，仍要求 Node 22.12+ / pnpm 10.33.4 / OpenSSH，不承诺免依赖 exe，不引入安装器/新框架。

## 经典问题与为何复用
- SSH 隧道、配置格式、探测协议都已存在：复用 `resolveTunnelConfig`、`startTunnel`（ssh -N -L、有界就绪、幂等 stop）、
  `~/.pet-next/qwen-remote.json` 与 `probeQwenService`（GET /v1/models），不另造连接协议。
- 探测改用 TS 版 `probeQwenService` 而非 `probeLocalService`：Electron 从 `dist/` 加载，`.mjs` 不进 dist；
  两者同为 GET /models 语义、零 POST，属于既有实现而非新协议。
- 分层约束（`tests/boundaries` 要求 core 自包含）：类型单一来源放 `core/launcher/types.ts`，
  `contracts/launcher.ts` 只做 re-export + IPC 通道，config 的路径解析与校验留在 adapters。

## 首次启动前后（实测）
| 步骤 | 操作 | 耗时（fake SSH/模型） |
|---|---|---|
| 1 | 双击 `启动.cmd`（等价 `node scripts/launch-trial.mjs`） | 页面可交互约 1.2s |
| 2 | 填 7 个连接字段（首启为空表单） | 人工 |
| 3 | 点「测试连接」→ 起隧道 → GET /models → 收隧道 | 约 0.5s（真机取决于 SSH/服务） |
| 4 | 选体验（默认标准对照）/ 会话上下文（默认关） | 人工，选项不触发模型调用 |
| 5 | 点「启动」→ 先落盘配置 → 建隧道 → 开桌宠窗口 → 销毁配置页 | 约 2.5s |
| 6 | 关闭桌宠窗口 | 退出码 0，进程全清 |

进入桌宠后启动页**已销毁**（CDP target 只剩桌宠页；`launcherAlive=false`）。本轮自动化中的进程数为启动链 8 个
（Electron 主/渲染/zygote/GPU + launch-trial + fake 服务等），退出后 0 残留、调试端口关闭。

## 分层数量与退出码
| 层 | 数量 | 退出码 |
|---|---|---|
| preflight（unit,integration,cleanup,e2e） | 全通过 | 0 |
| typecheck | — | 0 |
| lint | — | 0 |
| unit | 556/556 | 0 |
| cleanup | 22/22 | 0 |
| integration | 5/5 | 0 |
| build | — | 0 |
| e2e（`pnpm test:e2e`） | 43：39 pass / 0 fail / 4 launcher 默认 skip | 0 |
| 真实 Electron launcher e2e（`PET_NEXT_LAUNCHER_E2E=1`） | 4/4 | 0 |
| companion e2e 回归（A 驱动改造后） | 12/12 | 0 |
| 完整 `pnpm verify` | 串行全链 | 0 |
| 源码包验证（中文+空格目录） | install 0 / build 0 / test 523（522 pass/0 fail，300s 上限截断；少 8 个 bench 测试为打包白名单既有约定） | 0 / 0 / 截断 |

launcher 四场景：首次全链 2.1s、再次启动回填 3.6s、连接失败重试 21.7s（隧道 20s 就绪超时）、直接关窗 1.0s。

## 根因修正
1. `verify-windows.ps1`：`Start-Process -ArgumentList` 重拆含空格/中文的路径 → 改调用运算符 + `$LASTEXITCODE`，保留 mutex/finally。
2. `companion.e2e`：Windows 下 `spawn('pnpm')` ENOENT → 统一显式 Node + pnpm CLI 文件 argv，解析顺序可测、exit code 透传。
3. Electron 主进程的 `process.execPath` 是 electron 二进制，不能直接跑 `.mjs` 替身 → 脚本类 SSH_BIN 在 Electron 内改用 PATH 的 node。
4. 启动页无独立保存按钮（设计如此：启动前先落盘）→ e2e 断言顺序与选择器对齐实际页面。
5. e2e 失败清理改为进程组 kill（launch-trial 派生的 Electron 孙进程）；关窗向桌宠页 CDP 发 Browser.close。

## 有效结果 / 未证明
- 有效：上述全部分层、4 个真实 Electron 场景、截图与原始 NDJSON、零 POST（测试连接只 GET /models）。
- 未证明：Windows 真机（无环境，**not-run**，脚本与入口由 Codex 复跑）；Windows companion GUI/缩放矩阵 not-run；
  真实 SSH/真实模型链路未跑（零新增真实 POST，GPU 未动）；Windows 拖动未宣称通过。

## 交付物
- 源码包：`pet-next-trial-src-<sha>.zip`（362 文件，3.35 MiB，SHA256 见打包输出）。
- 截图：`tests/chat-evidence/launcher/screenshots/`（1 首启配置页 / 2 探测成功 / 3 桌宠运行）。
- 原始日志：`tests/chat-evidence/launcher/*/{exit.txt,requests.ndjson,ssh.ndjson}`、
  `tests/chat-evidence/feedback/*`（回归）、`logs/platform-runs/linux/*`。
- 未改：反馈内核、会话、播放器、默认开关；未合 main。

## 建议
- 新界面先按预览体验（本次即预览），团队评估"配置一眼可读 + 两步启动"的成本收益后再决定是否转正。
- Windows 复跑顺序：`pnpm install --frozen-lockfile && pnpm build && pnpm test && pnpm verify:windows`，
  再 `set PET_NEXT_LAUNCHER_E2E=1 && node --experimental-strip-types --test --test-concurrency=1 "tests/launcher/first-run.e2e.test.ts"`。
- 后续可加：配置页记住上次模型名、探测失败时一键回填示例值；均不涉及新协议。
