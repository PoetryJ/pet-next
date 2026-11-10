# M3-12 D：可见待机三臂（O/F/C）资源与行为对照

本目录只做**测量**：三臂跑同一条产品入口、同一窗口、同一可见状态，唯一差别是
`PET_NEXT_IDLE_URL`（`electron/main.ts:248` 已有的查询注入）指向的 idle 文件。
不改产品代码、不改默认开关、不建 SSH 隧道、不挂聊天，因此没有真实模型请求路径。

## 1. 两阶段纪律

| 阶段 | 何时 | 跑什么 |
|---|---|---|
| 一（现在） | 工具就绪即可 | `--mode=selfcheck`：只跑 O，证明 /proc 计量、真实解码帧、点击时延、退出/残留都可用 |
| 二（等负责人通知） | A 的产物过 C 画质门 + 负责人说“可以跑性能” | `--plan=O,F,C --reps=3`，以及其他 agent 停编码/停测试后执行 |

阶段一**不跑 F/C**；F/C 缺失时默认直接失败（`--allow-missing` 才会降级并标 notRun；接了
阶段门后这类旁路会被门禁拒绝，以 `STAGE-GATE.md` 为准），
避免“只跑 O 却看起来像做了对照”。

## 2. 三臂定义与素材路径

| 臂 | idle 源 | 说明 |
|---|---|---|
| O | 已提交 `out/O.webm`（回退 `assets/idle.webm`） | 必须等于 manifest `sourceSha256`；同时核对与 `assets/idle.webm` 同字节 |
| F | 已提交 `out/F.webm` | A 的全画布重编码；也接受 `full.webm` / `F-full.webm` |
| C | 已提交 `out/C.webm` | A 的 ROI 裁剪；也接受 `roi.webm` / `C-roi.webm` |

**素材只认已提交字节，目录由本次 subpath 唯一决定**：`--assets-ref=<ref>` 先
`git rev-parse --verify <ref>^{commit}`，再执行

```bash
git -C <repo> archive <commit> pet-next/<subpath> |
  tar -x -C runs/<stamp>/assets-committed --strip-components=1
```

- 解出目录 = `runs/<stamp>/assets-committed/<subpath>`（**由本次调用唯一决定**，不再遍历
  dest 找“第一个 manifest”）。`--assets-subpath` 默认 `experiments/idle-roi/out`；v2 用
  `--assets-subpath=experiments/idle-roi/out-v2`。
- 同一个 dest 先取 v1 再取 v2 时两个目录并存、各自准确；工具**不清理** dest 里不属于本次
  调用的内容（旧 `out/` 不删，也不会被当成 v2）。
- 只有**没有显式 subpath** 时（`--assets-dir=<dir>`）才允许向下扫描 `manifest.json`：
  0 个候选或 ≥2 个候选都直接失败（`manifest-not-found` / `ambiguous-assets-dir`），不猜。
- 需要复核“该用哪一份”时用精确模式 `resolveAssetsDir(dir, { subpath })`：不扫描，直接返回
  `<dir>/<subpath>`（`subpath-not-found` / `invalid-subpath` 时为 null）。单参
  `resolveAssetsDir(dir)` 在 v1/v2 并存的 dest 上返回 null，不会返回旧 `out/`。
- 路径校验：只接受 `pet-next/` 下的仓库相对路径（前缀可省略）。绝对路径、盘符（`C:/…`）、
  反斜杠路径、`.`/`..` 组件、空路径/空组件、pathspec 通配（`*`、`?`）一律拒绝
  （`invalid-subpath`）。

失败语义：下面每种情况都是**非零退出**（`run.mjs` 退出 4，不启动 GUI），不存在
`ok:true` 的空产物。

