# M3-8 待机资源对照（Linux，Xvfb :97，2026-11-06）

条件
- 应用 HEAD `60af704` + 本轮 bench/experiments（无产品路径改动）；素材 hash 见各轮 summary。
- 每臂 warmup 8s + 采样 60s；hidden = xdotool unmap（本环境无窗口管理器，Chromium 仍报 visible，
  `hiddenSignal=unmapped-only`），candidate 由 bench 显式 `setHidden(true)`；visible 为普通映射窗口。
- 顺序：p1 baseline→candidate，p2 candidate→baseline，p3 baseline→candidate；另跑 visible 1 对。
- 待机期间零模型请求：8 轮 requests/POST 均为 0。
- 进程 RSS 为“本轮进程 RSS 求和”，共享页会重复计数，不能当独占内存。

| 轮次 | 臂 | 状态 | fps | Electron CPU 秒/分钟 | RSS 求和 P50 (MB) | POST | 失败 |
|---|---|---|---|---:|---:|---:|---:|
| p1 | baseline | hidden | 24.1 | 3.05 | 575.5 | 0 | 0 |
| p1 | candidate | hidden | 0 | 0.23 | 572.8 | 0 | 0 |
| p2 | baseline | hidden | 24.0 | 3.12 | 575.5 | 0 | 0 |
| p2 | candidate | hidden | 0 | 0.10 | 564.7 | 0 | 0 |
| p3 | baseline | hidden | 24.0 | 3.19 | 575.4 | 0 | 0 |
| p3 | candidate | hidden | 0 | 0.33 | 572.3 | 0 | 0 |
| v0 | baseline | visible | 24.0 | 3.18 | 574.7 | 0 | 0 |
| v0 | candidate | visible | 24.0 | 3.33 | 575.0 | 0 | 0 |

交互（CDP 探针，ms）
- 恢复首帧：baseline 30.1 / 14.7 / 28.2；candidate 15.6 / 34.4 / 2.4（candidate 由 bench 显式恢复）。
- 点击回应：baseline 89.9 / 74.4 / 355.2；candidate 90.7 / 76.0 / 79.3（p3 baseline 355ms 为单次离群）。

结论
- 热点是隐藏态下原生 video 继续解码：24fps、renderer 2.1–2.4 CPU 秒/分钟、GPU 0.7。
- 原型（CDP 注入隐藏暂停）隐藏时 0fps、Electron CPU 0.10–0.33 秒/分钟（约 −90%~−97%），
  RSS 基本不变（−0.5%~−1.9%，在噪声内）；可见态无变化。
- 代价：需要产品级可见性/恢复触发（本轮由 bench 显式触发）；真实窗口管理器的 minimize/restore
  行为 Windows/macOS 未验证（not-run）；隐藏探针仅 unmap，不代表真实最小化路径。

## 目录
- `m38-p{1,2,3}-{b,c}/`：hidden 正式三对；`m38-v0-{b,c}/`：visible 对照；`mainpid-fix/`：harness 校验。
- 每轮保留 `summary.json`、`samples.json`、`requests.ndjson`、`fake-ssh.ndjson`、`exit.txt`、`product-stdout.log`；
  Chromium `user-data/` 已清理（非证据）。
