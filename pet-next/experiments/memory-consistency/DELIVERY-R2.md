# 记忆一致性实验 · R2 窄返工结论（一页）

**起点**：`6e4ac9d`（R1 交付）。**范围**：只做 TASKS 的 A/B/C 三包，F2/F4 原样保留。

**结论**：A、B 两条阻断在 Linux 上已修复并有可复跑证据；C 的代码（平台能力判定、路径语义、验收入口脚本）
已改好并通过 Linux 侧静态/子进程正控，但**本机没有 Windows，Windows 门仍标 not_run，待 Codex 补验**。

## A. checkpoint + 坏尾的绝对偏移

- 根因：`replayTail` 返回的是「尾段内已消费字节」，`repairTail` 却拿它和整个文件长度比较并 `truncate`，
  非零 checkpoint offset 被漏加 → `tail repair mismatch: keep 373 != parsed 0`。
- 修复：契约写死为**绝对偏移**（`keepAbsoluteBytes = absoluteOffset + consumed`），修复函数只接受绝对位置；
  持久化格式不变。
- 回归 5 组（storage 16 → 20）：无 checkpoint 坏尾（原正控）、checkpoint 后立即坏尾、checkpoint 后有完整新记录再坏尾、
  完整末行缺换行、隔离失败拒开且不截断。每组都核对：坏字节原样隔离、checkpoint 前缀 sha 不变、已 ACK 记录可读、
  恢复后再 append + 二次重启无重复。
- 复核脚本：`F1-original-torn-tail` 与 `F1-checkpoint-torn-tail` 均 pass（before：checkpoint 版 reopen=false）。

## B. 反事实判据与泄漏覆盖

- 旧判据：`behaviorDigest` 含 `events/payload/kind`，只换输入事件就能满足差异；`differingChecks` 只展示不判定。
- 现判据：`eval/behavior-spec.ts` 从两侧独立 expected 建规范——
  `flip`（期望不同，实际必须不同）、`stable`（期望相同，实际必须相同）、`presence`（仅一侧断言，另一侧必须 absent）；
  `classifiedDifferent` 还要求输出投影本身不同。输入事件、trackId、时间戳、标签一律不参与。
  `behaviorDigest` 同时去掉 events，只留输出。
- 负控（对 24 对全量）：输入不同+输出冻结 → 0 假阳性（原 15）；应保持字段被改 → stable 不成立；
  同内容换名 → 无差异；仅一侧断言的 C3/C5 靠 presence 证据成立（不硬编码 id）。
- 泄漏审计改为**按 class 全量**（dev 48 + 新 16 + derived 2），每个 trace 边界查两相（原始状态 + 一轮整理后状态），
  输出每类/每策略覆盖：state-update 68、generation-presentation 36、tool-result 44、stale-patch 36、dependency-graph 6
  （均为带笔记输入数）；缺任一类即不通过。审计只读，不产生新结论。

## C. Windows 门与执行脚本

- `platform/checks.ts`：权限能力按实际平台判定——Windows 无 POSIX 权限位、root 绕过权限位，两者都标 `not_proven`；
  新增 `controlled-io-failure`（把文件当目录）在两个平台都确定性验证 `io_error` 传播。
- `platform.checks` 增加 `scope`（platform/node/permissionCapability）；Windows 实跑时 `windows.status=measured`，
  不再写「本机无 Windows」。
- `runner/gate.test.ts`：路径/URL 由宿主 `pathToFileURL` 与 `join` 自建；Windows 字面值走单独导出的纯转换契约
  （`fileUrlForPath`），不再依赖宿主 pathToFileURL 识别；子进程正控整体放在中文+空格目录下真实执行。
  负控保留：空脚本、旧 runId、passed_gate=false、坏 JSON。
- `platform/windows-r1.ps1` 重写：UTF-8 **BOM** + `.gitattributes` 锁 CRLF；`$PSScriptRoot` 定位仓库根；
  `-SourceCommit` 必填（不读外层 git）；空格步骤复制 `experiments/memory-consistency` 后调用**真实**的
  `memory-consistency/run.mjs`；每个子命令记录退出码与原始输出，任一步失败或信封不匹配即非零退出；
  `-SelfTest` 用 fake-node（全部 exit 7）验证失败传播。

## 数字与门禁（Linux，Node 24.14.0）

| 项 | 结果 |
| --- | --- |
| 套件 | 12 个，**177** 项全过（R1 156 项全部保留；storage +4、eval +6、studies +10、gate +1） |
| G1 | 48 轨迹 / 143 断言 / 0 失败；6 个负控全部检出 |
| P1 | 新模板 16/47；leak 0 且五类覆盖；24 对反事实全过；三类负控全过；48 条完整回放全等 |
| P2 | 等价成立、性能主张仍撤回；平台 6 pass + 1 not_proven；dry-run plan 528 / attempts 120 |
| 15 项原探针 | 15/15（before 与 after 都是 15/15，证明 F2/F4 未被破坏） |
| 补充反例 | 12 项：before 2 失败（F1-checkpoint、F3-input-only）→ after 0 |
| typecheck / lint | exit 0 |

## 未证明（not-run）

**Windows 全套与 gate-only 未在本机执行**（无 Windows 环境），`platform.windows.status=not_run`；
`platform/windows-r1.ps1` 与 `WINDOWS-PENDING.md` 是交给 Codex 的补验入口。其余：真实模型效果与成本收益、
四策略效果、用户是否读到、断电/硬件耐久、高扇出成本——均未测。
