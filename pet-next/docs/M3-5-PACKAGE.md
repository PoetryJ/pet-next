# M3-5 打包清单与误导修正登记（worker C）

## 1. 停止跟踪（2026-11-04，普通提交，不改历史、不删磁盘文件）

移除范围（`git rm -r --cached`，保全 SHA256 见 `docs/M3-5-UNTRACKED-SHA256.txt`）：

- `logs/chat-evidence/closeout-demo/userdata/**`、`logs/chat-evidence/qwen-local-smoke/userdata/**`
  —— Electron 运行时缓存（Cache/Code Cache/GPUCache/Crashpad 等），共 99 个跟踪文件；
- `bench/runs*/**/environment.json`、`logs/platform-runs/**/environment.json`
  —— 原始全量环境快照（含机器现场），共 156 个跟踪文件。

`.gitignore` 新增模式与之对应；既有 NDJSON/截图/verify 日志等交付证据**保留跟踪**。
历史提交不受影响（不改写）；磁盘文件全部保留。

## 2. 源码试用包（scripts/make-trial-package.mjs）

- 白名单：`adapters/ app/ assets/ assets-pipeline/ bench/context/ config/ contracts/
  core/ docs/ electron/ experiments/ scripts/ tests/` + 根配置（package.json、
  pnpm-lock.yaml、tsconfig*、eslint.config.js、README.md）。
- 黑名单（二次过滤）：node_modules、dist、logs/、runtime/、bench/runs*、
  tests/chat-evidence/、tests/independent-*、userdata、各类 Cache、environment.json、
  *.pem/id_rsa/*.key/.env*/known_hosts、.pnpm-store。
- 打包命令（负责人在集成后执行）：
  `node scripts/make-trial-package.mjs --out <目录> --record`
- 压缩后端：系统 zip → python3 zipfile → tar.gz（如实记录实际格式）。

## 3. 误导修正登记（按冻结规则：归属外文件只登记，负责人处理）

1. **`bench/context/review/WINDOWS-TRIAL.txt` 16-17 行**（M3-4 D 归属）：
   示例展示 `$env:PET_NEXT_CHAT_CONTEXT='1'; pnpm chat:local` 后紧跟
   `pnpm chat:local  # 默认关（完全旧行为）`——PowerShell 会话内环境变量设置后
   **持续存在**，“直接再启动=off”的暗示是错的；M3-5 的 `chat:trial` 已从入口
   根治（显式 off 强制清除继承值），旧文档示例建议负责人在集成分支补一行
   `Remove-Item Env:PET_NEXT_CHAT_CONTEXT` 或直接改指 chat:trial。
2. **`scripts/chat-local.mjs` 26-27 行注释**（M3-1 归属）：`PET_NEXT_QWEN_BASE_URL
   覆盖服务地址与模型（默认 127.0.0.1:18872/v1）`——措辞易被读成“Windows 上
   chat:local 自动连服务器”；实际默认是**本机回环**，本机无服务即失败。
   Windows 远程试用必须走 chat:remote/chat:trial 的 SSH 委托链。建议负责人将该
   注释补一句“（本机地址；远程环境请用 chat:remote/chat:trial）”。
3. **JS 字符不是 token** 的强调位置（既有正确内容，无需修改）：
   `tests/chat-context.e2e.test.ts`、`bench/context/review/WINDOWS-TRIAL.txt`；
   本轮 `docs/WINDOWS-TRIAL.md` 第 4 节保留同一口径。

## 4. 打包记录

（由 `--record` 追加；集成后填）
