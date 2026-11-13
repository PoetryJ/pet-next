# 跟进桌宠预览（final-demo）

> 分支 `codex/pet-followup-final-demo`。这是一个**独立的预览入口**：不改 main 的默认运行模式；不双击这两个入口就和原来一样。

## 一次性准备

1. Node.js 24（需要内置 `node:sqlite`）。不在 PATH 时，把 `node.exe` 的完整路径写进本目录的 `followup-node.txt`（一行）。
2. 在 `pet-next/` 执行一次 `pnpm install` 与 `pnpm build`。

## 双击入口

| 文件 | 判断方式 | 说明 |
|---|---|---|
| `followup-preview.cmd` | 本地规则原型（scripted-rule P3，不调用模型） | 默认入口。面板标“本地规则原型 · 不调用模型”。不理解任意自然语言目标。 |
| `followup-preview-model.cmd` | 模型判断（capability：记忆抽取 + 有效记忆读取 + 介入评估） | 默认连接本机回环 `http://127.0.0.1:18882/v1`、模型 `Qwen3-8B`，单次模型请求超时 240000 ms（一次判断含抽取+评估两次调用，总超时 500000 ms），均可用同名环境变量覆盖。面板标“模型判断 · capability:<模型名>”，并多出“补充说明 / 改口”输入框。 |

双击后：一个控制台窗口（显示预检与日志）+ 桌宠出现。点桌宠上的“帮我跟进”打开面板。

## 使用

1. 面板里写任务名、选结果目录，点“建立委托”。可以关掉面板；后台宿主继续观察这个目录。
2. 另一个程序（例如 `experiments/task-followup/producer/run-tests.mjs`）往目录里写 `result.json`。宿主自动发现。
3. 需要你决定时，桌宠冒出气泡（面板关着也会提醒）。点气泡会打开对应任务和具体选项。
4. 选“分析失败样本”后，本地工具读取已核验的结果快照，写出分析报告。只有工具回执和文件 SHA 都核对通过，任务才算完成。“打开报告”可以直接查看。
5. 可以取消任务。取消后，新结果、到期的等待、重启都不会再提醒，也不会执行分析。
6. “完全退出”（或在桌宠上按 Esc）会停掉桌宠和后台宿主。退出期间到达的结果会在**下次启动时补处理**。应用退出或关机期间什么都不执行。

## 模型判断（followup-preview-model.cmd）

- 判断在事务外异步进行：先登记请求，然后 `assess` 调用模型，最后回交给 `submitAssessment`。回交时按当前任务核对 `taskRevision / assignmentId / memoryCursor / eventCursor`，再走原有的执行与通知校验。过时的回交会被拒绝。
- 模型的原始输出、guard 前提案和 guard 后结果都会落库：`assessments` 表，以及 capability 的 `cap_assessments` / `cap_items` / `cap_turns`。面板“开发者信息”里也能看到。
- 工具执行仍然需要你在问题里明确授权。模型提议“直接执行”时，会改成向你提问。
- 失败会被如实记录，不生成占位动作：模型不可达、超时、解析错误都记为 failed，也不会冒出问题。如果没配模型环境变量，宿主会回退到本地规则原型，并在面板上写明“模型未启用”。
- 请求固定带 `temperature=0`、`stream=false`、`chat_template_kwargs.enable_thinking=false`、`max_tokens`（入口默认 2048，上限 4096）。

## 已知限制

- 规则入口的跟进判断是本地规则原型，不是通用理解。
- 模型入口只是接线完成，不代表能力达标。在 Qwen3-1.7B 上的一次初步长任务实测（8B 正式结果待补）里，用户说过“等第二版再问”，模型仍在第一版就提问了（多打扰一次）。详见交付目录里的 `FINAL-DELIVERY.txt` 和 `evidence/LIVE-model-longtask`。
- 只支持模板 `local-tests`（`result.json`，结构见 `experiments/task-followup/contracts.ts`）。
