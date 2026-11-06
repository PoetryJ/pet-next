M3-8 独立验收证据（agent D）
============================

目录约定
--------
m38/<phase>/logs/<layer>-<stamp>.log        该层子进程 stdout+stderr 原样字节，不含任何笔记
m38/<phase>/logs/<layer>-<stamp>.meta.json  真实命令、cwd、display、起止时间、耗时、退出码、计数、备注
m38/<phase>/logs/<layer>-<stamp>.json       内部检查层（env / pkg-hash / resources / windows）的结构化结果；
                                            有子进程的层也可能同时产出 .json 作为细节，.log 仍是原始输出
m38/<phase>/results.ndjson                  追加式索引，每次层执行一行（历史不覆盖，权威索引）
m38/<phase>/summary.txt|summary.json        该 phase 最近一次运行的汇总与结论

日志文件没有同名 .meta.json 的，说明该次执行被上层终止（未完成），只能作为"中途快照"引用，
不能当成一次完整层的结论。

阶段1（pre）实测：2026-11-06，包内 560 tests / 557 pass / 0 fail / 3 skip，
默认并发 17s、串行 33s，install 2s、build 4s，全部 exit 0。
交付包 SHA256 3ad2a72fa7773f1103da9fb32a58370327bb6539b9933b3b54aac21d5e174fb9，
启动.cmd 1800B / 45 CRLF / 0 非 ASCII / 无 BOM / 无 chcp，与 HEAD 一致。

复跑
----
export PATH=/tmp/m38-tools/bin:$PATH; unset NODE_OPTIONS
node scripts/m38-acceptance/run.mjs --layer=pre        # 阶段1
node scripts/m38-acceptance/run.mjs --layer=post       # 阶段2（合流后）
node scripts/m38-acceptance/run.mjs --layer=launcher --phase=post
node scripts/m38-acceptance/run.mjs --list

必须披露的环境限制
------------------
1. 本机到 GitHub 不可达，解压包 `pnpm install --frozen-lockfile` 退出码 0 却没有落下
   node_modules/electron/path.txt，于是任何 require('electron') 都会同步触发下载并永久等待。
   层 `pkg-electron-binary` 会把本机同版本（43.3.0）的 dist 复制进临时解压目录并补 path.txt
   （path.txt 必须无换行），只动 /tmp 下的解压目录、不动产品源码；该层结果是"环境替代"，
   不能当成干净安装的产物去宣称。
   探针原始输出：logs/adhoc-probe-electron-install-hang.log、logs/adhoc-probe-chat-demo-hang.log。
2. 本机 CPU 为 384 核（协调文件写单核），GUI 层仍串行执行；真实紧约束是内存约 2.3GB。
3. Windows 项无环境，一律 not-run，命令与预期见 summary 的 windows 层输出。

合流后独立验收（phase=merged）
-----------------------------
HEAD 3380f7f 实测全部 exit 0：env 3.5s；unit 590/587/0/3（24s）；cleanup 22（18s）；integration 5（7s）；
typecheck 8s；lint 25s；build 14s；launcher（PET_NEXT_LAUNCHER_E2E=1）7/7（45s）；rounds 3 轮 9/9（87s）；
verify 46/39/0/7（730s）；resources 4 对（hidden 24.1→0 fps，visible 24→24，POST 0/0）；windows not-run。
详细分层表与披露见 scripts/m38-acceptance/ACCEPTANCE-CHECKLIST.md 第十节。

交付包三个哈希的关系（勿混用）
------------------------------
最终交付：pet-next-trial-src-c4af14d.zip，SHA256 dcffc47150dde0320bafc76cafb66915db7178160d247f07588ee1200808e1af，
385 条目，对应最终 HEAD c4af14d；启动.cmd 1800B/45 CRLF/0 非 ASCII/无 BOM/无 chcp。
历史被淘汰包（同源，仅打包时点不同，均不涉及产品源码/测试/启动.cmd）：
- df4c391d…（3380f7f）：差 scripts/m38-acceptance/ 下 4 个验收脚本的 D 自修订；
- 326e7c64…（2edb158）：差 scripts/unit-tests.mjs 的单测收集接线（.test.mjs 纳入，598 例）。
diff -rq 逐目录复核：df4c39→326e7c 仅 4 个文件不同，326e7c→dcffc4 仅 1 个文件不同。
报告与交付说明一律以 dcffc471… 为准。

解压包 install/build/test 由负责人有界执行（环境替代：ELECTRON_SKIP_BINARY_DOWNLOAD=1 安装、
从本机同版本 dist 复制二进制并补 path.txt），原始日志在 tests/chat-evidence/m38/pkg-lead/；
D 的包层结论止于 SHA256/完整性/启动.cmd/逐文件一致性。

