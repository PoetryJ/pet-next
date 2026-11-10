# M3-12 R1 D：阶段门（机器放行）与条件性性能

本文件只写**门**与**预置命令**。`README.md` 的取材段归 A；本轮我没有改它，
所以本文覆盖 README 里已被取代的两处旧说法（§1 的 `--allow-missing`、§2 的
`--src/--f-src/--c-src` 覆盖），以本文为准。

## 0. 本轮结论：**门不过，全部 not-run**

已提交的 `tests/idle-roi/out/quality-report.json`
（sha256 `5a1583b4…3612d8`，提交 `652cb63`）的 `verdict.status` 是 **failed**
（`verdict.failed: ["o-to-c"]`，`gates` 里 `o-to-c` 为 `pass:false`）。
因此：

| 项目 | 状态 |
|---|---|
| O / F3 / C3 各 3×60s 真实可见 idle | **not-run** |
| 响应/布局/退出回归 | **not-run** |
| 素材体积（绝对字节 + 倍数） | **not-run** |
| 原 CPU 收益门 | **未触发**（没有可用数据） |
| 产品接线 / 默认开关 | **未动**（0 行改动） |

素材侧已就绪：B 的 `07278fd` 的 `experiments/idle-roi/out-v3-yuva` 能被门精确取到，
正控放行（EXIT=0）、旧报告拒跑（EXIT=5），见 §5。**唯一 blocker** 是 C 的严格全片门报告
还没以 `verdict.status=passed` 提交。

本轮没有起过 Xvfb `:157`、没有起过 Electron 长跑；门的所有自检都在
`--mode=preflight`（或 perf 模式的门阶段）里完成，过程见
`runs/gate-*/console.txt`、`runs/gate-*/gate.json`。

## 1. 门做了什么（`lib/gate.mjs`，在 Xvfb/Electron/build 之前）

启动任何产品进程前，按顺序检查：

1. **素材目录是本次 subpath 的准确目录**
   - 目录名必须等于 `--assets-subpath` 末段（`out` / `out-v2` / `out-v3-yuva`），
     不遍历、不回退到 `<dest>/out`；
   - 必须存在、是目录、含 `manifest.json`、至少有一个臂视频（空目录不算取到素材）；
   - 与 `lib/artifacts.mjs` 的 `resolveAssetsDir(dest)` **交叉核对**：两者不一致就拒跑
     （这就是"同 dest 先 out 后 out-v2 会选回旧 out"那个缺陷的挡板）。
2. **质量报告必须 passed**
   - 读 `tests/idle-roi/out/quality-report.json`（路径写进错误信息与 evidence），
     `verdict.status` 必须是字面量 `passed`；`verdict.pass` 必须 true；
     `gates[]` 每一项都必须绿；缺 `verdict.status` 也算不通过。
   - 报告阈值必须覆盖并**不松于**冻结基线：`ocMaeLsb=1`、`ocP99Lsb=2`、
     `fToCChannelMaxLsb=2`、`fToCAlphaMaxLsb=2`、`frameCount=48`、`roiOutsideOpaque=0`、
     `ptsDeltaMs=1`、`durationDeltaMs=1`、`bboxDeltaPx=1`、`centroidDeltaPx=0.5`、
     `alphaThreshold=1`。任一字段缺失或更松 → 拒跑（防止靠放宽阈值"通过"）。
   - 报告必须是**已提交且工作区干净**的字节（`git ls-files` + `git status`），
     提交号写进 evidence；未跟踪/改动过的报告一律不作放行依据。
3. **素材 SHA 与报告一致**
   - 报告里的 O/F/C SHA 从 `arms.*`、`manifest.*`、`provenance.files[*]`、`assets.*`
     以及本次 staged `manifest.json` 全部收集，**同一臂出现两个不同 SHA 即自相矛盾** → 拒跑；
   - 本次真正要加载的三个文件的 SHA 必须逐一等于报告主张；找不到文件（而不是 SHA 不符）
     与 SHA 不符分开报错；
   - 文件名按 `F3.webm / F.webm / full.webm / F-full.webm`、`C3.webm / C.webm / roi.webm / C-roi.webm`
     候选，**SHA 匹配优先于命名顺序**，选中的文件名与来源写进 `gate.json`。

### 退出码

