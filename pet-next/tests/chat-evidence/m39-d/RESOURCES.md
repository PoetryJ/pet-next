# M3-9 资源对照（产品路径，真实 BrowserWindow hide/show）

| 对 | 状态 | baseline CPU s/60s | candidate CPU s/60s | 变化 | 解码帧 baseline→candidate | 恢复中位/最大 ms | 点击中位/最大 ms |
|---|---|---|---|---|---|---|---|
| m39-p1 | hidden | 2.97 | 0.13 | -95.6% | 1452→0 | 2.5/3 | 23/24 |
| m39-p2 | hidden | 2.95 | 0.13 | -95.6% | 1451→0 | 2/3 | 23/25 |
| m39-p3 | hidden | 2.87 | 0.14 | -95.1% | 1452→0 | 2/3 | 23.5/24 |
| m39-v1 | visible | 2.78 | 2.85 | 2.5% | 1451→1452 | 2/3 | 23/25 |
| m39-v2 | visible | 2.68 | 2.82 | 5.2% | 1452→1456 | 2/3 | 23/24 |
| m39-v3 | visible | 2.92 | 2.87 | -1.7% | 1451→1452 | 3/3 | 23.5/25 |

口径：CPU=/proc jiffies 差 ÷ HZ(100)，electron-only 角色求和（main/renderer/gpu/utility/zygote/crashpad）；
RSS 在 summary.json 里分开记 electron-only 与全部角色求和，不称"省内存"；
解码帧=totalVideoFrames 差；恢复/点击延迟是"软件呈帧/状态机进入"的墙钟，不是物理显示延迟；
POST=0：两臂都未启用聊天服务（无请求路径），不能据此宣称"隐藏不触发请求"。
