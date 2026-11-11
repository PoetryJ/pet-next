# pet-memory R3.1 状态（窄返工：F1 目标轮身份 / F2 S1 真实淘汰 / F3 索引与草案）

日期：2026-11-11 · 分支 `codex/pet-memory-shadow-r3-1` · 基线 `ef9955f` · CODE `703fd9d`

## 结论

REVIEW 三项全部闭合，未扩大记忆算法，未碰产品模块，未调用/探测任何模型服务。

| 项 | REVIEW 问题 | 修复 | 证据 |
|---|---|---|---|
| F1-1 | 最终请求取数组末项，目标轮失败被先前成功掩盖（501 字最终问题 → 两臂 error，仍 13/13 通过） | 评分绑定 `expectation.finalTurnIndex`（先写后跑冻结）；新增 `target-turn-requested` / `target-turn-ok` / `target-question-verbatim` / `turns-sound` | `after/minimal-probes-result.json`：同一 falseGreen 场景 12 断言失败；`before/` 为 0 失败 |
| F1-2 | 错误闭环断：runner 丢产品 `result.code` | `turns[].code` 原样保留（`too-long` / `provider-error` 可见） | `after/fixtures/fixture-final-too-long.json` |
| F1-3 | `requiredVisibleRate` 以「有任意请求」冒充可见性 | 拆为 `requiredVisible`（目标请求必要证据 分子/分母/比例）与 `requestCoverageRate`；SPEC 七注明旧口径废弃 | `after/shadow/summary.json` |
| F1-4 | 无负控，评分可能空转 | `shadow.ts --fixture=<final-too-long\|no-final-request\|final-cancelled\|provider-error>`；检出非零退出、MASKED 退出 4 | 四 fixture 全 `detected` + EXIT=1；`shadow.test.ts` 新增 5 项负控单测 |
| F2 | S1「偏好被短历史淘汰」从未触发（偏好只进 scripted store，历史全是寒暄） | 偏好改为经真实 `session.send` 首轮写入，四轮寒暄后按产品 `CHAT_HISTORY_MAX_TURNS=4` 淘汰；冻结 `turnMustIncludeText`（进入过）与 `finalHistoryMustExcludeText`（已淘汰） | `after/minimal-probes-result.json` S1-real-aging：H/M `firstHistoricalEvidence=true`、`finalHistoryFactAbsent=true`、M `finalEvidenceVisible=true`；8 故事 185 断言 0 失败 |
| F2（S7） | 第三轮探针未吸收 | S7 增加第三轮（取消迟到落定后再问），目标轮=2 | `after/minimal-probes-result.json` S7-post-late-response：`cancelled→ok→ok`，last=expected=3 |
| F3-1 | MANIFEST 141 条旧记录中 6 条 SHA 过期 | 交付索引改由脚本对交付树现算 sha256，无手工粘贴 | `MANIFEST.json` / `SHA256SUMS.txt` |
| F3-2 | FUTURE-PLAN「重试后仍失败」与禁重试矛盾 | 改为 `attempted-failed`（status≠ok）/ `not-attempted`（请求缺失） | `FUTURE-PLAN-R3.txt` 四节 |
| F3-3 | `budgetFailures` 口径含糊 | 保留但注明：trimToBudget 纯函数契约反例，会话内不可达（500 输入上限 + 固定开销 < 4000 UTF16），不参与评分 | SPEC 五节、runner.ts 注释 |

## 计数变化（审阅请对照）

| 指标 | R3 | R3.1 | 原因 |
|---|---|---|---|
| 13 套件测试 | 186 | 192 | shadow.test.ts 8→14（F1 负控 5 项 + F2 淘汰 1 项） |
| shadow 断言 | 109 | 185 | 每故事每臂 +4 目标轮/全轮健康断言（8×2×4=64）+ S1 进入/淘汰 4 + arms-differ 8 |
| stub 调用 | 44 | 48 | S1 5→6 轮、S7 2→3 轮，两臂各 +2 |
| 真实网络 | 0 | 0 | 哨兵未触发 |

冻结更新（`build-stories.mjs`，sha 变化）：

- `cases/stories.json`：`3afd02bf…` → `a6069919…`
- `expected/assertions.json`：`fe2e2d17…` → `f3bc5014…`
- `expected/manifest.json`：`7adbadcb…` → `33a10cd4…`

## 边界

- 产品五文件相对 `ef9955f` 零改动；全部变更在 `pet-next/experiments/memory-consistency/`（10 个文件）。
- 真实模型 POST=0；未访问 18872/GPU/共享服务/产品默认/main；未 push/merge。
- 原 R3 交付（`pet-memory-shadow-r3-delivery/`）与 R2/R3 复核包只读；本轮产物写入 `pet-memory-shadow-r3-1-delivery/`。

## 未证明

真实模型效果、策略优胜、成本收益、界面呈现/已读、断电耐久、生产发布；
Windows pwsh7 实机入口仍待补验（沿用 R3 的 notRun 记录，本轮未改平台代码）。
