# M3-10 B：便携入口（packaged-main）

## 改了什么

新增 `electron/packaged-main.ts`（编译为 `dist/electron/packaged-main.js`）：

```ts
import { LAUNCHER_MODE_ENV } from '../contracts/launcher.ts';
process.env[LAUNCHER_MODE_ENV] = '1';
await import('./main.js');
```

- 先在模块顶层设置 `LAUNCHER_MODE_ENV`，再**动态** import 既有 `main`；ESM 静态 import 会被提升，
  main 在模块求值时只读一次该环境变量，静态写法会漏进桌宠页。
- 不复制窗口/配置/退出逻辑：仍复用现有 launcher-start 同进程 `createWindow` 接管，
  不启动开发脚本 / Node / pnpm。
- 配置仍写 `~/.pet-next/qwen-remote.json`（不写应用包）；`standard`/`companion` 与
  `idle-pause` 原默认语义不变。

## Linux 实测：2/2 pass

```bash
cd pet-next
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
env -u NODE_OPTIONS PET_NEXT_PACKAGED_E2E=1 node --experimental-strip-types --test \
    --test-concurrency=1 --test-reporter spec tests/packaged-main.e2e.test.ts
```

结果：`tests 2 / pass 2 / fail 0`（原始日志 `m310-delivery/logs/packaged-e2e.log`，默认显示 `:132`）。
断言要点：进程进入 `app/launcher.html`（标题 `pet-next 首次启动配置`）而非桌宠页；env 里显式删除
`PET_NEXT_LAUNCHER`，launcher 模式只能由打包入口设置；`HOME` 指向临时目录，配置落
`$HOME/.pet-next/qwen-remote.json`；关窗自然退出 code 0。

## Windows：not-run（无机器）

前提：`pnpm build` 已产出 `dist/electron/packaged-main.js`；**真实桌面**（win32 分支不找显示 socket、
不起 Xvfb），`PET_NEXT_PNPM_CLI` 解析规则同 A 目录说明（本测试自身不 build，但 launcher 探测链路
仍会调用 pnpm）。

```powershell
cd pet-next
$env:PET_NEXT_PACKAGED_E2E = '1'
node --experimental-strip-types --test --test-concurrency=1 --test-reporter spec `
     tests/packaged-main.e2e.test.ts
```

判定：`tests 2 / pass 2 / fail 0`。这不是用户端双击验收的替代——用户端验收见
`tests/chat-evidence/m310/d/README.md` 的 Windows 清单（解压中文+空格目录、PATH 去掉 Node/pnpm/git）。

## 未证明

- Windows 真机 2/2 未跑（not-run）。
- 便携 ZIP 内 `resources/app/dist/electron/packaged-main.js` 与源码树一致由 D 的静态验收逐文件
  SHA 核对，不等于 Windows 上真的能启动。
