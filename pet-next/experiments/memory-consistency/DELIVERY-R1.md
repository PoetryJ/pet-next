# 记忆一致性实验 · R1 返工结论（一页）

**起点**：`cb8e7be`（R0 交付）。**裁决**：有限返工，只修 REVIEW 已复现的四类阻断。

**结论**：F1–F4 的复现反例全部转为「修复后断言」，15 个探针由 before 的 14 失败变为 after 的 0 失败；
同时**撤回**两条旧结论（性能优势、事件级重放等价），并把「测试全绿」重新限定为账本机制测试。

## 四个阻断项：改了什么、证据在哪

| 项 | 根因 | 修复 | before → after（`probes/before.json` → `after.json`） |
| --- | --- | --- | --- |
| **F1** 坏尾 | 只记 `isolatedTailBytes`，不截断、不禁写；追加后再次 reopen 报 `corrupt_log` | 坏字节落 `tail-quarantine-<sha>.bin` 并 fsync → 截断到最后一条完整记录 → 修复失败则整体拒开（`writeBlocked`）；末行「完整但缺换行」补换行而非当坏尾 | `F1-torn-tail-then-ack`：reopen=false → **true**，事件 0 → **2**，隔离 35B |
| **F1b** Windows fsync | checkpoint 对 `openSync(tmp,'r')` 的只读 fd 做 fsync，Windows 上 EPERM | 改成 `openSync(tmp,'w')` + write + fsync + rename，再按平台做目录 fsync（Windows 显式跳过） | Linux 回归通过；**Windows 未实跑 → 待复验**（`platform/windows-r1.ps1`） |
| **F2** 依赖/版本 | `task.changed` 的权威 `taskId/revision` 没进依赖；失效不校验目标版本；父更新不处理下游 | ① 从来源事件推导 `subject:task:<id>` 依赖；② `notesToInvalidate` 必须声明并在匹配时校验目标版本；③ 父更新级联失效下游、同批父子绑定提交后版本、投影整图不一致整份拒绝（校验与发布共用 `projectPatch`） | `F2a` applied → **rejected**；`F2b` applied → **rejected**（v2 仍是 active）；`F2c` 子 active 依赖旧父 → **invalidated** |
| **F3** 评估/门禁假通过 | digest 含 trackId；重放只存事件；泄漏审计只 reduce 事件；`file://` 手拼在 Windows/空格路径失配且 run.mjs 只看退出码 | ① 行为摘要排除身份字段；② 重放改为「事件 + 已接受补丁」过 store、关库重开、比笔记/版本/状态，并加「只存事件」负控；③ 审计在带补丁状态上跑并报覆盖度；④ `pathToFileURL` 判定 + `memory-gate/v1` 信封（runId/sourceCommit 逐一核对） | `F3a` 换名判差异 → **不判**；`F3b` 笔记丢失仍 equal → **检出**；`F3c` 笔记输入 0 → **active 15 / invalidated 4 / derived 3**；`F3d` 空格路径静默 exit 0 → **产出带信封结果**；`F3e` 空脚本/旧 runId/false 全 pass → **全失败，仅真实脚本通过** |
| **F4** 计量/队列/预算 | 局部路径只统计命中；队列 cap 只看 key 长度；dry-run 把预留当调用；每臂预算被合成共享池 | ① `CostCounters` 用 Proxy 计真实迭代（两条路径同一套）；② 队列按「提交补丁 UTF-8 字节」逐项试算并预留，首项超限报 `oversize` 留待办，被拒补丁退回队首；③ 计划/预留/attempt 三分，每臂独立 + 可选全局上限，失败计 1 次不退还 | `F4a` 报 51 实 3003 → **完全相等**（1001 事件：全量 20020、局部 2002）；`F4b` cap=1 仍提交 50351B → **0B + oversize**；`F4c` 528「调用」实 120 → **plan 528 / reservations 528 / attempts 120**；`F4d` 71808 过 70000 → **A/D 被拒 exit 3**；`F4e` 失败记 0 次 → **1 次、额度保留、exit 4** |

## 保留与撤回

- **保留**：G1 48 轨迹 / 143 断言；新模板 16 / 47；六个负控全部被指定反例检出；零外呼（静态扫描 + fetch 哨兵）。
- **升级**：重放从「只比事件层」改为「事件 + 补丁 + 笔记 + 版本 + 状态」，48 条轨迹全过；泄漏审计覆盖度不再为 0。
- **撤回**：① 旧「局部 50.5 vs 全量 9574.5 事件扫描」的口径不成立——真实访问量是 2002 vs 20020（1001 事件）、10k 事件约 1.9k vs 1950k；局部仍**线性扫事件日志**，不是索引加速，`speedClaimAllowed=false` 并写明原因。
  ② 旧 P1「恢复等价」在笔记丢失时仍为 true，已作废，由新重放与负控替代。
- **计数**：132 → 156 项（storage +2、queue/rebuild +8、future +2、gate +10，原有套件无一删除）。

## 未证明（not-run，不得读成通过）

真实模型效果与成本收益；四策略效果优劣；用户是否读到（产品无呈现 ack）；断电/硬件故障耐久；
高扇出成本（只做了 3 节点链 + 扇出 5 的定性等价）；**Windows 实跑**（fsync 修复未在该平台验证）；浏览器交互。
