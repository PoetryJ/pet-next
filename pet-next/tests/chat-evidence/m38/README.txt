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
2. 本机 CPU 为 384 核（协调文件写单核），GUI 层仍串行执行。
3. Windows 项无环境，一律 not-run，命令与预期见 summary 的 windows 层输出。
