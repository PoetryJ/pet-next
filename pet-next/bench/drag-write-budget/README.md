# M3-11 A：活跃拖动的系统写入观测（只测基线，不接候选）

问题：`pointermove → gesture(dx,dy) → preload IPC → main → advanceOrigin(夹边) → BrowserWindow.setPosition`
每来一条位移就写一次系统位置。本目录只回答一件事：**这条路径上是否存在值得消除的写入工作**。
不改产品一行；候选是否接线由负责人看这里的数据决定。

## 写入真值来源与分层

- 唯一写入真值：main 在 `PET_NEXT_TEST=1` 时自己打印的 `{event:'bounds', bounds, requested, physical}`。
  本 bench **不另造**写入计数器。
- 侧信道只有两条，都只读：renderer 的 pointer 观察器（CDP 注入，不改产品代码）与 `/proc/<main pid>/stat` 的 jiffies 差。
- 分层（不许互相冒充）：
  - `native`：Windows 物理鼠标 → 本机没有，**not-run**；
  - `cdp`：`Input.dispatchMouseEvent` 驱动真实 Electron → 合成，不是物理鼠标输入率；
  - `pure-trace`（`--source=fixture` 与 `trace.test.ts`）：固定 seed 的确定性序列，只用于机制/正确性。
- 已知口径限制：main 的 bounds 行**不含时间戳**，本 bench 记的写入时刻是“读到该行的时刻”（上界，含 stdout 管道抖动）；
  单次 `setPosition` 成本另用独立 Electron 微基准给出（`probe-setposition-main.cjs`）。
- 零真实模型：只起 `tests/support/fake-model-service.mjs` + fake ssh，显式删掉指向真实服务的环境变量并校验 `posts=0`。
  未访问 `127.0.0.1:18872`。

## 复跑

```bash
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
Xvfb :141 -screen 0 1920x1080x24 -nolisten tcp & export DISPLAY=:141
cd pet-next
pnpm build
node bench/drag-write-budget/run.mjs --arm=baseline --source=cdp --hz=125 --stamp=cdp-125 --display=:141
node bench/drag-write-budget/run.mjs --arm=baseline --source=fixture --hz=500 --stamp=fixture-500 --display=:141
env -u NODE_OPTIONS node --experimental-strip-types --test --test-reporter spec bench/drag-write-budget/trace.test.ts
```

Windows 物理鼠标（本机 not-run，一条命令）：在**交互式桌面**上用真实鼠标按住桌宠拖动 ≥3 秒，
同时把 main 的 `{event:'bounds'}` 日志重定向到文件（`PET_NEXT_TEST=1` 才会打印），
事后用同一套 `lib/analysis.mjs` 统计相邻写入间隔与 8ms 窗口内多写比例；
**不要用 CDP/fixture 数据替代物理鼠标的输入率**。

## 实测（Linux，单机；期间 load average 8–12，4 个 agent 并行，属噪声环境）

| run | 来源 | Hz | 写入数 | 间隔中位 ms | 相邻写 <8ms 占比 | 重复坐标 | 输入→写入中位 ms | 主进程 CPU 占墙钟 | setPosition 中位 ms | 多写窗口/总窗口 | 单窗最多 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cdp-60 | cdp | 60 | 480 | 16.55 | 0.002 | 0 | 0.39 | 3.21% | 0.0164 | 1/479 | 2 |
| cdp-60-r2 | cdp | 60 | 480 | 16.54 | 0.002 | 0 | 0.38 | 3.45% | 0.0160 | 1/479 | 2 |
| cdp-125 | cdp | 125 | 449 | 8.42 | **0.479** | 0 | 0.31 | 4.95% | 0.0164 | 166/283 | 2 |
| cdp-125-r2 | cdp | 125 | 453 | 8.45 | **0.477** | 0 | 0.32 | 5.42% | 0.0162 | 145/308 | 2 |
| cdp-500 | cdp | 500 | 250 | 3.56 | **0.944** | 0 | 0.27 | 9.53% | 0.0163 | 88/116 | 5 |
| fixture-60 | fixture | 60 | 451 | 16.55 | 0 | 0 | 0.36 | 3.33% | 0.0163 | 0/451 | 1 |
| fixture-125 | fixture | 125 | 449 | 8.43 | **0.468** | 0 | 0.28 | 5.19% | 0.0163 | 80/359 | 3 |
| fixture-500 | fixture | 500 | 449 | 2.32 | **0.998** | 0 | 0.26 | 13.93% | 0.0168 | 120/120 | 5 |
| fixture-500-r2 | fixture | 500 | 449 | 2.34 | **0.998** | 0 | 0.24 | 13.93% | 0.0166 | 120/120 | 6 |

微基准（独立 Electron 主进程，n=300 次调用）：`setPosition` 中位 **0.0163 ms**（最大 0.44 ms），
`getBounds` 中位 0.0009 ms，空控制组 0.0002 ms。原始数据见各 `runs/<stamp>/`（`bounds.ndjson`、
`dispatch.ndjson`、`pointer.ndjson`、`probe-setposition.ndjson`、`summary.json`）。

## 结论（给负责人的判据）

1. **同一 8ms 窗口内多次写入：存在，但只在 ≥125Hz 输入出现。** 60Hz 几乎为 0（0–0.2%）；
   125Hz 约 47–48%；500Hz（CDP 合成）94%，纯 trace 99.8%。
2. **相同坐标重复写：不存在（9 个 run 全为 0，distinctCoordinates 与写入数同量级）。**
   早前观察到的“0.1ms 配对”不是产品双写：`bounds.ndjson` 里相邻 <0.6ms 的只有 24/456 对，
   且 `requested` 无重复，属主进程批量处理/管道抖动，未用于结论。
3. **单次写入成本可测但很小**：`setPosition` 中位约 16µs；拖动期间主进程 CPU 占墙钟 3–14%
   （随输入频率上升，含 stdout 打印开销；load 8–12 的噪声环境，不作为产品基线）。
4. 因此**有值得消除的工作**：不是“每次写很贵”，而是**高刷新/高回报率输入下写入次数多于可见帧**，
   合并窗口内的中间目标不会改变最终落点（逐事件夹边仍在页面/主进程侧照旧计算，见 D 的等价验收）。
5. 收益边界必须说清：60Hz 常规输入**没有**可消除的写入；收益只出现在 ≥125Hz（尤其 500Hz）；
   Windows 物理鼠标的真实到达率**未测**（not-run），本机的 CDP/纯 trace 不能替代。

## not-run

- `native`：Windows 物理鼠标拖动与物理呈帧（本机无 Windows；命令见上）。
- main 内 `setPosition` 的真实调用时刻（产品不打印时间戳，本轮用读取时刻作上界）。
