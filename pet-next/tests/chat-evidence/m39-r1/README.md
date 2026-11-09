# M3-9 R1 · D 验收证据：Windows 驱动回填 + Linux 实跑 + 先导证据归档

基线：`5f4b431bb98eb8792ae2c422460a6e90e47e6beb`｜分支：`agent/m39r1-d`｜应用：`pet-next/`
本轮只改 `pet-next/tests/idle-suspension.e2e.test.ts`，另加本证据目录；**没有改产品代码**。

## 1. 回填到正式测试的内容（逐条对应 REVIEW / WINDOWS-M39-REVIEW）

| 项 | 正式测试现在的做法 | 保留的旧断言 |
|---|---|---|
| 平台显示环境 | `startOwnXvfb()` 在 `win32` 返回 `{ display: '', stop: no-op }`，Linux 仍走 `scripts/test-run-context.mjs` 的独占 Xvfb；`launch()` 在空 display 时不注入 `DISPLAY` | Linux 每例独占显示、不碰 `:94/:95-:97` |
| 窗口管理器 | `startWm()` 在 `win32` 直接 `available=true`（原生 WM）；Linux 仍起 `openbox`，失败则 `t.skip` | 无 WM 时不把机制缺失伪装成绿灯 |
| 失焦 | 读失焦前状态，断言 `hidden=false` 且 `pauseCount`/`resumeCount` **前后不变** | 失焦不算隐藏 |
| hide → pause | `hidden===true` **且** `pauseCount > 失焦后基线`（不再写死 `>=1` 或 `==0`） | `lease` 非空、`elementIdentity='single-primary'`、clip 真暂停 |
| show → resume | `hidden===false` **且** `resumeCount > paused.resumeCount` | 回 `playing`、clip 继续播、不重报 playing |
| 连续切换 | 3 次 hide/show 的 `pauseCount`/`resumeCount` 增量相对本轮基线各 `=3` | 最终可见且在播 |
| 隐藏中点击 | 先等隐藏暂停落地（`hidden===true` + 计数增加）再点；动作期间 `pauseCount` 不变；回 idle 且仍隐藏后计数再增 | 一次动作不被节能暂停；回 idle 再暂停 |
| minimize/restore | 同样改为相对基线（`pauseCount > 基线`、`resumeCount > paused.resumeCount`） | 真实 `isMinimized()=true/false`、`visible`、`reason='minimized'`、lease、clip 暂停/恢复、重复调用不重复计数 |
| 自然退出 | 未改动：`window.pet.quit()` → 15s 内退出、`exitCode=0`、`aliveTracked` 为空 | 隐藏中退出无残留 |
| 默认关闭 | 未改动：无 `__petIdleSuspension`、`petWindowVisibility.query()` reject、隐藏不暂停 | 默认关闭不建观测面/不加监听 |

要点：

- 没有任何 `assert.equal(..., true)` 之类的降级；每个相对断言都同时要求**真实窗口状态**（`hidden`）与**严格增加/不变**的计数。读不到状态直接抛错（`readRequired`），不用 `?? 0` 兜底，避免空断言。
- 不只改 Linux 分支：Linux 行为与 HEAD 一致（仍起 Xvfb/openbox），Windows 只替换显示/WM 准备。
- 没有为了让计数从 0 开始去改产品启动（`show:false` 的初始 pause/resume 保持原样）。
- 用例数仍为 3，未删除、未 skip 化。回填 diff 见 `logs/idle-test-backport.diff`。

## 2. Linux 实跑（本轮唯一新执行的 e2e）

环境：Linux 5.4.119 / Node v24.14.0 / `/usr/bin/Xvfb` / `/usr/bin/openbox`，`env -u NODE_OPTIONS`，`node_modules` 软链。
前置构建：`tsc -p tsconfig.json`、`tsc -p tsconfig.preload.json`、`node scripts/copy-static.mjs`（均 exit 0）。

命令（正式测试文件，不是临时 check 副本）：

```bash
cd pet-next
env -u NODE_OPTIONS node --experimental-strip-types --test --test-concurrency=1 --test-reporter spec tests/idle-suspension.e2e.test.ts
```

