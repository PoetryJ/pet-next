---
name: dsh-plugin-standards
description: "编写、修改或评审 DSH 插件时的代码规范：统一插件类型、包清单、目录与文件、命名、类型与接口、配置与状态、测试与发布方式。"
whenToUse: "新建 DSH 插件包、编写或修改 host/client 插件代码、拆分文件或新增接口、补测试、发布前自查时使用。"
metadata:
  language: "zh"
  category: "development"
disable-model-invocation: false
user-invocable: true
---

# DSH 插件代码规范

## 目标

让 DSH 插件在结构上一致、在接口上可预测、在维护上可拆分。规范只回答一个问题：**这段代码该怎么写，才能让别人接手时不骂人。**

适用对象：宿主半侧（host）、浏览器半侧（client）、工具、投影、bundle、独立运行与桌面 carrier。不适用于第三方库内部实现。

## 1. 先定插件类型

写第一行代码前，先确认属于哪一类；类型决定入口、清单字段与生命周期。

| 类型 | 特征 | 入口 |
|---|---|---|
| A 函数式 host | 只注册服务/监听/路由 | 命名导出 `name`/`inject`/`Config`/`apply` |
| B 服务式 host | 对外提供一个 Cordis 服务 | `class X extends Service` + `static Config` + `super(ctx, 'name')` |
| C 工具 | 给模型注册工具 | `ctx.tools.register(defineTool({...}))` |
| D 投影 | 从会话事件折叠状态 | `ctx.sessionProjections.register({...})` |
| E 客户端 UI | 有浏览器渲染 | host 侧空 `apply()` + `lib/client.js` + `dsh.client` |
| F bundle | 只组合其他插件 | `lib/index.js` + `cordis.patch.yml` + `dsh.bundle.patch` |
| G 纯再导出 | 只导出类型或转调 | 只 re-export，不写逻辑 |
| H 元数据 | 只有 locale/icon | `locale/*.json` + `icon` |

判定顺序：有 UI → E；只组合 → F；给模型用 → C；维护派生状态 → D；对外提供服务 → B；其余 → A。

## 2. 包清单

`package.json` 固定字段：

```jsonc
{
  "name": "@scope/dsh-<domain>-<role>",
  "description": "一句话，市场展示用",
  "version": "0.2.1-rc.2",              // 与同 release 的 DSH 精确对齐，不用 ^
  "publishConfig": { "access": "public" },
  "repository": { "type": "git", "url": "…", "directory": "packages/<组>/<包>" },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": { … },
  "files": [ … ],
  "license": "MIT"
}
```

`exports` 五段固定：

```jsonc
".":               { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
"./client":        { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
"./src/*":         "./src/*",
"./package.json":  "./package.json",
"./locale/*.json": "./locale/*.json"
```

- `./client` 只给 E 类，且必须同时存在 `lib/client.js` 与 `lib/types/client/index.d.ts`。
- `./cordis.patch.yml` 只给 F 类。
- `files` 只发运行产物与元数据：`lib/index.js`、`lib/types/**/*.d.ts`、`locale/*.json`；E 类加 `lib/client.js`；F 类加 `cordis.patch.yml`、`icon.svg`。

依赖三分：

| 位置 | 放什么 | 版本 |
|---|---|---|
| `dependencies` | 运行时真正 import、宿主不提供的包 | 精确 |
| `peerDependencies` | 宿主提供、不能打包的包；通常只有 `@deepseek-ai/cordis` | 精确或 `~` |
| `devDependencies` | 其余全部：peer 包、类型包、测试库、react | 与 release 精确一致 |

凡写进 `dsh.client.inject` 的包，必须同时列进 `devDependencies`，否则拿不到类型。

`dsh` 字段：

```jsonc
// E 类
"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-locale"], "platform": "web" } }
// F 类
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
// 需要兼容性声明时
"dsh": { "compatibility": { "dshReleases": { "0.2.1-rc.2": "compatible" } } }
```

`dsh.client.inject` 列包名，插件 `inject` 列服务名，两者不是一回事。

## 3. 目录与文件

`src` 模板：

```text
src/
├── index.ts          # 插件入口：name/inject/Config/apply
├── types.ts          # 本包类型唯一归属地
├── client.ts         # 可选：客户端类型再导出
├── client/           # E 类浏览器半边
│   ├── index.ts      # inject + apply(ClientContext)
│   ├── <Component>.tsx
│   ├── slots.ts      # inject face / props
│   └── locales.ts    # zh/en 字典 + key 类型
└── <topic>.ts        # host 侧按主题拆：storage / request / format
```

