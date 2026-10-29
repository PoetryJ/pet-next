# 预览开关

双槽播放、自主行为和候选素材默认关闭。不设置开关时，页面使用已验收的单槽适配器和现有点击 / 拖动会话，不创建行为调度器，回应仍是成品 `assets/reaction.webm`。

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

统一验收是 `pnpm verify`。它不设置 `PET_NEXT_PREVIEW`。

## 点名

令牌有四个：`two-slot`、`two-slot-preheat`、`behavior`、`candidate`。用逗号组合。`off`、`0`、`false`、`1`、`on` 和未知词不会打开任何策略。多个播放令牌时，后面的覆盖前面的。

```bash
PET_NEXT_PREVIEW=two-slot pnpm start
PET_NEXT_PREVIEW=two-slot-preheat pnpm start
PET_NEXT_PREVIEW=behavior pnpm start
PET_NEXT_PREVIEW=candidate pnpm start
PET_NEXT_PREVIEW=behavior,candidate pnpm start
PET_NEXT_PREVIEW=two-slot,behavior pnpm start
```

| 令牌 | 打开后 |
| --- | --- |
| `two-slot` | 第二个 video 参与播放。旧槽保持显示，新槽准备好再切换。不预热 |
| `two-slot-preheat` | 同上，并在启动时用独立请求号预热回应。预热不发出 `playing` / `ended` |
| `behavior` | 用产品调度器。空闲约 1.6 秒后可开始自动动作；拖动优先；最新点击覆盖旧点击。按 `f` 让下一次回应指向缺失文件，失败后回到待机 |
| `candidate` | 回应和自动动作改用 `assets/candidates/reaction/reaction.webm`。不改写三份成品 |

`PET_NEXT_IDLE_URL` 和 `PET_NEXT_REACTION_URL` 仍写入页面查询。查询里已经有 `reaction` 时，候选令牌不会替换它。缺素材测试继续用这条显式地址。

主进程把环境变量放进页面查询 `preview`。也可以在页面地址上加上 `?preview=behavior,candidate`。页面会写入：

| dataset | 值 |
| --- | --- |
| `data-preview-requested` | 解析后的令牌，例如 `behavior,candidate` |
| `data-preview-active` | 与请求相同。这些工厂已经接上 |

双槽没有被测成更快。bench 里点击到可见首帧是空的，空白形态差异不能当成回应已经出现。不要把 `two-slot` 当成默认，也不要把它写成已证明的优化。

## 体验一段连续动作

自主行为需要 `behavior`。要看到挥手，再加上 `candidate`（成品回应几乎没有不透明像素）。这是素材和调度的预览，不是播放算法的收益。

```bash
cd pet-next
PET_NEXT_PREVIEW=behavior,candidate pnpm start
```

顺序：启动后等待自动动作，点击打断，再连续点击，拖动，按 `f` 看失败回退，按 Esc 退出。

## 和实验命令的区别

`pnpm experiment:arbiter` 只跑仲裁实验，不启动桌宠，也不读取 `PET_NEXT_PREVIEW`。实验里的同级点击排队不是产品行为规则。产品调度在完成或失败时只回到待机，不在同一步接着开始下一条自动动作。
