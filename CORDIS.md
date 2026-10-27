# dsh-pet 对外 Cordis 服务

同名服务 `petApi7340` 在两半各有一份，分属不同容器（宿主进程 / DSH web 页面），互不可见。

```js
ctx.get('petApi7340')
```

拿不到对应分组 = 你在另一半，或 dsh-pet 未启用 / 版本过旧。

## 客户端半侧（DSH web 页面内，只在该页面内有效）

入口返回 `{ getState, pose, progress }`。

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
