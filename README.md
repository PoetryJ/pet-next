# pet-next

由 PoetryJ 维护的独立桌宠重构项目：透明桌面宠物、点击与拖动交互、可取消的文字对话，以及可显式开启的当前会话上下文。

工程采用可注入适配器、纯状态逻辑和分层测试。当前为开发预览，主分支迁移基线为 M3-5；Windows 测试与源码包验收的已知收尾项、M3-6 动作联动预览继续在开发分支处理。

## 开始使用

应用代码保持在 `pet-next/`，以兼容现有开发工作和打包脚本。

```sh
git clone https://github.com/PoetryJ/pet-next.git
cd pet-next/pet-next
pnpm install --frozen-lockfile
pnpm start
```

配置远程模型后，可以显式选择连续或单轮对话：

```sh
pnpm chat:trial --context=on
pnpm chat:trial --context=off
```

首次配置、SSH 隧道与启动要求见 [Windows 试用说明](pet-next/docs/WINDOWS-TRIAL.md)。真实模型需要用户自己的服务与配置；项目不包含凭据，也不会自动启动共享模型。

## 开发与验证

在应用目录运行 `pnpm verify`；Linux 无头验收需要 Xvfb。平台结果以对应原始记录为准，Linux 结果不代表 Windows 已通过。

- [应用说明](pet-next/README.md)
- [M3-5 交付报告](pet-next/docs/M3-5-FINAL.md)
- [迁移与提交身份说明](docs/migration/README.md)
- [原始研发仓库及 PR 档案](https://github.com/PoetryJ/dsh-pet)

## 来源与许可证

项目源于对 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的研究和独立重构。原项目作者记录、原 MIT [LICENSE](LICENSE) 和历史提交作者信息保留。旧仓库与 PR 未删除；本仓库为独立仓库，不属于原 fork 网络。

素材来源与相关说明继续保留在各素材/文档目录中。
