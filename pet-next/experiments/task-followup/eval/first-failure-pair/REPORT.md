# R8 首败、等待与下一轮：24 次真实配对

2026-11-20。基线 `0b38ccf`，试验分支 `codex/r8-first-failure`；产品代码 `1f5d903`，评分/运行器
`9c25529`。单卡 GPU0 完成（GPU1 已释放）；真实宿主、真实 `/api/say`、真实 JUnit、真实重启。
服务器无桌面，Windows 窗口点击仍待解锁机器补验。

## 1. 冻结设计

同一 96 条尾部聊天、同一任务名（主流程）、同一绑定（附录检查 = B 报告），只换第一段承诺：

- F：任何一份 CI 失败就马上问是否分析；两份都成功就安静归档。
- S：两份都过了再问；只要有一份没过就归档，别再问。
- W：第一份失败先问“先分析这份 / 等另一份再问”；等的话重启后不再问，另一份到了再问。
- E：这一轮两份都过了就归档，不用再跟下一轮。
- C：这一轮两份都过了先安静，继续跟下一轮；下一轮失败仍提醒。
- G4 改口：A 的询问条件反过来（成功问 / 失败问两个方向）。

八个场景（G1-F/G1-S/G2-W/G2-S/G3-E/G3-C/G4-AF/G4-AS）× 三臂（V-R 强规则、V-C 版本记忆+条件、
T-C 文本摘要+条件）= 24 次；每次新目录，运行器不读 evaluator 期望。

## 2. 先复现包里的反例

`replay-counterexamples.mjs`（只读评审包）：

- 首败：包里的 `any(A.failed,B.failed)` 在 A failed、B missing 时求值为 `true`；旧宿主仍因完整输入
  `result_missing` 拒绝，open=0、notifications=0。新宿主改为局部选项后同一求值生成三选一问题。
- 等待/归档：`本轮全部成功就归档` → `archive`；`本轮全部成功就先安静，继续跟进下一次重跑` → `wait`。
- 反向条件：包内 T2-O-V-C 的 `not(all(A.failed,...))` 和 T2-O-T-C 的 `present` 计划都被
  `validateDirection` 拒绝（`inverted_not` / `present_in_failure_ask`）。
- 预检 verdict：`allRejected=true, watchOk=true, archiveOk=true, firstTrue=true`。

## 3. 24 次结果

| 场景 | V-R 强规则 | V-C 版本+条件 | T-C 文本+条件 |
|---|---|---|---|
| G1-F 首败 | ask，未回答，超时 | ask partial + 回答 | ask partial + 回答 |
| G1-S 首败即归档 | ask partial（多余） | archive | archive |
| G2-W 等/重启 | 首次就 full ask，未按 wait | 首次就 full ask（重启关闭编译） | wait → 重启不问 → full ask |
| G2-S 等/归档 | full ask（多余） | archive | wait（多余） |
| G3-E 本轮结束 | ask（多余） | archive | ask（多余） |
| G3-C 跟下一轮 | r2 ask（多 1 条重复） | r1 静，r2 ask | r1 静，r2 ask |
| G4-AF 改口成功问 | ask，未回答，超时 | ask，未回答，超时 | archive（反向） |
| G4-AS 改口失败问 | active（无动作） | archive | active（无动作） |

总计：正确 11/24；应问未答 4；应归档未归档 7；主任务多余打扰 5；重复主提醒 4；旁支送达 12。
有效分析：partial 3、full 10（partial 只授权失败的那一份；full 才覆盖两份）。按臂：V-R 1/8、
V-C 6/8、T-C 4/8；按场景：G1 4/6、G2 2/6、G3 4/6、G4 1/6。
路径归因：强规则 8、原生归档 6、原生问 4、原生等待 1、兜底或原生待细分 5（逐格见 `score.json`）。

## 4. 两个用户能看见的行为

