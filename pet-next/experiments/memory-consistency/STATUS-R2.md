# M3-13 R2 窄返工 · 状态

起点：`6e4ac9d4b7fe4b22768c237e7e1d89f3714d3c74`（R1 交付，复核包 `codex-review-memory-r1-6e4ac9d`）
工作树：`/data3/DATA/project/project_meishijiang/petmem-r0-r2`，分支 `codex/pet-memory-r0-r2`
环境：Linux x64 / Node v24.14.0 / 单核共享主机

## 提交

| 提交 | 内容 |
| --- | --- |
| `28489df` | CODE：A 绝对偏移、B 行为判据+泄漏覆盖、C 平台能力/gate 测试/Windows 脚本 |
| `295507d` | `.gitattributes` 锁 `*.ps1` 为 CRLF |
| `9c86f4c` | 脚本测试改为「BOM + gitattributes 承诺 CRLF」（CODE_HEAD） |
| 其后 | 本文件与 `DELIVERY-R2.md`（仅文档，未再跑测试） |

## 门禁（Linux，`linux-out/`）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 套件 | pass | 12 个 / 177 项，R1 的 156 项全部保留 |
| G1 | pass | 48 轨迹 / 143 断言 / 0 失败；6 负控全检出 |
| P1 | pass | 16/47；leak 0 且五类覆盖；24 对反事实 + 三类负控；48 条回放全等 |
| P2 | pass | 等价成立；平台 6 pass + 1 not_proven；dry-run plan 528 / attempts 120 |
| 15 项原探针 | pass | 15/15（before/after 都通过，F2/F4 未回退） |
| 补充反例 | pass | 12 项：before 2 失败 → after 0 |
| typecheck / lint | pass | exit 0 |

## 平台

- Linux：全套 + 三门禁 + typecheck + lint 通过。
- **Windows：not_run**。本机没有 Windows 环境。`platform.windows.status=not_run`，
  `platform/checks.ts` 在 win32 上会写 `measured`；验收命令见 `platform/windows-r1.ps1`，
  待办清单随交付的 `WINDOWS-PENDING.md` 一起交给 Codex。
- 权限能力：Linux root → `root-bypasses-mode`，只读目录项 `not_proven`；
  错误传播由 `controlled-io-failure`（文件当目录）在任意平台证明。

## 与 R1 的差异（只列结论相关）

1. checkpoint + 坏尾可恢复：坏字节隔离、截断到绝对偏移、checkpoint 前缀不变、恢复后可继续写。
2. 反事实改为输出字段判据；输入差异不再能充当行为差异（15/24 → 0/24 假阳性）；
   泄漏覆盖从「前 8 条」改为按 class 全量，四类 + derived 缺一不通过。
3. Windows 相关测试与脚本按平台能力建模；脚本支持 PS5（BOM/CRLF）、显式 SourceCommit、真实入口路径与失败传播。

## 真实调用边界

模型 POST = 0；未访问 18872；未碰 GPU、产品默认、main；未 push、未 merge；
复核包与 R1 交付只读（复核包 100 项校验和复验 0 漂移）。
