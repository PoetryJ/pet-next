# R6-E 条件面板与演示

## 启动（真实宿主，需模型端点）

```bash
cd pet-next/experiments/task-followup
# 终端 1：带条件评估器的宿主（默认关闭，只有显式加 --assessor 才启用）
node run.mjs host --workspace out/demo-ws --assessor capability-conditions --timezone Asia/Shanghai
# 终端 2：桌宠面板（Electron）
node demo/r5-demo.mjs --workspace out/demo-ws      # 或既有 启动.cmd / followup-preview.cmd
```

没有模型端点时，宿主会像旧版一样显式提示 `capability 未启用` 并回退规则原型，不会假装条件模式可用。

## 3 分钟演示脚本

1. 0:00–0:30 建立委托：结果目录选一个真实目录，说明“两份报告都回来再问我”写在补充说明里。
2. 0:30–1:10 只放第一份结果文件：面板显示“条件还不满足 / 还在等 task:…result.present”，
   宿主不发问题（对比：旧模式会马上提醒）。
3. 1:10–1:50 放第二份结果文件：面板显示“条件已满足”，出现一次必要提问；选项来自宿主菜单。
4. 1:50–2:20 点“现在处理”：走既有授权链路；再放同名同 SHA 文件（重复事件），不产生新问题。
5. 2:20–2:50 改口“只要主报告就问我”：计划版本前进，旧条件不再行动；随后新结果只重算不求编译。
6. 2:50–3:00 取消任务：走原链路，之后到达的文件不再提醒。

## 样例页（不需要模型）

用浏览器打开 `demos/conditions/index.html`：四个固定样例（满足并提问 / 未满足 / 缺证据 / 旧模式）。
它只用 `demo/condition-view.mjs` 的纯渲染函数，不连宿主。

## 视觉证据状态

本机无 Windows 桌面、无 Electron 显示、无浏览器可执行文件，**未生成截图/录像**，
`windowsDemo.status = not_run`。面板改动由 `tests/condition-panel.test.ts` 的渲染断言覆盖（文本层）；
真实点击验收需在 Windows 机器上按上面脚本补跑。
