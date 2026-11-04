# 独立仓库迁移记录

迁移日期：2026-11-04（Asia/Shanghai）。所有权：PoetryJ。

## 来源与范围

- 原研发仓库：[PoetryJ/dsh-pet](https://github.com/PoetryJ/dsh-pet)，现有 PR、issues、分支和远端历史保持不变。
- 原项目：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。原 MIT LICENSE 的 `Copyright (c) 2026 PC2005-cloud` 原样保留。
- 主分支迁移来源：`edad129d74c027ebd8d33c2fa6248b4d8c254dec`（M3-5）。未将未提交工作或未验收的 M3-6 作为主分支交付。
- `pet-next/` 文件树与该基线完全一致。当前根目录不再展示旧工程；旧工程及其作者仍可从 Git 历史和旧仓库查看。

## 历史处理

历史曾误纳入两个交付文件：`pet-next-m3-full-16a84e4.bundle`（146,773,193 字节）与 `pet-next-m3-chat-fc75777-16a84e4.bundle`。为了迁入独立 GitHub 仓库，只在隔离迁移副本中移除这两个路径的历史，不改动原仓库。

使用 git-filter-repo 2.47.0，保留空提交、退化合并及提交信息中的原 SHA；未改作者、提交者或日期。受影响的提交 SHA 因树/父提交变化而改变，见 [完整对应表](commit-map.tsv)。517 个历史提交（主分支基线 513 个、独立 M3-6 快照另外 4 个）的作者/提交者/日期已逐一核验，应用树和许可证 blob 也已核对，见 [验证记录](verification.json)。完整原始 bundle 另行离线保全。

历史上的 `Cursor Agent` 提交不自动改署为 PoetryJ；此次仅修正未来提交身份。原作者的贡献不归到新维护者名下。

## 后续提交身份

本项目 Git 配置：

```sh
git config --local user.name PoetryJ
git config --local user.email 110576037+PoetryJ@users.noreply.github.com
git config --local user.useConfigOnly true
```

新 clone 后也应执行以上配置，并用 `git var GIT_AUTHOR_IDENT` 核对。不要用 agent 通用身份或显式 `--author` 覆盖项目身份。旧提交作者不会因修改配置而改变。

## 正在进行的 M3-6

服务器原工作树及其未提交文件保留原位，不能 reset/clean 或在其上强制切换迁移历史。已提交的后续改动可在新仓库的独立开发分支导入；导入时保留来源提交与作者，完成后再按正常评审流程进入 main。不要将旧历史分支直接强推到新 main。