| 情况 | code |
|---|---|
| 非法 subpath（绝对/盘符/反斜杠/`..`/空/通配） | `invalid-subpath` |
| ref 不存在或不是提交 | `bad-ref` |
| 子路径不存在（`git archive` 报 pathspec 不匹配） | `archive-failed` |
| 子路径没有 `manifest.json` | `manifest-missing` |
| 缺 `O.webm` / `F*.webm` / `C*.webm` | `missing-file` |
| 实测 SHA 与 manifest 声明不符 | `sha-mismatch` |
| 子路径指向文件而不是目录 | `assets-dir-missing` |
| `--assets-dir` 下多个候选 | `ambiguous-assets-dir` |

臂名映射表（`F_FILES`/`C_FILES`）：v1/v2 是 `F.webm`/`C.webm`，v3（原生 YUVA）是
`F3.webm`/`C3.webm`。**名字只用于定位，SHA 仍逐文件核验**——所以 `F3/C3` 不需要任何
“命名不符就放行”的旁路；`gate.json` 里的 `staging.namingOnlyFailure` 只是记账字段（仅在
候选名不在映射表内、且 manifest/字节自洽时为非 null），它**不放行 SHA**，随后仍由阶段门
按质量报告的逐臂 SHA 核验，对不上照样 exit 5。
注意 v3 manifest 没有声明 F3 的 SHA（`revision['v3-yuva']` 只有派生说明，没有 `F`/`C` 条目），
所以 `verifyAssetsDir` 对 F3 只做“存在”检查（`checks.fShaDeclared=false`、`fMatchesManifest=null`）；
F3 的字节绑定由阶段门按质量报告 `verdict.candidates.sha256.F` 完成。C3 仍有
`manifest.candidateSha256` 可对。

`O.webm` 必须等于 `manifest.sourceSha256`，`C.webm` 必须等于 `manifest.candidateSha256`；
`F.webm` 若 manifest 声明了 `revision.<ver>.F.sha256`（`<ver>` = `C.sha256 ===
candidateSha256` 的那一版）也必须一致——v1/v2 的 F 不同，不能拿 v1 的 F 校验 v2 的字节。

`summary.provenance`（`schemaVersion: 2`）全部字段从**实际取出的文件**重算，不手填：

| 字段 | 含义 |
|---|---|
| `assetCommit` | 素材来源提交（`--assets-ref` 解析出的完整 SHA） |
| `assetRef` / `assetSubpath` / `assetsDir` | 请求的 ref、仓库相对子路径、本次实际解出目录 |
| `evaluationCodeCommit` / `evaluationCodeRepo` | 跑评测的仓库 HEAD（与 `assetCommit` 不同不是错误） |
| `sourceVideoSha` / `fullCanvasSha` / `candidateSha` | 三臂实际会播放的字节 SHA |
| `manifestSha256` / `declared` / `checks` | manifest 字节 SHA、声明值、逐项是否一致 |
| `files[]` | 素材目录里每个文件的 `relative/bytes/sha256`（实测） |

每行 raw.ndjson 还带 `sourceSha256`，`summary.sources` 有三个臂的路径/字节数/SHA。
不读任何人的未提交工作区快照。`--src= --f-src= --c-src=` 仍可人工覆盖单文件（阶段门模式下
这类覆盖会被门禁拒绝，以 `STAGE-GATE.md` 为准）；给了本次
素材目录后**缺文件就报 missing，不回退到仓库里另一版本的 F/C**（避免 v1 字节混进 v2 数据）。

### C 的几何接线（负责人 830b7cb + 9dc035e，默认关闭）

`--roi-layout=on` 时工具给产品设：

```
# 只给 C 臂：
PET_NEXT_IDLE_ROI=1
PET_NEXT_IDLE_ROI_MANIFEST=<assetsDir>/manifest.json
PET_NEXT_IDLE_URL=<assetsDir>/C.webm

# O/F 臂：两个 ROI env 都不设（不是设 0）。sha 门比对的是 assets/idle.webm，
# 开着开关播 O 也会套上 ROI 盒，O 基线会“假失败”。
```

