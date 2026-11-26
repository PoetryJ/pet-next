# R7 反例样本

这里保留 R7 独立复核产生的三份 JSON，供 R8 预检使用。

- `design/first-failure.json` 记录旧宿主在正确条件得出应问时，因另一份报告未到而拦下首败提醒。
- `design/watch-vs-archive.json` 记录旧评估器把“继续跟进”误作归档的受控反例。
- `attribution/guard-replay.json` 记录两份语义错误的历史计划通过 R7 编译校验的复跑。

样本来自 R7 `0b38ccf` 的受控实验。任务 ID 与引文用于重放，三个文件只包含结果、命题、合成对话与派生引用。默认路径由预检脚本的位置解析，可用第一个参数指定其他评审目录。在 `experiments/task-followup` 下执行：

```bash
node --experimental-transform-types --no-warnings eval/first-failure-pair/replay-counterexamples.mjs
```
