# M3-8 独立验收清单（agent D，冻结于阶段1）

命令入口（package.json 由负责人接线）：`pnpm m38:accept -- --layer=pre|post|all|<id,...>`
脚本：`scripts/m38-acceptance/run.mjs`（`lib.mjs` 工具、`layers-pre.mjs` / `layers-post.mjs` 分层）
证据根：`tests/chat-evidence/m38/<phase>/logs/`（原始子进程输出 + 同名 `.meta.json`），
`tests/chat-evidence/m38/<phase>/results.ndjson`（追加式，不覆盖）、`summary.txt|json`（最近一次）。

判定规则（先冻结，避免事后解释）：
1. 执行过的层，退出码非 0 即 fail，必须原样记录，不得重跑到绿。
2. 未执行/无环境即 not-run，**不得**计入通过，也不得用 Linux/Node 结论替代 Windows 结论。
3. 数量以 node --test 汇总块（`# tests/pass/fail/skipped` 或 `ℹ ...`）为准，脚本自动解析，手抄不算。
4. GUI 层串行，单核机器不得与 A/C 的 GUI 并发；显示固定 :96（自起自收），禁用 :94。
5. 原始日志只放子进程字节；命令、环境、退出码、计数放 `.meta.json`，笔记不得混入 `.log`。

## 一、环境与前置（E）

| id | 检查 | 通过判据 | 层 |
| --- | --- | --- | --- |
| E1 | node/pnpm 版本 | node v22.x、pnpm 10.33.4（来自 /tmp/m38-tools/bin） | `env` |
| E2 | NODE_OPTIONS | 子进程环境已剔除（父进程非空只记录） | `env` |
| E3 | HEAD/分支/工作树 | 记录 HEAD、分支、porcelain；仅允许本 agent 新增目录未跟踪 | `env` |
| E4 | 显示 | `:96` socket 状态；`:94` 一律拒绝 | `env` / 各 GUI 层 |

## 二、基线交付包独立复核（P）

| id | 检查 | 通过判据 | 阶段1实测 |
| --- | --- | --- | --- |
| P1 | zip SHA256 | `3ad2a72fa7773f1103da9fb32a58370327bb6539b9933b3b54aac21d5e174fb9` | 一致 |
| P2 | zip 完整性 | `zipfile.testzip()==null`，条目 370 | 一致 |
| P3 | `启动.cmd` 字节 | 1800B / 45 CRLF / 0 孤立 LF / 0 非 ASCII / 无 BOM / 无 `chcp` | 一致 |
| P4 | `启动.cmd` 与 HEAD 一致 | 包内 sha256 == worktree `启动.cmd` sha256 | 一致（`f2f39dee…c1038`） |
| P5 | 中文+空格解压 | `/tmp/m38-d/中文 空格 解压包`，UTF-8 名保留 | 通过 |
| P6 | install --frozen-lockfile | exit 0（干净目录） | exit 0，≤2s（store 预热） |
| P7 | build | exit 0 | exit 0，4s |
| P8 | test（`pnpm test` 默认并发，自然结束） | exit 0，数量与串行一致 | exit 0，560/557/0/3，17s |
| P9 | test 串行复跑（同一批文件，`--test-concurrency=1`） | exit 0 | exit 0，560/557/0/3，33s，63 文件 |
| P10 | electron 二进制可用性（披露项） | 若 install 未产出 `node_modules/electron/path.txt`，记录并显式替代 | install 未产出；从本机同版本 dist 复制并补 `path.txt` |

数值基线（阶段1，供合流后对照）：包内纯单元 **560 tests / 557 pass / 0 fail / 3 skip**（3 skip 为
`tests/launcher/cmd-entry.test.ts` 的 Windows-only 用例）；源码包不含 `bench/*.test.ts`（8 文件），
故 worktree 收集到 71 文件、包内 63 文件，数量不可直接横比。

## 三、模块测试分层（U/C/I）