产品 `dist` 必须来自含接线的提交；工具在 `dist/electron/main.js`、`dist/contracts/idle-roi.js`、
`dist/app/page.js` 里找 `PET_NEXT_IDLE_ROI`，找不到就拒绝跑（避免把“文件裁过但没接线”的
C 当成采用候选）。`experiments/**` 永远不进 dist，不要去那里找接线。

### C 开跑前置（当前阻塞）

**硬规则：ROI 规则的 `object-fit` 必须是 `contain`。`none` 会把 226×286 按固有尺寸画进
113×143 的盒子（dpr=1 时等于 2× 裁切放大，只露左上角 1/4）；盒子与裁框同比例，`contain`
= `fill` = 按比例缩到 113×143，画面才与全画布重编码一致。** 违反时本工具判
`contentScalingOk=false` → `roi-layout-not-wired` → C 臂直接 notRun（不烧 3×60s）。
真实案例见 `runs/perf-3x60-v3-aborted-object-fit-none/`（接线第一次恢复成 `none`，启动后立即中断）。

负责人 HEAD `4b0b1f0` 的 `app/page.css` 里 ROI 规则仍是 `object-fit: none`：rect 与
`videoWidth/Height` 都会对，但 226×286 按固有尺寸画进 113×143 盒（2 倍大、右下溢出）。
本工具会因此判 `contentScalingOk=false` → `roi-layout-not-wired`。**等 `none → contain`
进 dist 再跑 C**，否则画面对照整轮要重跑（CPU 本身不受 object-fit 影响，但阶段门要求
布局+画面通过才认收益）。

C 开跑前还会轮询 `body.idle-roi === true && #clip.hidden === false && readyState>=2`
（最长 15s）；超时单独记 `roi-class-timeout`，与“接线错误”分开。布局被否决时**直接跳过
采样**（不烧 3×60s），只留 rect/objectFit/bodyIdleRoi 证据。`observedDpr` 也逐臂记录，
便于 125%/150% 复跑时区分 DIP 与物理像素。

**只比 rect 会漏判**（B 指出 830b7cb 的 `page.css` 是 `object-fit: none`）：盒子可以正好
是 104/56/113/143，但 226×286 的候选按原尺寸画进 113×143 盒 → 宠物 2 倍大并溢出。
所以 C 臂的 `roiLayoutWired` 同时要求三件事：

1. `rect` 与公式一致（容差 1.5 DIP）；
2. `videoWidth/Height === crop.width/height`（C 应为 226×286）；
3. `getComputedStyle(#clip).objectFit !== 'none'`，且 `body.idle-roi` 为真（稳态 idle）。

O/F 臂反向固定基线：`rect 0,0,320×240`、intrinsic `640×360`、`objectFit === 'contain'`；
不符即记失败，避免拿“被接线改坏的 O”去和 C 比。

C 臂真值（B 独立核对，scale 恒 0.5、窗口 frame:false + resizable:false，所以是精确值）：

| 量 | 期望 |
|---|---|
| `#clip` rect | `104 / 56 / 113 / 143` |
| `videoWidth/Height` | `226 / 286` |
| `objectFit` | `contain`（4b0b1f0 仍是 none，待修） |
| `body.idle-roi` | `true`（采样前置；否则 rect 是 0×0） |
| C 字节 | `08a80ac4…` 225952B；O=`6ebca6b2…` 78419B |

C 的**几何**收益依赖 B 的布局接线（契约第 4 节公式）。接线未落地时产品仍用
`object-fit: contain` 把裁剪后的视频铺满窗口——此时 C 只是“裁过的文件”，不是采用候选。
工具会在每支 C 臂上用页面 `getBoundingClientRect()` + `videoWidth/Height` 对照公式核对：

- `layout.roiLayoutWired=true` 才算接线生效；
- 未生效记 `roi-layout-not-wired`、`summary.verdict.pass=false`，并拒绝把该 CPU 数据当采用收益。

## 3. 命令

