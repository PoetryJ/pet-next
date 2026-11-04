# M3-5 最终交付报告（一页）

## 1. 结论与提交

- 分支：`codex/pet-next-m3-windows-trial`
- 交付 HEAD：以 `git log -1 --format=%h` 为准（核对锚点：行为代码提交 `3fc4d52`；其后仅文档登记提交）
- 正式入口：`pnpm chat:trial --context=on|off`（= `node scripts/chat-trial.mjs`，自持 `pnpm build` → SSH 委托链 chat-remote → 真实 Electron 窗口 → 远程隧道直连 → 状态行显示上下文模式；显式 `--context=off` 强制清除父进程继承的 `PET_NEXT_CHAT_CONTEXT`；缺省 off）。

## 2. 一条可执行命令

```bash
cd pet-next && pnpm verify    # 需 DISPLAY（无头环境先 Xvfb :94）
```

Windows 独立复跑（无 Xvfb，Codex 本机）：

```powershell
node scripts/win-trial-recheck.mjs
node --experimental-strip-types --test --test-concurrency=1 tests/independent-trial-windows.check.ts
```

## 3. 数量与退出码（最终 HEAD 实测）

| 层 | 命令 | 数量 | 退出码 |
|---|---|---|---|
| unit | `pnpm test` | 462/462 | 0 |
| cleanup | `pnpm test:cleanup` | 22/22 | 0 |
| integration | `pnpm test:integration` | 5/5 | 0 |
| e2e | `pnpm test:e2e` | 27/27（含 chat-trial 新增 5 条） | 0 |
| 全量 | `pnpm verify` | 516/516 | 0 |
| 正式入口单跑 | `node --experimental-strip-types --test --test-concurrency=1 tests/chat-trial.e2e.test.ts` | 5/5（两轮连跑全绿） | 0 |
| 解压包冒烟 | 解压源码包 → 借宿主 node_modules 构建 → `chat:trial --context=off`（fake 替身） | 起窗→关窗 | 0（状态行 off、chat-remote-ready、隧道无残留监听） |

注：verify 需 `env -u NODE_OPTIONS`（本机 IDE 注入的 `node-language-shim` 会拦截 `copy-static.mjs` 的 `fs.cp`，属环境干扰非代码问题）。

## 4. 证据目录

- `tests/chat-evidence/trial/`：t1-context-on、t2-explicit-off、t3-pending-reset、t4-empty-dist、t5-spaced-path，各含 `log.txt`（交互与断言流水）、`requests.ndjson`（模型请求体原始证据）、`ssh.ndjson`（隧道替身清单）；不落全量环境变量。
- `docs/M3-5-PACKAGE.md`：打包清单与记录（含停止跟踪 SHA256、误导修正登记）。

## 5. 交付包与 SHA256

| 包 | 文件 | 内容 | SHA256 |
|---|---|---|---|
| 源码包 | `pet-next-trial-src-3fc4d52.zip` | 302 文件，3.24 MiB，zip(python3)，无黑名单/无绝对路径前缀，解压即仓库根 | `fa3973424cee7a1609192d3c0b9c7a87d6a2e1e126df72f21b7f4b2a8c62868d` |
| 证据包 | `pet-next-trial-evidence-2026-11-04.zip` | 16 文件，9.9 KiB（5 用例 × 3 证据文件 + 登记文档） | `eb1d26a5d0f9560da307f19d0f5962ec6b455d9d947353bca5c8545747622de7` |

## 6. 未证明项（不声称）

1. **Windows 真机实跑未执行**（本机 Linux）：`scripts/win-trial-recheck.mjs` 生成器已验证（7 处替换全命中、生成物 lint + build 通过），但 `tests/independent-trial-windows.check.ts` 的 Windows 实跑标记 not-run，交 Codex 本机复跑。
2. **真实 qwen 服务与真实 OpenSSH 未触碰**（零真实推理约束）：隧道/probe/上下文语义均由替身证明链正确性；模型端行为（真实 token 计费、服务端历史裁剪）未验证。
3. **Windows 启动器/DWM/焦点层**：Linux Xvfb 下 CDP 真实输入覆盖不到 Windows 窗口管理细节（缩放、DPI、任务栏、权限弹窗）。
4. **代码签名/自动更新/安装器**：本轮为源码试用包，未涉及。
5. `chat:trial` 对 pnpm 未透传未知参数的边界（如 `--context=` 空值）仅由模块级测试覆盖，入口级未单列。

## 7. 本轮修复（集成阶段，负责人权限）

- `scripts/make-trial-package.mjs`：out 目录未建 → 误报"无可用压缩后端"；zip 内路径带宿主绝对前缀 → 改 cwd=base 相对路径；`--evidence` 目录支持递归展开（证据包 2→16 文件）。
- `bench/context/review/WINDOWS-TRIAL.txt`：修正 PowerShell `$env:` 残留示例（补 `Remove-Item` 并指向 chat:trial）。
- `scripts/chat-local.mjs`：注释补"本机地址；远程环境请用 chat:remote/chat:trial"。
