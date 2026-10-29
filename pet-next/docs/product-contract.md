# 产品契约

形状在 `contracts/process-tracker.ts`、`contracts/coordinates.ts`、`contracts/assets.ts`。这里写类型表达不了的规则。默认桌宠行为在接线 PR 之前保持现状：页面把 `PointerEvent.screenX` / `screenY` 交给手势核心。

## 进程跟踪

实现类型是 `ProcessTracker`。一次 `start` 返回一棵树，`dispose` 只结束这棵树，并且可以重复调用。

符合契约的记录方式：跟踪器记住这棵树的根和子孙，结束时只向这些 pid 发信号。Windows 使用只包住这棵树的作业对象，或等价的按子孙结束的办法。调用方传入的 `env` 是日志里唯一允许出现的环境键。

当前 `tests/electron.e2e.test.ts` 的 `electronPids` 用 `ps` 按命令名收集 Electron，`shutdown` 对负 pid 发信号，并清掉启动后新出现的 Electron pid。这不符合契约。Agent A 替换这两处。本轮不把它算作已完成。

无法启动时 `pid` 为 null，`started` 为 false，`signaledPids` 为空，`finished` 已经完成。超时后 `timedOut` 为 true，进程树已结束。

必须覆盖的用例名是 `REQUIRED_PROCESS_CASES`：`spawn-failure`、`timeout`、`clean-exit`、`foreign-pid-survives`。最后一项里，跟踪开始前已经存在、且不属于这棵树的进程，不得出现在 `signaledPids` 里，测试结束后仍然存活。

平台记录使用 `PlatformMatrixEntry`。本轮只有 `linux` 和 `win32`。没跑的平台写 `status: "not-run"`，`reason` 说明原因，`evidencePath` 指向 `scripts/verify-windows.ps1` 或当次日志。`not-run` 不是通过。

原始日志目录是 `test-results/platform/<platform>/<caseId>.json`，已被 gitignore。PR 里附上矩阵和原始输出。需要进仓库的样本放在 `tests/platform/`。

一键 Windows 命令是 `pnpm verify:windows`。

## 坐标

三套单位：

| 空间 | 字段 | 来源 |
| --- | --- | --- |
| `viewport-css` | `PointerObservation.client` | `PointerEvent.clientX` / `clientY` |
| `screen-css` | `PointerObservation.screen` | `PointerEvent.screenX` / `screenY` |
| `dip` | `PointerObservation.window`、`DipPoint`、现有 `WindowBounds` | Electron `BrowserWindow.getBounds` / `setPosition`，以及 `Display.workArea` |

`scaleFactor` 取当前窗口所在显示器的 `screen.getDisplayMatching(bounds).scaleFactor`。文档见 [screen](https://www.electronjs.org/docs/latest/api/screen) 和 [BrowserWindow.getBounds](https://www.electronjs.org/docs/latest/api/browser-window#wingetbounds)。`devicePixelRatio` 只写进观察记录。生产代码里的乘除集中在 `PointerAdapter.toDip`。`core/`、`app/`、`electron/` 和 `adapters/window` 不按 `devicePixelRatio` 换算。

本轮不规定换算公式。B 先按 `REQUIRED_SCALE_CASES` 记录观察，再实现 `toDip`。测量表明 CSS 屏幕像素已经等于 DIP 时，`conversion` 为 `identity`。否则为 `scaled`，并在 PR 里写明公式。位置断言使用该公式的精确 DIP，再沿用窗口控制器现有的 `Math.round`。容差是 0。

验收行：

- `default`：不带 `--force-device-scale-factor`，记录实测 `scaleFactor`。
- `simulated-100` / `125` / `150`：用该开关，在日志里标 `simulated`。其中 1 倍是对照，保留现有 Electron 实测，不能单独作为通过条件。
- `system-100` / `125` / `150`：操作系统显示缩放真的设成该值时标 `system`。没有这种环境就记 `not-run`。

真实输入是 CDP `Input.dispatchMouseEvent` 或 `webContents.sendInputEvent`。页面里 `dispatchEvent(new PointerEvent(...))` 只能作补充。拖动要沿这条路径移动窗口、夹在工作区内，并且不增加点击。`DRAG_THRESHOLD_PX` 仍是 5，单位与传入 `core/interaction` 的坐标相同；接线之后是 DIP。

本轮只处理单屏，继续用 `getDisplayMatching`。样本可提交到 `adapters/pointer/samples/`。运行日志在 `test-results/pointer/<caseId>.jsonl`。

接线前，默认路径不调用 `createPointerAdapter`。接线属于 B 的例外范围，见 [ownership.md](ownership.md)。

## 素材

流水线读取源文件，写出 `AssetProcessReport`。命令行是 `pnpm assets:check`。

`AssessQuality` 只接收 `QualityEvidence`。`backgroundColorString` 可以记窗口 `getBackgroundColor()` 之类的字符串，但不能决定 `verdict`。

判定：

- 源 `hasAlpha` 为 false：`verdict` 为 `source-lacks-alpha`，`limitation` 写明限制，流水线到此结束。
- 源有 alpha：输出也必须有 alpha。裁剪和编码保留该通道。用删除近黑像素来制造透明，判定为 `fail`。
- 源有 alpha 且输出有 alpha：至少有一个 `frameIndex` 同时具备 `light`、`dark`、`checker` 三张对照，且深色那张的 `darkForegroundVisible` 为 true，才可以 `pass`。任一背景缺失，或深色前景是 `unobserved`，判定为 `fail`。
- 没有输出或读不到输出 alpha：`fail`。

报告放在 `assets-pipeline/out/report.json`，对照图放在 `assets-pipeline/out/frames/`。需要进仓库的夹具放在 `assets-pipeline/fixtures/`。成品 `assets/*.webm` 和 `placeholder.png` 不在这条流水线里被覆盖。

不引入生成模型，也不引入新的抠像框架。系统里已有的 ffprobe / ffmpeg 可以作为命令，不新增 npm 依赖；缺工具时 `verdict` 为 `fail`，`limitation` 写明缺什么。

## 预览与产品行为

双槽和自主行为默认关闭。解析规则在 `contracts/preview.ts`，开启方式在 [preview.md](preview.md)。关闭时页面继续使用现有单槽适配器和现有会话，不创建行为调度器。

产品行为的形状在 `contracts/behavior.ts`。它不沿用仲裁实验里的同级点击排队：新点击取消上一个未完成的点击。拖动不产生点击，拖动期间不开始自动动作。实验协议仍只描述 `experiments/arbiter/`。

候选素材的交付记录在 `contracts/asset-candidate.ts`。三份成品的字节锁保持不变。