```bash
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
cd pet-next
# 显示号固定 :154（先起 Xvfb；脚本也会在探活失败时自起）
Xvfb :154 -screen 0 1920x1080x24 -nolisten tcp &

# 阶段一自检（60s 采样 + 8s 预热 + 10 次点击；素材从已提交 9dc035e 抽取）
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --mode=selfcheck --seconds=60 --warmup=8 \
  --probe=click --clicks=10 --assets-ref=9dc035e --display=:154

# 阶段二：完整三臂，3×60s，交替 O,F,C → C,F,O（产品 dist 必须含 830b7cb/9dc035e）
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --plan=O,F,C --reps=3 --seconds=60 --warmup=10 \
  --assets-ref=9dc035e --roi-layout=on --display=:154

# 阶段二：行为回归（每臂 ≥10 次点击、拖动、隐藏恢复、失败占位、退出）
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --mode=behavior --plan=O,F,C --seconds=0 --warmup=4 \
  --probe=click,drag,hidden,failure --clicks=12 --assets-ref=9dc035e --roi-layout=on --display=:154

# v2 素材（编码域裁剪）：显式 subpath；assetsDir = runs/<stamp>/assets-committed/experiments/idle-roi/out-v2
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --plan=O,F,C --seconds=60 --warmup=10 \
  --assets-ref=b9c2f61 --assets-subpath=experiments/idle-roi/out-v2 --display=:154

# 只复算已有目录（不启动 GUI）
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --mode=analyze --run=bench/idle-roi/runs/<stamp>

# 阶段门（lib/gate.mjs，任何 perf/behavior 采集都会先跑它）：
#   - 默认 subpath = experiments/idle-roi/out-v3-yuva（F3/C3）；--assets-subpath 可换
#   - assetsDir 由本次 stage 唯一决定，并用 resolveAssetsDir(dest, { subpath }) 精确复核
#   - report verdict.status 不是 passed / 任一臂 SHA 与报告不符 → exit 5；取素材失败 → exit 4
#   - 干跑只看门（不启动 Xvfb/Electron/build）：
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --mode=preflight \
  --assets-ref=07278fd --assets-subpath=experiments/idle-roi/out-v3-yuva --display=:157

# 素材入口回归（纯文件系统，不启动 Electron；含真实 out-v2 一次）
env -u NODE_OPTIONS node --test bench/idle-roi/test/artifacts.test.mjs
```

前置：`pnpm install` + `pnpm build`（脚本会按 `dist/electron/main.js` 的 mtime 自动补构建，
构建耗时单列在 `summary.build`，不混进任何臂的采样窗）。

## 4. 指标口径（可复算）

- **CPU**：归属进程树（electron main + 全部后代 renderer/gpu/utility/zygote/crashpad）
  的 `/proc/<pid>/stat` `utime+stime`（HZ=100）增量 ÷ 墙钟，报 **CPU 秒/分钟** 与百分比。
  进程树按 `/proc/<pid>/stat` 的 ppid 做 BFS，非“按名字猜”。
- **RSS**：`/proc/<pid>/status` `VmRSS` 求和——共享页重复计，不等于整机增量。
- **PSS**：`/proc/<pid>/smaps_rollup` `Pss` 求和（读不到写 `null`，不用 RSS 冒充）。
- **真实解码帧**：页面 `video.getVideoPlaybackQuality().totalVideoFrames` 的 1s 增量；
  另外记录 `droppedVideoFrames`、rVFC 计数与 `currentTime`，用来确认时间轴在走。
- **视频尺寸**：`videoWidth × videoHeight`（O=640×360；C 应为 ROI 宽高），并记 `rect`、
  `objectFit`、`body.idle-roi` 类，用来区分“几何接错”和“几何对但内容缩放错”。
- **首个回应软件时延**：合成点击（CDP Input）→ 注入观察器看到该请求的第一个 reaction
  呈帧（rVFC）。**软件呈帧证据，不是物理屏幕/物理输入延迟**；每次原始值与中位数都落盘。