文件规模（有效行，去空行与注释）：

| 类型 | 软上限 | 硬上限 |
|---|---|---|
| 普通模块 | 200 | 300 |
| 含 IO/路由聚合 | 300 | 400 |
| React 组件文件 | 200 | 250 |
| 入口/装配 | 120 | 150 |
| 类型文件 | 150 | 200 |
| 测试文件 | 400 | 600 |

- 超限时按**变化原因**拆，不按行数切：同一资源、同一状态所有者、同一生命周期放一起。
- 行数与变化原因冲突时，**变化原因优先**：确实没有独立变化原因的就不切，在提交信息里写明“超限但没有独立变化原因，暂不拆”。判断标准是“以后改一个需求，还会不会同时动这两处”，不是“行数有没有回到表内”。
- 一个文件一个主职责，模块头第一行必须说得清。
- 目录深度 ≤4；单目录文件 ≤30；不留空目录。
- 文件命名 kebab-case；组件文件 PascalCase；类型 `types.ts`；插槽 `slots.ts`；字典 `locales.ts`。
- 禁止 `utils.ts`、`helpers.ts`、`common.ts`、`misc.ts`；按领域命名（`jsonc.ts`、`http.ts`、`dom.ts`）。
- 相对导入带扩展名：`from './slots.ts'`、`from './GoalBar.tsx'`。
- `src/index.ts` 是唯一入口，其他文件都是它的私有依赖；客户端插件入口不得 import `src/client/**`。

README 必须有源码地图：

```md
| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：Config schema、工具注册 |
| `src/types.ts` | 投影键与载荷类型的唯一归属地 |
```

### 目录细化

目录按领域分，不按技术类型分。满足以下五条才建子目录：

1. 这组文件共享一个变化原因（改 A 常要改 B）；
2. 对外只需要 1–2 个入口；
3. 能用领域名命名（不是 `utils`/`common`/`components`）；
4. 组内 ≤30 个文件（与单目录上限同口径），且不会继续膨胀；
5. 跨组引用主要经过出口。

| 单目录文件数（含测试） | 建议 |
|---|---|
| ≤20 | 保持扁平 |
| 20–30 | 先合并同类、删无用文件，再考虑分 |
| >30 | 必须按领域分 |

- 子目录 ≥3 个文件才建。
- `index.ts` 出口按需建：跨组引用 ≥2 处、或有稳定的对外面时才建；只有 1–2 处引用时直接相对导入。出口解决的是“散落的深路径”，不是“目录必须长得一样”——没有第二个消费方时，加一层只是多一跳。
- 禁止按技术类型分（`components/`、`hooks/`、`services/`）与杂物目录（`misc/`、`helpers/`、`common/`）。
- 测试文件跟随源文件进子目录，不集中到 `tests/`。

### 文件生命周期

拆分或替换旧文件时，旧文件只有三种去向：

| 旧文件身份 | 去向 | 保留多久 |
|---|---|---|
| 包入口 | 薄壳：只 re-export 与装配，≤50 行 | 永久 |
| 被其他包 import | 兼容层：只 re-export，标 `@deprecated 替代路径与删除版本` | 一个 minor |
| 仅本包内部使用 | 删除 | 立即 |

- 禁止 `legacy/`、`old/`、`archive/`、`backup/` 目录；禁止 `_v2`/`_new` 并行实现；禁止注释掉的旧代码。
- 删除前确认：引用清零、类型检查通过、测试绿、README 源码地图已更新。
- 历史交给 git（`git log --follow`、`git blame -C -C`），不靠留文件。

## 4. 插件骨架

函数式 host：

```ts
/**
 * <一句话职责>。
 *
 * <为什么需要这个插件 / 它约束了什么，2–4 句>。
 * @module @scope/dsh-<name>
 */
import z from '@deepseek-ai/schemastery';

/** Cordis plugin name. */
export const name = '<name>';
/** 需要的宿主服务。 */
export const inject = ['<service>'];
/** 运行时配置 schema；默认值写在这里。 */
export const Config = z.object({
  enabled: z.boolean().default(true),
});

/**
 * <注册了什么、依赖什么、清理什么>。
 * @param ctx - 挂载上下文。
 * @param config - <配置语义>。
 */
export function apply(ctx: Context, config: z.infer<typeof Config>) {
  ctx.effect(() => ctx.<service>.<register>({ /* ... */ }), '<name>.<resource>()');
}
```

服务式 host：

```ts
export class WebServer extends Service {
  static readonly Config = z.object({ host: z.string().required(), port: z.number().required() });
  constructor(ctx: Context, config: z.infer<typeof Config>) {
    super(ctx, 'webServer');
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { webServer: WebServer; }
}
```

