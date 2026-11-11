# R4 任务状态（按任务包逐项）

基线：`90fb4cd244ecae832377bd847ca185284ef976f0`；分支 `codex/pet-followup-r4`；工作树 `/data3/DATA/project/project_meishijiang/petmem-followup-r4`。
上游：`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`（MIT）。

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| 包校验 | 完成 | 288/288 文件 OK，无 FAILED。 |
| A1 复用上游 | 完成 | 15 文件 SHA 一致；`upstream/tests` 原样 vitest 4.1.8：144/144；`MAPPING.md`。 |
| A2 持久 runtime 与恢复 | 完成 | SQLite 仓库；命令事务 + 提交后派发；4 个真实进程退出检查点；`recover`；`needs_reconciliation`；旧 assignment 报告在 `reportSafe` 前被挡。 |
| B1 任务记忆与行动有效性 | 完成 | `memory-bridge/`；提案/执行/通知三次校验；4 组反例（`tests/validity.test.ts`）。 |
| B2 介入决策与强基线 | 完成 | P0–P3；`decision/rules.ts`；问题合并/静默/额度；H1 消融 `out/eval/ablation.json`。 |
| C1 受控工作区与事件源 | 完成 | `tools/`；原子写入、SHA 校验、partial JSON、同 SHA 去重、乱序 revision 留档；watch + 启动补读。 |
| C2 独立评估 | 完成 | 16 轨迹（8+8）、gold 独立、72 份 raw、`verify-eval` 0 失配、5 负控全 detected。 |
| D 可操作演示 | 完成（UI 部分验证） | `demo/panel.html`、`node run.mjs demo` 18 项 PASS；面板仅 HTTP/CLI 验证，浏览器未验（见 LIMITS）。 |
| 封包 | 完成 | 交付目录以最终文件现算 MANIFEST/SHA；bundle 从 90fb4cd 起。 |

## 检查数字（现算）

- 单测：35/35（`out/logs/test.log`）。
- 上游原测试：144/144（`out/upstream/vitest-verbose.log`，exit 0）。
- 评估：72 次运行（4 策略 × 18 机会），`out/eval/raw/`。
- 独立重评：72 份文件，0 失配（`out/logs/verify-eval.log`）。
- 负控：5/5 detected（各自子进程 exit 1）。
- 演示：18 项断言 PASS，每步独立进程。
- 离线静态审计：29 个代码文件，0 个禁用端点/网络客户端；R3.1 diff 0；上游指纹 0 失败。

## 未完成 / pending

- Windows 入口未运行（无环境）；pwsh 命令见交付 `REPRO.txt`。
- 真实浏览器 UI 验收未做；仅有 HTTP/CLI 证据。
- 模型适配器未启用（按任务包要求，预算 0）。
- 断电/磁盘损坏/多写者恢复未测。
- P3 相对 P2 没有“更少打扰”的优势，只有完成率与必要决策覆盖优势（见交付 `DELIVERY.txt`）。
