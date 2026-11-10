# M3-13 R0 记忆一致性实验 · 状态

更新：2026-11-11 00:00 (+08)｜启动 2026-11-10 19:54:52｜12h 截止 11-11 07:54｜11h 停新工作 06:54

## 基线

- BASE（启动时已提交 HEAD）：`9621d4872aefaee235690d59018712c9a14a8e32`（m38-wt-lead，`codex/pet-next-m3-idle-roi-r1`）
- 工作树：`/data3/DATA/project/project_meishijiang/petmem-wt-lead`，分支 `codex/pet-memory-r0-12h`（从 BASE 新建，未改动活动树）
- 活动树 `m38-wt-lead` 有未提交测试证据：未 reset / 未 clean / 未接管任何进程
- Node 运行时：`/root/.workbuddy/binaries/node/versions/24.14.0/bin/node`（v24.14.0；`node` 不在默认 PATH）

## 提交

- CODE_HEAD：`075d325`（A2+B2+D2+D4a）
- `e4b38d6` A1+C1+D1（纯账本、48 轨迹、独立评分与六负控）
- `652f721` G0（契约 v1 + 往返样例）

## 契约

- 事件 `memory-event/v1`、状态 `memory-state/v1`、补丁 `memory-patch/v1`、结果 `memory-result/v1`
- v1.1 增量（向后兼容）：`EventPayload.subjectKey`；`patchDigest` 不含 `snapshotVersion`（重试同意图仍幂等）
- 保留但未发出：`source_not_observed` 之外的错误码全部可达；`not_found`/`tail_incomplete` 保留未用（README 说明）

## 阶段门

| 门 | 状态 | 证据 |
| --- | --- | --- |
| G0 | 通过 | `tests/contracts.test.ts` 7 项；`tsc -p experiments/memory-consistency/tsconfig.json --noEmit` 0 错 |
| G1 | 通过 | 48 轨迹 / 143 断言全绿；六负控全部被指定反例检出；零外呼双证据（静态扫描 + fetch 哨兵） |
| G2a | 通过 | `storage/store.test.ts` 12 项 + `recovery/recovery.test.ts` 7 项（8 个崩溃点覆盖 7 个，`checkpoint.after-snapshot` 与 `after-manifest` 均验） |
| G2b | 进行中 | `eval/equivalence.test.ts` 5 项已绿（含「故意漏变更集必须被发现」的反向控制）；16 条新模板轨迹待建 |
| G3 | 未开始 | 依赖 G2b；失败实现不因更快而胜出 |
| G4 | 未开始 | 封包阶段 |

## 模块

- `ledger/` A1 纯 reducer + 补丁单写者路径（reduce 30 项、patch 14 项测试）
- `storage/` A2 JSONL 日志 + 版本化快照/清单 + 崩溃注入点
- `policies/` B1 四策略统一序列化与预算（9 项）
- `maintenance/` B2 全量/局部重建（槽位身份；共享 desiredFor）
- `cases/` C1 24 对 48 条合成轨迹 + 构建器 `--check`
- `eval/` D1 独立断言、六负控、零外呼哨兵、D4a 等价门

## 阻塞 / 决策点

- 平台：单核 2.2GB，无可用可写子代理（仅有只读探查代理）。四工作流由负责人在同一独立工作树按路径所有权顺序执行，未做多工作树并行；已在交付报告写明。
- `node` 不在 PATH：所有命令需前置 `export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH`。
- M3-12 R1 遗留收尾：待做（时间盒 45 分钟，仅离线重算，不改活动树）。

## 真实调用

- 模型 POST 0；未访问 18872；未碰 GPU；未接产品；未改默认；未合 main；未 push。

## 下一条命令

```
cd /data3/DATA/project/project_meishijiang/petmem-wt-lead/pet-next
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
node --experimental-strip-types --test --test-reporter spec "experiments/memory-consistency/**/*.test.ts"
```
