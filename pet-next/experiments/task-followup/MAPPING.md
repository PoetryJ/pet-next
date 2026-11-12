# 上游 SuperAgent 映射说明

固定上游：`deepseek-ai/dsh-superagent-prototype@8c32a9dc5d72c033816c6a8110b37f40cf94fba4`（MIT）。
本目录 `upstream/src/core/` 的 15 个文件字节不改；`upstream/tests/` 是原测试副本，用 vitest 4.1.8 原样运行（144/144）。

## 概念映射

| 上游 | 本实验 | 说明 |
| --- | --- | --- |
| Ticket | 长期委托 | 一个“跟进实验 E17”的委托在面板关闭、进程重启后仍然存在。 |
| Assignment | 一次执行 | 每次启动/恢复产生一个 assignment；`assignmentId` 与 `taskRevision` 是不同身份。 |
| Input | 到达的信息 | inbox 结果、用户回答、目标更正都作为 Trigger 进入 ticket。 |
| Attention | 用户问题 | 上游只存 `id + question`；本实验在本地表里补选项、证据、`decisionKey`、版本与等待原因。 |
| Report | 状态回报 | `progress / waiting / ready / blocked / failed / dropped` 原样使用；`ready` 才结束 ticket。 |
| Decision | 接受/停止/忽略 | 委托创建走 `accept`；用户取消走 `stopTicket`（by human）。 |
| Policy.gate | 本地策略 | 只放行 `pet` / `inbox` 来源；人类消息 explicit，观察事件 inferred。 |
| Executor | effect 队列 | `start/deliver/stop` 只入队；事务提交后才派发，工具/启动不在事务里执行。 |
| Outbox | 本地通知表 | 不发送真实消息；面板读同一张表。 |

## 本地新增（不属于上游）

- `taskRevision`：用户改变目标/约束或取消时递增；提案、执行、通知三次校验都绑定它。
- `EvidenceRef`：来源身份 + 内容 SHA + R3.1 记忆事件/笔记版本；执行前重验。
- `ProposedDecision`：`record_only / continue_local / defer / ask_user / notify_result`，每条都写理由、证据、选择与时间窗。
- `AttentionPort`：同 `decisionKey` 合并；旧问题回答记 `stale_answer`；显式静默/额度/最小间隔。
- SQLite 权威事件与 effect/receipt 表：上游仓库端口用 JSON 聚合文档落盘，单写者事务。
- `InputRef`（R4.1）：把 taskRevision/assignmentId/sourceRevision/resultFileSha/artifactSha 绑定到 effect、回执与分析；派发前核对当前权威结果与磁盘字节。
- 完成检查：读真实产物与 SHA + 成功回执 + 当前目标事件 + 当前输入与 receipt/analysis 的输入身份逐项相等，缺一不可。
- 可见性回执（R4.1）：通知 `queued → delivered → presented`，回答只认已送达/已呈现；写库不等于用户看过。
- 回执合法性（R4.2）：`accept_receipt` 只接受成功、已核验、身份全等、输出字节正确的当前回执；
  失败/未核验/输出缺失均为明确拒绝码，不解除 `needs_reconciliation`。
- 续办状态（R4.2）：执行前输入拒绝 → `continuation` + `continuation_pending`；
  输入恢复后只提一个绑定版本/attempt 的重新授权问题，新授权前不执行。
- 评分身份（R4.2）：ask→attention 用 `decisionId` 精确连接并校验 ticket/版本/派工；
  `decisionKey` 不再当身份。
- 显式时区（R4.1）：`quiet.timezone` 是 IANA 名称，计入 configSha 与 raw；不读宿主 TZ。

## 明确的边界

1. 上游 `Engine.report(ticketId, report)` 不带 `assignmentId`；桥接器在调用前检查 `runningAssignment(ticket).id === task.assignmentId`，旧 assignment 报告被挡住并留 `driver_log`。
2. 上游的 `ready` 只表示 worker 报告成功；本实验只有在 `completionCheck` 通过后才调用 `report({state:'ready'})`。
3. `assignmentInterrupted` 的语义来自上游：若最后一次报告是 `waiting/ready/blocked/failed` 且之后没有输入，保留会话；否则用恢复说明重启 assignment。本实验只在恢复路径调用它。
4. 没有把上游的模型/DSH/GitHub/Feishu 部分搬进来；assessor 是空实现，实际决策由 `DecisionPort` 完成。
5. 外部副作用不声称 exactly-once；本地工具用 `effectId + receipt` 去重，无法确认的执行进入 `needs_reconciliation`，不盲重试。
