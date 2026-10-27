# dsh-pet 对外 Cordis 服务

同名服务 `petApi7340` 在两半各有一份，分属不同容器（宿主进程 / DSH web 页面），互不可见。

本文是**完整契约**（参数、返回字段、边界与示例）；只要成员的一句话预览，见 [`CORDIS-API.md`](CORDIS-API.md)。

```js
ctx.get('petApi7340')
```

拿不到对应分组 = 你在另一半，或 dsh-pet 未启用 / 版本过旧。

## 客户端半侧（DSH web 页面内，只在该页面内有效）

入口返回 `{ getState, menuEvents, pose, progress }`。

### pose

**参数**

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `petId` | string | 宠物 id |

**返回**：`{ x, y, facing } \| null`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `x` | number | 中心点横坐标，视口归一化 0–1 |
| `y` | number | 中心点纵坐标，视口归一化 0–1 |
| `facing` | `left` \| `right` | 朝向 |

`null`：这一页没有这只宠物。

```js
ctx.get('petApi7340').pose('main');
// { x: 0.8467, y: 0.2438, facing: 'left' }
```

### progress

**参数**

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `petId` | string | 宠物 id |

**返回**：`{ playbackId, anim, currentTime, duration, paused, buffering } \| null`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `playbackId` | `string \| null` | 本次播放编号；自播动画（随机走位 / 点击 / 碎碎念…）为 `null` |
| `anim` | string | 当前动画：池内动作给名字（`walk`），`url` 点播给该地址 |
| `currentTime` | number | 当前播放位置，秒 |
| `duration` | number | 视频总长，秒；元数据未就绪时为 `0` |
| `paused` | boolean | 是否暂停；播完也是 `true` |
| `buffering` | boolean | 是否在缓冲（`readyState < 3` 或正在 seek） |

`null`：这一页没有这只宠物。

```js
ctx.get('petApi7340').progress('main');
// { playbackId: 'pb_1755...', anim: 'walk', currentTime: 3.42, duration: 10.09, paused: false, buffering: false }
```

### getState

**参数**：无。

**返回**：`PollState | null` —— 本页最近一拍的轮询状态，与 `GET /state` 的响应体同形；`/state` 首拍还没回来时为 `null`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `counter` | number | 整份状态的版本号；任意叶子被写入都递增 |
| `sections` | `Record<SectionName, StateLeaf>` | 全局段：`balance` / `workStatus` / `notify` / `config` / `menu` |
| `pets` | `Record<petId, Record<PetLeafName, StateLeaf>>` | 每只宠物的叶子：`say` / `anim` / `position` / `throw` / `lock` |

每个叶子都是 `{ counter, data }`：`counter` 变了就说明这一项变过，`data` 是它当前的值（`null` = 还没写过）。

使用要点：

- 返回的是**快照引用**，只读；改它会影响宠物页自己的渲染。
- 每拍整包替换，所以拿在手里的旧对象不会被后续写入改掉。
- 首拍之前是 `null`；页面级数据，别的标签页读不到。
- 零请求：读的是内存，可以在渲染或 `requestAnimationFrame` 里按需读。

```js
const s = ctx.get('petApi7340').getState();
if (s) {
  console.log('版本', s.counter, '这只宠物最近说：', s.pets.main?.say?.data);
}
```

### menuEvents

**参数**

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `owner` | string | 注册菜单项时用的 owner |

**返回**：与 `GET /menu/events` 的响应体同形。

| 形态 | 内容 |
| --- | --- |
| 成功 | `{ ok: true, events: Record<label, petId \| null> }` |
| 未知 owner | `{ ok: false, reason: 'unknown-owner' }` |

`events` 覆盖本页可见的全部菜单项：值是 `petId` 表示这一项被点过（点在哪只宠物上），`null` 表示没被点过。

**读取即消费**：读走后所有标记清回 `null`，下一次读到的是之后的新点击；连续点同一条只留最后一次。这个 owner 在本页没有可见项（没注册、已清除，或只注册给 `desktop`）时回 `unknown-owner`。

```js
const res = ctx.get('petApi7340').menuEvents('my-plugin');
if (res.ok) {
  for (const [label, petId] of Object.entries(res.events)) {
    if (petId !== null) console.log(label, '被点了，点在', petId);
  }
}
```

## 宿主半侧（宿主插件进程内）

入口返回 `{ balance }`。

### balance.register

