# M3-6 D 一页交付：聊天/宠物反馈联动预览验收

基线 `edad129` · 分支 `codex/pet-next-m3-companion-preview` · 源码包基线 HEAD `ad93e47e045d50779cd492b2504ff03b8ef18636`（报告随 `bd40127` 提交）

## 1. 问题 / 原理 / 方案

问题：发消息后宠物无即时反应，成功回复也无回应；取消/新对话/迟到结果不能乱动。
原理：反馈只是**纯归约**（`core/feedback`，内部 token+epoch 判归属、单定时器、至多一次回应），
表现是**薄接线**（`app/feedback*.ts` 包装既有 `ChatPanelClient`），回应只走既有
`BehaviorPet.reaction()`（仅 idle、不抢 `media.begin`、忙/拖中丢弃不排队）。
方案：显式入口 `--experience=companion` 才开启；普通命令与素材默认不变。

## 2. 用户可见改进（同机实测，1700 端口本机 fake）

| 指标 | 对照臂（无参数） | companion 臂 |
|---|---|---|
| 提交→等待提示可见 | —（无提示） | **57 ms** |
| 提交→助手回复 | 1566 ms | 1568 ms |
| 提交→成功提示/短片回应 | —（reaction 0 次） | **1568 ms**，`reaction-2` 恰 1 次 |
| 提示自动隐藏 | — | 4110 ms |
| 推理 POST | 1 | 1（不增加） |

证据：`tests/chat-evidence/feedback/companion-success/{log.txt,react.png,requests.ndjson}`；
对照 `control-off/log.txt`（`reactions=0`）。

## 3. 两臂 60s 待机资源对照（同机、同 `short,behavior`、无交互）

`bench/feedback/resource.mjs`，`/proc` 进程树每秒采样 60 点，产物 `bench/feedback/runs/2026-11-04T08-35-48-160Z/`：

| 臂 | RSS p50 / max | CPU avg | 自发 POST |
|---|---|---|---|
| 对照 | 624 / 625 MB | 5.03 % | 0 |
| companion | 624 / 624 MB | 5.51 % | 0 |

**结论**：待机 RSS 无可测差异（0 MB），CPU 差 +0.47 个百分点在测量波动内（单次 60 点、同机），
不宣称显著性；联动本身零额外推理请求。工程代价：新增 `core/feedback` 纯模块与
`tests/feedback/companion.e2e.test.ts`（750 行）＋ `bench/feedback/resource.mjs`（约 324 行），
不改聊天内核与媒体播放器。

## 4. 根因与修正（本轮新发现）

1. **e2e 假性 240s 超时**：`window.pet.quit()` 使渲染进程先于 CDP 回复销毁，`connectCdp` 不处理
   close 导致 promise 永久悬挂。修正：close 时 reject pending；`quitByApi` 容忍 `cdp closed`
   （退出码/残留仍由 `waitForChildExit` 与 `assertNoLeftovers` 严判）。单跑 11.8s 通过，
   不再随负载偶发。
2. **扫描竞态 ENOENT**：`bench/context/runs/wb-*` 被其他测试并发清理，`boundaries`/`verify-reach`
   扫到即抛错。修正：源文件扫描对 ENOENT 跳过（运行产物目录无源码可扫）。
3. **源码包内单测不可复跑（任务书 A 遗留）**：打包 CLI dry-run 依赖包外 `.git`；矩阵测试
   依赖包内被排除的 `logs/`。修正：`PET_NEXT_TRIAL_FILE_LIST` 注入清单（CLI 行为不变，
   `shortSha` 仅真实打包时取）；矩阵证据改自含校验（仓库 `logs/` 或
   `tests/platform/evidence/runs/` 8 个副本），保留“未跑不能称通过”。

## 5. 分层数量与退出码

| 层 | 数量 | 退出码 |
|---|---|---|
| `pnpm verify`（typecheck/lint/unit 498/cleanup 22/integration 5/build/e2e） | 498 + 22 + 5 + 35 | **0** |
| e2e 8 文件（7 既有 + feedback 1 文件 8 用例） | 35 pass / 0 fail | 0 |
| 源码包内 `pnpm install && pnpm build && pnpm test` | 468 tests（467 pass / 1 skip / 0 fail） | 0 |
| 源码包内两臂正式入口（`bench/feedback/resource.mjs` 短采样） | 两臂 failure 空、POST 0 | 0 |
| Windows 验收（`verify:windows`） | — | **not-run**（Linux 主机） |

复跑：`env -u NODE_OPTIONS DISPLAY=:94 pnpm verify`；
Windows 一条命令：`pnpm verify:windows`（需 Windows + PowerShell 7）。

## 6. 试用一条命令

```bash
pnpm chat:trial --experience=companion     # 对照：去掉该参数
```

两臂均用预览令牌 `short,behavior`（逗号分隔）；`PET_NEXT_EXPERIENCE` 仅由入口参数注入，
父环境残留会被清除。零真实推理：fake-ssh + fake-model-service。

## 7. 未证明

- Windows/Linux 跨平台行为仅 Linux 实测（not-run 如实记录，未写成通过）。
- 60s 资源对照为单次采样，CPU 0.47pp 差异不构成显著性结论；未做长短时多轮统计。
- 未验证真实模型（本轮零真实 POST）；未加长期记忆/流式/语音/LLM 动作分类。

## 8. 建议

**通过（仅预览）**：8 项两臂验收与资源对照达标，不改默认。是否转正由负责人看试用与代价决定。

## 9. 交付物与 SHA256

| 文件 | 内容 | SHA256 |
|---|---|---|
| `pet-next-trial-src-ad93e47.zip` | 干净源码包（338 文件，3.28 MiB） | `6f32e2a783697ceea23d8e5e6af184c53fa385b916e748b2627ec4cd90c2cb6f` |
| `pet-next-trial-evidence-2026-11-04.zip` | 证据包（46 文件，203.7 KiB） | `78acd360e722121a7c2c7a3f19911d30376dd68bd1b2e422d9e6e91fd12d8749` |
| `pet-next-m36-incremental-edad129.bundle` | `edad129..HEAD` 8 提交增量 | `2046e4d1cfa5bdf50d59e8e2448f819793c2ca3446a4de5f5c79aa59ad467cf6` |

恢复：`git clone <bundle> pet-next && git checkout codex/pet-next-m3-companion-preview`
（或直接解压源码包后 `pnpm install`；包内无 `.git`/`logs/`/证据，属预期）。
