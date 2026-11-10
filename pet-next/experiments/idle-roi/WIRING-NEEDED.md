# M3-12 待机 ROI：最小接线需求（B → 负责人）

本文件只描述 `app/**` 的接线需求。B 不碰 `app/`、`electron/`、`contracts/`；
下列代码是**建议 diff 的形状**，由负责人裁剪落地。

依赖的纯函数（B 独占路径，已提交）：

- `experiments/idle-roi/layout.ts` → `computeIdleRoiLayout`
- `experiments/idle-roi/adapter.ts` → `parseIdleRoiManifest` / `decideIdleRoi` / `formatIdleRoiStyle`

## 0. 不变量（接线时必须保持）

1. **不改播放生命周期**：不新增 `play()/pause()/load()` 调用，不改 `attachPetMedia`、
   `createPetController`、`createBehaviorPet` 的时序，不新增第二个 `<video>`/第二播放器。
2. **只对 idle 生效**：`selection.playback === 'single'` 且当前 `visual === 'idle'`
   才写 ROI；`reaction`（含 preview `short` 的短片）、`placeholder` 一律回全窗口 contain。
3. **开关关闭 = 零成本**：不 fetch、不 new 监听、不写任何 style/dataset。
4. **COS 值是 DIP**：直接来自 `formatIdleRoiStyle`，**不得再乘 `devicePixelRatio`**。
5. **失败即回原片**：`decideIdleRoi` 返回 `kind:'original'` 时清空 ROI 样式并
   `console.log` 一条 reason；既有失败/占位语义（`media.showPlaceholder()`）完全不动。
6. `#pet` 命中区域、窗口尺寸、聊天面板、拖动/点击判定不变。

## 1. 主进程注入（`electron/main.ts`，建议方案 A：同步、无启动竞态）

页面需要三件东西：**开关**、**manifest**、**当前 idle 字节的 SHA256**。
`decideIdleRoi` 强制要求 SHA 对齐（缺 SHA 直接回原片），这是"旧 manifest 套新素材"的唯一防线。

方案 A（推荐）：主进程启动时 `fs.readFileSync` manifest，用 `crypto` 校验
`sourceSha256 === sha256(assets/idle.webm)`，**通过才**把 manifest 内联进页面查询串：

```ts
// electron/main.ts（示意）
const roiEnabled = /* 与现有 preview 开关同一处判定，默认 false */ false;
const query = new URLSearchParams({ /* 现有参数 */ });
if (roiEnabled) {
  const manifestText = fs.readFileSync(path.join(root, 'assets/candidates/idle-roi/manifest.json'), 'utf8');
  const idleSha = sha256File(path.join(root, 'assets/idle.webm'));
  query.set('idle-roi', Buffer.from(manifestText, 'utf8').toString('base64url'));
  query.set('idle-roi-sha', idleSha);
}
```

- 只有 `enabled` 为真时这几个参数才存在；默认关闭，用户包不受影响（闭包过滤照旧）。
- 建议把这四个令牌常量放进 `contracts/preview.ts`（负责人独占）：
  `IDLE_ROI_QUERY = 'idle-roi'`、`IDLE_ROI_SHA_QUERY = 'idle-roi-sha'`。
- 若坚持方案 B（页面 `fetch(manifestUrl)`），务必**不要**在 idle 播放中晚到 manifest 时
  重排当前画面（会构成"位置跳动"失败项）：只在**下一次** `setVisual('idle')` 生效。

## 2. `app/page.ts`（约 25 行，全部放在 `surface` 旁边）

