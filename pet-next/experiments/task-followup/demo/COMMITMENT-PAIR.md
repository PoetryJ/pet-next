# R7 现场演示：同一份 CI 输入，两条相反承诺

演示不读“期望答案”：它只读真实 run 的 SQLite、通知表与时间线。两份 run 的任务名、报告绑定、
96 条尾部聊天完全相同，只有第一条用户承诺不同。

## 秒级回放（推荐现场先看）

```bash
cd pet-next/experiments/task-followup
node --experimental-transform-types --no-warnings \
  eval/commitment-pair/demo.mjs \
  --replay <T1-P-V-C run>,<T1-O-V-C run>
```

输出会并排列出：主任务动作（提问/归档/取消）、是否回答、有效分析是否核验、
旁支任务送达的提醒数、模型调用与 token。T1 是“A 成功先到、B 失败后到”：

- P（失败才问）：B 失败后问一次，回答后产出核验分析。
- O（成功才问）：B 失败后安静归档，零提问。

## 现场重跑“两份都成功”配对

```bash
export PET_MODEL_UPSTREAM=http://127.0.0.1:18882
export PET_MODEL_NAME=Qwen3-8B PET_MODEL_DISABLE_THINKING=1 PET_MODEL_TEMPERATURE=0
node --experimental-transform-types --no-warnings \
  eval/commitment-pair/demo.mjs --live --arm V-C --out <新目录>
```

它会真实启动两个宿主、各喂 96 条 `/api/say`、各生成两份成功的 JUnit：
P 安静归档；O 在第二份成功后提问，用户回答后核验分析。每次输出目录独占。

## 现场重跑失败配对

```bash
node --experimental-transform-types --no-warnings \
  eval/commitment-pair/run-pair.mjs --trajectory T1 --promise P --arm V-C --out <新目录P>
node --experimental-transform-types --no-warnings \
  eval/commitment-pair/run-pair.mjs --trajectory T1 --promise O --arm V-C --out <新目录O>
node --experimental-transform-types --no-warnings \
  eval/commitment-pair/demo.mjs --replay <新目录P>/<...>,<新目录O>/<...>
```

## Windows 桌面

负责人机器解锁后在 Windows 运行同一组命令；面板必须真实可见并留下截图/呈现回执。
本轮服务器无桌面（`windowsClick: pending_locked_desktop`），未把 HTTP/进程通过计作窗口点击通过。
