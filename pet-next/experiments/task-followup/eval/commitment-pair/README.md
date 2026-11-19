# R7 委托承诺配对实验（真实模型）

研究问题：用户早期约定“CI 成功就安静归档、失败才问是否分析”能否在真实委托里被正确执行；
语义相反的约定是否在同一时刻产生不同动作；改口与取消是否即时生效；旁支任务会不会制造额外打扰。

## 冻结输入

同一任务名（主测试）、同一报告绑定（依赖检查 = B 报告）、同一段 95 条尾部聊天，
每条轨迹只替换第一条用户承诺：

| ID | 承诺 |
| --- | --- |
| P | 这两份 CI 报告，只要有任何一份失败，就马上来问我是否分析失败原因；如果两份都成功，就直接安静归档，不要打扰我。 |
| O | 这两份 CI 报告，只有两份都成功时才来问我是否继续；只要有任意一份失败，就直接安静归档，不要打扰我。 |

P/O 是语义相反的配对；同一输入在至少一个到达时刻要求不同动作。

## 三条轨迹 × 三臂 × 两条承诺 = 18 次

| 轨迹 | 真实事件 | 期望 P | 期望 O |
| --- | --- | --- | --- |
| T1 失败 | A 成功先到 → B 失败后到 | B 失败后问一次，回答后产出核验分析 | B 失败后安静归档，不问 |
| T2 改口 | 改口“B 失败不用问，只有 A 失败才问” → B 失败 → 真重启 → A 成功 | 归档（改口即时生效） | 归档 |
| T3 取消 | 取消主任务 → B 失败迟到 | 取消后零提醒/零动作 | 同左 |

| 臂 | assessor | 记忆 |
| --- | --- | --- |
| V-R | `capability-need-rule` | 版本化记忆 + 强规则 |
| V-C | `capability-conditions` | 版本化记忆 + 条件 IR |
| T-C | `capability-conditions` | 文本摘要/BM25 + 条件 IR |

每条 96 条真实 `/api/say` intake（不写库、不预标）；报告由真实 Node 测试生成 JUnit
（成功跑 `tests/runtime.test.ts` / `cn-path.check.mjs`，失败跑 `ci-failure.check.mjs`）；
重启是真正换进程读同一个 SQLite。

## 运行

```bash
cd pet-next/experiments/task-followup
export PET_MODEL_UPSTREAM=http://127.0.0.1:18882
export PET_MODEL_NAME=Qwen3-8B PET_MODEL_DISABLE_THINKING=1 PET_MODEL_TEMPERATURE=0
node --experimental-transform-types --no-warnings \
  eval/commitment-pair/run-pair.mjs --matrix --promises P \
  --out <新目录> --base-port 19500
node --experimental-transform-types --no-warnings \
  eval/commitment-pair/run-pair.mjs --matrix --promises O \
  --out <新目录> --base-port 19600
node --experimental-transform-types --no-warnings \
  eval/commitment-pair/score-pair.mjs --runs <P目录>,<O目录> --out <目录>/score
node --experimental-transform-types --no-warnings \
  eval/commitment-pair/reconcile-pair.mjs --runs <P目录>,<O目录> --out <P目录>/reconcile
node --experimental-transform-types --no-warnings \
  eval/commitment-pair/audit.mjs --runs <P目录>,<O目录> --s1 <S1 run> --out <目录>/audit.json
```

## 语义验收（离线）

- `check-grid.mjs --run <T1-P/V-C run> --negative`：对真实编译计划求值
  4 种报告组合 × 2 条承诺 + 单边缺报；负控把 failed/succeeded 互换成对调，必须检出。
- `eval/condition-followup/usable/check-all-arrived.mjs` 原样保留，继续对上一轮 S1 做九格测试。

## 指标与分母

- 正确介入：应问且问在最后一份必要报告之后、已回答、`verifyCompletion` 通过。
- 漏办：应问未问/未答；应归档未归档；应取消未取消。
- 实际多余打扰：不应问却问（含过早问）；旁支任务送达的提醒单列 `sideDelivered`，不混入主任务分母。
- 有效分析：真实分析文件 + 回执 + 输入身份全部核验通过。
- 延迟：报告→首次可见、授权→产物、时间线最长等待步骤。
- 路径：条件原生（最终 cond_eval 动作与主任务动作一致）、模型兜底（fallback/编译失败/评估错误）、
  强规则（V-R）、记忆取消（T3）。
- 用量：客户端/代理双账本逐请求编号，跨任务/重启唯一，未知用量单列。

## 目录

- `stories.mjs`：冻结承诺、轨迹、臂与 evaluator-only 期望。
- `run-pair.mjs`：真实委托 runner（新目录独占）。
- `score-pair.mjs`：独立评分（只读 SQLite/工作区/账本）。
- `reconcile-pair.mjs`：双账本对账与全局唯一编号。
- `check-grid.mjs`：真实计划的离线语义网格 + 负控。
- `audit.mjs`：交付审计（冻结输入、期望不泄漏、旧 S1 九格、对账）。
- `demo.mjs`：同一输入 P/O 配对的现场回放/重跑。
- `../../producer/test-report/checks/ci-failure.check.mjs`：真实失败报告来源。
