# 记忆一致性实验（M3-13 R0）

离线、可复跑的机制实验。验证的是「事件身份、幂等、失效传播、补丁依赖、崩溃恢复、预算口径」这些工程性质；
**不验证模型理解、长程语义记忆或用户体验**。

- 零真实模型请求；不访问模型服务；不碰 GPU；不改主产品代码、默认配置与入口。
- 产品模块（`core/chat/history.ts`、`core/chat/session.ts`）只读导入，用于回放当前语义。
- 结论只覆盖：合成/脚本轨迹上的机制行为、纯 Node 进程崩溃恢复、本机操作量与耗时。

## 快速开始

```bash
cd pet-next
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH   # 本机 node 不在默认 PATH

# 全部套件 + 三道门禁，产物写到 experiments/memory-consistency/out/
node experiments/memory-consistency/run.mjs --all

# 只跑某一套
node experiments/memory-consistency/run.mjs --suite=ledger
node experiments/memory-consistency/run.mjs --gate=G1

# 重新生成离线演示（单文件 HTML，本地直接打开）
node experiments/memory-consistency/run.mjs --demo

# 列出现有套件与门禁
node experiments/memory-consistency/run.mjs --list

# 每次运行写新目录（默认 out/runs/<runId>）；归档无 .git 时必须显式给源码身份
node experiments/memory-consistency/run.mjs --all --out=/tmp/run-1 --source-commit=<sha>
```

`run.mjs` 本身是纯 JS；它用 `--experimental-strip-types` 拉起子进程，所以入口命令不需要额外 flag。

单独跑某组测试：

```bash
node --experimental-strip-types --test --test-reporter=spec \
  experiments/memory-consistency/ledger/reduce.test.ts \
  experiments/memory-consistency/ledger/patch.test.ts

node node_modules/typescript/bin/tsc -p experiments/memory-consistency/tsconfig.json --noEmit
```

## 契约（`contracts.ts`，冻结 v1）

| 概念 | 关键点 |
| --- | --- |
| 事件 | `memory-event/v1`；身份 `eventId`，顺序 `sequence`（接收序），墙钟只作描述 |
| 请求身份 | `sessionId + sessionEpoch + requestId`；跨代际复用是另一个身份 |
| 任务身份 | `taskId` + 单调 `taskRevision`；旧 revision 不能覆盖新 revision |
| 幂等 | 同 `eventId` 同载荷无效果；同 id 异载荷记冲突且不覆盖 |
| 生命周期 | 生成 / 呈现 / 确认 / 工具结算四个独立布尔；任一为真不推出其它 |
| 笔记 | `Note` 带 `sourceEventIds`、`parentNoteIds`、`dependencyVersions`、`status`、失效原因 |
| 补丁 | `memory-patch/v1`；A 从来源重算依赖，不信自报版本；失败整份不落 |
| 预算 | 只叫 UTF-16 code units 与 UTF-8 bytes；没有真实 tokenizer，不叫 token、不报价 |

v1.1 的两处向后兼容增量：

1. `EventPayload.subjectKey`：`task.changed` 可显式给 subject 键，缺省约定 `task:<taskId>`。
2. `patchDigest` 不含 `snapshotVersion`：一次网络重试只要笔记内容与依赖声明不变，仍算同载荷。

R1 追加的三条硬约束（都有对应回归）：

1. **来源依赖**：`task.changed` 自带 `taskId/revision`，补丁必须据此推导 `subject:task:<id>` 依赖；
   省略可选 `subjectKey` 不能再绕过撤销检查。
2. **失效也是版本断言**：`notesToInvalidate` 的目标版本必须写进 `dependencyVersions`；
   父笔记更新会级联失效下游 active 笔记，同批父子用「提交后版本」绑定，最终图不一致就整份拒绝。
3. **门禁信封**：`memory-gate/v1` 的 `schemaVersion/gateId/runId/sourceCommit/passed_gate` 必须与本次运行一致；
   缺文件、坏 JSON、旧 runId、`passed_gate=false`、空脚本 exit 0 一律判失败。

R2 追加的两条契约：

1. **尾段偏移**：`replayTail` 返回的截断位置是相对**整个日志文件**的绝对偏移（已含 checkpoint offset），
   `repairTail` 只接受绝对位置；持久化格式不变。
