# R6-live Windows 体验：5 步演示（约 3 分钟）

> 状态：**脚本已交付，未在本机点击验收**（本机无 Windows 桌面/浏览器，`windowsDemo.status=not_run`）。
> 需要负责人在 Windows 上按下面步骤跑一次并留截图；不要用截图替代原始证据，截图只是体验附录。

## 启动

```powershell
cd pet-next\experiments\task-followup
.\demo\W1-RUN.ps1 -ModelBaseUrl http://127.0.0.1:18882/v1 -ModelName Qwen3-8B -Workspace "D:\演示 工作区"
```

脚本会：检查 node → 设置 `PET_MODEL_*` → 起真实宿主（`--assessor capability-conditions`）→ 打印带 token 的
`PANEL` 链接并自动打开。缺少模型配置时直接退出，**不会**换成 stub。

## 5 步（每步只做一件事）

1. **建依赖任务**：面板里新建「中文路径检查」，结果目录选 `工作区\inbox\B`。
2. **建主任务**：新建「主测试」，目录 `工作区\inbox\A`，补充说明写
   `两份报告都回来以后再问我是否继续`，并在“依赖报告”里选「中文路径检查」。
3. **只放一份**：把任意 `result.json` 放进 `inbox\B`。预期：任务仍“等待结果”，**不提问**；
   条件卡片显示“条件还不满足 / 还在等 task:…result.present”。
4. **放第二份**：把 `result.json` 放进 `inbox\A`。预期：条件变“已满足”，出现**一次**提问；
   点“现在处理”后回执成功。
5. **改口**：在补充说明里写 `更正：B 不用等了，只要主报告回来就问我`。预期：旧计划不再行动，
   新计划版本前进；随后删掉 `inbox\B` 里的文件也不影响（不再依赖 B）。

## 必须一起看的失败形态

- 模型未配置：启动即报“缺少 PET_MODEL_BASE_URL”，宿主日志里有 `capability 未启用` → 回退规则原型。
- 中文/空格工作区：`D:\演示 工作区` 必须能正常建库、写结果、重启后仍能恢复。
- 关面板不关机：关掉浏览器后宿主仍按 `PET_FOLLOWUP_RECHECK_MS` 重判；重开面板看到同一问题或已回答。
- 重启：杀掉宿主再启动，未回答问题仍在，回答不会重复执行。

## 留证

把以下文件拷回交付目录（不要只留截图）：

- `<工作区>\state\host.json`、`followup.sqlite`
- `<工作区>\host-console.log`
- `model-io\`（每次模型请求/响应）
- 面板截图（可选）+ 每一步的时间戳

## 已知限制

- 未做 Electron 原生窗口（用默认浏览器打开面板）；如需桌宠外壳，沿用既有 `demo/panel.html` 托管方式即可。
- 演示用的问答选项由宿主菜单提供；面板不提供自定义问题。
