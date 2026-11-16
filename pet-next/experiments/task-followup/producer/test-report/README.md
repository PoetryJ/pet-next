# R6-C 真实测试报告接入

把 Node 内建 JUnit reporter 的真实输出导入既有 `pet-followup-result/v1`，并组合成“两份独立报告都回来”的条件。

## 一条命令（真实测试 → 报告 → 条件求值）

```bash
cd pet-next/experiments/task-followup
node --experimental-transform-types --no-warnings producer/test-report/two-source-demo.mjs --out producer/test-report/out
```

它依次做：

1. `run-junit.mjs` 用 `--test-reporter=junit` 跑本实验 `tests/*.test.ts`（来源 `main-tests`），
   记录实际命令、退出码、开始/结束时间到 `invocation.json`；
2. 同样跑 `checks/cn-path.check.mjs`（来源 `cn-path-check`，中文+空格路径真实往返）；
3. `import-test-report.mjs` 分别导入两个来源：各自独立 `input.sha256`、`revision`、`artifactSha`，
   演示脚本里的条件按来源各自求值，不合并计数。

表盘（桌面宿主）读取的是这两个 `result.json`；`--assessor capability-conditions` 下宿主把
`source:<id>.present/failed/revision` 作为字段注册（见 `capability/conditions/context.ts` 的首批字段约定）。

## 失败链（受控夹具，明确标注）

```bash
D=$PWD/producer/test-report/out/injected-demo
node producer/test-report/run-junit.mjs --out $D --source injected --case producer/test-report/fixtures/injected-failure.check.mjs
node producer/import-test-report.mjs --report $D/junit.xml --out $D --source injected --exit-code 1   # r1 failed
node producer/test-report/run-junit.mjs --out $D --source injected --case producer/test-report/fixtures/injected-failure-fixed.check.mjs
node producer/import-test-report.mjs --report $D/junit.xml --out $D --source injected --exit-code 0   # r2 succeeded
```

## 规则

- 解析失败 / 空报告 / 无 `testcase` / 退出码与报告矛盾 → `status=failed`，不当成全通过。
- `skipped` 单列（`result.json.skipped` 与 `metrics` 分开），不凑进 passed。
- 同一来源、同一输入字节重复导入：`revision` 不变、重写相同字节；字节变化才 +1。
- XML 解析用 `fast-xml-parser`（`tooling/package.json`，MIT，见 `THIRD-PARTY.json`），不手写 regex 解析器。
- 依赖复现：`cd producer/test-report/tooling && npm install`。
