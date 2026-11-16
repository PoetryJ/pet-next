# R6-D 真实五臂运行的执行清单（本轮**未运行**）

离线重放（`run.mjs`）只验证驱动与判据管线；它明确标 `mode=offline-replay`、`capabilityResult=false`，
不能当作 H2 证据。下面是 EVAL 要求的真实 72 跑矩阵与台账字段，供有模型端点时一次跑完。

## 前置

```bash
export PET_MODEL_BASE_URL=http://<已配置的 OpenAI 兼容地址>/v1
export PET_MODEL_NAME=Qwen3-8B
export PET_MODEL_DISABLE_THINKING=1
export PET_MODEL_TEMPERATURE=0
export PET_MODEL_TIMEOUT_MS=240000
export PET_MODEL_MAX_TOKENS=4096
export PET_FOLLOWUP_RECHECK_MS=20000
```

两份相同的 A10 副本各串行一个队列，同固定模型/版本；每个 run 独占输出目录与工作区。

## 矩阵（12 故事 × 5 臂 = 60，验证集 V-C/V-R 各追加 1 次重复 = 72）

| 臂 | assessor | 记忆读取 | 说明 |
| --- | --- | --- | --- |
| V-R | `capability-need-rule` | 版本记忆 | 强规则 + 共享抽取 |
| V-L | `capability` | 版本记忆 | 逐事件模型 |
| V-C | `capability-conditions` | 版本记忆 | 条件 IR（本轮新增） |
| T-L | `capability` | 强文本记忆 | 需接 `reference/strong-text-memory.mjs` |
| T-C | `capability-conditions` | 强文本记忆 | 同上 |

```bash
cd pet-next/experiments/task-followup
node --experimental-transform-types --no-warnings \
  capability/intervention/trajectory/product-driver.ts \
  --trajectory <故事轨迹>.json --producer producer/run-tests.mjs \
  --out runs/<arm>-<story>-<rep> --timezone Asia/Shanghai --assessor <assessor>
```

## 必须逐 run 记录

- `END-STATE.json`（ok / missed / responses / artifacts / notProven）
- `driver/timeline.jsonl`、`driver/product-db-export.json`、`http/*.json`（每次真实请求响应）
- `model-io/` 原始请求响应（usage 原样保留）
- 台账：物理 POST attempts/success/failed、输入/输出 tokens 与未知量、冷启动整理成本、在线成本、墙钟

## 本轮结论

`real-run: not_run`。原因：本机没有配置 `PET_MODEL_BASE_URL`（`env | grep PET_` 为空，本机无 OpenAI 兼容端点）。
按 START “无可用模型时先完成全部离线实现，并准确标记未运行”，本轮只交付离线实现与判据管线，
不写任何真实五臂数字。
