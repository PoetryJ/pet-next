# 从 R8 恢复工作

## 定位源码和证据

从 GitHub 检出 `main` 即可恢复，固定归档入口为 `r8-checkpoint-20261126`。原记录的产品代码与运行器身份分开保存。需要查看历史矩阵当时的实现时，检出 `9c25529`。下面的命令使用自带预检样本的归档版本。

```bash
git fetch origin --tags
git show --no-patch --format=fuller 1f5d903 9c25529 4fff1f1
git worktree add --detach ../pet-next-r8-reproduction 9c25529
```

服务器 h20v7 原始位置如下。R8 交付的原始实验环境包含模型和原始日志，可用仓库中发布的版本核对服务器留档。新实验应写入新的目录。

- 代码工作树 `/data3/DATA/project/project_meishijiang/pet-r8-first-failure/`
- 原始证据 `/data3/DATA/project/project_meishijiang/r8-evidence/`
- 24 次正式记录 `final-a/`、`final-b/`
- 汇总与核验 `score/score.json`、`verify.json`、`preflight.json`、`R8-REPORT.md`、`demo-replay.txt`
- 原包 `/data3/DATA/project/project_meishijiang/r8-evidence-20261120.tgz`，SHA-256 为 `dec3459b7458e18b3fd8581c52cf4d4a20f238bcd33a278c8c0764c441a35d89`

每个运行的优先阅读顺序为原始 `raw.json`、事件时间线、SQLite 中的决策／通知／授权／回执、实际工作区里的报告和产物，再对照 `model-io/` 和客户端／代理账本。事件写入的送达只代表宿主产生送达记录。桌面点击需要可见会话及实际面板操作。

## 从 GitHub 离线回放与重评

以下 Bash 命令从仓库根目录运行。历史工作区、SQLite 和模型调用全部来自归档。Windows 可用 PowerShell 的 `tar.exe` 解包，再向相同 Node 入口传绝对路径。

```bash
checkpoint="$PWD/docs/checkpoints/r8-20261126"
evidence="$(mktemp -d)"
recheck="$(mktemp -d)"
tar -xzf "$checkpoint/r8-evidence-share.tgz" -C "$evidence"
(cd "$evidence" && sha256sum -c "$checkpoint/r8-evidence-share.sha256")
cd pet-next/experiments/task-followup
node --experimental-transform-types --no-warnings eval/first-failure-pair/demo.mjs \
  --replay "$evidence/final-a/G1-F-V-C,$evidence/final-a/G1-S-V-C,$evidence/final-a/G3-C-V-C"
node --experimental-transform-types --no-warnings eval/first-failure-pair/score.mjs \
  --runs "$evidence/final-a,$evidence/final-b" --out "$recheck/score"
node --experimental-transform-types --no-warnings eval/first-failure-pair/verify.mjs \
  --runs "$evidence/final-a,$evidence/final-b" --out "$recheck/verify.json" \
  --before "$evidence/code-before.json" --after "$evidence/code-after.json"
node --no-warnings "$checkpoint/archive-proof.mjs" "$evidence" > "$recheck/archive-proof.json"
```

只回放 R7 的三个已知反例可直接用 Git 中的样本：

```bash
node --experimental-transform-types --no-warnings eval/first-failure-pair/replay-counterexamples.mjs
```

预检为离线机制测试，覆盖首败条件求值、等待与归档的分支动作、两份历史错误条件的拒绝。不启动模型，也不代表桌面行为端到端通过。

## 真实模型重跑

使用 Node.js 24 和本地 Qwen3-8B。恢复模型服务时参考 [环境记录](ENVIRONMENT.md)。历史 R8 用 GPU0 和本机 18882 完成最终矩阵。恢复当日先确认设备占用和服务归属。

从仓库的 `pet-next/experiments/task-followup/` 执行。若是干净副本，先按 lockfile 安装 `tooling` 与 `producer/test-report/tooling` 的依赖。保持固定模型、真实时钟和已记录时区，观察实验是否落在提醒窗口内。重跑前记录源码树、模型、实例、环境参数，运行后保存目录和退出状态。

```bash
npm ci --prefix tooling
npm ci --prefix producer/test-report/tooling
node run.mjs test
node run.mjs typecheck

# 先见到失败，再看完整条件对照。
PET_MODEL_UPSTREAM=http://127.0.0.1:18882 PET_MODEL_NAME=Qwen3-8B \
PET_MODEL_DISABLE_THINKING=1 PET_MODEL_TEMPERATURE=0 PET_MODEL_TIMEOUT_MS=600000 \
  node --experimental-transform-types --no-warnings eval/first-failure-pair/run.mjs \
  --group G2 --promise W --arm V-C --out /path/to/new/r8-g2-vc

PET_MODEL_UPSTREAM_A=http://127.0.0.1:18882 \
PET_MODEL_UPSTREAM_B=http://127.0.0.1:18882 \
  bash eval/first-failure-pair/reproduce.sh /path/to/new/r8-repro
```

全仓单测的状态和环境差异见 [归档时验收记录](VERIFICATION.md)。实验继续开发时可先用上面的独立入口。

离线机制或历史回放可用于排故。现场运行应读取新产生的事件、真实报告和真实模型响应。若当前要验证的仅是重启恢复，先跑 G2-W 的单格并保留停机前后的 DB，再跑配对，避免把完整矩阵当作寻找首个根因的工具。

## 接手后的第一组验证

1. 分开复现 G2-W 的两个阶段。先看 B 失败后首次局部询问是否成功，再在明确回答 `wait_other` 后测试真实进程重启。落盘记录承诺版本、等待状态和旧授权是否失效。分别测试正常关停和进程中断。
2. 两种重启都要验证 B 尚未到时等待、B 首次到达后可作答、重复结果不二次提醒。局部产物应只引用被授权来源。若有全量产物，验证两份输入及文件 SHA。
3. 再用 G3-C 验证持续观察确实跨轮存在，同时检查改口和取消之后的旧报告。最后恢复真实模型两臂对照，按原生条件、兜底和规则分别登记。
4. 在解锁的自有 Windows 桌面上，用真实面板点击授权并打开报告。跟进旧的 Windows 宿主回归入口及其帮助文档。桌面验收单列截图、可见性和点击事件。
