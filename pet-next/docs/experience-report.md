# 集成体验版汇报

默认路径没有打开新策略。下面的数字来自已提交的原始记录，不是这次录像的目测。

## 问题、原理、选择

成品 `assets/reaction.webm` 标了 alpha，但抽样几乎没有不透明像素，浅色、深色、棋盘底上都看不见角色。原因是抠黑，不是缺母版。母版有可用 alpha，所以候选是母版字节副本，写在 `assets/candidates/reaction/`，不覆盖三份成品。

单槽换源会改掉正在显示的元素。双槽让旧槽继续显示，新槽准备好、generation 和槽号都对上之后再切换。预热不进入播放内核，因此不发 `playing` / `ended`。

产品行为与仲裁实验分开：拖动优先，最新点击覆盖旧点击，自动动作只在空闲时开始，完成或失败只回到待机，不在同一步再开下一条。时钟和随机数由调用方注入。

这些都放在 `PET_NEXT_PREVIEW` 后面。不点名就仍是已验收的单槽会话和成品回应。

## 有效结果

`pnpm verify` 在本环境通过：类型检查、lint、单元测试 224、构建，以及 6 条真实 Electron 实测（不是 mock）。平台是 Linux，Electron 43.3.0，`DISPLAY=:1`。

预览 `behavior,candidate` 的连续过程写在 `logs/experience-preview/demo-stdout.log`：`idle-1` → `auto-2` → 连续 `click-3/4/6/7` → 拖动后窗口从约 (78,107) 到 (727,187) → `fail-22` → `idle-23` → 退出。录像是同一次操作。挥手来自候选素材；点击和自动动作用的是同一份候选，所以画面重启不等于播放算法变快。

## 错误根因与修正

契约替身在 `settled` 同一步就启动下一条自动动作，拖动也不取消正在播放的点击。产品调度器不是这样：`settled` 只发 `idle`，拖动取消当前片段并回到待机，拖动期间新来的自动动作先排队。集成把这 10 个契约用例接到 `createTwoSlotAdapter` 和 `createBehaviorScheduler`，断言改成产品规则，没有删用例。

页面原先只把预览记成 `data-preview-active=off`。现在点名的令牌会创建对应工厂，`data-preview-active` 与请求相同。`pnpm verify:windows` 改为 `tests/platform/verify-windows.ps1`。

## 未证明

播放对照用的是成品素材，不是候选。可见首帧（反应画面里出现不透明角色）三种模式都是空的。单槽切换后空白约 2 秒；双槽空白为 0，是因为透明的反应帧下面还留着待机，不是反应姿势已经出现。预热把首次 `play()` 兑现到 0.8 ms，首次画面回调 P50 却是 46.6 ms，比单槽的 14.6 ms 更慢。内存约 910–939 MiB，闲置 CPU 约 7.5–8.5，差别没有超过各轮波动。人工慢加载只说明旧画面还在，不能代替正常环境的收益。

没有 Windows 执行器，也没有把系统缩放设成 100% / 125% / 150%。`pnpm verify:windows` 在非 Windows 上退出码 2。`tests/platform/evidence/matrix.json` 里 win32 与 system-* 是 **not-run**。

## 建议

通过这次集成，作为可运行的体验版：默认仍走已验收路径。停止把双槽或预热保留成已证明的优化；除非换上可用 alpha 素材后重测，否则不要默认启用。候选回应只给预览体验，不自动替换成品。行为调度默认关闭。收益和多出来的视频槽、内存，由负责人决定留不留。

## 命令与记录

```bash
cd pet-next
pnpm install
pnpm start
PET_NEXT_PREVIEW=behavior,candidate pnpm start
pnpm verify
```

| 记录 | 路径 |
| --- | --- |
| 播放对照原文 | `bench/runs/2026-10-29T16-33-51-374Z/`（`report.md`、`samples.jsonl` 540 条、`frames.jsonl`、`strips/`） |
| 成品哈希 | idle `6ebca6b2…df1a`，reaction `9d73e16c…9861`；候选与母版同为 `48cd729c…8776` |
| Linux 平台矩阵 | `tests/platform/evidence/matrix.json` |
| 本次预览轨迹 | `logs/experience-preview/demo-stdout.log` |
| Windows | **not-run**。脚本 `tests/platform/verify-windows.ps1` |
