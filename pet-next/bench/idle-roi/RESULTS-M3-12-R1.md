# M3-12 R1 D：三臂 O / F3 / C3 实测结果（原生 YUVA + ROI 裁边）

**一句话结论：画质门通过，资源门不通过——C3 对 O 没有 CPU 收益，停在离线结果，不恢复产品接线、不转正。**
默认开关与 main 一行未动；本轮只提交 `bench/idle-roi/**` 的测量工具与证据。

## 1. 口径（与 TASKS 第 D 节一致）

- 三臂：O = 原片（`out-v3-yuva/O.webm`，与 `assets/idle.webm` 同字节 `6ebca6b2…`）；
  F3 = 全画布重编码 `08afc852…`；C3 = ROI 裁剪 `195ae6aa…`（= `manifest.candidateSha256`）。
- 每臂 3×60s，预热 10s 单列不入均值；顺序交替 O→F3→C3→C3→F3→O→O→F3→C3。
- 同一产品入口、同窗口 320×240、可见纯 idle、无聊天/无 SSH 注入；只有 C3 臂多两个
  ROI env（`PET_NEXT_IDLE_ROI=1` + `PET_NEXT_IDLE_ROI_MANIFEST=<staged>/manifest.json`），
  O/F3 臂该 env 不存在（`roiEnvApplied.enabled=false`，不是设 0）。
- 产品根：隔离实验 worktree `m312r1-wt-perf/pet-next` @ **736fe65**（v3 提交 `07278fd` +
  恢复默认关闭接线 + `object-fit: contain` 修复）；`dist` up-to-date、`matchesSource=true`。
- 素材：`--assets-ref=07278fd --assets-subpath=experiments/idle-roi/out-v3-yuva`，由阶段门
  精确取到 `<dest>/out-v3-yuva` 并逐臂核 SHA。
- **质量报告 pin**：提交 **`a1cd1fb`**（`git show a1cd1fb:pet-next/tests/idle-roi/out/quality-report.json`，
  sha256 `62777d44e38a886d48c8fc1f7d67149c477d1c5871f8958c2008ff32a33071bd`），
  `verdict.status=passed`、subject=f3c3、`verdict.candidates.pass=true`、
  `prerequisites=[yuva-selfcontrol passed]`；门在启动前判定 `ok=true`（`gate.json`）。

## 2. 性能（CPU / RSS / 解码）

| 臂 | CPU s/min（r0/r1/r2） | 中位 | CPU% 中位 | RSS 中位 MB | PSS（r0/r1/r2） | 解码 fps | loadavg1 中位（三值） |
|---|---|---|---|---|---|---|---|
| O | 3.373 / 3.362 / 3.405 | **3.373** | 5.85–5.90 | 378.87 | 189.2 / 189.9 / 188.8 | 23.98 | 17.98（22.12 / 17.98 / 15.60） |
| F3 | 4.775 / 4.390 / 4.623 | **4.623** | 6.9–7.9 | 380.75 | 192.0 / 192.5 / 190.1 | 23.94 | 15.65（15.65 / 27.01 / 15.59） |
| C3 | 3.737 / 3.491 / 3.680 | **3.680** | 5.90 | 374.49 | 186.1 / 185.0 / 186.5 | 23.93–23.94 | 18.60（13.22 / 30.64 / 18.60） |

视频尺寸（页面实测）：O/F3 = 640×360、rect 0,0,320,240；C3 = 226×286、rect 104,56,113,143、
`object-fit: contain`、`body.idle-roi=true`。三臂解码 fps 均 ≈23.94–23.99（24fps 视频，掉帧 <0.3%）。

配对（逐 rep 下降百分比，正数=C 更省）：

| rep | C vs O | C vs F3 |
|---|---|---|
| r0 | −10.79% | +21.74% |
| r1 | −3.84% | +20.48% |
| r2 | −8.08% | +20.40% |

### 门判定（机械复算，见 `summary.json` 的 `verdict`）

| 门 | 结果 |
|---|---|
| C 对 O CPU 中位下降 ≥15% | **FAIL**（−9.1%） |
| C 对 F 同向下降 | PASS（C 比 F3 低 20.4%） |
| 配对支持 ≥2/3（C 对 O） | **FAIL**（0/3） |
| RSS ≤ +10% | PASS（−1.16%；PSS 约 −1.5%） |
| O/C loadavg1 中位差 ≤2 | PASS（+0.62） |
| **综合** | **pass=false** |

### 噪声声明（必须与上面数字一起读）

- 开跑时 `loadavg1=19.02`，全程 **15–31**（共享 1 核 + 外部评测），单轮 CPU 差异量级约 **±10%**。
- 因此本轮**不宣称任何方向**：既不说"C3 更省"，也不把 −9.1% 当成稳定的"更费"；
  能说的只有"**在 15% 门槛下看不到收益**"，以及"F3→C3 的相对节省（约 20%）远不足以抵消重编码代价"。