- **主机负载**：每个样本都写 `/proc/loadavg`，summary 记各臂 1 分钟负载中位/最大值与
  起止绝对值。**本机 1 核共享，外部评测常把 load 拉到 10+，任何 CPU 数值必须连同 loadavg 解读。**
- **退出与残留**：Escape（产品既有退出键）→ 退出码；退出后扫 `/proc` 找带本轮 user-data
  标记的残留进程。
- **预热段**：`phase=warmup` 与 `phase=measure` 同文件但分列；summary 只用 measure。

## 5. 交替顺序

`--reps=3 --plan=O,F,C` 生成：`O,F,C`（rep0）→ `C,F,O`（rep1）→ `O,F,C`（rep2），
即 `O→F→C→C→F→O→O→F→C`，抵消单向漂移。每臂之间完整退出进程（不留 GUI 串行冲突）。

## 6. 产物

```
bench/idle-roi/runs/<stamp>/
  raw.ndjson                  # 每行一个 1s 样本（含 warmup/measure、CPU、RSS/PSS、帧、loadavg）
  summary.json                # 每臂聚合、配对、判定、素材 SHA、布局核对、失败/notRun
  arms/<arm>-r<rep>/
    product-stdout.log        # 产品原始输出（含 ready/bounds 事件）
    product-stderr.log
    probes.json               # 点击原始值/拖动/隐藏恢复/失败占位/退出
  assets-committed/<subpath>/ # --assets-ref 解出的已提交素材；目录由本次 subpath 决定（gitignore）
  arms/<arm>-r<rep>/user-data/  # 每臂临时 profile，gitignore
```

## 7. 判定（契约第 7 节，机械复算在 `lib/stats.mjs`）

主判据是 CPU，不是 ZIP 大小/回调数/可见面积：

| 条件 | 阈值 |
|---|---|
| C 对 O | `cpuSecondsPerMinute` 中位 ≥ 15% 下降 |
| C 对 F | 同向（C 更低），且 ≥2/3 配对支持 |
| RSS | C 中位 ≤ O × 1.10 |
| 负载 | O/C 臂 loadavg1 中位差 ≤2；超出即标“无法与负载波动分离” |

任一不满足 → `verdict.pass=false`，`reasons` 写明哪条。工程门，**不声称统计显著**。
C 布局未接线时额外否决（见第 2 节）。

## 8. 已知边界（不夸大）

- **Windows not-run**：本工具依赖 `/proc` 与 X11；Windows 收益未验证，需另跑
  `pnpm verify:windows` 与 Windows 侧采样，Linux 数值不能替代。
- **可见纯 idle**：主资源测量不做隐藏态混入；`--probe=hidden` 只记录隐藏/恢复行为事实
  （示例里 unmap 后 `visibilityState` 仍为 visible，说明 Xvfb 无 WM 时该信号不可靠，
  原样落盘而不是猜测）。
- **失败占位**：`--probe=failure` 复制一份 idle 副本、删除副本、用该路径启动产品，
  观察产品既有失败/占位语义；不改任何开关，也不把失败吞掉。
- **单核共享**：所有臂串行；同一时刻只允许一个 bench（`runs/.lock`）。
- **数据来源**：结论只认 `summary.json.sources` 里 SHA 对应的已提交字节，不用未提交
  工作区快照。
- **体积/面积/重编码都不能当 CPU 收益**（A 的硬数据）：C 225952B > F 188075B > O 78419B，
  C 是 O 的 2.88 倍；像素面积保留 64636/230400 = 28.05% 只是名义值；C 的 `alpha>1`
  前景比 O 裁框内少 3448 px（-0.177%），所以 **C-O 含“重编码损失 + 几何裁剪”两部分**。
- **C-F 的口径要分开说**（A 更正）：CPU 口径下 C-F 隔离的是**几何面积**（解码 226×286 vs
  640×360）；但 v1 的 C-F **像素差不是零误差基线**——它含“226 宽区域独立做 RGB→420
  色度下采样”的路径差异（α 与 Y 平面逐位相同，差在 B 通道主导的色度），真正的编码域
  裁剪（f-to-c=max 0）才是纯几何。不要拿 v1 的 C-F 当零误差参照。