2. **反事实判据**：只认两侧独立 expected 派生出的 flip/stable/presence 字段，输入事件、trackId、时间戳不参与；
   泄漏审计按 class 全量覆盖四类 + derived，缺类即不通过。

成本口径（`CostCounters`）：`eventsVisited` 是真实迭代次数，`uniqueEventsTouched` 是去重条数，
`indexBuilds/indexLookups` 分开记；**不得把命中数叫扫描数**。

## 目录

```
contracts.ts          冻结契约（类型 + 确定性纯函数）
ledger/               纯 reducer、补丁校验与单写者应用、失效传播
storage/              JSONL 日志 + 版本化快照/清单 + 崩溃注入钩子
policies/             四策略统一序列化与预算
maintenance/          全量/局部重建、有界整理队列
cases/                24 对开发轨迹 + 8 对新模板轨迹（含构建器与 --check）
product-replay/       只读导入产品 core/chat，注入 Promise 回放
eval/                 独立断言、判分器、六种负控、防泄漏审计、等价门
recovery/             子进程崩溃恢复实验
studies/              固定规模成本比较
platform/             路径/权限/损坏/退出码边界
future-run/           下一轮模型实验的 dry-run 计划（无 live 传输）
demo/                 演示生成物校验
runner/               门禁计算（G1/P1/P2）
run.mjs               入口
```

## 结果与判读

`out/summary.json` 记录每个套件/门禁的退出码、耗时与原始日志路径；`out/g1.json`、`out/p1.json`、`out/p2.json` 是门禁明细。

- **G1**：48 条开发轨迹（24 对）143 条断言全绿；六种错误实现各自被指定反例检出；零外呼有静态扫描与 `fetch` 哨兵两重证据。
- **P1**：16 条新模板轨迹独立通过；防泄漏审计在**带补丁**的状态上跑，并报告覆盖度（active/invalidated/派生笔记、来源 ID 必须非零）；反事实只比行为（排除 trackId/时间戳），换名不得产生差异；重放把事件 + 已接受补丁一起过 store，关库重开后比笔记/版本/状态，另有「只存事件」负控。
- **P2**：维护等价成立后才比较成本；主指标是真实访问次数与重建条数，墙钟时间只作参考（共享主机、单核配额）。**R1 撤回性能主张**：局部重建仍是「每个受影响槽位扫一遍事件日志」，10k 事件实测约 1.9k 次访问 vs 全量约 1950k，不是索引加速。

## 明确未证明

- 真实模型生成质量、长程语义记忆、用户是否读到：全部 not-run。
- 断电/文件系统永久损坏下的耐久性：未测；只证明被测过的进程崩溃恢复。
- 高依赖扇出（一个笔记被很多下游依赖）下的成本：未构造，not-run。
- Windows 实跑：本机无 Windows 环境，not-run；`platform/windows-r1.ps1` 是待复验脚本。checkpoint 的 fsync 已改成可写句柄（原实现只读句柄在 Windows 会 EPERM），但**未在 Windows 实跑**。
- 浏览器交互：演示页只做生成物与内容校验，未在真实浏览器点击验证。

## 已知限制

- 单写者：同一目录第二个写者被拒绝（`writer_busy`），不声称多写者支持。
- 坏尾修复：隔离文件写不出去时整个 `open` 失败（宁可不打开），不会带着坏尾继续接受写入。
- 局部重建的 `eventsVisited` 与事件条数线性相关；不要把它读成 O(1)。
- 互斥的 POSIX 权限位在 Windows 上不存在：`readonly-dir` 在 Windows/root 下是 `not_proven`，
  错误传播另由 `controlled-io-failure` 证明。
- **Windows 全套尚未在本仓库执行**：`platform.windows.status=not_run`，入口脚本 `platform/windows-r1.ps1` 待 Codex 补验。
- 日志要求 `sequence` 单调，否则拒绝写入（保证在线状态与重放一致）。
- 保留错误码 `not_found`、`tail_incomplete` 当前没有路径发出：前者留给未来的按 id 查询接口，后者由「隔离尾部」的返回值表达而不单列错误。
- root 下 `chmod` 不构成权限测试，平台检查会标 `not_proven`。