| id | 命令 | 通过判据 | 层 |
| --- | --- | --- | --- |
| U1 | `pnpm test` | exit 0；fail=0；与基线数量对照并解释差异 | `unit` |
| C1 | `pnpm test:cleanup` | exit 0；`tests/support/**` 独立入口 | `cleanup` |
| I1 | `pnpm test:integration` | exit 0；含 `assets:check` | `integration` |
| T1 | `pnpm typecheck` | exit 0 | `typecheck` |
| L1 | `pnpm lint` | exit 0 | `lint` |
| B1 | `pnpm build` | exit 0 | `build` |

## 四、E2E 与 launcher 关键路径

| id | 检查 | 通过判据 | 层 |
| --- | --- | --- | --- |
| X1 | `pnpm test:e2e` | exit 0；launcher 默认 skip 状态如实记录 | `e2e` |
| X2 | **显式** `PET_NEXT_LAUNCHER_E2E=1` 的 7 例 | exit 0；tests=7、fail=0、skip=0 | `launcher` |
| X3 | 取消/重试/退出隔离 3 轮 | 每轮 exit 0，逐轮登记；每轮证据快照到 `post/rounds/round-N/` | `rounds` |
| X4 | 单轮三例语义 | 探测中关窗：无残留 pid、debug 端口关闭、POST=0；连接失败：改端口后重试成功、旧隧道退出；直接关窗：无残留、哨兵存活 | `rounds`（读 `exit.txt`） |

## 五、完整 verify

| id | 检查 | 通过判据 | 层 |
| --- | --- | --- | --- |
| V1 | `pnpm verify` | 串行执行、自然结束；记录次数/退出码；失败用例逐条分类（实现/环境/抖动），**不重试到绿** | `verify` |

## 六、资源对照复核（R）

| id | 检查 | 通过判据 | 层 |
| --- | --- | --- | --- |
| R1 | 数据存在性 | `bench/idle-profile/runs/<对>/baseline|candidate/{summary,requests,samples}` 齐全 | `resources` |
| R2 | 待机无请求 | 两臂 `requests.ndjson` 中 POST 数 = 0 | `resources` |
| R3 | 同机同素材 | summary 里 hostname/素材标识一致（字段缺失则标"无法验证"） | `resources` |
| R4 | 交替顺序 | 逐对记录 baseline/candidate 先后；只能凭落盘字段与时间戳推断，需显式标注为推断 | `resources` |
| R5 | 无法验证项 | 必须列出（同时并发、进程 RSS 口径、外部负载等），不得写成结论 | `resources` |

## 七、Windows 项（W）

| id | 检查 | 判据 | 层 |
| --- | --- | --- | --- |
| W1 | 平台 | 无 Windows/pwsh 环境 → **not-run**，列出命令与预期，不声称通过 | `windows` |
| W2 | `cmd-entry` 真实 .cmd 5 例 | Windows 上 exit 0、5 pass / 0 skip（跑前系统代码页未改） | 人工 |
| W3 | launcher 7 例 | Windows 上 exit 0、7 pass | 人工 |
| W4 | `pnpm verify:windows` | exit 0；真实系统 125/150 仍 not-run | 人工 |
| W5 | 解压包中文+空格 | install/build exit 0；test 自然结束 | 人工 |

## 八、结论口径

单一建议取值：**通过 / 有限返工 / 停止**。
- 任一执行层 fail → 不给"通过"。
- 只允许"not-run 项 + 无 fail"给"通过（附 not-run 清单）"，且 not-run 必须在报告首屏出现。
- 失败分类固定三类：实现缺陷 / 环境限制（网络、显示、Windows 缺失）/ 抖动（需给出重复证据）。

## 九、阶段1 执行结果（冻结时点）

