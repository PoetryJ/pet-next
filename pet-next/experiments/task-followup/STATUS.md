# R4.1 任务状态（有限返工，按任务包逐项）

基线：`c7bd9052dbc33c47bc285411314f75a4a4057797`；分支 `codex/pet-followup-r4-1`；工作树 `/data3/DATA/project/project_meishijiang/petmem-followup-r4-1`。
上游：`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`（MIT，15 文件字节不改）。

本轮只关闭 REVIEW 的三个阻断（F1 来源/完成证据、F2 重复恢复、F3 可见性/时间），
不调阈值、不改 gold、不新增功能、不调用模型。

| 修复包 | 状态 | 关键改动 | 证据 |
| --- | --- | --- | --- |
| 包 1 输入/执行/回执/分析同一来源 | 完成 | `InputRef` 持久化到 effect/receipt/analysis；派发前核对当前权威结果与磁盘字节，工具只读内容寻址快照；新来源修订使旧分析、未执行 effect、旧问题与旧授权失效；`completionCheck` 逐项比较并 fail closed | `tests/r41.test.ts`、`tools/r41-acceptance.mjs` c5/c6、负控 `stale-input` |
| 包 2 未知执行结果持久阻断 | 完成 | `running` 跨进程恢复转 `needs_reconciliation`；recover 任意次数不重建 assignment、不新建 attempt/receipt；`reconcile accept_receipt / abandon_attempt` 最小显式入口 | 验收 c4（真实 exit 42 + recover1/2/3）、负控 `repeat-recover` |
| 包 3 可见性与统一时间 | 完成 | 通知 `queued→delivered→presented` 与时间；回答只认已送达/已呈现；显式面板动作产生呈现回执；IANA 时区进入 quiet/configSha/raw；可控时钟单调且每步只用 at 或 advance 之一 | 验收 c7/c8、`tests/r41.test.ts`、负控 `hidden-answer`/`quiet-config`/`quiet-timezone-shanghai`/`clock-regression` |

## 检查数字（本轮现算，Linux Node 22.20.0）

- 单测：45/45（原 35 项全部保留，其中 2 项按新语义收紧；新增 10 项）。
- 独立验收（真实子进程、真实 exit 42）：27/27 断言通过。
- 评估：72 次运行（4 策略 × 18 机会，16 轨迹 dev/heldout 8/8）。
- 独立重评：72 份 raw，0 失配。
- 负控：10/10 detected（各自子进程 exit 1，无 MASKED）。
- 演示：19 项断言 PASS，每步独立进程；显式 `--timezone UTC`，回答前有呈现回执。
- 上游原测试：144/144。
- R3.1 只读回归：13 套件 192/192 + G1/P1/P2；R3.1 目录零 diff。
- typecheck：exit 0。
- 离线静态审计：32 个代码文件，0 禁用端点/网络客户端；上游 15 文件指纹 0 失败。

## 有效完成与覆盖（新口径，P3）

- 状态完成 8/18；**有效完成 8/18（44.4%）**——两者相等，本轮没有出现“状态完成但输入不一致”的样本。
- 必需问题 17 项：已产生 15、已可见 13、已回答 11；漏报 2（T10 `tool_failed`、T16 `insufficient_result`），产生但不可见 2（T15、T16）。
- 通知 16 条：送达 16、呈现 0；未回答 5、被替换 4；“实际无用提醒”1（定义见 `eval/score.ts`）。
- 隐藏问题被拦截的回答尝试 4 次；已回答但无可见回执的 attention 0 个。
- 运行时硬额度违规 0；gold 参考上限超标 1 个 run（两者分开字段）。

## 未完成 / pending

- Windows 入口本轮未运行（无环境）；负控已改成显式时区，但未在 Windows 复验，不能声称跨平台通过。
- 真实浏览器 UI 验收未做；本轮只有 CLI/HTTP 证据，面板 `POST /api/present` 未被真实浏览器触发。
- 模型适配器未启用（预算 0）。
- 断电/磁盘损坏/多写者恢复未测。
- P3 相对 P2 的完成率差（8 vs 7）与漏报差（2 vs 7）只作原始计数；不支持“更少打扰”的结论（通知 16 vs 13）。
