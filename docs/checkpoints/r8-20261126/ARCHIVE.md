# 实验证据

`r8-evidence-share.tgz` 保存最后的 24 次真实模型运行及评分。每个目录包含事件时间线、SQLite、JUnit 与报告、实际分析文件、模型请求响应和客户端/代理调用账本。根目录保留代码指纹、原始报告、反例复现、原始核验和评分。

以下两份校验值区分服务器保留的原始交付和仓库中的副本。

| 文件 | SHA-256 |
| --- | --- |
| 服务器原包 `r8-evidence-20261120.tgz` | `dec3459b7458e18b3fd8581c52cf4d4a20f238bcd33a278c8c0764c441a35d89` |
| 仓库证据 `r8-evidence-share.tgz` | `318ebe2cfceea1c3c0e173e888533da998c429adef645f472e1df0fd0205f711` |

仓库副本保留原包 1,124 个文件中的 1,100 个。省略各次运行用于连接活宿主的 24 个 `ws/state/host.json` 文件。其余路径和每份内容与原包一致。运行时状态可由保留的 SQLite、事件和日志恢复分析。部署凭据和模型权重由恢复环境提供。

`r8-evidence-share.sha256` 是解压后逐文件的校验清单。先把压缩包解到新目录，再从该目录校验。

```sh
mkdir /path/to/r8-archived-evidence
tar -xzf r8-evidence-share.tgz -C /path/to/r8-archived-evidence
cd /path/to/r8-archived-evidence
sha256sum -c /absolute/path/to/r8-evidence-share.sha256
```

正式矩阵和历史调试运行的目录不同。服务器原证没有改动。只用 `final-a` 和 `final-b` 汇总正式 24 格。恢复手册提供重新评分的命令。