| code | 含义 |
|---|---|
| 2 | 参数问题，或用了反放行开关（见下） |
| 4 | 素材/staging 前置不满足（目录不存在、空目录、缺 manifest、找不到某臂文件、resolveAssetsDir 交叉核对不一致） |
| 5 | 质量报告门拒绝（status 非 passed、阈值放水、gates 有红、报告内部 SHA 矛盾、报告未提交/有改动、加载字节与报告 SHA 不符） |

### 反放行（没有例外）

- `--force` / `--skip-gate` / `--allow-missing` → 退出 2；
- `--src=` / `--f-src=` / `--c-src=`（任意路径覆盖臂素材）→ 退出 2；
- 非 `--mode=preflight` 用 `--quality-report=`（换一份报告）→ 退出 2；
  该参数只在 preflight 的自检负控/正控里可用，且 preflight 不启动任何产品进程；
- 不给 `--assets-ref` 也不给 `--assets-dir` → 退出 2（不再回退到工作区 `experiments/`）。

## 2. 预置命令（本轮 not-run，命令可原样复跑）

```bash
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
cd /data3/DATA/project/project_meishijiang/m312r1-wt-d/pet-next
ASSETS_REF=07278fd   # B 的 v3（负责人分支）；只认已提交字节，脚本可换 V3_REF
SUB=experiments/idle-roi/out-v3-yuva
# :157 由 ensureDisplay 自动拉起（Xvfb :157 -screen 0 1920x1080x24 -nolisten tcp）

# (a) 只过门，30 秒内给出放行/拒绝结论，不起 Electron
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --mode=preflight \
  --assets-ref=$ASSETS_REF --assets-subpath=$SUB --display=:157

# (b) 三臂 3×60s 真实可见 idle（rep 偶数 O→F3→C3，奇数反向；预热 10s 单列不入均值）
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --mode=perf --plan=O,F3,C3 \
  --reps=3 --seconds=60 --warmup=10 \
  --assets-ref=$ASSETS_REF --assets-subpath=$SUB --display=:157

# (c) C 臂几何接线（只有 dist 含接线且 CSS 为 contain 时才可能通过布局核对）
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --mode=perf --plan=O,F3,C3 \
  --reps=3 --seconds=60 --warmup=10 --roi-layout=on \
  --assets-ref=$ASSETS_REF --assets-subpath=$SUB --display=:157

# (d) 响应/布局/退出回归（不采资源，只打点）
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --mode=behavior --plan=O,F3,C3 --seconds=0 \
  --probe=click,drag,hidden,failure --clicks=10 \
  --assets-ref=$ASSETS_REF --assets-subpath=$SUB --display=:157

# (e) 只复算已有目录（唯一不过门的模式；不会启动产品）
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --mode=analyze \
  --run=bench/idle-roi/runs/<stamp>
```

产物：`runs/<stamp>/gate.json`（门判定原文）、`raw.ndjson`（每臂 1s 样本，含 loadavg）、
`summary.json`（perArm / pairs / verdict / `qualityGate` 原文 / `sources[arm].gateShaMatched` /
`armLabels`（F3、C3）/ `provenance`）。素材体积用 `summary.sources[arm].bytes` 出**绝对字节**，
倍数相对 O。

## 3. 自检：门会真的非零退出（原始输出在 `runs/gate-*/console.txt`）

基线素材：`--assets-ref=HEAD`（`b9c2f61`）+ `--assets-subpath=experiments/idle-roi/out-v2`。
正控用的 "passed" 报告是 `gate-fixtures/positive-report.json`（合成夹具，只允许 preflight 用），
三个臂 SHA 就是 out-v2 实际字节的 SHA；负控只改动其中一项。
**一键复跑**：`bash bench/idle-roi/gate-fixtures/run-controls.sh`（不建 Xvfb、不起 Electron，
结束时校验并还原仓内报告）。

