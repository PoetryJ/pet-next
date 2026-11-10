# M3-12 D：可见待机三臂（O/F/C）资源与行为对照

本目录只做**测量**：三臂跑同一条产品入口、同一窗口、同一可见状态，唯一差别是
`PET_NEXT_IDLE_URL`（`electron/main.ts:248` 已有的查询注入）指向的 idle 文件。
不改产品代码、不改默认开关、不建 SSH 隧道、不挂聊天，因此没有真实模型请求路径。

## 1. 两阶段纪律

| 阶段 | 何时 | 跑什么 |
|---|---|---|
| 一（现在） | 工具就绪即可 | `--mode=selfcheck`：只跑 O，证明 /proc 计量、真实解码帧、点击时延、退出/残留都可用 |
| 二（等负责人通知） | A 的产物过 C 画质门 + 负责人说“可以跑性能” | `--plan=O,F,C --reps=3`，以及其他 agent 停编码/停测试后执行 |

阶段一**不跑 F/C**；F/C 缺失时默认直接失败（`--allow-missing` 才会降级并标 notRun），
避免“只跑 O 却看起来像做了对照”。

## 2. 三臂定义与素材路径

| 臂 | idle 源 | 说明 |
|---|---|---|
| O | `assets/idle.webm` | 原字节；有 manifest 时必须等于 `sourceSha256` |
| F | `experiments/idle-roi/out/F.webm` | A 的全画布重编码；也接受 `full.webm` / `F-full.webm` |
| C | `experiments/idle-roi/out/C.webm` | A 的 ROI 裁剪；也接受 `roi.webm` / `C-roi.webm` |

路径都可用 `--src= --f-src= --c-src=` 覆盖；实际使用路径与 SHA-256 写在
`summary.json.sources`。SHA 与 manifest 不符时该臂记 `sha-mismatch` 并**不产生**可用数据。

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

# 阶段一自检（60s 采样 + 8s 预热 + 10 次点击）
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --mode=selfcheck --seconds=60 --warmup=8 \
  --probe=click --clicks=10 --display=:154

# 阶段二：完整三臂，3×60s，交替 O,F,C → C,F,O
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --plan=O,F,C --reps=3 --seconds=60 --warmup=10 --display=:154

# 阶段二：行为回归（每臂 ≥10 次点击、拖动、隐藏恢复、失败占位、退出）
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --mode=behavior --plan=O,F,C --seconds=0 --warmup=4 \
  --probe=click,drag,hidden,failure --clicks=12 --display=:154

# 只复算已有目录（不启动 GUI）
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --mode=analyze --run=bench/idle-roi/runs/<stamp>
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
- **视频尺寸**：`videoWidth × videoHeight`（O=640×360；C 应为 ROI 宽高）。
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

## 9. 阶段一自检结果（2026-11-10，`selfcheck-O-20261110-160704`）

工具自证，**不是产品结论**（只有 O 臂，无 F/C 对照）：

- O 臂 60 个 measure 样本（预热 8 个单列），窗口 62.96s：
  **3.612 CPU 秒/分钟**（中位 5.9%，P90 6.97%），RSS 求和 378.7MB、PSS 191.9MB；
  真实解码帧 1510 / 62.96s = **23.98 fps**，视频 640×360（O 原片，SHA `6ebca6b2…`）。
- 同期 `/proc/loadavg` 1 分钟中位 **15.59**（起 16.05 → 止 16.06），主机 CPU busy 中位 3.1%。
  高负载下该 CPU 数值只能与 loadavg 一起读，不能与空闲机器上的历史数字横比。
- 10 次合成点击：10/10 有回应、0 漏；软件首回应中位 **95.5ms**
  （原始 98/118/130/95/88/80/88/94/**542**/96；542ms 那条与当轮 loadavg≈16 的抖动一致，
  不替它找理由，原样保留），每次点击后均回到 idle。
- Escape 退出码 0，退出后残留进程 0；构建 up-to-date；electron v43.3.0；
  HEAD `dfeca20`（数据来自该提交字节；运行时 `dirty=1` 是本目录当时尚未提交）。
- 当轮没有 `experiments/idle-roi/out/manifest.json`，所以 `layout` 为空、F/C 标为缺失——
  这是阶段一的预期状态，不是 F/C 结论。
- 工具覆盖已自证：进程树 CPU/RSS/PSS、真实解码帧与视频尺寸、10 次点击原始值、
  loadavg、退出码与残留、warmup/measure 分列、raw.ndjson + summary.json 落盘。

## 10. 红线

零真实模型 POST（环境里主动删掉所有 chat/Qwen/SSH 变量）；不访问 18872；不动 GPU/模型参数；
不改默认开关；不把候选带入默认便携包；只提交 `bench/idle-roi/**`。
