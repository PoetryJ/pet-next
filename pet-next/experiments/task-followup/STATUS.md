# R4.2 任务状态（有限返工，按任务包逐项）

基线：`0a46616bfcbde42b72d70ce99d8007ded0f8ed3f`；分支 `codex/pet-followup-r4-2`；
工作树 `/data3/DATA/project/project_meishijiang/petmem-followup-r4-2`。
上游：`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`（MIT，15 文件字节不改）。

本轮只关闭 R4.1 REVIEW 的三个阻断，不扩功能、不调阈值、不改 gold、不调用模型。

| 修复项 | 状态 | 关键改动 | 证据 |
| --- | --- | --- | --- |
| F1 失败回执解除阻断 | 完成 | `reconcile accept_receipt` 逐项核对 effect/attempt/任务/assignment/来源/`ok`/`inputsVerified`/未解决状态/输出文件与 SHA；任一失败返回明确拒绝码，effect 与阻断不动 | `supplemental-runtime.mjs` 63/63；`tests/r42.test.ts`；`demo` 步骤 7 |
| F2 输入恢复无继续入口 | 完成 | 输入门拒绝 → 持久化 `continuation`、清空已消耗授权、`continuation_pending`；输入未恢复只 defer；恢复后只提一个绑定版本/attempt 的重新授权问题；新授权前不执行、不建 attempt/receipt | 同上；`tests/r42.test.ts` 含跨进程重启 |
| F3 评分跨版本误配与漏报混用 | 完成 | raw 导出完整身份；评分按 `decisionId` 精确连接 + ticket/版本/派工校验，缺失/歧义 fail closed；输出 produced/visible/answered 与 notProposed/notVisible/notAnswered | `eval/score.ts`、`tools/score-crosscheck.mjs`、`tests/r42-score.test.ts` |

## 检查数字（本轮现算，Linux Node 22.20.0）

- 单测：66/66（原 47 项保留；新增 11 项运行时 + 8 项评分）。
- 独立运行时正控：98/98（`runtime-independent/independent-runtime.mjs`，52 个真实 CLI 子进程）。
- 补充反例：63/63（基线 4 失败 → 0；36 个真实 CLI 子进程）。
- 独立评分交叉核对：72 runs，0 差异；review 的 `independent_score.py` 在新 raw 上 1430 检查 0 失败，
  与产品评分逐项一致（P0/P1/P2/P3 可见 0/9/9/12，回答 0/6/8/11，未触达 17/8/8/5）。
- 评估：72 次运行（4 策略 × 18 机会，16 轨迹 dev/heldout 8/8）；`verify-eval` 0 失配。
- 负控：10/10 detected。
- 演示：35 项断言 PASS（19 项原有 + 16 项恢复入口），每步独立进程，显式受控时钟。
- 独立验收（R4.1 脚本）：27/27，未回退。
- 上游原测试：144/144；R3.1 192/192 + G1/P1/P2；四 fixture exit 1；R3.1 目录零 diff。
- typecheck exit 0；离线静态审计 0 禁用项；上游 15 文件指纹 0 失败。
- 行为对照：新 raw 与 R4.1 基线 72 份逐字段比较，只有 6 个 run 的 stage/proposal/driverLog 变化
  （T04 a/b、T10 P2/P3 的输入拒绝被记录为 continuation），完成/通知/回执/effect 全部相同。

## 有效完成与覆盖（P3）

- 有效完成 8/18；必需问题 17：产生 15、可见 12、回答 11；漏提案 2、未触达 5、未回答 6。
- 通知 16（送达 16、呈现 0）；运行时硬额度违规 0；gold 参考上限超标 1 run。
- P3 vs P2：有效完成 +1、漏提案 −5、未触达 −3、未回答 −3、通知 +3。
  仍不支持“更少打扰”；只报计数。

## 未完成 / pending

- Windows 本轮未运行（无环境）；两支独立探针、test/acceptance/demo/eval/negative/typecheck 的
  pwsh 命令见交付 `WINDOWS-PENDING.txt`，不能拿 R4.1 的 Windows 结果盖章。
- 真实浏览器 UI 本轮未复验；demo 用 CLI/HTTP 与真实进程，面板 `POST /api/present` 未被浏览器触发。
- 模型适配器未启用（预算 0）。
- 断电/磁盘损坏/多写者/跨机恢复未测。
- `effect_running` 注入点在工具 execute 之前：只证明阻断不被绕过，不证明产生过两次外部副作用。