```
env               pass  exit 0
pkg-hash          pass  exit 0   (P1–P4 全部一致)
pkg-extract       pass  exit 0
pkg-install       pass  exit 0   1–2s（干净目录，store 预热）
pkg-electron-binary pass exit 0  (环境替代：干净安装后仍缺二进制，已复制 313M 并补 path.txt，已披露)
pkg-build         pass  exit 0   4s
pkg-test          pass  exit 0   560 / 557 / 0 / 3   17s
pkg-test-serial   pass  exit 0   560 / 557 / 0 / 3   33s
unit              pass  exit 0   590 / 587 / 0 / 3   20s
cleanup           pass  exit 0   22 / 22 / 0 / 0      17s
integration       pass  exit 0   5 / 5 / 0 / 0        7s
typecheck         pass  exit 0   7s
lint              pass  exit 0   16s
build             pass  exit 0   15s
launcher          pass  exit 0   7 / 7 / 0 / 0       45s
rounds            pass  exit 0   9 / 9 / 0 / 0       87s（3 轮 × 3 例，逐轮 exit 0）
```

阶段1 额外用基线在 `:96` 上自验了 GUI 链路（`build` → `launcher` 7/7 → `rounds` 3 轮）：
Xvfb 自起自收、显式 `PET_NEXT_LAUNCHER_E2E=1`、逐轮证据快照均可跑通，
免得到了合流后才第一次发现脚本/显示问题。注意 `launcher` 依赖 `dist/electron/main.js`，
所以合流后必须 `build` 先于 `launcher`/`rounds`/`e2e`。

已知事件（须在交付说明中披露）：
1. 解压包内 `pnpm install --frozen-lockfile` exit 0 但未产出 electron 二进制（本机到 GitHub 不可达），
   `require('electron')` 会同步下载并永久等待 —— 这是本机**环境限制**，不是包缺陷；
   未做替代前的两次整链尝试因此在 `scripts/chat-demo-core.test.ts` 处挂起并被上层终止，
   原始片段保留在 `tests/chat-evidence/m38/pre/logs/`（无 `.meta.json` 者为被终止的尝试）。
2. 补齐 electron 二进制后，默认并发 `pnpm test` 与串行复跑都自然结束且计数一致，
   M3-7 记录里"解压包默认并发可能挂起"在本轮未复现；成因与 (1) 相同，已按环境限制归类。
3. 本机 CPU 实为 384 核（`nproc=1` 是 `OMP_NUM_THREADS=1` 造成的误读），真实紧约束是**内存约 2.3GB**：
   纯单元可并行，但同一时刻只保留 1 个 Electron/bench，bench 全程避开其他 GUI；本清单所有 GUI 层串行。
4. 容器原先缺 Electron 系统库（libnspr4/libnss3 等）会 exit 127，负责人已 apt 安装并 ldd 无 not found；
   本轮 GUI 层（launcher 7/7、rounds 9/9）在该修正后跑通，记为**环境修正**，不是产品失败。
5. 离线策略已固化进脚本：`pkg-install` 带 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，二进制由
   `pkg-electron-binary` 预置（复制同版本 dist 313M + 写无换行 `path.txt`），两层都在 `.meta.json` 留痕；
   `pkg-install/build/test/serial` 各自独立有界超时（300s/300s/600s/600s），超时只杀本轮进程组并记 124。
6. 负责人两次终止的 `pkg-test-serial` 尝试（分别 18 分钟与 13 分钟 0% CPU，卡在 `electron/install.js`
   二进制下载）保留在 `pre/logs/`（无 `.meta.json` 者即为被终止尝试），并已作为"环境限制"归类。

## 十、合流后独立验收（phase=merged，HEAD 3380f7f，2026-11-06）

| 层 | 结果 | 退出码/计数 | 耗时 |
| --- | --- | --- | --- |
| env | pass | 0 | 3.5s |
| unit | pass | 0；590 / 587 / 0 / 3 | 24s |
| cleanup | pass | 0；22 / 22 / 0 / 0 | 18s |
| integration | pass | 0；5 / 5 / 0 / 0 | 7s |
| typecheck | pass | 0 | 8s |
| lint | pass | 0 | 25s |
| build | pass | 0 | 14s |
| launcher（显式 PET_NEXT_LAUNCHER_E2E=1） | pass | 0；7 / 7 / 0 / 0 | 45s |
| rounds（取消/重试/退出，3 轮） | pass | 0；9 / 9 / 0 / 0 | 87s |
| verify（完整 pnpm verify） | pass | 0；46 / 39 / 0 / 7 | 730s |
| pkg-extract + pkg-hash（最终交付包 c4af14d） | pass | 0；385 条目，5 个关键文件与 HEAD blob 一致 | 2s |
| resources（4 对） | pass | 0；hidden 24.1→0 fps，visible 24→24 | <1s |
| windows | not-run | -（本机 linux） | - |