- 结论不依赖挑轮次：三对配对同向，但没有达到门槛；按纪律不为过门重跑或剔轮。

## 3. 行为 / 布局 / 响应（`--mode=behavior`，`--seconds=0`）

behavior 轮**不采 CPU**，判定是功能性的（`verdict.kind = "behavioral"`，逐臂汇总在 `behaviorPerArm`）：

| 臂 | 布局 | 点击中位（10 次/rep） | 退出码 | 残留 | 隐藏恢复 | 失败占位 |
|---|---|---|---|---|---|---|
| O | contain、640×360、rect 0,0,320,240（2 rep） | 89.45ms（88.35 / 90.55） | 0 | 0 | 回 idle | 可见 |
| F3 | 同上（3 rep） | 90.25ms（89.75 / 93.55 / 90.25） | 0 | 0 | 回 idle | 可见 |
| C3 | ROI 接线生效：226×286、rect 104,56,113,143、rectDelta 全 0、contain、`body.idle-roi`（3 rep） | 91.70ms（91.70 / 92.10 / 91.45） | 0 | 0 | 回 idle | 可见 |

- 首回应：C3 − O = **+2.25ms**，C3 − F3 = +1.45ms；一帧 = 41.7ms → **退化远小于一帧**。
- 隐藏恢复后首帧 1.1–29.9ms 回到 idle；拖动 80,80→140,80（dx=60）、`draggingClass` 清空；
  失败占位：placeholder 可见、idle video hidden+paused、拷贝文件 sha 与该臂字节相同且已删除。
- **一处采集侧抖动**：`O#2` 在 loadavg≈13 时 45s 内未进入可播放状态（观察器注入报错），
  该臂无探针数据，记入 `verdict.incompleteArms`，**不补跑、不计入 pass**。
- 零真实模型请求：perf/behavior 的 product stdout/stderr 中无 `POST`/`api.`/`18872`/`qwen` 痕迹。

## 4. 素材体积（绝对字节 + 倍数，相对 O）

| 文件 | 字节 | 倍数 |
|---|---|---|
| O.webm | 78,419 | 1.00× |
| F3.webm | 625,108 | 7.97× |
| C3.webm | 631,169 | 8.05× |

C3 比 F3 还大 1.4%：裁边省的是像素，不省字节；这份体积差必须与 CPU 结果一起看。

## 5. 证据位置（都在 `bench/idle-roi/runs/`）

- `perf-3x60-v3-736fe65/{summary.json, summary.pre-finalize.json, raw.ndjson, console.txt, gate.json}`
- `behavior-v3-736fe65/{summary.json, summary.pre-finalize.json, raw.ndjson, console.txt, gate.json}`
- `gate-perf-precheck-736fe65/gate.json`：运行前门判定（报告 pin + 三臂 SHA）。
- `perf-3x60-v3-aborted-object-fit-none/`：**失败证据**——第一次启动时 C 臂接线是
  `object-fit: none`，会在 dpr=1 下把 226×286 画进 113×143 盒（2× 裁切放大），
  门会判 `roi-layout-not-wired`，因此在 arm 1 主动中断、未保留采样。
- `run.mjs --mode=finalize --run=<stamp>`：用已有逐臂数据重算 `perArm`/`verdict`（不重启产品）。
  本轮用它纠正了 `perArm` 与 `verdict` 的 CPU 键名错位，并把 behavior 轮改成功能性判定；
  原始 summary 保留为 `summary.pre-finalize.json`。

## 6. 本轮明确 not-run

- >10 分钟热漂移 / 内存增长；GPU 时间与频率；软解/硬解归属；
- 100/125/150 真实缩放下 D 侧资源数据（只有画质侧覆盖）；
- Windows 全部；隐藏态暂停开关的收益（本轮只测可见 idle）；
- 把 500/1000Hz 鼠标当视频资源验收目标（TASKS 明确禁止）。

## 7. 复跑

```bash
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
cd <D worktree>/pet-next
export PET_NEXT_BENCH_ROOT=/data3/DATA/project/project_meishijiang/m312r1-wt-perf/pet-next
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --mode=preflight \
  --assets-ref=07278fd --assets-subpath=experiments/idle-roi/out-v3-yuva \
  --quality-report-ref=a1cd1fb --display=:157
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --mode=perf --plan=O,F3,C3 \
  --reps=3 --seconds=60 --warmup=10 --roi-layout=on \
  --assets-ref=07278fd --assets-subpath=experiments/idle-roi/out-v3-yuva \
  --quality-report-ref=a1cd1fb --display=:157
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --mode=behavior --plan=O,F3,C3 --seconds=0 \
  --probe=click,drag,hidden,failure --clicks=10 --roi-layout=on \
  --assets-ref=07278fd --assets-subpath=experiments/idle-roi/out-v3-yuva \
  --quality-report-ref=a1cd1fb --display=:157
```
