阶段门自检用报告夹具（不是真实画质结论！）

这里的三份 JSON 只是给 `bench/idle-roi/run.mjs --mode=preflight --quality-report=...`
做负控/正控用的合成"质量报告"，它们的 SHA 是 out-v2 真实字节的 SHA：

- positive-report.json        ：status=passed、阈值=冻结基线、三臂 SHA 全对齐（门应放行，EXIT=0）
- wrong-sha-report.json       ：把 F 的 SHA 改成全 0（门应拒绝，EXIT=5）
- loose-threshold-report.json ：把 ocP99Lsb 放宽到 3（门应拒绝，EXIT=5）
- positive-report-v3-yuva.json ：同上，但三臂 SHA 换成 v3（07278fd）实测的 O/F3/C3
  （6ebca6b2… / 08afc852… / 195ae6aa…）；用来证明「门 + v3 素材」这条链本身是通的

口径说明：
1. 它们**永远不能**当放行依据。perf/behavior 模式会拒绝 `--quality-report`
   （退出 2），只读仓内已提交且工作区干净的 `tests/idle-roi/out/quality-report.json`；
   preflight 模式不启动任何产品进程，只打印判定。
2. 复核命令见上一级 `STAGE-GATE.md` 第 3 节，或直接跑 `gate-fixtures/run-controls.sh`。
