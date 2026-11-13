# capability（能力线 B）— 记忆 / 模型 / 介入

独占目录：`capability/memory`、`capability/model`、`capability/intervention`、`capability/tests`。
旧 `memory-bridge/`、`decision/rules.ts`、`decision/r5/*`、`product-shadow/*` 原样保留作基线，未改动。
运行只需 Node 24（直接运行 .ts，type stripping；对 `../../contracts.ts` 仅 `import type`，运行时不加载）。

## 模型配置（只用环境变量名，不落盘、不打印 key）
- `PET_MODEL_BASE_URL`（如 `http://127.0.0.1:18881/v1`）、`PET_MODEL_NAME` 必填
- `PET_MODEL_API_KEY` 可选；**未设置时只允许 loopback**（127.0.0.0/8、localhost、::1），否则 `not_configured`
- 可选：`PET_MODEL_TIMEOUT_MS`(60000)、`PET_MODEL_MAX_TOKENS`、`PET_MODEL_TEMPERATURE`(0)、`PET_MODEL_PROVIDER`(元数据标签)、
  `PET_MODEL_NO_RESPONSE_FORMAT=1`（服务端不支持 `response_format` 时关闭）
- 失败码：not_configured / timeout / aborted / provider_error / http_error / empty_output；解析失败 parse_error。任何失败都不产生占位成功。

## 命令（在 experiments/task-followup 下）
- 单元/机制测试：`node --test capability/tests/adapter.test.ts capability/tests/chain.test.ts`
  （夹具 FixtureClient/fakeOpenAI 只验证管线，不是被测模型，不可用于能力结论）
- SCHEMA 候选臂：`node capability/model/schema-adapter.ts --cases <cases.jsonl> --out <新目录> [--max-items 40 --max-chars 6000]`
  输出 `responses.jsonl`（guard 前原始提案，{caseId, response}）、`trace.jsonl`（两次调用原文/模型元信息/抽取校验/packet/guard 后）、`requests/`、`failures.jsonl`；任一失败 exit 1
  预算：每 case 固定 2 次模型调用（1 抽取 + 1 assessment）
- 开发故事实跑：`node capability/intervention/dev-story/run.ts --out <新目录>`

## 给集成负责人的接口（宿主消费）
```ts
// 记忆（宿主单写者：可把已打开的 DatabaseSync 传入，表名 cap_*）
new CapabilityMemoryStore(dbPathOrDatabaseSync)
store.appendTurn(turn: Turn)                       // 聊天每条原话；幂等；同 id 改内容抛错
store.retractTurn(turnId, at, reason)              // 删除/撤回
extractPending(store, client, { entities, now, signal }) // 事务外异步；返回 applied/failed/pending/nothing
readForDecision(store, { taskId, sessionId, asOf, asOfSeq?, intent, historicalAt?, question, requiredSlots, budget }) : MemoryPacket
// 评估（事务外异步）
snapshotFromTask(task: TaskSnapshot, now, options?) : AssessSnapshot   // options = 宿主可执行选项
assess(snapshot, packet, signal, client, question?) : Promise<AssessmentRecord>
submitAssessment(record, packet, { taskRevision, assignmentId, now }, store, snapshot) : SubmitResult
// 介入落库
const plan = new InterventionStore(store.db)
plan.apply(record, submit, now) : PlanOutcome     // waiting | notified | suppressed_duplicate | execute | none | rejected
plan.nextWakeAt() / plan.dueWaits(now) / plan.dueNotices(now)
plan.markSeen(noticeId, at) / plan.answer(noticeId, decisionId, answer)
plan.evidenceArrived(taskId, at, what) / plan.cancelTask(taskId, at)
```
异步生命周期：
1. 新原话/新结果到达 → `appendTurn`（工具结果以 role=tool 写入）→ 若有等待则 `plan.evidenceArrived`。
2. 宿主在事务外调用 `extractPending`，再 `readForDecision` → `snapshotFromTask` → `assess`（不持锁，可 AbortSignal 取消）。
3. 回交：读取**当前** task（revision/assignment）→ `submitAssessment`；拒绝码 stale_revision/stale_assignment/stale_memory 时丢弃并重新评估；
   evidence_*/wait_* 拒绝时保留 guard 前提案（已写 cap_assessments），宿主按 fallback 或原有规则处理。
4. 通过后 `plan.apply`：`execute` → 交给宿主现有执行与通知校验（optionId 必须来自 snapshot.options）；`notified` → 等 `dueNotices` 到期由 UI 呈现，UI 确认后 `markSeen`；
   `waiting` → 宿主 RealClock 在 `nextWakeAt()` 唤醒，`dueWaits(now)` 返回的任务重新走第 2 步。
5. 取消任务 → `plan.cancelTask`；之后该任务所有提案 `rejected:task_cancelled`，合并通知中只撤回该任务成员。
