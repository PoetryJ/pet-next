# M3-12 待机 ROI：接线核对（B 复核负责人已落地的 830b7cb）

负责人在 `830b7cb` 已把接线落在产品树（`contracts/idle-roi.ts` 实现 + `electron/main.ts` 注入 +
`app/page.ts` 包一层 + `app/page.css` 定位）。B 只复核、不改产品文件；下面是**必须改的一处**
和若干可选加固。

## 0. 结论先行（一处真问题）

**`app/page.css` 里 `body.idle-roi video#clip { object-fit: none; }` 会把候选画大 2 倍。**

事实链：

- 主窗口固定 `320×240` 且 `resizable: false`（`electron/main.ts` 的 `WINDOW_WIDTH/WINDOW_HEIGHT`、`resizable:false`），
  所以 contain 的 `scale` 恒为 `0.5`；
- 契约候选 `crop(208,52,226,286)` → 布局 `left=104, top=56, width=113, height=143`（DIP）；
- C 臂候选的解码分辨率就是 ROI 宽高 `226×286`（契约第 2 节），`<video>` 的固有尺寸即 **226×286 CSS px**；
- `object-fit: none` 表示**不缩放**、按固有尺寸居中绘制 → 在 113×143 的盒子里画出 226×286，
  溢出部分被 `overflow: hidden` 裁掉，宠物会显示成 2 倍大且右下偏移。

改成 `object-fit: contain` 即可精确：盒宽高比 `113:143` 与 `226:286` 完全相等，
contain 的缩放就是 `0.5`，与 layout 的 `scale` 一致。

```diff
 body.idle-roi video#clip {
   position: absolute;
   left: var(--idle-roi-left);
   top: var(--idle-roi-top);
   width: var(--idle-roi-width);
   height: var(--idle-roi-height);
-  object-fit: none;
+  object-fit: contain;   /* 盒与候选同宽高比 → 恰好 0.5 等比，像素级对齐 */
 }
```

（`fill` 在本候选下数值等价，但一旦 A 的最终 crop 宽高比与候选分辨率不一致，`fill` 会拉伸变形，
`contain` 只会留透明边——选 `contain` 更稳。）

## 1. 已核对正确的部分

| 检查项 | 结论 |
|---|---|
| 开关关闭零成本 | `idleRoiSpec === null` 时直接用 `baseMedia`，不包对象、不写 style、不注册监听 ✓ |
| 只对 idle 生效 | `applyIdleRoi('idle')` 才加类；`reaction`/`short`/`placeholder` 走 `classList.remove` ✓ |
| 切换回原布局 | `begin()` 与 `showPlaceholder()` 都重算，所以 idle→short→idle、失败占位都恢复 ✓ |
| 不套旧 metadata | 每次 `begin` 按 `request.clip` 重新判定，没有缓存上一次的布局 ✓ |
| 不碰播放生命周期 | 只包 `begin`/`showPlaceholder`，`dispose`/`setHidden`/`idleSuspensionState` 原样透传 ✓ |
| 无第二播放器 | 复用 `#clip`，无新元素/无 Canvas ✓ |
| DIP 不乘 DPR | 用 `petEl.getBoundingClientRect()`（CSS px = DIP），未读 `devicePixelRatio` ✓ |
| manifest 与 SHA 对齐 | 主进程 `resolveIdleRoiQuery()`：manifest 合法 **且** `sourceSha256 === sha256(assets/idle.webm)` 才注入；否则打 `idle-roi-skip` ✓ |
| 双槽不注入 | `parsePreview(preview).playback === 'single'` 才注入 ✓ |
| 窗口/命中区不变 | 只给 `#clip` 加绝对定位，`#pet` 仍是 100%×100%，指针事件仍绑在 `#pet` ✓ |

## 2. 可选加固（不影响本轮判定，出问题再动）

1. **`#pet` 缺 `position: relative`**。当前 `body` 与 `#pet` 都是 100% 且 `margin: 0`，
   绝对定位相对视口与相对 `#pet` 数值相同；加一行 `#pet { position: relative; }` 可把语义钉死，
   且不改变命中区域（`#pet` 尺寸本来就是 100%）。