客户端 UI：host 侧保留空 `apply()`，让 Loader 能看到插件；浏览器侧：

```ts
import type { Context as ClientContext } from '@deepseek-ai/cordis';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { <ns>: <Key>; }
}

/** Required services. */
export const inject: string[] = ['slots', 'locale'];

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void { /* ctx.slots.register(...) */ }
```

规则：

- 所有注册走 `ctx.effect(register, '<模块>.<资源>()')`，第二个参数是稳定标签，不能省。
- 配置默认值只写在 `Config` schema，`apply` 内不再兜底。
- 可选字段用展开合并：`...config.x ? { x: true } : {}`。
- bundle 的 patch 用 `- insert:` + `id`/`name`/`config`，`group: true` 配 `isolate` 隔离服务作用域。

## 5. 导出与 Loader 契约

Loader 的 `unwrapExports` 只要发现 `default` 就取 default，命名导出被静默忽略：

| 形态 | 写法 | 后果 |
|---|---|---|
| 函数式 | 只用命名导出，**不要 default** | 有 default 则 `inject` 丢失 |
| 类式 | `export { Klass, Klass as default }`，`inject`/`name` 写成**静态成员** | 命名 `inject` 不生效 |

- 导出顺序按字母序：`export { Config, apply, inject, name }`。
- 一个文件一个主导出；类型紧邻实现；测试专用导出标 `@internal` 并放文件末尾。
- 单文件导出 ≤15 个；`index.ts` 只做公开入口，禁止 `export *`。
- 包导出面只包含插件四件套与公开类型；内部模块不承诺兼容。

## 6. 命名

| 对象 | 规则 | 例 |
|---|---|---|
| 文件/目录 | kebab-case | `request-zone.ts` |
| 组件文件 | PascalCase | `GoalBar.tsx` |
| 变量/函数 | camelCase，动词开头 | `deriveTimeZoneContext` |
| 常量 | UPPER_SNAKE | `MAX_WAIT_MS` |
| 类型/接口 | PascalCase，无 `I` 前缀 | `WebRoute` |
| 布尔 | `is/has/can/should/was` | `isLoopbackHost` |
| 服务名 | camelCase，Context 上的键 | `webServer` |
| 插件 name | kebab-case | `tool-todo` |
| 事件名 | `<域>/<动作>` | `turn/start`、`llm/stream` |
| slot 名 | 点分层级 | `conversation.input.dock` |
| 配置字段 | camelCase，单位入名 | `compressionThresholdBytes` |

- 单位后缀强制：`_MS`、`_PX`、`_BYTES`、`_PERCENT`。
- 禁止 1–2 字符标识符（`i/j` 循环、`e` catch、`t` 翻译函数例外）。
- 禁止 `data/info/temp/obj/val/manager/helper/flag` 作局部变量名。
- 缩写白名单：`id`、`url`、`api`、`http`、`json`、`css`、`ms`。
- 同一概念只用一个词；不要 `pet`/`instance`/`item` 轮换。

## 7. 变量

按角色分类，每类有自己的规则：

| 种类 | 形态 | 规则 |
|---|---|---|
| 模块常量 | UPPER_SNAKE | 只在定义处赋值；单位入名 |
| 共享常量 | 集中在 `constants.ts` | 一个概念一处定义；跨包用 type-only 引用 |
| 配置值 | `config.xxx` | 只来自 schema；只读；不再兜底 |
| 环境变量 | `DSH_<PKG>_<NAME>` | 只在 `env.ts` 读一次并解析；非法即失败 |
| 可变状态 | camelCase | 只存在 store/闭包；不导出可变对象 |
| 模块单例 | `xxxStore`/`xxxRegistry` | 必须可 dispose；测试可重置；初始化顺序写进模块头 |
| 缓存 | `cache`/`byId` 后缀 | 必须有失效策略与容量上限 |
| 计数器 | `seq`/`count`/`epoch` | 单调性写清；并发下不靠自增保证唯一 |
| 定时器 | `*Timer`/`*Handle` | 必须可清理；`unref` 策略统一 |
| disposer | `dispose*`/`*Off` | 必须被 `ctx.effect` 收集，禁止丢弃返回值 |
| 资源句柄 | `child`/`stream`/`fd`/`server` | 单一所有者；关闭顺序写进模块头 |
| 哨兵 | 禁魔法字符串 | 缺失用 `undefined`，无值用 `null`，不让一个值兼表两义 |
| 凭据 | `*Key`/`*Token`/`*Secret` | 只驻内存；禁日志；错误只回分类文案 |
| 路径 | `*Path`/`*Dir` | 内部用绝对路径；拼接后校验前缀 |
| 标识符串 | 常量导出 | route/service/slot/event 名禁止字面量散落 |
| 时间/随机 | `now`/`rng` 参数 | 纯函数不读时钟；随机可注入 |

