# dsh-pet 对外 Cordis 服务

客户端半侧在 DSH web 页面内提供一个服务入口，只在该页面内有效：

```js
const pet = ctx.get('petApi7340'); // 拿不到 = dsh-pet 未启用或版本过旧
```

下面每个方法都从这个入口取。

| 方法 | 说明 |
| --- | --- |
| `pose(petId)` | 读网页端宠物的实况（位置 + 朝向），零请求 |

## pose

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
pet.pose('main');
// { x: 0.8467, y: 0.2438, facing: 'left' }
```