第三方插件注册自己的余额查询。宿主不再为每家服务商改代码。

**参数**

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 服务商 id，必须与 DSH 报告的 provider 一致 |
| `fetch` | function | 取数；入参只有 `{ provider }`（没有 key、没有 resolveAccount） |

**返回**：`() => void`，注销函数。配合 `ctx.effect` 使用，插件卸载时自动注销。

**抛错**：`id` 为空、`fetch` 不是函数、与内置 id 冲突、已被其他第三方注册。

**`fetch` 返回**：`ok` 恒为 `true`，失败一律 `throw`（宿主统一落成 `fetch-error`）。

| shape | data |
| --- | --- |
| `windows` | `{ monthly, rolling?, weekly?, *CapUsd?, *ResetsAt?, rollingLabel? }` |
| `money` | `{ wallets: [{ currency, total, granted, toppedUp, fullBalance? }], tier? }` |
| `points` | `{ unit, total, full? }` |
| `custom` | 节点树：`{ views: CustomNode[], percent? }` 或 `{ rows: CustomNode, detailRows?: CustomNode, percent? }`，见下 |

```js
export const inject = ['petApi7340'];

export function apply(ctx) {
  ctx.effect(() =>
    ctx.get('petApi7340').balance.register({
      id: 'my-gateway',
      async fetch({ provider }) {
        const res = await fetch('http://127.0.0.1:8080/v1/credits', { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        return { ok: true, provider, shape: 'points', data: { unit: '积分', total: String(j.remaining), full: String(j.limit) } };
      },
    }),
  );
}
```

宿主不替 `fetch` 加超时或重试。

#### `custom` 形态：自己画气泡

`data` 给一棵节点树，宿主与两端共用同一份渲染器——气泡长什么样完全由你决定，不用为每家服务商改插件代码。

两种写法（`views` 优先；两种都给时忽略 `rows`）：

| 写法 | 形状 | 页数 |
| --- | --- | --- |
| 多页 | `{ views: CustomNode[], percent? }` | 最多 4 页；点击循环切页，末页回第一页 |
| 老两页 | `{ rows: CustomNode, detailRows?: CustomNode, percent? }` | 合成 1–2 页；只有一页时气泡不可点 |

`percent` 是已用百分比，驱动余额档位动画：越界夹到 0–100；缺省或非有限数则不播动画。

节点字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `tag` | `div` \| `span` \| `i` \| `b` \| `strong` \| `em` \| `img` | 白名单之外的标签会让整页作废 |
| `text` | string | 文本片段，先于子节点渲染 |
| `src` | string | 仅 `img` 有效，只收 `http` / `https` |
| `style` | `Record<string, string>` | 内联样式，键为 camelCase，解析层按白名单过滤 |
| `children` | `CustomNode[]` | 子节点 |

限额（超过即整页作废）：深度 6、全树 200 节点、单节点 24 个子节点、页数 4。单段文本超过 120 字符**截断**；单个样式值超过 64 字符只丢该属性；`src` 超过 512 字符无效。

失败口径：`fetch` 抛错 → 气泡显示 `fetch-error`；`shape: 'custom'` 但任一页非法 → 这一拍整份跳过，不出现「前几页正常、翻到后面崩」的半坏状态。

```js
ctx.effect(() =>
  ctx.get('petApi7340').balance.register({
    id: 'my-gateway',
    async fetch({ provider }) {
      return {
        ok: true,
        provider,
        shape: 'custom',
        data: {
          percent: 42,
          views: [
            {
              tag: 'div',
              style: { display: 'flex', gap: '6px' },
              children: [
                { tag: 'span', text: '积分' },
                { tag: 'b', text: '420 / 1000' },
              ],
            },
            { tag: 'div', children: [{ tag: 'span', text: '下次刷新 5 分钟后' }] },
          ],
        },
      };
    },
  }),
);
```

4 页与 3 页的完整样例见 [`tools/cordis-probe`](tools/cordis-probe/README.md) 的 `lib/mock-balance.js`（`mock-custom-kinds` / `mock-custom-fancy`）。

### balance.list

**参数**：无。

**返回**：`{ builtin, external }`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `builtin` | string[] | 内置服务商 id |
| `external` | string[] | 第三方已注册 id |

```js
ctx.get('petApi7340').balance.list();
// { builtin: ['opencode-go', 'commandcode', 'deepseek-official', 'deepseek-account'], external: ['my-gateway'] }
```