- **画质门状态（A 报给负责人，D 只记录不裁决）**：f-to-c 在 4:2:0 下结构不可达
  （max 6、B 通道主导），o-to-c 与裁剪无关（O vs F 与 O vs C 误差相同），只能上
  444+alpha。若负责人据此停止 ROI 接线，本 bench 不再投 3×60s；已提交的 `out/` 字节
  （da02255，SHA 与 9dc035e 一致）保持可复跑。
- **alpha 形态**：C 带 `alpha_mode=1`，ffprobe 容器仍报 `pix_fmt=yuv420p`，属 VP9 alpha
  正常形态；`colorTags` 三臂一致（`unknown/unknown/bt709/tv`），不是异常。

## 9. 阶段一自检结果（2026-11-10，`selfcheck-O-committed-20261110-162352`）

工具自证，**不是产品结论**（只有 O 臂，无 F/C 对照）。素材用
`git archive 9dc035e` 抽取，O=`out/O.webm` SHA `6ebca6b2…`（78419B，与
`assets/idle.webm` 同字节，`provenance.sourceVideoMatchesShipped=true`）；F/C 的 SHA 也一并记录
（F `2ca492a9…` 188075B、C `08a80ac4…` 225952B），但**本轮未运行**它们。
A 的提交 `da02255` 与负责人集成提交 `9dc035e` 的三臂字节逐字节相同（已用两棵
`git archive` 各算一次 SHA 验证）。

- O 臂 60 个 measure 样本（预热 8 个单列），窗口 63.63s：
  **3.413 CPU 秒/分钟**（中位 5.9%，P90 6.9%），RSS 求和 379.12MB（最大 379.93）、PSS 190.58MB；
  真实解码 1522 帧 / 63.63s = **23.92 fps**，intrinsic 640×360、
  rect 0,0,320,240、`objectFit=contain`、`body.idle-roi=false`（O 必须走原路径）。
- 同期 `/proc/loadavg` 1 分钟中位 **14.2**（起 15.16 → 止 14.04），主机 CPU busy 中位 3.6%。
  该 CPU 数值只能与 loadavg 一起读，不能与空闲机器的历史数字横比。
- 10 次合成点击：10/10 有回应、0 漏；软件首回应中位 **87.85ms**
  （原始 80/81/87/88/95/93/92/**798**/79/88；798ms 那条落在 loadavg 15–16 的窗口内，
  原样保留不剔除），每次点击后均回到 idle。
- 读到产品 `{"event":"ready"}`（transparent=true，bounds 320×240 @80,80，scaleFactor=1）；
  Escape 退出码 0，退出后残留进程 0；构建 up-to-date；electron v43.3.0。
- 产品源码改动 0（`productDirtyFiles=0`，只算 `app/electron/core/adapters/contracts/scripts/package.json`）；
  `dirtyFiles=3` 是本 bench 工具自身当时的未提交改动。
- 说明：`steadyState` / `observedDpr` / `sourceShaVerified` / `build.distCss` 是这份自检
  之后加的（已用 3s 短跑验证：dpr=1、稳定态仅在 C 臂等待、SHA 校验仅在 manifest 存在时
  执行、`dist/app/page.css` 与源同 SHA 且含 `object-fit: contain`），所以不在这份历史
  summary 里；下一次真实三臂会带上。

### 9.1 仪器自身修复项（不藏在 diff 里）

- **ROI env 曾全局注入（已修）**：早期版本 `--roi-layout=on` 会给全部三臂设
  `PET_NEXT_IDLE_ROI*`。sha 门比对的是 `assets/idle.webm`，所以 O/F 也会被套上 ROI 盒，
  O 的 rect 会从 `0,0,320,240` 变成 `104,56,113,143`，O 基线“假失败”、整轮数据不可用。
  现在只有 `arm === 'C'` 注入，且逐臂记 `roiEnvApplied`。**用旧版跑出的三臂数据一律作废。**
