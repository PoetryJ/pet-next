# 预览开关

双槽播放和自主行为默认关闭。不设置开关时，页面使用已验收的单槽适配器和现有点击 / 拖动会话，不创建行为调度器。

## 关闭

下面两种启动相同，都是已验收路径：

```bash
cd pet-next
pnpm install
pnpm start
```

```bash
PET_NEXT_PREVIEW= pnpm start
```

查询串里不出现 `preview`，页面也不写 `data-preview-requested`。

## 点名

令牌只有三个：`two-slot`、`two-slot-preheat`、`behavior`。用逗号组合。`off`、`0`、`false`、`1`、`on` 和未知词不会打开任何策略。多个播放令牌时，后面的覆盖前面的。

```bash
PET_NEXT_PREVIEW=two-slot pnpm start
PET_NEXT_PREVIEW=two-slot-preheat pnpm start
PET_NEXT_PREVIEW=behavior pnpm start
PET_NEXT_PREVIEW=two-slot,behavior pnpm start
```

主进程把环境变量放进页面查询 `preview`。也可以在已打开的页面地址上自行加上 `?preview=two-slot`。页面会写入：

| dataset | 值 |
| --- | --- |
| `data-preview-requested` | 解析后的令牌，例如 `two-slot,behavior` |
| `data-preview-active` | `off` |

`off` 表示工厂还没有接入。本轮没有双槽适配器，也没有行为调度器，所以打开开关后的画面、点击和拖动仍是已验收路径。后续接入时只改 `app/` 的接线，默认值保持关闭。

## 和实验命令的区别

`pnpm experiment:arbiter` 只跑仲裁实验，不启动桌宠，也不读取 `PET_NEXT_PREVIEW`。实验里的同级点击排队不是产品行为规则。
