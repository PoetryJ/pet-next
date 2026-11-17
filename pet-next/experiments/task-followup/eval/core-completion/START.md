继续 R6；主线固定为“持续委托、任务记忆、必要介入”。不要重做 R0–R5，也不要修完一个点就封包。

Codex 已写好并验过
- 多报告任务显式使用 analysisWhen=always；单报告需要分析时也可在 POST /api/tasks 传该值。旧的“只在失败时分析”模式保持兼容。
- continue_now 真正执行 write_analysis；授权绑定问题、任务版本、派工与整个 InputSet。等待不是授权。
- 工具读取每个来源的内容寻址快照，产出逐来源指标、失败明细、下一步；这是确定性测试报告分析，不是模型自由推理。
- 完成要求实际文件、SHA、成功回执、执行身份、可见问题的授权和当前全部输入匹配。依赖变化后旧判断重算，旧授权失效。
- tests/r6-completion.test.ts：7 项；eval/core-completion/run.mjs：真实进程/RealClock/JUnit/HTTP/重启/取消，独立核验与 3 类负控。Codex Windows 通过 25 项，独立核验 24 项。
- 当前产品 158/158、能力 67/67、typecheck 0。原始记录另存 pet-core-completion-evidence-20261117；初次失败也保留。

你这一轮必须完成的结果
1. 可用端点预检；接通真实 V/T 记忆差异与 12 个不同故事。
2. 核心门通过后，同一次执行自动进入 72 次真实对照；产生按故事配对的收益和成本表。允许方法输，不允许缺测伪装完成。
3. 所有更改、原始请求响应、失败与重试、72 份运行记录及可复现命令一起交付。

并行分工（真有可写 agent 才并行）
A 独占 memory 适配层：V=当前版本记忆；T=文本摘要+检索基线。模型实际请求必须来自不同实现，先留请求包差异。不要只改 memory 标签。不要改 runtime/engine.ts、tools/workspace.ts 和上述核心门。
B 独占 eval/condition-followup/live/、数据与评分：替换旧 arithmetic CSV pilot；用真实 JUnit 导入。实现 run-matrix.mjs，完整驱动 12 故事（6 dev/6 heldout）、96 轮有意义历史、跨任务更正、报告乱序、重启/取消。先冻结故事、gold、用户回答规则与预期，再看 heldout 结果；不得改 gold 求胜。
负责人集成并跑全部实验：统一模型/温度/预算/用户行为；若无可写 agent，按依赖顺序做完这三块，如实报告人数。

执行入口（从 task-followup 目录）
1. node run.mjs test
2. node run.mjs typecheck
3. node --experimental-transform-types --no-warnings eval/core-completion/run.mjs --out <新目录>
4. 完成适配器后：node eval/core-completion/run-round.mjs --plan <matrix-plan.json> --out <新目录>

第 4 条自动跑核心回归→完整宿主演示→真实矩阵→覆盖检查；不要在 core_e2e 后结束。run-round.mjs 尚未跑真实矩阵，它是你集成的固定入口。旧 run-live.mjs 已堵住无产物假通过，但旧 --matrix 仍只有标签与重复 pilot，不是正式矩阵。

run-matrix.mjs 的短接口
- 接收 --plan / --out；必须使用真实模型。不导入 gold 到宿主/请求。策略表现失败也继续其他 run；基础设施失败保留原文并尝试恢复，仍未恢复非零退出。
- plan.schema=pet-r6-matrix-plan/v1；cases=[{id,split:dev|heldout}] 共 12；runs=[{id,caseId,arm,repeat}] 共 72。12×5 臂 repeat=1，加 6 heldout×(V-L,V-C) repeat=2。五臂 V-R/V-L/V-C/T-L/T-C。
- <out>/coverage.json={planSha:原 plan 文件 SHA256,runs:[{id,rawPath:相对路径}]}；每份 raw 至少含 mode:live、arm、scenario=caseId、startedAt、finishedAt、timeline、ok（策略是否达成任务）、cost.physicalPosts（真实 POST 含失败/语法重试）。保留实际请求响应与 SQLite，不只给摘要。
- <out>/comparison.json 与 cost-ledger.json 必须存在。有效完成使用 core-completion/verify.mjs（先规范 Windows 路径再跨平台读归档；原始字节不改）；别把状态 completed 当有效完成。
- 对照主指标：有效完成、必要决定漏报、无用打扰、真实 token/延迟/重试与兜底代价。给逐故事配对明细，再汇总。C/V 都不得以缺请求或缺来源换成本优势。

运行环境
- Node 24；tooling 的依赖与 producer/test-report/tooling 的 XML 依赖均安装；保留只读兄弟目录 memory-consistency。
- h20v7 原 Qwen3-8B 地址 127.0.0.1:18882/v1（备用 18883），PET_MODEL_NAME=Qwen3-8B、PET_MODEL_DISABLE_THINKING=1、PET_MODEL_TEMPERATURE=0。不要假设服务已启动。
- Codex 2026-11-17 11:51 实查：18882/18883 未监听，两张 A10 均有其他计算负载。先辨明已有服务/执行环境；不终止不属于本任务的进程。模型不可用时继续适配与数据准备，具体阻塞写 STATUS，不得以零调用宣布本轮完成。
- 真实调用累计最多 2000 POST / 800000 token（包括开发、失败和重试）；到限停止模型调用并保留剩余列表。可执行的负结论也算研究结果，缺测不算。

交付仅一次：REPORT（解决问题/经典对应/方案原因/有效结果/根因修正/未证明）、代码提交、raw 与账本、复现入口。STATUS 只有 ready_for_review 才表示计划内工作全测完；blocked 必须列具体失败与恢复尝试。不要合 main、改产品默认或另开新主线。
