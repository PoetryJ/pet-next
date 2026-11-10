# M3-10 D：便携产物独立验收（静态）与成本

产物（C 实际 ZIP，未从源码旁路启动）。**两个阶段的 ZIP 要分清，不要混用 SHA：**

| 阶段 | 构建点 | ZIP SHA256 | 说明 |
|---|---|---|---|
| 初次验收 | C 分支 `a93dd54` | `48eb0dd09c0372143f1bb85f0d213a11f9aa57a9d48de45517c3565d1cb5ca1a` | 本节 23 项检查首跑对象，留有 `static-result.json` |
| **最终交付** | 集成后 `1271f44` | `c21e688fd5b7963abd2959ba763d43148260cc1239c81535cae245bcf45eb181` | 与 `manifest.json`(gitSha=1271f44) / bundle 对齐；**重建后已复检 23 项 0 失败** |

最终包复检原始结果：`m310-delivery/logs/portable-static-result.json`（`zip_sha_matches_manifest`
比对 `c21e688f…eb181`，197 条目、逐文件 SHA 全对、0 失败）。两次构建的运行时闭包相同，
差异只来自新增的 B 入口与 A 测试改动之后的重新 build。

复算命令（对最终包）：
`python3 tests/portable-accept/verify-portable-zip.py <zip> <manifest> <extract-root> <out.json>`

## 静态验收（本机 Linux 实际执行）

| 项 | 结果 |
|---|---|
| ZIP SHA/字节与 manifest 一致 | pass |
| ZIP 完整性（testzip） | pass |
| 197 条目与 manifest 一致 | pass |
| 无 node_modules/tests/bench/证据/.git/assets-pipeline/experiments/密钥 | pass（0 命中） |
| `PetNext.exe` 存在且 PE32+ x64 GUI（machine 0x8664 / subsystem 2） | pass |
| `resources/app/package.json` main=`dist/electron/packaged-main.js`、type=module、无 dependencies | pass |
| `packaged-main.js` 动态 import `./main.js`；main/preload 存在 | pass |
| page.html/launcher.html/page.js/launcher.js/idle.webm | pass |
| Electron LICENSE、LICENSES.chromium.html、项目 LICENSE（PC2005-cloud）、README | pass |
| 197 文件逐项 SHA 与 manifest 对照 | pass（0 mismatch） |

解压位置：`/tmp/m310-d-extract/中文 空格 便携包/PetNext-win32-x64/`（路径含中文与空格；cwd 在包外）。
解压字节 367 213 277 B（约 350 MiB），ZIP 146 564 405 B。

## Windows 运行期验收：not-run（本机无 Windows，不用 Linux 替代）

请在 Windows 上按下面清单执行（Node/pnpm/git 只用于外置测试器，**不要**进入应用 PATH）：

1. 把 ZIP 解到含中文与空格的目录，cwd 放在包外；应用目录设为只读后启动。
2. `PATH` 仅保留 `C:\Windows\System32;C:\Windows`（或用受限用户环境）；确认无 node/pnpm/git。
3. 双击 `PetNext.exe`：应直接出现现有配置页（不是桌宠页），窗口标题/页面 URL 为 `launcher.html`。
4. 填表→保存→探测（GET /models）→启动：桌宠页 `app/page.html` 出现，配置页销毁。
5. 关闭桌宠（自然退出）：退出码 0；`tasklist`/`netstat` 无本次进程与调试端口；无关哨兵进程存活。
6. 再次打开 `PetNext.exe`：配置回填（`%USERPROFILE%\.pet-next\qwen-remote.json`），应用包目录不新增用户配置。
7. 缺 SSH：给出可行动中文错误（`ssh-missing`/`not-ready`/`auth-failed`），能改配置重试；探测中关窗可取消且无残留。
8. 成功聊天链（可选）：包外 fake HTTP + 真实系统 `ssh.exe` 转发到随机 fake 端口；**绝不访问 18872**。
   没有 SSH 凭据就记 not-run，不要用依赖 Node 的 `.mjs` 假 SSH 冒充“无 Node 完整链路”。

建议命令（仅测试器使用，PowerShell）：
```powershell
$zip = 'PetNext-win32-x64.zip'; $dst = "D:\验收 目录"
Expand-Archive -LiteralPath $zip -DestinationPath $dst
$env:PATH = 'C:\Windows\System32;C:\Windows'
Start-Process -FilePath (Join-Path $dst 'PetNext-win32-x64\PetNext.exe') -PassThru
# 之后按第 3–7 步人工/截图验收；结束后 Get-Process PetNext,electron -ErrorAction SilentlyContinue
```

## 成本对照

| 项 | 源码试用 ZIP（8eac712） | 便携 ZIP（本轮） |
|---|---|---|
| 压缩字节 | 3 675 319 B（399 条目） | 146 564 405 B（197 条目） |
| 解压字节 | 约 3.7 MiB 源码 | 367 213 277 B（约 350 MiB） |
| 用户端需要 | Node 22.12+、pnpm、install、build、Electron 下载 | 无 Node/pnpm/源码；自带 Electron 运行时 |
| 构建耗时 | 现有 build | 63.4 s（含 build+staging+packager+zip） |
| 外部依赖 | 同左 + 系统 OpenSSH（SSH 模式） | 系统 OpenSSH（SSH 模式）与用户凭据 |

Windows 同机“已装依赖源码启动 vs 便携 EXE”交替 5 次（首启单列）本机 **not-run**：
需测进程启动→配置页可交互、选择→桌宠 ready、退出、进程角色/残留；n=5 只给原始值/中位数，
不报 P95，不预设速度/RSS 改善。

## 未证明

1. Windows 上双击/配置/回填/退出/残留全链未跑（无 Windows）。
2. 无 Node/pnpm/git 的 PATH 下运行未实测（只做了静态依赖检查）。
3. 系统 OpenSSH 真实隧道成功链未跑（无凭据；不访问 18872）。
4. 启动耗时/内存对照未测；仅给出 ZIP/解压/构建成本。
5. 未做代码签名/安装器/自动更新（本轮范围外）。