位置规则：模块常量在 import 之后、类型之前；局部变量距首次使用 ≤10 行；循环不变量提到循环外；同一语义只声明一次。

## 8. 类型与接口

两种 schema 分工明确：

- **插件 `Config` 用 schemastery**：要能 dump JSON Schema 给 Loader 与 patch。
- **持久化 record / wire payload 用 zod**：`z.infer` 推导类型，同一 schema 之后还能投影成 RPC schema。

类型规则：

- 对外字段一律 `readonly`；数组 `readonly T[]`。
- 失败用判别联合：`{ ok: false; error: { code; message } }`，不用 `boolean + 可选错误`。
- 跨包契约只用 `declare module` 合并（`Context`/`Events`/`SlotMap`/`LocaleNamespaceMap`/`SessionProjectionMap`），不在本地复制一份。
- 配置类型从 schema 推导，不手写第二份。
- 禁 `any`；外部输入用 `unknown` + 逐字段校验；断言必须紧邻校验语句。
- 内部字段用 `#private`，不靠 `_` 前缀。
- 判别联合必须穷尽：`default: assertNever(x)`。

接口分层与稳定性：

| 层 | 内容 | 承诺 |
|---|---|---|
| 包导出面 | `exports` 的 `.`/`./client` | semver 约束 |
| 插件接口 | `name/inject/Config/apply` | Loader 契约 |
| 服务接口 | `Service` 类 + `Context` 增强 | 跨插件运行时契约 |
| 跨包类型 | `declare module` 合并 | 编译期契约 |

- 事件声明写清 `@mode emit`/`@mode waterfall`/`@mode serial`，载荷必须是可序列化判别联合。
- 注册类接口一律 `register(def) => disposer`：id 唯一、内置优先、重复注册抛错、注销只删自己那一次。
- 对外错误必须有稳定 `code`（kebab-case）+ 人话 `message`；`code` 变更等同 API 变更。
- 废弃用 `@deprecated 替代品与起始版本`，至少保留一个 minor。

## 9. 函数、控制流与分层

### 9.1 规模与复杂度

| 对象 | 上限 |
|---|---|
| 普通函数 | 40 行 |
| 导出 API 函数 | 60 行 |
| `apply` | 60 行 |
| React 组件（展示） | 150 行 |
| React 组件（实时：rAF / 指针 / 状态机） | 面板部分 150 行，驱动必须外置 |
| 自定义 hook | 80 行 |
| 类 | 200 行；方法 30 行；公开方法 10 个 |
| 参数 | 4（超过改对象） |
| 嵌套 | 3 |
| 圈复杂度 | 10 |

- 一个函数只做一层抽象：不混“决策 + IO + 格式化”。
- 布尔参数 ≥2 个、参数 >4 个，改选项对象或拆函数。
- 类只用于“有生命周期/多实例状态”；一次性对象必须在模块头写明“stop 后不可复用”。
- 实时组件按**驱动数量**判，不按行数：`ref ≥ 8`、`rAF 循环 ≥ 2`、或带指针状态机时，把驱动抽成 `createXxx(deps)` 工厂，组件只留「面板 + 装配」。拆分的判据是“这块有没有独立的失败模式”，不是“行数超没超”。
- 拿不准要不要抽时，用一条判据：**这块的规则能不能脱离 DOM / React 断言？** 能（换算、优先级、状态转移、决策）就抽成纯函数并配测试；不能（帧时序、指针捕获、布局写入）就先收拢状态，别急着换文件。

### 9.2 控制流

- 卫语句 + 早返回；成功路径保持最左缩进，`else` 只用于真正对称的分支。
- 嵌套 ≤3；超出就提取函数或改查表。
- 同一概念的分支 >3 个（例如 `kind` 有四种以上）改 `Record<Kind, Handler>`，并用 `assertNever` 兜住穷尽性。
- 循环内不做 IO；嵌套循环先建索引；能一次遍历解决就不要两遍。
- 禁止嵌套三元；`if (x) return true; return false;` 写成 `return x`。
- 复杂条件先命名：`const isStale = ...`，不要整段塞进 `if`。

### 9.3 校验边界

DSH 的写法是“解析一次，之后信任”：