- verify 的 46/39/7 与负责人口径一致；7 skip 即 launcher 组（未开 PET_NEXT_LAUNCHER_E2E 时按设计跳过）。
- 上表 unit 计数 `590/587/0/3` 是 D 在 3380f7f 上的实测值。最终 HEAD `c4af14d` 只改
  `scripts/unit-tests.mjs` 一处收集条件（`.test.mjs` 纳入、`.e2e.test.*` 仍排除），把 B 的
  `scripts/test-run-context.test.mjs`（8 例）接入门禁，单测层变为 **598 / 595 / 0 / 3**；
  该次完整 verify 由负责人执行（第四次），D 未重跑，此处只记口径来源。
- **交付包最终口径**：`pet-next-trial-src-c4af14d.zip`，SHA256
  `dcffc47150dde0320bafc76cafb66915db7178160d247f07588ee1200808e1af`，385 条目，对应最终 HEAD `c4af14d`。
  历史上验过的两个包均为**同源被淘汰包**，不再作为交付物：
  - `df4c391d…`（对应 3380f7f）：差异为 D 合流时对 `scripts/m38-acceptance/` 4 个文件的自修订
    （`pkg-hash` 的 hash 门禁改为可选、`resources` 适配 `runs/<pair>-{b,c}/<arm>`）；
  - `326e7c64…`（对应 2edb158）：差异为负责人补的单测收集接线（`scripts/unit-tests.mjs`）。
  两处差异均不涉及产品源码/测试/`启动.cmd`；三个包的 5 个关键文件与 `启动.cmd` 结构不变量一致
  （`diff -rq` 逐目录复核：df4c39→326e7c 仅 4 个验收脚本不同，326e7c→dcffc4 仅 `scripts/unit-tests.mjs` 不同）。
- `启动.cmd` 包内 1800B / 45 CRLF / 0 非 ASCII / 无 BOM / 无 chcp；仓库里以 LF 存储（1755B），
  说明打包做了 eol 规范化，因此校验口径是"包内容经 `git hash-object --path` 与 `HEAD:path` 比对"，
  **不能**用字节直比（否则必然误判"包与 HEAD 不一致"）。
- 复跑注意：`pkg-hash` 依赖已解压目录，若把 `pkg-hash,pkg-extract` 放进同一次调用，层定义顺序会让
  hash 先跑而误报"解压目录为空"；应按 `--layer=pkg-extract` 再 `--layer=pkg-hash` 分两次执行。
- resources 抽验：`m38-p1` 对 CPU（electron-only）3.05→0.23 s/min、RSS 全角色求和 575.5→572.8MB、POST 0/0，
  与 C 的 SUMMARY 完全一致；`m38-v0`（visible）24→24 fps，CPU 3.23→3.38，符合"可见时不降载"。
- 脚本自身两次口径修正（须披露）：`pkg-hash` 原先硬编码 M3-7 基线 SHA/条目数与 worktree 路径前缀，
  换新包后误报 4 次；`resources` 原先只认 `runs/<pair>/{baseline,candidate}`，未适配 C 的
  `runs/<pair>-{b,c}/<arm>` 布局，误报 1 次。均为脚本问题，修正后 pass，**不是产品失败**。
- 解压包 install/build/test 未由 D 执行（负责人口径：离线 electron 由负责人有界执行并回填证据）；
  D 只保留 SHA/完整性/启动.cmd/逐文件一致性结论。
