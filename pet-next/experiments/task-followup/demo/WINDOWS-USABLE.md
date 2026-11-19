用户原先委托跟进 A、B 两份报告，随后改口只等 A。这项演示会真实退出程序，在停机时运行 Node 测试并把 JUnit A 放入工作区。重开后接受问题、核验分析。最后取消 B，再次退出，在停机期间投入迟到的 B，重开后核验通知与回执。

从完整 checkout 的 pet-next 目录开始，使用 Node 24 和 package.json 指定版本的 pnpm。宿主同时导入 experiments/memory-consistency。模型服务需要提供 /health 和兼容的 /v1 接口。

```powershell
npm ci --prefix experiments/task-followup/tooling
npm ci --prefix experiments/task-followup/producer/test-report/tooling
$env:PET_MODEL_BASE_URL = 'http://127.0.0.1:18882/v1'  # 替换为已启动的本地服务或 SSH 转发
$env:PET_MODEL_NAME = 'Qwen3-8B'
$env:PET_MODEL_DISABLE_THINKING = '1'
$demo = 'experiments/task-followup/demo/windows-usable.mjs'
$stamp = Get-Date -Format yyyyMMdd-HHmmss
node --experimental-transform-types --no-warnings $demo --http --out "out/http-$stamp"
```

要验收桌宠窗口，先解锁 Windows 并在产品通知时段运行。构建和执行命令如下。

```powershell
pnpm install --frozen-lockfile
pnpm build
node --experimental-transform-types --no-warnings $demo --out "out/desktop-$stamp"
```

桌面模式会打开实际 Electron 窗口，经桌宠按钮进入面板。演示初始化用 HTTP 声明两份报告的依赖，随后通过面板输入更正，点击作答、打开报告、取消。隐身或锁屏的面板不能证明问题送达。轮询过程中等待系统自动处理真实文件。运行时请给桌宠保留可见桌面，勿同时操作此窗口。

两种模式的 result.json 分开记录。HTTP 模式用脚本客户端发送呈现与作答回执，适合无人值守复跑。桌面模式保留窗口截图。两种模式都把报告原文与磁盘文件逐字对比，并检查独立 verifier 的 SHA、来源数及回执。查看 model-io、会话数据库里的 cond_plans / cond_failures 及客户端和代理账本，区分条件命中与逐事件模型兜底。每次使用新输出目录。