- **只比 rect 会漏判（已修）**：`object-fit:none` 时 rect 与 intrinsic 都对但画面 2 倍大；
  现在 C 与 O/F 都要求 `objectFit === 'contain'`（全等，不是“非 none”）。
- **dist 可能是旧的（已加证据）**：`build.distCss` 记录 `dist/app/page.css` 与源
  `app/page.css` 的 SHA 是否相同（`copy-static` 原样复制，不同即未重建），并抓出
  `object-fit` 行号与文本，避免把旧 dist 的 `none` 误判成“没接线”。
- **只在元素上查 computed style 也不够（已加文本层预检）**：ROI 规则整块被删时，
  `#clip` 会退回默认 `contain` 而“碰巧通过”。`build.distCss` 另记
  `roiRulePresent` / `roiRuleObjectFitContain` / `objectFitNoneLines` / `preflightWarnings`：
  dfeca20 基线是“无 `body.idle-roi` 规则块”（正常）；接线落地后应出现该规则且其
  `object-fit: contain`，最终判定仍以运行时 computed style 为准。
- **同 dest 的 v1/v2 会选错臂（已修，R1-A）**：原实现 stage 成功后用 `resolveAssetsDir(dest)`
  遍历一级子目录找 manifest，同 dest 先 `out` 后 `out-v2` 会选回旧 `out/`（Codex smoke 复现：
  `ok=true` 但 candidateSha 是 v1 的 `08a80ac4…`）。现在 assetsDir = `<dest>/<subpath>` 由本次
  调用唯一决定；只有无显式 subpath 才扫描，且 ≥2 个候选报 `ambiguous-assets-dir` 而不是猜。
- **非法/空路径曾经返回 ok（已修，R1-A）**：`../README.md` 原实现 `ok=true` 且零素材（git
  规范化到仓库根 README）。现在 `..`/绝对/盘符/反斜杠/通配一律 `invalid-subpath`；子路径没有
  manifest/O/F/C 或实测 SHA 与声明不符都非零失败，空产物不得 `ok`。
- **provenance 曾残留 v1 字段（已修，R1-A）**：`summary.provenance` 改为 `schemaVersion: 2`，
  `assetCommit`/`evaluationCodeCommit`/`sourceVideoSha`/`candidateSha`/`manifestSha256` 与
  `files[].sha256` 全部从实际取出的文件重算（字段表见第 2 节）。
- **阶段门合并（R1-A + D）**：D 的 `lib/gate.mjs` 与 A 的精确 staging 合入同一条路径——
  `assetsDir` 只来自本次 `stageCommittedAssets` 的返回值（`--assets-dir` 时来自唯一候选扫描 +
  `verifyAssetsDir`），门再用 `resolveAssetsDir(dest, { subpath })` 精确复核；v3 的
  `F3.webm`/`C3.webm` 走臂名映射表，`namingOnlyFailure` 不放行 SHA。
- 工具覆盖已自证：已提交字节抽取与 SHA 记账、进程树 CPU/RSS/PSS、真实解码帧与视频尺寸、
  10 次点击原始值、loadavg、ready/退出码/残留、warmup/measure 分列、raw.ndjson + summary.json。

**仍缺的指标（明确列出，不假装有）**：进程内线程级 CPU（目前只到进程级）；GPU 时间/频率
（不能动 GPU 参数，只能看 gpu-process CPU）；软解/硬解归属；隐藏态暂停开关开启后的收益
（本轮不混入可见 idle）；>10 分钟的热漂移/内存增长；100/125/150 真实缩放下 D 侧资源数据
（画质门有跑，资源侧未跑）；Windows 全部 not-run。

## 10. 红线

零真实模型 POST（环境里主动删掉所有 chat/Qwen/SSH 变量）；不访问 18872；不动 GPU/模型参数；
不改默认开关；不把候选带入默认便携包；只提交 `bench/idle-roi/**`。