- 外部输入在入口解析一次：`parseX(raw): X` 返回**已校验的值**，不返回 boolean。
- 分工：schema 负责类型/必填/枚举；`parseX` 只补 schema 表达不了的约束（非空、范围、去重、组合）。
- 解析后向下传已校验类型（branded 或解析后对象）；内部函数不再校验。
- 配置在 `apply` 入口一次性解析：校验 + 填默认 + `deepFreeze`，之后只读。
- 只有三种情况允许二次校验：跨进程边界、跨版本读取、从介质读回。
- A 校验后调 B、B 又校验——二者只能留一个：B 是公共 API 就删 A 的校验；B 是内部函数就删 B 的校验。

### 9.4 分层与依赖方向

按能力缝分四层，不照搬 controller / service / mapper：

| 层 | 形态 | 只做 | 禁止 |
|---|---|---|---|
| 入口 carrier | 路由 handler、slot 组件、tool `execute`、CLI 命令 | 解析输入、调服务、写响应/渲染 | 业务规则、直接读介质 |
| 服务编排 service | `Service` 子类、registry | 注册、路由、生命周期、事务边界 | 纯计算、文案拼接 |
| 领域 domain | 纯 fold、parse、format、policy | 规则、换算、状态转移 | IO、时钟、随机、DOM |
| 介质适配 adapter | storage backend、LLM adapter、HTTP client、bridge | 序列化、持久化、协议 | 业务判断 |

- 依赖单向：carrier → service → domain；adapter 由 service 调用；domain 不依赖任何层。
- 按需分层：小插件不强行四层，但 **domain 不得依赖 carrier**。
- 模块头写非目标，官方写法是“owns only X, never Y”。
- 同一结果给多处消费时，结构化数据只构造一次，渲染各自做薄映射。

### 9.5 副作用与错误位置

- 副作用集中在入口与 adapter；领域函数不读时钟、不写盘、不发请求。
- 时间、随机、IO 通过参数注入，便于测试。
- 领域抛语义错误（带 `cause`），入口转成结构化结果；不在中间层重复包装。

### 9.6 调用依赖

- 依赖分两种：import 边与调用边。import 环用工具禁，调用环由装配根拉直。
- 双向通信只能经装配根注入的函数或事件，禁止两个模块互相 import。
- 下层通知上层：注入回调或发事件，不 import 上层。
- `let` + 延迟引用只允许出现在装配根，业务模块禁止。
- 命名区分“请求”与“执行”：`requestRestart()` 不等于 `restart()`。

### 9.7 实时驱动

rAF 循环、指针状态机、定时器泵这类实时设施共用一套骨架，按这张表走，不要在同一仓库里各自发明：

| 要素 | 做法 | 为什么 |
|---|---|---|
| 帧句柄 | 驱动内部持有 `frame: number \| null` | 必须跨渲染存活；放组件里，重渲染后就失去了取消能力 |
| 世代号 | 起跑/停止时 `token++`，帧首 `if (token !== own) return` | 迟到的帧自弃，旧循环不会改到新状态 |
| 实例 | 组件里 `xxxRef.current ??= createXxx({...})` | 每渲染重建会丢句柄；只建一次，则依赖必须全走 getter |
| 依赖 | 全部 getter（`box()`/`physics()`/`viewport()`），不传快照 | 驱动活过多次渲染，快照会陈旧 |
| 停止 | `stop()` 取消帧、清句柄、清派生状态；要停谁由调用方决定 | 一条驱动只管自己，不 import 兄弟驱动 |
| 写入 | 帧内同步写 DOM 与实时值，落定才提交框架状态 | 把写入推迟到回调里，重渲染会读到旧值，只在特定渲染节奏下暴露 |

组件侧只留三件事：把 getter 束装配起来、把驱动方法接到视图、在卸载时 stop。

判据：**这块有没有独立的失败模式**（帧不取消会漏帧、句柄不跨渲染会丢循环、快照会陈旧）——有就抽成驱动；只是“行数多”不构成理由。

### 9.8 运行时注入的 React

组件库由宿主注入 react 能力（`h`、`useState`、`useEffect`、`useRef`）而不是直接 import 时，按这个模具写，不要每次重新设计：

```ts
/** 注入的 react 能力；类型只取用到的子集。 */
export interface XxxRuntime {
  /** 创建元素。 */
  h: typeof jsx;
  /** 状态。 */
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  /** 引用。 */
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
}

/**
 * 造 hook。
 *
 * @param rt - 注入的 react 能力。
 * @returns 接收视图输入的 hook。
 */
export function createXxx(rt: XxxRuntime) {
  return function useXxx(input: XxxInput): Xxx {
    // …
  };
}
```

