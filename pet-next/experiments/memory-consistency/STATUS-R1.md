# M3-13 R1 有限返工 · 状态

起点：`cb8e7be01351b584391b443fffcce8f4b180360a`（R0 交付，复核包 `codex-review-memory-r0-cb8e7be`）
工作树：`/data3/DATA/project/project_meishijiang/petmem-r0-r1`，分支 `codex/pet-memory-r0-r1`
环境：Linux x64 / Node v24.14.0 / 单核共享主机；Windows 未实跑。

## 提交

| 提交 | 内容 |
| --- | --- |
| `40f35e1` | CODE_HEAD：F1–F4 四类阻断修复 + 新回归 + fixtures 重生成（patchId 去轨迹名）+ 派生用例 |
| 其后 | 本文件与 `DELIVERY-R1.md`（仅文档，未再跑测试） |

## 门禁（Linux，`linux-out/`）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| G1 | pass | 48 轨迹 / 143 断言 / 0 失败；6 个负控全部检出；信封 runId/sourceCommit 匹配 |
| P1 | pass | 新模板 16/47；leak 0 且覆盖度非零；48 条轨迹完整重放全等；3 条只存事件负控全部检出 |
| P2 | pass | 维护等价成立；性能主张已撤回；平台 5 pass + 1 not_proven；dry-run plan 528 / attempts 120 |
| 套件 | pass | 12 套件 156 项（R0 为 11 套件 132 项） |

## 平台

- Linux：全套 + 门禁 + 类型检查 + lint 通过（`linux-out/logs/`）。
- Windows：**not-run**。R1 改了 checkpoint fsync 的句柄类型，必须在 Windows 复跑
  `storage/store.test.ts`、`recovery/recovery.test.ts` 与 `--gate=G1`；脚本见 `platform/windows-r1.ps1`。
  在该结果回来之前，Windows 门保持未通过。
- 只读目录权限项在 root 下仍标 `not_proven`（root 绕过权限位），没有伪造成 pass。

## 与 R0 的差异（只列影响结论的）

1. 坏尾修复后继续写入可恢复；修复失败时拒绝打开。
2. 任务来源依赖、失效目标版本、父更新级联三条规则生效；旧补丁被拒。
3. 反事实只比行为；重放含补丁与笔记；泄漏审计有非空输入；门禁校验信封。
4. 计数改为真实访问量；队列按补丁字节设限；未来 runner 三分账本、每臂独立预算。
5. 撤回：性能优势、事件级重放等价。

## 真实调用边界

模型 POST = 0；未访问 18872；未碰 GPU、产品默认、main；未 push、未 merge；复核包与原交付只读。
