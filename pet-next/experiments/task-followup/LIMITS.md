# 未证明项与已知代价（R4.2）

本文件只列仍然没有证据的东西，避免把机制演示说成研究结论。

## 没有模型参与

- 所有决策都是 `scripted-rule`，配置 SHA（含 timezone）记在每次提案/面板上。
- 没有验证模型能否理解“何时该打扰”；没有模型质量、泛化、长程推理结论。
- 没有模型调用预算被消耗；下一步若接模型，必须先冻结地址/模型/次数/输入预算/失败记账。

## 只有机制级证据

- 16 条轨迹是工程机制测试；8 条 heldout 也只是留出机制，不是模型泛化集。
- 用户回应由固定行为规则产生，且 R4.1 起只在“已送达/已呈现”时回应；
  这不代表真实用户，也不代表真实到达率。
- 观察延迟、任务密度、失败分布都是合成数据，没有来自真实生产日志。
- 4 种策略共享同一 runtime/工具/硬性拦截；结果只在“这些策略 + 这 18 个机会”内成立。

## 输入身份与完成证据

- 输入身份覆盖 `taskId/taskRevision/assignmentId/sourceId/sourceRevision/resultFileSha/artifactSha`；
  没有覆盖文件系统 inode、mtime、外部进程在快照写入后修改原文件（快照本身不可变，但原文件可被替换；
  替换会被下一次派发/完成检查发现）。
- 老库里的 `completed` 状态保留，但 `completionCheck` 对新旧记录一视同仁：
  老回执没有 `inputRef` 就返回 `receipt_input_identity_missing`，不计为有效完成。
- `accept_receipt` 的输出校验只覆盖 `write_analysis` 的文件产物；只读工具没有输出字节可核。
- 继续入口只处理“执行前已知输入拒绝”；工具已执行后的失败（如 `tool_failed`）仍走原有路径，
  本轮没有扩展。
- 没有做“同一 SHA 但语义不同”的对抗样本（SHA 碰撞不在威胁模型内）。

## 恢复与副作用

- 崩溃用真实子进程 `exit 42` 验证（入站持久后、派发前、工具执行中、回执后），但没有做断电/文件系统损坏/磁盘满。
- `effect_running` 注入点在工具 execute 之前，所以只能证明“阻断不被绕过、不新建 attempt”，
  不能证明已经产生两份外部文件或两次副作用。
- SQLite 单机单写者；没有跨机复制、并发多写、WAL 破损恢复证据。
- 本地工具用 `effectId + receipt` 幂等；不声称通用 exactly-once。
- `assignmentInterrupted` 只覆盖上游定义的“主机重启”语义，没有覆盖执行器进程池/远程 worker。

## 评估口径

- 只有 `validCompletions` 进入完成率；旧口径的 14/14、17/17 与收益结论已撤回，不覆盖历史文件。
- 评分身份规则：当前有效实例 = 未被撤销的 ask 中 `(taskRevision, at, decisionId)` 最大者。
  同一 kind 若存在多条仍有效的提案，只取最新一条；这条规则本身是约定，不是自然事实。
  缺失/歧义一律 fail closed（老 raw 因此不可评分，见交付 `legacy-raw-fail-closed.json`）。
- `notVisible` 含“已提案但身份缺失/歧义”的项；它不等于“用户没看到”，只表示当前证据不足。
- 本轮的 63 项补充反例由 4 失败变 0，只证明这些具体序列；不证明任意恢复序列都不会卡住。
- 必需问题分“已产生/已可见/已回答”三段；`requiredVisible` 只认 delivered/presented 回执。
- `unansweredNotifications` / `supersededNotifications` 是代理指标，
  不能直接称为“无用打扰”；`uselessNotifications` 的定义见 `eval/score.ts` 的
  `metricDefinitions`（已送达 + 未回答 + 同 decisionKey 之后被重新提问）。
- 运行时硬额度（`reminderQuotaPerHour`）与 gold 参考上限（`maxNotifications`）分开字段；
  P3 在 1 个 run 超过 gold 参考上限，但没有硬额度违规。
- 首次提问延迟中位数为 0ms；夜间场景是 5 小时，但样本少，不做分布结论。
- 没有调阈值直到全赢：P2 阈值 0.15、冷却 30 分钟、静默 23–7 均为事先冻结值。

## 界面

- 面板只做了 HTTP/CLI 自动化验证；`demo/panel.html` 在渲染出开放问题时会 POST `/api/present`，
  但本轮没有真实浏览器触发它。
- 没有录屏或截图；不把静态 HTML 当作演示完成证据。
- 面板是单机单用户；没有多任务并发、权限、移动端布局验证。

## Windows

- 本轮没有 Windows 环境；未运行 PowerShell 入口，也没有把 R3.1 的 Windows 结果套到本轮 SQLite/runtime。
- 静默/时区负控已改成显式 IANA 时区（不读宿主 TZ），但未在 Windows 复验，不能声称跨平台通过。
- 交付目录给出 pwsh 7 命令（含中文空格路径），等待后续补验。