- hook 定义在工厂闭包里，组件里无条件调用一次；返回的方法不依赖 `this`，可以在视图里直接传 `onClick: xxx.onClick`。
- 必须有 `useRef` 才能跨渲染存活的状态，一律用 `useRef` 持有；不要用模块级变量（会串到别的实例）。
- 注入类型用「只取用到的子集」，不要整份 `typeof React`——测试替身也得跟着实现全部方法，成本会翻倍。

## 10. 配置与状态

配置：

- 一份 schema 是唯一真源：类型、默认值、校验、文档都由它派生。
- 未知字段默认拒绝（`strict`），要放行必须显式并写明理由。
- 优先级固定并写进模块头：内置默认 → bundle patch → profile patch → 用户覆盖 → CLI。
- 字段改名/改语义必须提供迁移与版本号；迁移幂等；失败不写半成品。
- 敏感项标 `secret`：不回显、不落日志、不进 dump。
- 配置变更必须走同一条重载路径；重载失败保留旧值并报错。

状态：

- 持久化状态必须有 `stateVersion`；升版提供相邻迁移，旧数据可回放。
- 投影 `apply` 必须是纯同步函数：`(state, event) => state`，禁止 IO/时钟/随机。
- 未关心的事件返回**同一引用**，让框架用 `Object.is` 短路。
- 持久化状态必须是 plain JSON。
- 携带状态的日志事件必须给完整变更后状态，禁止裸 delta。
- 写链语义：先等持久化成功 → 再改内存 → 再发变更事件；失败则内存不动。
- 持久化行只是“fold 捷径”，版本不符或 seq 超界就丢弃，不当权威。

## 11. 并发与资源

- 所有等待有超时；超时常量命名并注明依据。
- 异步入口接受 `AbortSignal` 并贯穿到最内层；取消后不再写响应/状态。
- 禁止 floating promise：要么 `await`，要么 `void` + 注释说明，要么进队列。
- 同一资源的并发写必须串行化（队列/锁/单飞）；读可以并发。
- 流式输出必须有界；队列必须有上限与丢弃策略。
- 清理顺序固定并写进模块头：摘监听 → 停定时器 → 关流/子进程 → 落盘。
- 子进程用 `stopAndWait` 语义；重启退避 + 熔断；禁止新旧进程重叠。
- 定时器统一 `unref` 策略；请求级与长驻级分开。
- 注册返回的 disposer 必须交给 `ctx.effect`；不允许“注册了但没人清理”。

## 12. 错误与日志

错误分三类：

| 类型 | 例 | 处理 |
|---|---|---|
| 用户错误 | 参数非法、配置非法 | 4xx / 明确文案；不记 error |
| 系统错误 | IO、网络、超时 | 5xx / 归一化 code；记 warn/error；可重试 |
| 依赖错误 | 服务缺失、凭证缺失 | 降级或明确不可用；严禁冒充成功 |

- 抛错带 `cause`：`throw new TypeError(msg, { cause })`。
- 错误信息写“期望什么、收到什么”，不写“出错了”。
- 安全相关错误只回分类文案，绝不回显凭据、完整 URL、请求体。
- 日志用 `ctx.logger`，禁裸 `console.*`（客户端可用，但统一前缀）。
- 日志结构化：级别 + `event` + 关键字段 + `durationMs`；不打印用户内容。
- 每个插件一个日志前缀；请求级日志带 session/trace id。

## 13. 安全

- 输入：长度上限、类型白名单、枚举白名单；路径拼接后校验前缀；URL 只允许 http/https。
- 凭据：只驻内存；错误脱敏；不写日志、不落盘；读取时校验文件权限。
- 命令：禁止 shell 拼接；参数数组传递；命令固定时也要防路径含引号。
- HTML：外部文本一律转义；富文本走白名单节点树 + 容量上限；CSP 默认拒绝。
- 网络：默认只监听回环；跨源默认拒绝；令牌比较用 timing-safe。
- 供应链：lockfile 入库；依赖构建脚本默认禁用；发布 job 与构建 job 权限分离。

## 14. 客户端 UI

