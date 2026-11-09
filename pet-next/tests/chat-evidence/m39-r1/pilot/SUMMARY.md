# M3-9 先导实验：真实服务 + 隐藏期聊天结算

时间：2026-11-09（本机）｜HEAD 未变：`5f4b431bb98eb8792ae2c422460a6e90e47e6beb`
服务：`http://127.0.0.1:18872/v1`，model `qwen3.8-27b`，`/health` 200（空体）、`/v1/models` 200。
GPU：4×NVIDIA H20 97871 MiB；`VLLM::Worker_TP0..3` 每卡 **19006 MiB ≈ 18.56 GiB**（与 18.6 GiB 口径一致）；
每卡总量 43.1/43.3/42.6/33.5 GiB，其余为同机其他负载，本轮未动 GPU 参数、未改并发。

## 调用计数（真实 POST，严格串行，无重试）

| 类型 | 次数 | 结果 |
|---|---|---|
| 质量抽检（run-acceptance，预算 3） | 3 | 3×HTTP 200，finish=stop |
| 隐藏期聊天结算（真实 Electron，自建计数代理） | 3 | 3×HTTP 200，每轮恰 1 POST |
| GET /models（健康检查） | 0（用 18872 直连的 GET，不计 POST） | 200 |
| 合计真实 POST | **6** | 0 失败 |

代理只转发 `/v1/*` 到 18872 并计数，不改请求体；产品确认 `mode=local, model=qwen3.8-27b, transport=direct, context=false`。

## 质量抽检（n=3，完整回复延迟，非首 token）

| # | 延迟 | 字数 | finish | 回复摘要 |
|---|---|---|---|---|
| 1 | 5815 ms | 42 | stop | “今天天气不错，希望你也能保持好心情…” |
| 2 | 2229 ms | 53 | stop | “辛苦了，快放下手机好好休息吧…” |
| 3 | 1990 ms | 47 | stop | “我就喜欢趴在屏幕角落，看你敲代码…” |

P50 2229 ms / P95 5815 ms（n=3，仅记录，不作 P95 结论）；usage 3/3 可得。

## 隐藏期聊天结算（核心先导项，3/3 通过）

每轮：idle 播放 → 打开面板 → 输入 → 发送 → 立刻 `BrowserWindow.hide()` → 隐藏期等真实回复上屏 → `show()`。

| 轮 | 发送→回复 | 隐藏→回复 | 服务端 POST | 隐藏态 | clip 暂停 | 回复条数 | 恢复后重发 |
|---|---|---|---|---|---|---|---|
| 1 | 993 ms | 964 ms | 1（958 ms, 200） | hidden=true | true | 1 | 0 |
| 2 | 1046 ms | 1015 ms | 1（980 ms, 200） | hidden=true | true | 1 | 0 |
| 3 | 1398 ms | 1370 ms | 1（1329 ms, 200） | hidden=true | true | 1 | 0 |

恢复后：`hidden=false`、clip 继续播放、消息仍为 1 条、POST 仍为 1（无重发/重放）。
证据：`hidden-real{,-2,-3}/result.json`（含每轮 state/lease/消息/代理转发记录与原始 stdout/stderr）、`probe-hidden-real.mjs`。

## 服务端指标（本轮 6 次 POST 前后差）

- `vllm:request_success_total` 8 → 14（+6）
- `vllm:prompt_tokens_total` 2596 → 2948（+352）｜`generation_tokens_total` 1220 → 1366（+146）
- `vllm:num_requests_running` / `waiting` 采样时均为 0；`request_queue_time_seconds_sum` 增量约 0.16 ms
- `request_prefill_time_seconds_sum` +4.74 s｜`request_decode_time_seconds_sum` +8.42 s（含质量 3 次长回复）
- HTTP 请求总时长增量 13.25 s（含 6 次 POST）

## 边界（不外推）

1. n=3，单机、单并发、本机回环；延迟是完整回复墙钟，不是首 token/物理显示。
2. 隐藏期结算只证明“真实模型回复能在隐藏窗口内完成并上屏一次”，未做 30s 级长回复/断网/取消。
3. GPU 参数与并发保持用户给定值；未做多并发/吞吐实验，未改共享 GPU。
4. 证据目录未提交到仓库 HEAD（交付包仍是 5f4b431），需要入库可另开提交。

## 结论

服务可用；默认关闭的待机预览与真实模型可以共存：隐藏期 idle 暂停的同时，已有聊天请求照常结算，
恢复不重发、不重放。先导目标达成，可进入下一轮（例如隐藏期取消/超时与更长的真实回复）。
