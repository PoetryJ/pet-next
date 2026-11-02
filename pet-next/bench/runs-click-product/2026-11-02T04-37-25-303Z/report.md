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

- 正控（可用素材 short.webm ×3）：回应观测 3/3，回应 P50 307.70 ms，endState 分布 {"response-observed":3}。
- 负控（损坏素材 ×3）：回应观测 0/3（应为 0），endState 分布 {"load-failed":3}。
- 关键帧截图证据：`evidence/`（对照组每个样本在首帧与回应时刻各一张）。

## 主臂（每臂 not-run）

- 本次未跑主臂（`--controls-only`）。

## 未证明 / 口径外

- 物理输入设备与物理屏幕呈现延迟未测量（软件输入 + 软件呈帧证据口径）。
- 姿态（画面内容）核实仅限对照组关键帧截图（evidence/），主臂只依据 rVFC mediaTime 判据。
- 呈帧 mediaTime 由 Chromium 报告；丢帧时观测帧号可能大于目标帧号（样本内如实记录）。
