# 产品真实回应观测（runs-click-product）

在真实产品页（preview=bench-observe，不开行为，pointer 点击路径与验收一致）观测点击到回应的过程。
与 bench/click.ts 的 bench 测量页报告分列：本报告的回应时间是观测值，不再是"首帧+素材常数"的估算。

## 口径

- 输入：`webContents.sendInputEvent` 合成点击（软件输入）；t0 = 产品页 pointerdown 时刻。
- 呈帧证据：产品页 video 的 rVFC 元数据（软件呈帧）；不含物理输入设备与物理屏幕呈现延迟。
- 回应判据（可复算）：固定素材 sha256 + 固定帧号，首个 `mediaTime ≥ onsetFrame/fps` 的呈帧记为回应观测；
  onset 帧由 assets-pipeline/response-onset.ts 逐帧运动规则离线测得（素材内常数）。
- 未到目标帧 / 装载失败 / 取消 / 被新输入取代 / 旧请求帧：一律不计成功（记 null + endState）。
- 事件来源：产品 bench-observe 打点（bench-click/bench-media）+ bench 注入观察器（bench-input/bench-frame，
  injected:true；产品侧接线同名事件后自动优先产品版）。

## 素材（素材内回应时刻 = 估算输入，非产品观察）

| 素材 | sha256 | fps | 回应帧 | 回应时刻 |
| --- | --- | --- | --- | --- |
| 全母带 source.webm | `48cd729ccdcf…` | 24 | #59 | 2458.3 ms |
| 截取短片 short.webm | `3781ac8068ce…` | 24 | #6 | 250.0 ms |

## 对照组（观测链验证）

- 本次未运行对照组（`--arms-only`）；观测链对照验证见 `runs-click-product/2026-11-02T04-37-25-303Z`（正控 short.webm 3/3 精确命中回应帧 #6，P50 307.7ms；负控损坏素材 3/3 load-failed 全 null；关键帧截图在该目录 evidence/）。

## 主臂（每臂 3 轮 × 30 样本）

| 臂 | 样本 | 回应观测成功 | 输入→play 兑现 P50/P95（实测） | 输入→首帧 P50/P95（实测） | 输入→回应帧 P50/P95（实测） | 首帧+素材onset（估算对照列） |
| --- | --- | --- | --- | --- | --- | --- |
| `single-full` | 90 | 90/90 | 72.90/80.30 | 80.10/87.50 | 2530.70/2542.50 | 2538.43 |
| `single-short` | 90 | 90/90 | 76.10/81.30 | 82.70/87.40 | 316.80/337.40 | 332.70 |

分列说明：
- 实测首帧 = 输入→回应素材首个 rVFC 呈帧。
- 素材运动起点 = 上表素材内回应时刻（离线逐帧规则常数，估算输入）。
- 真实回应观测 = 输入→目标回应帧（mediaTime 判据）；"估算对照列"与它的差值即呈现/解码偏差。

## 未证明 / 口径外

- 物理输入设备与物理屏幕呈现延迟未测量（软件输入 + 软件呈帧证据口径）。
- 姿态（画面内容）核实仅限对照组关键帧截图（evidence/），主臂只依据 rVFC mediaTime 判据。
- 呈帧 mediaTime 由 Chromium 报告；丢帧时观测帧号可能大于目标帧号（样本内如实记录）。
