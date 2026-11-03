# M3-4 真实对照评分规则（D 持，2026-11-03 冻结）

不改 C 的样本/阈值。本规则用于人工逐例复核；不使用模型判卷、不做显著性统计。

## 原则

1. **盲看**：先只看 `userText` 与回复文本（盖住 arm 列）判断回复是否合理回应第三问，再看 arm 验证方向性。
2. **判语义不判字面**：关键词命中只是提示（workbook 列出），最终判定以人读为准；同义指称（如"小满"）算命中。
3. **off 臂的"不知道"不是错误**：单轮无上下文，模型说不知道/答不出是正确行为；off 臂编造出上下文内容才算异常（说明文本泄漏）。
4. **每例判定**（互斥）：
   - `hit`：on 臂利用了上下文（S1/S2 观测点命中）或 S3 reset 后正确不记得；
   - `miss`：on 臂观测点未命中（该有的上下文没用上）；
   - `leak`：off 臂或 S3 reset 后出现旧信息（不该有的上下文出现了）；
   - `truncated`：回复被 max_tokens 截断（meta.truncated / finish_reason=length），质量判定搁置；
   - `error`：status 非 ok 或 HTTP 非 200（根因归服务/链路，不算模型分）。
5. **S3 特别判定**：两臂 R3 回复出现"豆包"或自称记得宠物 → `leak`（reset 语义失效或幻觉，需对照请求体确认 messages 是否真的单轮）。

## 每例核对项（workbook 已列材料）

- 账本：`cases.ndjson` 的 seq 与 `ledger.ndjson` attempt 行一一对应；attempt 计数 ≤ 18。
- 请求体：`request.body.messages` 角色序列与 `historyInjected` 一致（on 臂非 reset 第三问应为 system+4 历史+user=7 条；off 臂恒 2 条；S3 两臂第三问 2 条）。
- reset 语义：S3 例 `resetBeforeRound=true` 且 messages 单轮。
- usage：`meta.usage` 缺失时为 "unknown"，不推算。
- 延迟：`fullLatencyMs`（send 全程）与 `meta.latencyMs`（provider 测量）同列，异常大的标注。
- 字节增量：同场景 on/off 第三问 `request.bytes` 对比即"上下文代价"的直接材料。

## 汇总口径（报告用）

- 只报：每臂每场景判定计数、每例原文摘录、输入 token（有 usage 时）、完整回复延迟、请求字节增量。
- 3 场景×1 次重复是**产品对照演示**，不称统计显著；请求数不等于质量。
- fake（fixture）产物只验证评分流程与预算保护，不得进入真实结论。

## 负责人建议模板（最终报告用）

- 建议开启默认 on/off：仅基于上述小样本 + 延迟/费用代价，注明这是负责人决策，报告只给材料。