- 插槽由 owner 声明 `kind`（single/list/keyed/chain）与 `scope`（root/session-maybe/session），registrant 只消费。
- props 由框架三段合成：`PropsRuntime<slot>` + `InjectFace<...>` + `PropsLocale<ns>`；组件不自己造 `t`。
- 每个导出组件 props 字段：语义不显然的写一行，坐标/尺寸/名字这类不写（细则见 `dsh-plugin-comment-spec`）；返回类型显式 `JSX.Element | null`。
- locale：`locales.ts` 里 `zh` 是 key 集真源，`en` 键集必须一致；`type Key = keyof typeof zh`；key 用 `<域>.<对象>.<角色>`。
- `locale/zh.json` 只放市场元数据（`meta.title`/`meta.description`），不放 UI 文案。
- 组件拆分：展示组件单组件 ≤150 行；`useState` ≤5；`useEffect` ≤6；派生状态抽纯函数。实时组件（rAF / 指针 / 状态机）按 §9.7 把驱动外置，面板本身仍受 150 行约束，`useState`/`useEffect` 的额度只算面板自己的。
- 样式只用 `--dsw-*` 设计 token，禁止字面色值；优先用 primitives，不重复造按钮/菜单/弹窗。
- 尺寸、间距、圆角走 token 或共享常量；CSS 注入只允许一个 `injectStyleOnce(key, css)` 入口。
- 无障碍：可点元素用原生语义或 `role="button" tabIndex={0}` + Enter/Space；图标按钮有 `aria-label`；状态用 `aria-expanded`/`aria-live`；焦点可见；键盘可达。

## 15. 注释与文档

注释细则见同目录的 `dsh-plugin-comment-spec`，这里只列硬约束：

- 文件头按角色分档：入口/装配/驱动/带状态 hook 写 4–8 行（职责、非目标、依赖、不变量），普通模块 1 行，纯函数叶子可省略。
- 每个导出一行摘要；复杂函数写 `@param name - 语义`、`@returns 边界`、`@throws 条件`。
- 只写“为什么”，不写“做了什么”；禁历史叙述、文件路径引用、无主 TODO。
- 覆盖率豁免必须带原因：`/* v8 ignore next N -- 原因 */`。
- 注释语言跟随项目，标签与结构不变。

文档：

- `README.md` 与 `README.zh.md` 成对，顶部互链。
- frontmatter 固定 `description` + `kind: "package-reference"`。
- 章节固定：概述 → 使用本包 → 理解实现（含源码地图、导出形状）→ 进一步探索 → 模型体验（工具类）→ 已知限制 → 开发备注。
- 章节锚点用 `<a id="kebab-case"></a>`；长实现说明放 `<details>`。
- 双语 README 用 `README.i18n.yaml` 记录每个 heading 的中英哈希；改一侧必须同步另一侧并重录。
- 设计决策写进 `notes/<date>-<topic>.md` 或 ADR，README 链接过去，不塞进代码注释。

## 16. 测试

### 16.1 测试类型

| 类型 | 测什么 | 放哪 | 占比 |
|---|---|---|---|
| 单元 | 纯函数：parse / format / 换算 / 状态转移 | 与被测同目录 | ~70% |
| 契约 | 插件注册了什么、清理了什么 | 与被测同目录 | ~20% |
| 集成 | 组件 + slot + locale 的组合行为 | `tests/integration/` | 少量 |
| 端到端 | 启动、路由、失败矩阵 | `tests/*.expected.e2e.ts` | ~10% |

- 组件测试用真实渲染，不用大快照。
- 需要 HTTP 的测试用可控替身：本机 stub、`nock`/`msw`、注入的 fetch 任一即可；断言请求形状、超时、重试与失败归一化，不依赖真实账号与当前时间。
- 默认测试套件不访问公网与真实服务商；需要真实服务商的用例单独放 `*.live.test.ts`（默认 skip、需显式环境变量、不进 CI）。

### 16.2 文件与目录

- 一个源文件对应一个测试文件：`foo.ts` ↔ `foo.test.ts`，同目录。
- 跨模块集成放 `tests/integration/`；e2e 放 `tests/*.expected.e2e.ts`。
- fixture 放 `tests/fixtures/`，只读；需要写入的用每个 test 自建的临时目录。
- 测试辅助函数放 `tests/support/`，不叫 `utils.ts`。
- 测试文件 ≤600 行；超过按行为分组拆，不按“第 1 部分 / 第 2 部分”拆。

### 16.3 写法

- `describe('<模块/函数>')`；`test('<行为>：<条件> → <结果>')`，中文。
- AAA：准备、执行、断言；一个 test 只验证一个行为。
- 断言消息写“应该是什么”，失败时能直接定位。
- 每个 test 自建 ctx / store / 临时目录；测试之间不共享可变状态、不依赖执行顺序。
- 时间、随机、网络、文件系统通过参数注入。
- 契约测试至少断言两件事：注册成功、dispose 后清理干净。
- 网络测试：每个 test 自建 server、随机端口、结束时关闭；断言请求头/路径/超时，不依赖公网。

### 16.4 禁止