结果：**tests 3 / pass 3 / fail 0 / skipped 0 / exit 0**，`duration_ms 9827.332033`。

| 用例 | 结果 | 耗时 |
|---|---|---|
| 默认关闭：不创建观测面、不加窗口监听，隐藏不影响播放 | pass | 2734.42 ms |
| 开启后：真实 hide/show 驱动暂停与恢复，失焦不算隐藏，点击动作不被暂停 | pass | 4545.46 ms |
| 最小化：真实 minimize 算隐藏并暂停，restore 恢复且重复调用不重复计数 | pass | 2424.32 ms |

原始输出：`logs/idle-e2e-linux-20261109T071434Z.log`（含末尾 `EXIT_CODE=0`）。环境快照：`logs/environment.txt`。
三个 Electron 会话的原始记录：`logs/platform-runs-linux/<时间戳>-<label>-<pid>/`（`command.json`、`exit-code.txt`、`stdout.log`、`stderr.log`；从 `pet-next/logs/platform-runs/` 原样移入）。
其中 `m39-off`、`m39-min` 由 `closePet()` 在用例结束时终止，`exit-code.txt` 记为 `null`；`m39-on` 走 `pet.quit()` 自然退出，记为 `0`（用例内另有 `exitCode===0` 与无存活子进程断言）。
`environment.json` **未保留**：该文件是宿主全量环境快照，含 `JUPYTER_TOKEN_SECRET`/`PASSWORD` 等机器凭据变量，与本证据无关，按"不落凭据"处理。

本机有 openbox，minimize 用例是真跑而不是 skip；无 WM 环境的既有 `t.skip('openbox 不可用…')` 语义保留但本轮未触发。

## 3. 证据清单

### 3.1 `pilot/` — 先导原件（historical / backfilled）

来源 `m38-wt-lead/pet-next/tests/chat-evidence/m39-pilot/`（此前未提交，源目录只读保留）。复制后与源目录 `diff -r --exclude=userData` 一致。

- `SUMMARY.md`、`service/{SUMMARY-machine.txt,commands.txt,run-log.ndjson,stats.json}`、`hidden-real{,-2,-3}/{result.json,product-stdout.log,product-stderr.log}`、`metrics-before.txt`、`metrics-after.txt`、`models.json`、`probe-hidden-real.mjs`、`health.json`（源文件即 0 字节）。
- **已排除** `hidden-real*/userData/` 下的 Chromium/Electron 生成缓存（DawnGraphiteCache、GPUCache、Code Cache、Cache、Session Storage、Shared Dictionary、Crashpad、Preferences 等，源目录约 6.6 MB）。归档后共 20 个文件，两份 metrics 各约 55 KB，其余均小于 9 KB。
- **这批 6 次真实 POST 是 2026-11-09 的先导实验，属 historical；本次入库属 backfilled。它不是"发前持久账本"**，不能当预算硬上限或本轮之后的调用记录。详见 `pilot/HISTORICAL-NOTE.txt`。

### 3.2 `windows/` — 原始失败与修正驱动（未在本机复跑）

- `logs/windows-m39-idle-windows.log`：**原始 3 例套件 2 过 1 败，exit 1（19.78s）**，失败是 `AssertionError 1 !== 0`（失焦后 `pauseCount` 已是 1）。这份失败原样保留。
- `logs/windows-m39-idle-hide-delta.log`：修正断言后的定向检查 **1/1 pass，exit 0（9.97s）**，日志含 `M39_INITIAL/M39_BLURRED` 的 `pauseCount:1, resumeCount:1` 证据。**这是独立副本结果，不等于原正式命令已全绿。**
- `logs/windows-m39-{install,build,modules}*.{log,json}`：安装/构建/模块 33/33 的原始记录。
- `platform-raw/`：Electron 会话级原始 `command/environment/stdout/stderr/exit-code`。前 3 个会话（06:31:48–06:31:59）属同一原始套件进程（共享 exit 1）；06:32:46 的 on 例是"只加日志仍失败"的中间版（exit 1）；06:33:22 的 on 例是修正后 delta（exit 0）。
- `driver-copies/`：两个临时驱动原件（`idle-windows.check.ts.txt`、`idle-windows-delta.check.ts.txt`，加 `.txt` 后缀避免被仓库 `tsc --noEmit` 当作源码编译，内容逐字节未改）；`patches/`：对应的 `windows-driver.diff`、`windows-delta-driver.diff`；`probes/`：`prepare_windows_driver.py`、`run_windows_gate.py`（120s 看门狗）。
- `WINDOWS-M39-REVIEW.txt`：Codex 独立复核原文。
- 凭据检查：`platform-raw/*/environment.json` 只含本机路径等运行环境，未发现 `*KEY/*TOKEN/*SECRET/*PASSWORD/*CREDENTIAL/*AUTH*` 字段；仍按原样保留（原包内容）。