| # | 场景 | 命令要点 | 退出码 |
|---|---|---|---|
| 1 | 仓内已提交报告（真实状态 failed） | `--mode=preflight --assets-ref=HEAD` | **5** |
| 2 | 同上但用 perf 模式（证明 Electron 前就被挡住） | `--mode=perf --assets-ref=HEAD` | **5** |
| 3 | 正控：passed + 三臂 SHA 全对齐 | `--quality-report=bench/idle-roi/gate-fixtures/positive-report.json` | **0**（门放行） |
| 4 | 报告里 F 的 SHA 被改错 | `gate-fixtures/wrong-sha-report.json` | **5** |
| 5 | 报告把 `ocP99Lsb` 放宽到 3 | `gate-fixtures/loose-threshold-report.json` | **5** |
| 6 | 同 dest 同时有 `out/` 和 `out-v2/`（A 的旧 `resolveAssetsDir` 会选回 out） | `--assets-dir=<tmp>/dup/out-v2`（脚本临时造） | **4** |
| 7 | 空目录当素材目录 | `--assets-dir=<tmp>/empty/out-v2`（脚本临时造） | **4** |
| 8 | 把仓内报告临时改成 passed（未提交）后跑 perf | `--mode=perf` | **5** |
| 9 | 本轮 B 的 `out-v3-yuva` 还没提交 | `--assets-subpath=experiments/idle-roi/out-v3-yuva` | **4** |
| 10 | 本轮 v3 素材（B 的 `07278fd`）+ 仓内旧 v2 报告 | `--assets-ref=07278fd --assets-subpath=…out-v3-yuva` | **5** |
| 11 | v3 素材 + v3 正控（O/F3/C3 实测 SHA） | `--quality-report=…positive-report-v3-yuva.json` | **0**（放行） |

### 原始输出（节选，全文见各 `console.txt`）

#1 `runs/gate-neg1-failed-report/console.txt`：

```
[idle-roi] 阶段门拒绝（code=5）：5 项
  - verdict.status=failed（不是 passed）；失败门：o-to-c（报告：…/tests/idle-roi/out/quality-report.json，sha256=5a1583b4…3612d8）
  - verdict.pass=false（报告：…，sha256=5a1583b4…3612d8）
  - 门 o-to-c 未通过（pass=false）（报告：…，sha256=5a1583b4…3612d8）
  - F: 报告内部素材 SHA 自相矛盾 → b1c3e8cf…3673 | 2ca492a9…02f0（来源：report.arms.fSha256=b1c3e8cf, report.provenance.files[F.webm].sha256=2ca492a9）
  - C: 报告内部素材 SHA 自相矛盾 → 81c8a2f2…8f4e | 08a80ac4…7e0c（来源：report.arms.candidateSha256=81c8a2f2, report.manifest.candidateSha256=81c8a2f2, report.provenance.files[C.webm].sha256=08a80ac4, staged-manifest.candidateSha256=81c8a2f2）
  素材 subpath：experiments/idle-roi/out-v2；判定细节见 …/runs/gate-neg1-failed-report/gate.json
EXIT=5
```

#2 `runs/gate-perf-failed/console.txt`：与 #1 同因（`verdict.status=failed`、`o-to-c` 红），
不同点是 `gate.json` 里 `qualityReport.provenance = {tracked:true, clean:true, commit:"652cb63…"}`
——perf/behavior 模式下报告来源（已提交 + 干净）也一起被校验。整段在没有
`ensureDisplay`/`ensureBuild`/`electronPreflight` 的情况下退出。

#3 `runs/gate-positive-report/console.txt`（正控，证明门不是"永远拒绝"）：

```
{ "gate": { "ok": true, "code": 0, "errors": [] } }
EXIT=0
```

#4 `runs/gate-wrong-sha-report/console.txt`：

```
  - F: 报告内部素材 SHA 自相矛盾 → 0000…0000 | b1c3e8cf…3673（来源：report.arms.fSha256=00000000, report.provenance.files[F.webm].sha256=b1c3e8cf）
EXIT=5
```

#5 `runs/gate-loose-threshold-report/console.txt`：

```
  - thresholds.ocP99Lsb=3 比冻结基线 2 更松（放水）（报告：bench/idle-roi/gate-fixtures/loose-threshold-report.json）
EXIT=5
```

#6 `runs/gate-dup-dest/console.txt`：

```
  - resolveAssetsDir 选中了别的目录：<tmp>/dup/out（本次应为 <tmp>/dup/out-v2）；拒跑，避免拿旧 out 的字节当本轮素材
EXIT=4
```

#7 `runs/gate-empty-dir/console.txt`：

```
  - 素材目录缺 manifest.json：<tmp>/empty/out-v2
  - 素材目录里没有任何臂视频（<tmp>/empty/out-v2）；空产物不算取到素材
  - resolveAssetsDir 选中了别的目录：<tmp>/empty/out（本次应为 <tmp>/empty/out-v2）
  - F: 素材目录里没有该臂文件（找过 F3.webm/F.webm/full.webm/F-full.webm）：…
  - C: 素材目录里没有该臂文件（找过 C3.webm/C.webm/roi.webm/C-roi.webm）：…
EXIT=4
```

