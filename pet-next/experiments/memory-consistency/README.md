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
- **P1**：16 条新模板轨迹独立通过；防泄漏审计同时检查「标签哨兵」「未来事件」「序列化输入」；反事实配对要求行为不同、双方不变量成立、重复执行一致。
- **P2**：维护等价成立后才比较成本；主指标是扫描/重建/读写量，墙钟时间只作参考（共享主机、单核配额）。

## 明确未证明

- 真实模型生成质量、长程语义记忆、用户是否读到：全部 not-run。
- 断电/文件系统永久损坏下的耐久性：未测；只证明被测过的进程崩溃恢复。
- 高依赖扇出（一个笔记被很多下游依赖）下的成本：未构造，not-run。
- Windows 实跑：本机无 Windows 环境，not-run；命令见 `platform` 报告。
- 浏览器交互：演示页只做生成物与内容校验，未在真实浏览器点击验证。

## 已知限制

- 单写者：同一目录第二个写者被拒绝（`writer_busy`），不声称多写者支持。
- 日志要求 `sequence` 单调，否则拒绝写入（保证在线状态与重放一致）。
- 保留错误码 `not_found`、`tail_incomplete` 当前没有路径发出：前者留给未来的按 id 查询接口，后者由「隔离尾部」的返回值表达而不单列错误。
- root 下 `chmod` 不构成权限测试，平台检查会标 `not_proven`。