```ts
// M3-12：只在主进程注入 idle-roi 时启用；关闭时零解析、零监听。
import { decideIdleRoi, formatIdleRoiStyle } from '../experiments/idle-roi/adapter.ts';

const roiRaw = params.get(IDLE_ROI_QUERY);            // base64url(manifest) or null
const roiSha = params.get(IDLE_ROI_SHA_QUERY) ?? undefined;
const roiEnabled = roiRaw !== null && selection.playback === 'single';
const roiManifest: unknown = roiEnabled ? decodeManifest(roiRaw) : null;

/** base64url → JSON；解不开就返回 null（下游按"manifest 无效"回原片）。 */
function decodeManifest(raw: string): unknown {
  try {
    const base64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

/** `idle` 写 ROI；其余清空，回到 page.css 的 contain 默认。 */
function applyIdleRoi(visual: string): void {
  if (!roiEnabled) return;
  const decision = decideIdleRoi({
    selection: visual === 'idle' ? 'idle' : visual === 'reaction' ? 'reaction' : 'placeholder',
    manifestRaw: roiManifest,
    viewWidth: window.innerWidth,      // CSS px == DIP，不要再乘 DPR
    viewHeight: window.innerHeight,
    enabled: true,
    sourceSha256: roiSha,
  });
  if (decision.kind === 'roi') {
    const style = formatIdleRoiStyle(decision.layout);   // 四个值成套给出
    video.dataset.roi = 'on';
    for (const [key, value] of Object.entries(style)) video.style.setProperty(`--roi-${key}`, value);
    return;
  }
  video.removeAttribute('data-roi');
  for (const key of ['left', 'top', 'width', 'height']) video.style.removeProperty(`--roi-${key}`);
  if (visual === 'idle') console.log(JSON.stringify({ event: 'idle-roi', kind: 'original', reason: decision.reason }));
}

if (roiEnabled) window.addEventListener('resize', () => applyIdleRoi(document.documentElement.dataset.visual ?? 'placeholder'));
```

唯一改动点：在**已存在**的 `surface.setVisual(visual, requestId)` 里加一行
`applyIdleRoi(visual);`（放在写 `dataset.visual` 之后）。

为什么用 `setVisual` 而不是 `media.begin`：

- `wire.ts` 与 `behavior-pet.ts` 两条路径都会先 `setVisual(clip)` 再 `play`，
  覆盖 idle / reaction / placeholder 三态，天然跟代际（`requestId`）同步；
- 不需要碰 `PetMedia` 接口，也不需要包 `media.begin`；
- `setVisual` 在 `play` 之前，样式先到位再出画面，不会出现"先画全窗口再跳 ROI"。

### 双槽

`selection.playback !== 'single'` 时 `roiEnabled = false`（上面已内置）。
双槽下 idle 可能落在 `#clip-next`，需要动 `app/pet-media.ts` 的 `showSlot`——
属于负责人路径，本轮建议**不做**，避免两元素同时带 ROI。若以后要开，
把 `data-roi` 写成"给可见槽"并在 `showSlot` 里同步切换。

## 3. `app/page.css`（两处小改）

```css
#pet {
  position: relative;   /* 新增：给 ROI 的 absolute 定位提供包含块；不影响命中区域 */
}

video[data-roi='on'] {
  position: absolute;
  /* 候选分辨率 = crop 宽高，与 ROI 盒同宽高比，contain 即精确等比，无需 fill */
  object-fit: contain;
  left: var(--roi-left);
  top: var(--roi-top);
  width: var(--roi-width);
  height: var(--roi-height);
}
```

- `video[data-roi='on']` 的特异性 (0,1,1) 高于现有 `video, img`（0,0,1），无需 `!important`。
- `#placeholder` 是 `img`，永远不会命中该选择器。
- 不写死任何像素值：数值全部来自 `formatIdleRoiStyle`，窗口变化由 `resize` 重算。

## 4. 失败与回原片的落点

| 情况 | 结果 | 落点 |
|---|---|---|
| 开关关闭 / 未注入参数 | 全窗口 contain，原 `assets/idle.webm` | `page.css` 默认规则 |
| manifest 缺字段/越界/NaN/提阈值 | `kind:'original'`，reason 写 console | `applyIdleRoi` 清理分支 |
| `idle-roi-sha` 与素材不符（换了 idle 字节） | 同上 | `decideIdleRoi` → `manifest rejected: sourceSha256 mismatch` |
| 视口 0/NaN（启动瞬间） | 同上，下一次 `resize`/`setVisual` 自然纠正 | `layout unavailable` |
| 视频加载失败 | 既有 `media` 失败语义 → `placeholder` | 不动，`setVisual('placeholder')` 自动清 ROI |

## 5. 验收自查（负责人落地后）

1. 默认启动：`?` 无 `idle-roi` 参数 → `#clip` 上无 `data-roi`、无 `--roi-*` 变量、无 `resize` 监听。
2. 开开关 + 320x240 窗口：`#clip` 计算样式为 `left:104px; top:56px; width:113px; height:143px`。
3. idle → 点击（reaction）→ idle：reaction 与 placeholder 期间 `data-roi` 不存在，回到 idle 再出现。
4. 把 `assets/idle.webm` 换字节（不改 manifest）：永远 original，console 有 sha mismatch。
5. 拖大窗口：`--roi-*` 随 `innerWidth/innerHeight` 变化，无 DPR 参与。
