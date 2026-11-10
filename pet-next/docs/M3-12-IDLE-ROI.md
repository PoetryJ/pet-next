# M3-12 契约：可见待机素材裁边（默认关闭，先画质后性能）

基线 `dfeca20`。分支 `codex/pet-next-m3-idle-roi`。本文件由负责人冻结，任何人不得擅自改字段/阈值/公式；
实现与实测有冲突时先报负责人，不得让断言适配结果。

## 1. 范围

- 只对 `assets/idle.webm` 生成候选；`short.webm`、`reaction.webm`、`placeholder.png` **字节不动**、路径不动。
- 候选默认关闭：关闭时页面走原路径（`assets/idle.webm`、全窗口 contain），零新增 timers/监听。
- 不新增运行时依赖（无 Canvas/WebGL/PixiJS/AIRI），不做每帧像素读回，不加第二个播放器。
- 不称"无损"。阈值固定 `1`（仅 `alpha<=1` 置零），不得提高；不得抠黑、不降帧率/分辨率、不逐帧裁框。

## 2. 三臂定义（A 产出，C 验证，D 测量）

| 臂 | 定义 |
|---|---|
| O | `assets/idle.webm` 原字节（不重编码），`O.sha256 = sourceSha` |
| F | 全片 `alpha<=1 → 0` 预处理后，**全画布 640x360** 重编码；与 C 同一次预处理、同一编码参数、同一色彩标签与 PTS |
| C | 与 F 完全相同的预处理/编码/色彩/PTS，**仅多 ROI 裁剪**（编码分辨率 = ROI 宽高，偶数对齐） |

C-F 隔离几何裁剪；C-O 是实际采用收益。F 变好不等于 ROI 成立。

## 3. manifest（`experiments/idle-roi/out/manifest.json`）

```jsonc
{
  "schemaVersion": 1,
  "kind": "idle-roi",
  "sourcePath": "assets/idle.webm",
  "sourceSha256": "<64 hex>",
  "candidateSha256": "<64 hex>",
  "originalCanvas": { "width": 640, "height": 360 },
  "crop": { "x": 208, "y": 52, "width": 226, "height": 286 },
  "alphaThreshold": 1,
  "guard": 2,
  "codec": "vp9",
  "pixelFormat": "yuva420p",
  "colorTags": { "primaries": "bt709", "transfer": "bt709", "matrix": "bt709", "range": "tv" },
  "frameCount": 48,
  "pts": { "count": 48, "firstMs": 0, "lastMs": 1958.333, "stepMs": 41.667, "minDeltaMs": 41.667, "maxDeltaMs": 41.667 },
  "durationMs": 1999,
  "loopFrames": 48,
  "generatedBy": "node experiments/idle-roi/compiler.mjs --out=experiments/idle-roi/out",
  "ffmpeg": "ffmpeg version 8.0.1 ...",
  "builtAt": "2026-11-10T…Z"
}
```

`pts` 是逐帧 PTS 的摘要（必须来自实际解码回读，不是命令行假设）；`durationMs` 允许 ≤1ms 的时间基舍入误差。
`crop` 必须由**全片**并集得到、向外留 `guard=2` 像素、宽高与 x/y 按偶数对齐（yuva420p 色度单位）。

## 4. 纯布局公式（沿用 contain，B 实现）

```
s = min(viewW / origW, viewH / origH)
left = (viewW - origW * s) / 2 + crop.x * s
top  = (viewH - origH * s) / 2 + crop.y * s
size = (crop.width * s, crop.height * s)
```

- 320×240 视口下本候选必须是 `left=104, top=56, width=113, height=143`（负责人已手算，B 单测必须钉住）。
- CSS 值直接用 DIP，**不得再乘 DPR**；窗口尺寸、`#pet` 命中区域、聊天面板、拖动/点击语义不变。
- 无效 manifest（缺字段、NaN、crop 越界、crop 宽高 ≤0、sha 不匹配）→ 返回 `null`，调用方回原片。

## 5. 接线语义（B 出建议 + 负责人落公共文件）

- 仅当 `selection === 'idle'` 且 manifest 有效且开关打开时使用 ROI；`short`/`reaction`/`placeholder` 永远原布局。
- 切换 idle→short→idle、失败占位、隐藏恢复后必须回到对应布局：**不得把旧素材的 metadata 套到新素材**，
  继续复用现有代际隔离（`requestId`/`playToken` 语义），不新增第二播放器。
- 加载失败沿用现有失败/占位语义，不吞错误。

## 6. 画质门（C，全 48 帧，不允许抽样）

| 门 | 判据 |
|---|---|
| 全片覆盖 | 48/48 帧解码；ROI 外 `alpha>1` 被删除像素数 = 0 |
| 时间轴 | 帧数相同；逐帧 PTS 一一对应；duration 差 ≤1ms；循环不增删帧 |
| F–C | C 按 crop 偏移还原到 640×360 后，与 F 原画布合成，每通道最大差 ≤2/255 |
| O–C | 前景（alpha>1）与边缘区域合成 MAE ≤1/255、P99 ≤2/255；黑/白/棋盘三种底分别过门 |
| 人工 | 关键边缘与深色区域无裁断/变形/位移 |
| 负控 | 「裁入前景」与「偏移 1 DIP」必须被门拒绝（否则测试无效）|
| 缩放 | 真实 Electron 100/125/150 各验一次；模拟缩放与系统 DPI 分别标注，未知即 not-run |

## 7. 性能门（D，画质过门后才跑）

- 同机同窗口同可见状态，O/F/C 交替各 3×60s；预热段单列；其他 agent 停止编码与测试。
- 指标：归属进程树 CPU 秒/分钟、RSS、真实解码帧、视频尺寸、构建与文件成本、主机负载（loadavg 必须记录）。
- 主判据：**CPU**。C 对 O 中位至少低 15%，C 对 F 方向一致且 ≥2/3 配对支持，且不能被负载解释；RSS 增幅 ≤10%。
- 行为回归：idle→short→idle、连续点击/拖动、隐藏恢复、失败占位、退出；每臂 ≥10 次点击取中位/原始值，
  C 相对 O 首回应中位退化 ≤ 一帧（≈42ms），不漏回应、不位置跳动。软件首回应 ≠ 物理帧。
- 少回调、小 ZIP、小面积都不能顶替 CPU 数据；不宣称统计显著。

## 8. 停止条件

画质门不过、位置/时间轴漂移、只有 F 变好、CPU 收益不稳、维护成本过高 → 停止并保留负结果；
若只有 F 有价值，先报告，不自行转正。Windows 缺环境记 not-run 并交一条命令。

## 9. 文件分工

| 角色 | 独占路径 |
|---|---|
| A | `experiments/idle-roi/compiler*`、`experiments/idle-roi/lib/**`、`experiments/idle-roi/out/**` |
| B | `experiments/idle-roi/layout*`、`experiments/idle-roi/adapter*` 及其单测 |
| C | `tests/idle-roi/**` |
| D | `bench/idle-roi/**` |
| 负责人 | `package.json`、`tsconfig*`、`docs/**`、`app/**`、`electron/**`、`contracts/**`、`assets-pipeline/**` |

跨角色需要改文件时，提 diff 给负责人，不抢路径。所有提交只含自己路径；不 push、不 reset/clean、不改默认开关。