#8 `runs/gate-dirty-report/console.txt`：

```
  - 质量报告有未提交改动（M pet-next/tests/idle-roi/out/quality-report.json），不能作为放行依据
EXIT=5
```

（#8 执行后已把报告还原：`git status` 干净，sha256 回到 `5a1583b4…3612d8`。）

#9 `runs/gate-v3-missing/console.txt`：

```
[idle-roi] assets-ref=HEAD subpath=experiments/idle-roi/out-v3-yuva -> 失败：fatal: pathspec 'pet-next/experiments/idle-roi/out-v3-yuva' did not match any files
git archive 取已提交素材失败：git -C … archive HEAD pet-next/experiments/idle-roi/out-v3-yuva | tar -x … --strip-components=3
EXIT=4
```

**门之后的采集路径本轮未被跑到**（没有 passed 报告，按纪律不启动产品）：`--mode=perf/behavior`
从门通过到 `runArm` 的那段代码只做了静态复核，没有真实 Electron 证据。等 C 的报告真的
`passed` 并提交后，第一次 perf 必须同时核对 `summary.json` 里的
`qualityGate.ok=true`、`sources[arm].gateShaMatched=true`、`armLabels={F:'F3',C:'C3'}`。

### 反放行开关（都在启动前退出 2）

```
$ … --force            → 本轮禁止绕过阶段门：--force（放行只看 report 的 verdict.status 与素材 SHA，无人工记忆开关）
$ … --allow-missing    → 本轮禁止绕过阶段门：--allow-missing（…）
$ … --src=…            → 本轮禁止 --src：臂素材只能来自 --assets-ref 的已提交 subpath，并被质量报告 SHA 钉住。
$ … （不给 ref）        → 阶段门：必须给 --assets-ref=<已提交 ref>（推荐）或 --assets-dir=…
$ … --quality-report=… → --quality-report 只给 --mode=preflight 的负控/正控自检用；性能/行为采集只读仓内已提交的报告。
$ … --display=:156     → 显示号只能是 :157 / :154
```

## 4. 本轮暴露、需要别人修的依赖

1. **A**：`lib/artifacts.mjs` 的 `resolveAssetsDir(dir)` 仍是"遍历第一个含 manifest 的子目录"，
   同 dest 里 `out/` + `out-v2/` 时返回 `out`（#6 原样复现）。本文的交叉核对会把它变成**拒跑**，
   但要顺手拿到正确目录，仍需 A 的精确实现（按 subpath 末段解析）。A 落地后 #6 应改为：
   门返回 ok（若报告对得上），或至少不再报"选中了别的目录"。
2. **A/C**：仓内 `quality-report.json` 自身矛盾——`arms.fSha256/candidateSha256` 是 v2（`out-v2`）
   字节，而 `provenance.files` 还写着 v1（`out`）的 SHA + `sourceCommit=9dc035e`。
   这不是门太严，是 Codex 复核第 1 条的原样复现；门只是不再让人"凭记忆"绕过它。
3. **B**：本轮臂文件名要用 `F3.webm` / `C3.webm`（或在 `manifest.json` 里给出
   `f3Sha256` / `c3Sha256`、`candidateSha256` 指向 C3），否则门会因"报告 SHA 与候选文件对不上"拒跑。
   门对命名是宽容的（SHA 优先），但对字节是严格的。
4. **负责人**：`--display` 默认已改为 `:157`，`:154` 仅保留给上一轮归档证据。

## 5. 与集成分支对接（B=`07278fd`，A=`ccc883b`）

素材取法（本轮预置）：

```bash
env -u NODE_OPTIONS node bench/idle-roi/run.mjs --mode=preflight \
  --assets-ref=07278fd --assets-subpath=experiments/idle-roi/out-v3-yuva --display=:157
```

逐字节实测（`git cat-file -p 07278fd:<path> | sha256sum`）：

| 臂 | 文件 | 字节 | SHA-256 |
|---|---|---|---|
| O | `out-v3-yuva/O.webm` | 78,419 | `6ebca6b2…df1a` |
| F3 | `out-v3-yuva/F3.webm` | 625,108 | `08afc852…b4a1` |
| C3 | `out-v3-yuva/C3.webm` | 631,169 | `195ae6aa…eb7c`（= `manifest.candidateSha256`） |

