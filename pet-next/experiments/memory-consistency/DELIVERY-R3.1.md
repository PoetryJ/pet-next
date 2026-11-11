# pet-memory R3.1 交付（窄返工）：F1 目标轮身份 / F2 S1 真实淘汰

结论：REVIEW 指出的三项问题全部闭合。评分不再被先前成功请求掩盖；
S1「偏好真实写入→被四轮短历史淘汰→长程记忆补回」第一次真正发生并被断言冻结；
交付索引 SHA 由脚本现算。未扩大记忆算法，未碰产品，未调用/探测模型服务。

产物：`/data3/DATA/project/project_meishijiang/pet-memory-shadow-r3-1-delivery/`

    before/                 基线 ef9955f 上复现的漏检记录（falseGreen.failed=[]）
    after/                  修复后同一探针（falseGreen 12 断言失败）、四负控 fixture、8 故事 shadow
    after-precommit/        提交前等价产物（内容除时间戳外与 after 一致，证明确定性）
    run/                    干净树 703fd9d 全量回归（13 套件 192 项）
    run-precommit/          提交前等价回归
    frozen/                 本次冻结快照（stories/expected/manifest + 新旧 sha 说明）
    EVIDENCE-INDEX.json     每条证据的路径/生成命令/退出码/源码指纹
    MANIFEST.json           交付清单与现算 sha256
    SHA256SUMS.txt          全树校验和
    bundle-r3-1.bundle      增量 bundle（ef9955f..703fd9d 及文档提交）
    VERIFY-R3.1.txt         本核验记录（复现→修复→回归）

## 修复摘要

1. 目标轮身份（A）：`expectation.finalTurnIndex/finalQuestion` 冻结；
   `scoreStory` 全部最终请求断言绑定该轮；`target-turn-requested/ok/question-verbatim`、
   `turns-sound` 四类断言覆盖每臂；error 轮保留产品 `code`（too-long / provider-error）。
2. 失败传播（A）：非预期失败轮（除 `allowedNonOkTurns`）一律判失败；
   `--fixture` 四负控真实跑 CLI，检出退出 1、若被掩盖退出 4（MASKED）。
3. S1 真实淘汰（B）：偏好经首轮 `session.send` 写入，四轮寒暄后按产品 4 轮上限淘汰；
   `turnMustIncludeText`（进入过）与 `finalHistoryMustExcludeText`（已淘汰）两臂断言。
4. S7 第三轮（B）：取消迟到落定后再问一轮，历史仍未回填取消文本。
5. 口径与索引（集成）：`requiredVisible` 分子/分母取代旧 `requiredVisibleRate`；
   `budgetFailures` 定性为纯函数反例；索引 SHA 脚本现算；草案删「重试后仍失败」。

## 复跑命令（本机 Node v24.14.0）

    cd pet-next
    node experiments/memory-consistency/run.mjs --all --out=<新目录> --source-commit=703fd9d01a8783945ff278e902c6d5b824b7fb2d
    node --experimental-strip-types experiments/memory-consistency/product-shadow/shadow.ts --out=<新目录>
    node --experimental-strip-types experiments/memory-consistency/product-shadow/shadow.ts --out=<新目录> --fixture=final-too-long
    node --experimental-strip-types <codex-review-memory-r3-ef9955f>/shadow-minimal-probes.mjs experiments/memory-consistency/product-shadow <输出目录>

## 边界

产品契约五个文件相对 `ef9955f` 零改动；真实网络 0；未访问 18872/GPU/main；未 push/merge。
stub 固定回复「离线占位回复」不构成模型能力；未来模型实验仍只有预算草案（FUTURE-PLAN），本轮 0 调用。