2. **没有 resize 重算**。主窗口 `resizable: false`，320×240 恒定，可接受；
   若将来有 `setBounds`/聊天窗口联动改尺寸，`--idle-roi-*` 会留旧值。
   届时再加 `resize` 监听，且必须只在 `idleRoiSpec !== null` 时注册（关闭态仍要零监听）。
3. **写值未取整**。`${layout.left}px` 在 320×240 下恒为整数 `104/56/113/143`，无噪声。
   若出现非整数窗口，可用 `experiments/idle-roi/adapter.ts` 的 `idleRoiCssVariables(layout)`
   统一成 3 位小数（`282.5px` 这类），避免 `5.650000000000001px` 进 e2e 断言文本。
4. **`decideIdleRoi` 在生产没被调用**。生产用"有没有 query 参数"表达开关、用 `applyIdleRoi(clip)`
   表达 selection，语义与 `decideIdleRoi` 等价但两条实现并存。
   建议（仅当要做 e2e 一致性断言时）在 `applyIdleRoi` 里改调
   `decideIdleRoi({ enabled: true, selection: clip, ... })`，让生产与单测走同一判定。
   现在不改也安全：页面拿到的几何已由主进程校验过。

## 3. 契约使用边界（给 A/C/D）

- `contracts/idle-roi.ts` 是唯一实现；`experiments/idle-roi/layout.ts` 只 `export *`，
  `experiments/idle-roi/adapter.ts` 只额外提供 CSS 值转换（`idleRoiCssVariables` / `formatIdleRoiStyle`），
  没有第二份公式。
- `parseIdleRoiManifest` 会硬拒：`alphaThreshold ≠ 1`、`schemaVersion ≠ 1`、`kind ≠ 'idle-roi'`、
  sha 非 64 位**小写** hex、crop 宽高非正整数、crop 原点非整数/为负/越界、crop 未偶数对齐、
  `pts.count ≠ frameCount`、`durationMs ≤ 0`。A 产出时按这组约束对齐。
- `computeIdleRoiLayout` 只做数值校验（不做判空）：缺 `crop` 对象会抛，
  必须先过 `parseIdleRoiQuery` / `parseIdleRoiManifest`（页面 `idleRoiSpec === null` 早退即此）。
- `decideIdleRoi` 的 `sourceSha256` 是**可选**的（契约如此）：不给就不比对。
  主进程已自行比对，页面侧不传也安全；任何直接吃 manifest 的新调用方**必须**传 sha。

## 4. 验收自查（改完 object-fit 之后）

1. 默认启动（无 `PET_NEXT_IDLE_ROI`）：`body` 无 `idle-roi` 类、无 `--idle-roi-*` 内联值。
2. `PET_NEXT_IDLE_ROI=1` + `PET_NEXT_IDLE_ROI_MANIFEST=<manifest>`：320×240 窗口下
   `#clip` 计算样式 `left:104px; top:56px; width:113px; height:143px`，宠物与原片**同位置同尺寸**
   （用截图叠差或 C 臂还原图对齐验证，允许 ≤1 DIP 误差）。
3. idle → 点击（reaction）→ idle：reaction 与占位期间 `body` 无 `idle-roi` 类，回 idle 再出现。
4. 换掉 `assets/idle.webm` 字节（manifest 不动）：启动日志出现 `idle-roi-skip` + `source-sha-mismatch`，
   页面永远原片。
5. 隐藏/恢复（`idlePause` 打开时）：类名与 `--idle-roi-*` 不丢；恢复后位置不跳。

## 5. 本分支的运行前提（重要）

我的分支基线是 `dfeca20`，只提交 `experiments/idle-roi/**`；单测 import 的
`contracts/idle-roi.ts` 由负责人提交（`ad4d20a` 引入、`830b7cb` 补了 query 编解码）。

本分支单独 checkout 时该文件不存在，`import` 会解析失败。跑测试需要先把它物化：

```bash
git show 830b7cb:pet-next/contracts/idle-roi.ts > pet-next/contracts/idle-roi.ts   # 临时、未提交
cd pet-next && env -u NODE_OPTIONS node --experimental-strip-types --test --test-reporter spec experiments/idle-roi/*.test.ts
```

如果希望 b 分支能独立复跑，请指示我在 `agent/m312-b` 上 cherry-pick 该文件
（我不会自作主张把 `contracts/` 或 `docs/` 提交进自己分支）。