- 新增读源码的正则守卫（如“这个文件里必须出现某个符号”）：它测的是文本不是行为，重构一动就红。存量守卫登记进 baseline，只减不增；改到相关文件时把守卫换成断言行为的测试。
- mock 被测模块的内部函数。
- 大对象快照。
- `sleep` 等待；用条件轮询或注入时钟。
- 测试之间传状态（全局变量、模块级缓存）。
- 断言实现细节（私有字段、调用次数）而非行为。

### 16.5 覆盖率

- 新增/改动行 ≥80%；纯函数 ≥90%；不追全量数字。
- 未覆盖的存量登记 baseline，只降不升。
- 覆盖率豁免必须写原因。
- 测试行数 : 源码行数 ≈ 0.8–1.2。

## 17. 构建与发布

- 构建用 tsdown，产物 `lib/`；客户端 bundle 形态为 `window.__ModuleLoader__.load({ id, factory })`，`react`/`react-dom`/`@deepseek-ai/*` 外部化。
- 发布前必须跑：`typecheck → lint → format:check → test → prepack-check`。
- `files` 白名单只能有一个来源；生成器、打包器、检查脚本都从它派生或对它断言。
- 生成物（`lib/types/**`、bundle、schema dump、catalog、i18n 哈希）标 `@generated` + 生成命令；CI diff 校验。
- 版本与 DSH release 同步；打 tag 前校验 `package.json.version` 与 tag 一致。
- CI：PR 跑全量门禁；发布独立 job，`contents: write` 只给它；构建 job 用只读权限。

## 18. 性能

- 预算：bundle 大小、启动时间、单次请求内存、首屏时间，各有阈值并进 CI。
- 缓存：只缓存纯计算结果；有 key、有上限、有失效；缓存不改变语义。
- 懒加载：SDK、解析器一类重依赖动态 import，不进启动路径。
- 热路径（rAF、轮询）禁止每帧新建大对象/闭包；派生值缓存。
- IO：批量读、避免重复 stat；文件监听去抖。

## 19. 禁止清单

1. 函数式插件导出 `default`（会让 Loader 丢 `inject`）。
2. 客户端插件缺 host 半边 `apply()`。
3. 只声明 `exports["./client"]` 而漏 `dsh.client`。
4. `dsh.client.inject` 的包漏出 `devDependencies`。
5. 手写第二份配置默认值。
6. 用字面色值/硬编码 px，不用 `--dsw-*`。
7. `utils.ts`/`common.ts` 杂物袋。
8. 跨插件复制类型/常量/协议。
9. 单文件 >300 行、单函数 >60 行、单组件 >150 行（实时组件的“驱动外置”见 §9.7，面板部分同样受此限）。
10. 注册了资源却没有 disposer 归属。
11. floating promise、无超时的等待、无法取消的异步。
12. 用 `console.*` 取代 `ctx.logger`。
13. 用注释写历史、写路径、写无主 TODO。
14. 发布清单与构建脚本各自维护。
15. 迁移没有版本号，或改格式不 bump `stateVersion`。

## 20. 提交前检查

- [ ] 插件类型明确，入口四件套齐全。
- [ ] `exports`/`files`/依赖三分/`dsh` 字段正确。
- [ ] 文件 ≤300 行、函数 ≤60 行、组件 ≤150 行；超限的先问“有没有独立变化原因”，没有就写明不拆，有才拆。
- [ ] 实时组件（rAF / 指针 / 状态机）的驱动已外置，帧句柄与世代号在驱动内部（§9.7）。
- [ ] 注入 react 的 hook 走 `createXxx(rt)` 模具，跨渲染状态用 `useRef` 而非模块级变量（§9.8）。
- [ ] 没有第二份常量/类型/规则/清单。
- [ ] 变量按种类放对位置；句柄与定时器有清理归属。
- [ ] 配置默认值只在 schema；未知字段被拒绝。
- [ ] 持久化状态有 `stateVersion` 与相邻迁移。
- [ ] 异步有超时/取消；没有 floating promise。
- [ ] 错误分类、带 `code`/`cause`、已脱敏。
- [ ] 日志结构化，不打印用户内容与凭据。
- [ ] 输入校验长度/枚举/路径/URL。
- [ ] 客户端只用 `--dsw-*` token，优先用 primitives。
- [ ] locale 的 zh/en 键集一致；键盘可用。
- [ ] 测试同目录、测行为、覆盖新增行。
- [ ] 生成物标 `@generated` 并被 CI 校验。
- [ ] README 有源码地图、双语成对、i18n 哈希已更新。
- [ ] 废弃/兼容有声明与迁移说明。
