# R8 环境记录

## 复现用版本

- 实验引擎使用 Node.js 24。服务器记录为 24.14.0，本次离线复核使用 Windows 24.22.1。
- 应用的 `package.json` 固定 pnpm 10.33.4。实验单独用 `npm ci` 安装 `pet-next/experiments/task-followup/tooling` 与 `producer/test-report/tooling`，依赖取各自的 lockfile。
- R8 现场使用 Linux、真实时钟和 `Asia/Shanghai` 时区，24 次最终运行使用同一 GPU0 Qwen3-8B 实例。服务器为 NVIDIA A10，驱动 550.90.07。GPU 分配由恢复当日资源决定。
- 保留的服务是 `disconnect-cancellation-v1`，只在回环地址监听。实测环境由 Python 3.12.2、PyTorch 2.5.1+cu121、Transformers 4.51.3、Accelerate 1.6.0、tokenizers 0.21.1、safetensors 0.5.3、huggingface-hub 0.30.2 和 NumPy 2.4.4 组成。见 [requirements-cu121.txt](requirements-cu121.txt)。
- 模型服务按 bf16、SDPA、16,384 token 上下文运行，关闭 thinking。历史 `config.json` SHA-256 为 `f7c4eadfbbf522470667b797a3c89be25248322d2d599797248dc304fff447c30`。它提供配置身份，恢复时另记录模型权重的实际版本和指纹。

## 在需要真跑时启动本地模型

离线复核只需 Node。要启动归档的 Python 服务，请在兼容 CUDA 的机器上先准备本地 Qwen3-8B 权重。以下命令从本目录运行，示例监听 18882，输出选独立新目录。PyTorch 的 cu121 wheel 由其 CUDA 索引提供。已有且获授权使用的兼容服务也可以直接接入。

```sh
python -m venv /path/to/r8-model-venv
. /path/to/r8-model-venv/bin/activate
python -m pip install -r requirements-cu121.txt
python serve-cancel-v1.py \
  --model-path /path/to/local/Qwen3-8B --model-id Qwen3-8B \
  --output /path/to/new/service-records --port 18882 --device cuda:0
```

启动后检查 `/health`、`/v1/models` 并记录 `environment.json`。运行器通过 `PET_MODEL_UPSTREAM_A` 和 `PET_MODEL_UPSTREAM_B` 指向明确选用的实例，同一实例可供两队列使用。重启或调整并发会影响排队延迟，比较时应记录分配。

服务端源码已与服务器副本逐字节核对，SHA-256 为 `4c00ddcfb86772c7d1fe42e3f3ec842290d4b5557461651eb6f7a2ba05488ceb6`。服务器原目录和完整证据位置见 [恢复手册](RESUME.md)。当前 GitHub 检出可完成历史证据回放。GPU 真跑需要另行启动并记录模型服务。
