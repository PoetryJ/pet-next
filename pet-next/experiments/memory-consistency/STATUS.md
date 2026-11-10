# M3-13 R0 记忆一致性实验 · 状态

更新：2026-11-11 05:30 (+08)｜启动 2026-11-10 19:54:52｜12h 截止 11-11 07:54｜11h 停新工作 06:54

## 基线

- BASE（启动时已提交 HEAD）：`9621d4872aefaee235690d59018712c9a14a8e32`（m38-wt-lead，`codex/pet-next-m3-idle-roi-r1`）
- 工作树：`/data3/DATA/project/project_meishijiang/petmem-wt-lead`，分支 `codex/pet-memory-r0-12h`
- 活动树 `m38-wt-lead`：只读访问，未 reset / 未 clean / 未接管任何进程（其 `fake-model-service` 遗留进程未触碰）
- Node：`/root/.workbuddy/binaries/node/versions/24.14.0/bin/node`（v24.14.0）；默认 PATH 无 node

## 提交（本工作树）

| 提交 | 内容 |
| --- | --- |
| `652f721` | G0 契约 v1 + 往返样例 + 自检 |
| `e4b38d6` | A1+C1+D1 纯账本、48 轨迹、独立评分与六负控 |
| `075d325` | A2+B2+D2+D4a 日志/快照恢复、全量局部等价、四策略 |
| `de94d8c` | C1/C2/C3/C4+P1 新模板、泄漏审计、演示、入口与门禁 |
| `37173c9` | B3/B4/D4b/D5+P2 队列、未来 dry-run、成本、平台 |
| `da7e66a` | README/.gitignore、lint 清理；运行产物移出代码提交 |
| `d649ce1` | CODE_HEAD：`--verify` 跨轮确定性比对 |

- CODE_HEAD：`d649ce1f605c9a3a4ba225291de0e8068f22f967`（本次全部测试与门禁在该提交的干净工作树上跑出，`dirty=0`）
- 其后仅追加 `DELIVERY.md`/`STATUS.md` 文档提交，作为 ARTIFACT_HEAD；**不声称该文档提交跑过测试**。

## 契约

- `memory-event/v1`、`memory-state/v1`、`memory-patch/v1`、`memory-context/v1`、`memory-roundtrip/v1`
- v1.1 增量：`EventPayload.subjectKey`；`patchDigest` 不含 `snapshotVersion`
- 保留未发出错误码：`not_found`、`tail_incomplete`（README 已说明原因）

## 阶段门

| 门 | 状态 | 证据文件 |
| --- | --- | --- |
| G0 | 通过 | `out/logs/contracts.log`（7 项）+ tsc 0 错 |
| G1 | 通过 | `out/g1.json`：48 轨迹 / 143 断言 / 0 失败 / 6 负控 / fetch 0 |
| G2a | 通过 | `out/logs/storage.log`（12）+ `out/logs/recovery.log`（7，8 崩溃点覆盖 7） |
| G2b | 通过（限定） | `out/logs/eval.log` 中的 `D4a` 等价门；`out/p1.json` 新模板 16/47 |
| G3 | 通过（限定） | `out/p2.json`：仅在等价成立后比较成本；高扇出 not-run |
| G4 | 通过 | 交付目录有 `MANIFEST.json` / `SHA256SUMS.txt` / 增量 bundle；bundle 克隆后复跑 20 项测试与 G1 门禁通过（`bundle-clone-check.txt`） |

## 平台

- Linux 单核 2.2GB；`platform` 检查 5 pass + 1 `not_proven`（root 下只读目录）
- Windows：not-run，命令见 `out/p2.json` 的 `platform.windows.command`

## 阻塞 / 决策点

- 平台没有可写的子代理（只有只读探查代理），四个工作流由负责人在同一独立工作树按路径所有权顺序执行；
  已出现在交付报告，未伪称四人并行。
- 只读探查代理未在时限内产出 M3-12 R1 调查报告，改由负责人自做 30 分钟只读核对：
  独立重算与 `perArm` 完全一致，故保留原状、不重做。
- 单核导致墙钟时间受共享主机负载影响：成本结论只以操作量为主，时间仅参考。

## 真实调用

模型 POST 0；未访问 18872；未碰 GPU；未接产品；未改默认；未合 main；未 push。

## 下一条命令

```
cd /data3/DATA/project/project_meishijiang/petmem-wt-lead/pet-next
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
node experiments/memory-consistency/run.mjs --verify
node experiments/memory-consistency/run.mjs --demo
```