**首败及时问 + 局部授权**（G1-F，V-C/T-C）：A failed、B 未到时，问题原文
“主流程 失败了，附录报告 还没到。要现在先分析已失败这份，还是等另一份到了再问？”，
选项 `analyze_this / wait_other / skip_once`；回答 `analyze_this` 后产物
`scope=partial`，回执 `inputSet.authorizedTaskIds` 只有 A 的 taskId，`resultFileSha` 与 A 的
`result.json` 一致；B 后来到达不再追问。演示记录：
`final-a/G1-F-V-C`（partial）、`final-a/G1-F-T-C`（partial）。V-R 被强规则的“结果不足”问题覆盖，
局部问题未回答，超时。

**这一轮成功先安静、下一轮失败仍提醒**（G3-C，三臂）：r1 两份成功时 `defer follow_next_round`
（无通知、无提问）；r2 A 失败后 3/3 询问“结果不足：1/1 失败”，回答 `analyze_failing`，full 分析
覆盖两份。V-R 多一条重复主提醒。G3-E（“不用再跟下一轮”）V-C 归档正确，T-C/V-R 在 r2 仍问，
说明 `end` 与 `next_round` 的区分只在 V-C 稳定。

**等待/重启**（G2-W）：T-C 通过“首次 partial → wait_other → 重启无问 → A 到 → full ask”；
V-C 在重启时条件评估仍拿不到已关闭的内存编译（`provider_error: Memory compilation is closed`），
第一条问题退化成 full ask，用户没有机会选“等另一份”。这是本轮主导的生命周期失败，不是条件内核。

## 5. 成本、延迟与核验

24 次客户端 618,579 token，代理端 693,905 token；最长报告→送达 323.2s（G4-AF-V-R 超时格），
中位 154.4s，最短 3.3s（G3-C-V-C）。延迟主要仍在版本记忆抽取/编译排队，而非条件求值。
`verify.mjs` 162 项全过：24 个 `raw.json`/SQLite/双账本/模型请求齐全；编译请求只含 turn/fact，
不含 `G1-F`、`G2-W` 等故事名（中性 runId `r8-A-r1`）；partial/full 产物文件存在；运行前后产品代码树
SHA 一致（`0da6bd0b…`，62 个文件）。反例、live、评分、核验都由 `reproduce.sh` 串起。

## 6. 限制

- 单卡串行；GPU1 在本轮中途释放，24 格都在 GPU0 上完成。
- 5 个格（G1-F-V-R、G4-AF-V-C/V-R、G4-AS-V-R/T-C）在 300s 等待预算内未拿到最终动作，标为 timeout/active；
  其中 G4-AS-V-C 是超时后归档，行为正确但送达晚。
- 每格一次真实运行，不作统计显著性结论；修复后的 24 与上一轮 21 格不拼排名。
- 强规则仍会抢先发“结果不足/报告到齐”，并制造 12 条旁支提醒；未改产品默认。

## 7. 结论（约 500 字）

本轮把“第一份失败、另一份不来”做成了用户能选的三选一，并把局部授权绑定到眼前这份报告的
`resultFileSha`：G1-F 的 V-C/T-C 都只分析失败的那一份，回执授权 ID 只有 A，B 到达后不再追问；
“这一轮成功先安静、下一轮失败仍提醒”在 G3-C 三臂全部做到，r1 无通知、r2 问一次并产出 full 分析。
V-C 以 6/8 正确领先，T-C 4/8，强规则 1/8 且 8/8 给旁支发了提醒。主导失败不是条件内核，而是生命周期：
G2-W 的 V-C 在重启时内存编译已关闭，首败问题退化成 full ask，用户失去“等另一份”的选项；
T-C 同一场景通过。另一个失败是自然措辞：“过了/没过”与“改口反过来”让 T-C 的 S/E/G4 多次编译成
反向条件，V-C 只在 S 和 AS 上稳定。24 次共 11 次正确、5 次主任务多余打扰、4 条重复主提醒、12 条旁支
送达；3 份 partial 和 10 份 full 通过独立核验；客户端 618,579、代理 693,905 token；最长送达 323s，
中位 154s。结论：首败局部授权与跟下一轮已经可演示，但“等待后重启”必须等条件评估落盘再重启，
否则会把 partial 选项丢掉；强规则仍应在旁支和应安静场景被替换。未改产品默认，Windows 点击待补验。
