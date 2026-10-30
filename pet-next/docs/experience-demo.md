# 桌宠体验：一条命令、截取短片与实测数据

这一页只回答三件事：怎么打开看、看什么、实测数字是多少。实现细节在
[`docs/preview.md`](preview.md)（预览令牌）、[`docs/experience-report.md`](experience-report.md)（上一轮验收结论）。

## 一条命令

```bash
pnpm demo                                   # 构建后按日常节奏启动（成品素材）
pnpm demo:record                            # 演示节奏 + 截取短片 + 自动跑一遍并留证（Linux/X11）
node scripts/demo.mjs --demo --asset=short --scale=1.25   # 任意组合
```

| 参数 | 作用 |
| --- | --- |
| 默认 | 日常节奏：自主动作 45s–15min，点击回应后用日常节奏接着待机 |
| `--demo` | 演示节奏：自主动作冷却 1.6s，方便一次看完 |
| `--asset=master` | 成品 `assets/reaction.webm`（全母带） |
| `--asset=candidate` | 候选副本 `assets/candidates/reaction/reaction.webm`（字节同母带） |
| `--asset=short` | 截取短片 `assets/candidates/reaction/short.webm`（母带 53–158 帧，回应 0.25s 即现） |
| `--scale=1.25` | 用 `--force-device-scale-factor` 模拟系统缩放，仅做对照 |
| `--record` | 自动序列：激活→点击→连点×3→拖动→等自主动作→失败注入（F）→恢复，打印 visual 序列 |
| `--keep-alive` | 不自动退出，等 Ctrl-C |

素材选择走已冻结的预览令牌 `PET_NEXT_PREVIEW`，不改写成品字节；`--record` 额外置
`PET_NEXT_TEST=1`。每次运行的原始输出在
`logs/experience-preview/demo-<素材>-<节奏>-<时间戳>.log`，控制台先打印 `demo-config`
（节奏、素材、令牌、Electron 参数），结束打印 `demo-summary`（visual 序列与
反应/自动/占位计数）。

## 演示里能看到什么

- 点击：待机→回应→回待机。连点 3 次只认最新一次，不叠帧、不闪回。
- 拖动：窗口跟手，贴到屏幕边缘被夹在工作区内。
- 自主动作：间隔到了才出现，不打断正在播放的回应。
- 失败注入（F 键，行为会话的 `failNext`）：下一请求的素材路径不存在→单槽适配器装载超时
  （8s）→`failed`→按"新请求失败直接回待机"处理，不卡在回应画面。占位图只在
  未知/过期请求命中时出现，已知请求的失败走回待机，两者都不留死帧。
- `demo-summary.visuals` 给出完整序列（例如 `idle→reaction×3→idle→auto→…→fail→idle`）。

## 实测数据

### 点击响应（`bench/click.ts`，同一窗口参数，只换回应素材）

3 轮 × 30 样本 = 每臂 90 个样本；三段毫秒数来自同一次点击，"—"表示未兑现、不按 0ms 计。

| 臂 | 样本 | 兑现率 | 点击→兑现 P50/P95 | 点击→首帧 P50/P95 | 点击→首明确回应 P50/P95 |
| --- | --- | --- | --- | --- | --- |
| 全母带（241 帧 10.0s） | 90 | 90/90 | 11 / 14 ms | 16 / 20 ms | 2474 / 2478 ms |
| 截取短片（106 帧 4.4s） | 90 | 90/90 | 11 / 12 ms | 15 / 17 ms | 265 / 267 ms |

- "素材内明确回应时刻"用逐帧运动量判定（任一 RGB 通道差 > 24 的像素数 ≥ 5% 画幅，且后续
  24 帧窗口内持续），与短片截取同一套规则：母带第 59 帧 / 2458ms，短片第 6 帧 / 250ms。
- 点击→首明确回应 = 点击→首帧 + 素材内回应时刻。短片把这段从 **2474ms 提前到 265ms**
  （P50 差 −2209ms，P95 差 −2211ms），首帧时间不变（差 −1ms，在噪声内）。
- 对照：损坏素材负对照 3/3 全部兑现失败；候选素材自比正对照 3/3 全部兑现。
- 原始样本与每轮帧记录：`bench/runs-click/2026-10-30T09-54-36-271Z/`。

### 待机资源（`bench/resource.mjs`，真实产品入口，60s 采样）

| 素材 | RSS P50（进程树） | CPU 均值 | 进程数 |
| --- | --- | --- | --- |
| 成品 master | 319 MB | 4.62% | 6 |
| 截取 short | 319 MB | 4.72% | 6 |

待机成本主要是待机短片解码，换回应素材对 60s 待机几乎无影响（同一窗口、同一进程树）。

## 已知限制

- `--record` 依赖 X11（xdo）；Windows/macOS 只启动不录制。
- 成品 `assets/reaction.webm` 容器标了 `alpha_mode=1`，但抽样帧 alpha 全为 0
  （`pnpm assets:check` 记为 `source-lacks-alpha`），Chromium 里渲染为空。候选副本与源母带
  alpha 正常；截取短片由源母带重编码，alpha 最差失配 0.062%。短片目前在候选区
  （`assets/candidates/reaction/short.webm`），没有替换成品字节。
- `--scale` 只是 `--force-device-scale-factor`，用于对照缩放下的窗口行为，不代表系统缩放设置。
- 点击对照只覆盖单槽；双槽实验臂保持关闭，等本轮结论再定。

## 复现

```bash
pnpm demo:record                                                  # 演示 + 录制（约 40s）
node --experimental-strip-types bench/click.ts                    # 点击对照（约 4 分钟）
node bench/resource.mjs --asset=short                             # 待机资源（约 70s）
```
