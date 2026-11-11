# M3-13 R3 · 状态

起点：`ef36f91e2171e3bcf07e1e7dd1f6347ed5fbbcdc`（R2 交付）
工作树：`/data3/DATA/project/project_meishijiang/petmem-r0-r3`，分支 `codex/pet-memory-shadow-r3`
环境：Linux x64 / Node v24.14.0；Windows 无环境（pwsh7 入口待 Codex 补验）。

## 提交

| 提交 | 内容 |
| --- | --- |
| `11c2aad` | CODE：product-shadow（contracts/SPEC/adapter/capture/runner/score/shadow + 8 故事 + 冻结期望）、pwsh7 入口、新套件 |
| 其后 | 文档（DELIVERY-R3/STATUS-R3/FUTURE-PLAN）与交付索引，未再跑测试 |

## 门禁

| 项 | 结果 |
| --- | --- |
| 套件 | 13 个 / 186 项，全过（含新增 shadow 8 项；Codex 复跑核对 7+37+9+20+7+26+10+6+14+9+22+11+8=186） |
| G1 / P1 / P2 | pass（与原语义一致） |
| shadow 8×2 | 109 断言 0 失败；stub 44；真实网络 0 |
| 15 项探针 | 15/15 |
| 独立反例 | 12 项 failed=[] |
| typecheck / lint | exit 0 |

## 冻结物

- `product-shadow/SPEC.txt`：路径、两臂、注入格式、选择规则、预算、评分字段、非目标。
- `product-shadow/cases/stories.json` + `product-shadow/expected/assertions.json`：
  生成器 `cases/build-stories.mjs`，`expected/manifest.json` 记录两者 sha256，`--check` 可验证未漂移。

## 已知限制

- 记忆块只能走 user 消息前缀（产品 provider 无独立上下文通道）；已显式标注「非用户发言」。
- 场景内事实均为 scripted 注入；不证明模型自动抽取或理解。
- Windows：本机无环境；`platform/windows-r1.ps1` 已强制 pwsh7（<7 exit 2），实跑待补验。

## 边界

模型 POST = 0；未访问 18872/GPU/共享服务；未改产品与 main；未 push/merge；复核包与 R2 交付只读。