v3 的 `manifest.json` 顶层只有 `sourceSha256` / `candidateSha256`，**没有 F 的 SHA**；
`revision.v2.arms[*]` 是历史版本记录（`b1c3e8cf…` / `81c8a2f2…`），我按"版本不混用"只当历史、不当作主张。
因此 **F3 的 SHA 只能由 C 的报告提供**：报告里没有 F sha，门会以"报告没有该臂 SHA"拒跑（不会拿 manifest 里的 v2 F 顶上）。

A 的 `ccc883b` 带来两个契约变化，我这边已适配（`run.mjs` + `gate.mjs`）：

1. `stageCommittedAssets` 改成 `tar --strip-components=1` 并返回 `assetsDir`
   （`<dest>/experiments/idle-roi/out-v3-yuva`）。门优先用 `archive.assetsDir` 作 expectedDir，
   没有该字段（旧版）时才回退 `<dest>/<subpath 末段>`；`resolveAssetsDir` 交叉核对仍照做。
2. `verifyAssetsDir` 的候选名仍只有 `F.webm/full.webm/F-full.webm`、`C.webm/roi.webm/C-roi.webm`，
   遇到本轮的 `F3.webm`/`C3.webm` 会返回 `ok:false, code:missing-file`（字节其实已经解出来）。
   门对"只缺命名"不静默、也不硬退：记 `evidence.staging.namingOnlyFailure`，再逐臂按**报告 SHA** 核验
   （有候选但对不上 → 5；连候选都没有 → 4）。**建议 A 把 F3/C3 加进候选**，否则 stage 2 每次都带一条 warning。

实证（临时把 A 的 `ccc883b` artifacts.mjs 放进工作区跑，跑完还原、未提交）：
`runs/gate-v3-a-fix/console.txt` —— 负控（v2 报告）`EXIT=5`；正控（v3 夹具）`EXIT_POSITIVE=0`，
`gate.json` 里 `assetsDir.expected = <dest>/experiments/idle-roi/out-v3-yuva`、
`staging.namingOnlyFailure.code = missing-file`。

### C 的 R1 报告格式（门已适配，干跑放行）

C 这一版报告分层了，门现在读这些字段（旧格式仍然认）：

- 结论：`verdict.status`（只认 `passed`）+ `verdict.pass`；
- 候选门：`verdict.candidates.{status,pass,failed}` 必须绿，`verdict.prerequisites[]` 必须绿
  （例如 `yuva-selfcontrol` 原生 YUVA 直通自对照）；
- 臂 SHA：`verdict.candidates.sha256.{O,F,C}`，并与 `variants[category === candidates.category].arms.sha256`
  交叉核对；`verdict.historical` 与其他 variants（v2、自对照）**只记账**，不当同一臂的第二个主张；
- 阈值：顶层 `thresholds` 逐项比对冻结基线（R1 报告与基线完全一致）。

干跑（v3 素材 `07278fd` + C 当前**未提交**的报告）：`runs/gate-c-report-dry/console.txt` → `EXIT=0`，
选中 `O.webm 6ebca6b2…` / `F3.webm 08afc852…` / `C3.webm 195ae6aa…`，`verdict.subject=f3c3`，
`verdict.historicalFailed=['v2-rgba/o-to-c']`（历史 v2 失败不阻塞候选，但原样记账）。

**这不算放行性能**：那份报告还没提交，strict 模式（perf/behavior）会以"未提交改动"拒跑。

**仍未放行**：仓内 `quality-report.json` 还是 `652cb63` 的 v2 报告（`status=failed`，
且 `provenance.files` 与 `arms` 互相矛盾）。C 的严格全片门出结果并**提交**后，我先跑 #10/#11
两条 preflight，确认 `verdict.status=passed` 且三臂 SHA 对齐，再等负责人说"可以跑性能"。

## 6. 红线（本轮仍成立）

零真实模型 POST（bench 的 `sanitizedEnv` 删掉 chat/Qwen/SSH 变量）；不访问 18872；
不动 GPU/模型参数；不改默认开关、不碰产品代码；性能数据没有 → 不给结论；
门没过的证据不许用"上次跑过"补。
