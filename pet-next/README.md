# pet-next

单宠物、单屏的透明置顶桌宠。待机循环，点击播一次回应后回到待机；拖动时不误触点击，窗口留在当前工作区。素材失败时显示静态占位，仍可拖动和退出。

## 启动

需要 Node `>=22.12.0` 和 pnpm。Windows 与 Linux 都是：

```bash
cd pet-next
pnpm install
pnpm start
```

`pnpm start` 会先构建再打开窗口。按 Esc 或调用预加载桥的 `quit()` 退出。

`pnpm verify` 依次做类型检查、lint、单元测试、构建和 Electron 实测，任一步失败都会返回非零。

分工、验收和实验协议在 [`docs/ownership.md`](docs/ownership.md)。公共形状在 [`contracts/`](contracts/)。`pnpm experiment:arbiter`、`pnpm experiment:arbiter:check`、`pnpm experiment:arbiter:demo` 和 `pnpm assets:check` 不进入 `pnpm start`，也不进入 `pnpm verify`。

本轮实测平台是 **Linux**（`DISPLAY` 上的 Electron 43.3.0）。没有在 Windows 上跑过同一套 Electron 测试；Windows 启动命令仍是 `pnpm start`。

## 模块

```
core/playback       迁入的 reducePlayback。只吃事件，不碰 DOM / Electron / 文件 / 网络
core/interaction    点击与拖动判定、回应结束或失败后回待机
adapters/media      唯一的加载、播放、取消和回调
adapters/window     窗口平移、工作区夹紧、退出
app                 把上面几块接到页面事件
electron            主进程和 preload。preload 只暴露 moveBy 与 quit
```

`core` 不引用适配器。`pet-next` 不引用 `dsh-pet`。

## 素材

| 文件 | 来源 | 限制 |
| --- | --- | --- |
| `assets/idle.webm` | 从本仓库 `dsh-pet/assets/webm/待机呼吸休闲.webm` 裁约 2 秒，VP9 | 形象是社区二创「大肥鱼」，[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)，禁止商用。公开衍生须署名 <https://github.com/PC2005-cloud/dsh-pet> |
| `assets/reaction.webm` | 从 `dsh-pet/assets/webm/点击回应-元气挥手.webm` 约 2.6 秒起裁 2 秒，纯黑底抠成透明后重编码为 VP9 | 同上 |
| `assets/placeholder.png` | 本目录生成的静态图 | 无外部授权 |

启动只读这些本地文件，不依赖原仓库路径、DSH、API Key 或远程下载。待机片段是流复制，保留源文件的 `ALPHA_MODE`。回应片段落在两个关键帧之间，所以重新编码，并把纯黑底抠成透明；抠像可能吃掉少量深色边缘。窗口按透明置顶创建；素材失败时显示占位图。