### 3.3 SHA256

- `pilot/SHA256SUMS`、`windows/SHA256SUMS`、`SHA256SUMS-m39-r1.txt`（覆盖本目录全部文件，含本 README 与两份子清单）。
- 校验：`cd pet-next/tests/chat-evidence/m39-r1 && sha256sum -c SHA256SUMS-m39-r1.txt`。
- 仓库 `.gitignore` 忽略 `*.log`，本目录的原始日志用 `git add -f` 显式入库（与 `tests/chat-evidence/m39-lead/logs/` 的既有做法一致），未改 `.gitignore`。
- 仓库 `.gitattributes` 是 `* text=auto eol=lf`，Windows 来源的 19 个文本文件（`.json`/`.log`/`.diff`/`.ts.txt`）按仓库统一规范转成 LF 入库，**内容不变、仅行尾变**；原始 CRLF 字节仍在 review 包与本轮 handoff 备份（`pilot-originals.tar.gz` 等）中。上面的 SHA256 都是**入库后 LF 版本**的哈希，克隆后可直接 `sha256sum -c`。

## 4. Windows：未复跑，交 Codex 一条命令复验

本机无 Windows，**不声称 Windows 已通过**。可用它复验的正式驱动就是本仓库的 `tests/idle-suspension.e2e.test.ts`（不再需要任何 `*.check.ts` 临时文件）。

前置（干净解压/克隆后）：

```powershell
pnpm install --frozen-lockfile
pnpm build
```

正式命令（PowerShell，`pet-next/` 目录内，Node 24）：

```powershell
$env:NODE_OPTIONS = $null
node --experimental-strip-types --test --test-concurrency=1 --test-reporter spec tests/idle-suspension.e2e.test.ts
```

cmd.exe 等价：

```bat
set NODE_OPTIONS=
node --experimental-strip-types --test --test-concurrency=1 --test-reporter spec tests/idle-suspension.e2e.test.ts
```

期望：`tests 3 / pass 3 / fail 0 / skipped 0`、退出码 0。
说明：win32 上 minimize 用例不再 skip（原生 WM 视为可用），因此若宿主是 Session 0 / 无交互桌面导致 `isMinimized()` 不翻转，会**如实失败**——请连同 `logs/platform-runs/` 原始记录一起回报，不要改断言或加 skip。

## 5. 未证明项（不外推）

1. Windows 正式命令本轮**未运行**；此前只有"改驱动的临时副本 2 过 1 败 + 定向 delta 1/1 过"，不是同一件事。
2. macOS 完全未跑。
3. 无 WM（裸 Xvfb）下 minimize 的 skip 分支本轮未触发（本机有 openbox），仅保留既有语义。
4. 未跑完整 `pnpm verify`、launcher e2e、DPI 矩阵、资源/CPU 基准（不在本轮 D 范围）。
5. 本测试只覆盖窗口/idle 暂停恢复机制，**不覆盖**隐藏期聊天取消/超时/长正文/断网；那些属 C/B 的 fake 回归。
6. 先导 6 次 POST 只支持"标准聊天 + context=false + 无 companion、n=3"的有限结论，详见 `pilot/HISTORICAL-NOTE.txt`。
