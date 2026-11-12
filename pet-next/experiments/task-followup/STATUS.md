# R5 任务状态（G0 + 持续唤醒 + 强简单基线）

基线：`5e3dc881bb1c02f40cc9cda3680324614c291b6f`；分支 `codex/pet-followup-r5`；
工作树 `/data3/DATA/project/project_meishijiang/petmem-followup-r5`。
上游：`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`（MIT，15 文件字节不改）。

## G0（先做，单独提交）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| ask/attention 双方同时缺 ticketId/taskRevision/assignmentId 不算匹配 | 完成 | `effectiveInstance` 先验存在/类型（非空字符串、正整数），缺失/空串/非法 revision 明确降级 |
| 正式入口 identity-probes 7/7 | 完成 | 基线 3 失败 → 0；`before-fix/g0-probes.json`、`after-fix/g0-probes.json` |
| 正常 72 raw 主表不变 | 完成 | 与 R4.2 summary 逐项相同 |
| 旧 raw 无身份继续 fail closed | 完成 | `ask_decisionId_missing`，visible 0 |

## R5

| 项 | 状态 | 证据 |
| --- | --- | --- |
| A 持久唤醒 | 完成 | `runtime/scheduler.ts`、`wake_jobs` 表、`syncWake/wakeDue`；8 项调度测试（重启重建、重复幂等、旧版本 stale、取消失效、续办不误排） |
| A 安全重评 | 完成 | job 只触发 `proposeAll/drain`；取消/完成/更正/未知结果使 job 失效；不执行 job 内旧调用 |
| 服务 | 完成 | `service/scheduler-service.ts` + `serve --scheduler`（RealClock，PID/时区/configSha 落 `state/service.json`） |
| B NeedRule | 完成 | `decision/r5/`，独立配置 SHA；6 项规则测试；不改 P3 |
| C 12 故事 | 完成 | `fixtures/r5/`、`gold/r5/`（6 对，dev/heldout 各 3 对）；`eval/r5/` runner/score/crosscheck/6 负控 |
| 演示 | 完成 | `r5-demo` 23 项断言：真实时钟到期唤醒、重启不重复、授权后只执行一次、取消不提醒 |

## 检查数字（本轮现算，Linux Node 22.20.0）

- 单测：93/93（G0 新增 7；R5 新增 8 调度 + 6 规则 + 6 评分）。
- identity-probes：7/7（基线 3 失败）。
- R5 评估：24 runs（12 故事 × 2 策略）；独立 crosscheck 24/24 一致。
- R5 负控：6/6 DETECTED。
- R4 回归：72 runs 主表逐项不变；verify-eval 0 失配；10 负控；27 验收；demo 35；交叉核对 0 差异。
- 上游 144/144；R3.1 192/192 + G1/P1/P2；四 fixture exit 1；R3.1 目录零 diff。
- typecheck 0；静态审计 0 禁用项；上游 15 文件指纹 0 失败。

## R5 结果（P3 vs N1，12 故事）

| 策略 | 有效完成 | 产生/可见/回答/行动 | 漏提案 | 过期 | censored | 通知 |
| --- | --- | --- | --- | --- | --- | --- |
| P3 | 10/10 | 9/9/9/9 | 0 | 0 | 0 | 12 |
| N1 | 10/10 | 9/9/9/9 | 0 | 0 | 0 | 12 |

结论：本组冻结故事不支持 NeedRule 更少打扰或更高触达；两份规则持平，N1 无可报告收益。
详见 `out/r5/REPORT.md` 与交付 `r5/`。

## 未完成 / pending

- Windows 本轮未运行；`WINDOWS-PENDING.txt` 给命令，不能借旧结果。
- 真实浏览器 UI 未复验；服务演示是独立进程 + CLI/HTTP。
- 没有 12 小时稳定性；只有秒级实时序列和 10 分钟有界运行记录。
- 无模型/真实用户/远程任务；无断电、磁盘损坏、多写者、跨机恢复。
