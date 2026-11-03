#!/usr/bin/env bash
# M3-2 Linux 真实隧道验收脚本（薄封装；实际断言在 scripts/verify-remote-entry.mjs，
# 与 Windows 共用同一份实现，避免两套语义漂移）。
#
# 默认零推理：隧道 → /models → 面板就绪 → Browser.close 收尾 → PID/端口/无关进程断言。
#   --fake                 用 fake SSH + fake 模型替身（零推理）
#   --interact             发送/取消/重发（只能与 --fake 组合）
#   --allow-real-inference 显式真实单次（默认关闭，不可循环）
#   --expect=auth-failed   指定负路径（auth-failed/probe-failed/not-ready/port-conflict/cancelled）
#   --out=<目录>           证据目录（默认 tests/chat-evidence/remote/auto-<stamp>）
#
# 用法（在 pet-next 目录）：
#   PET_NEXT_SSH_HOST=... PET_NEXT_SSH_PORT=... PET_NEXT_SSH_USER=... \
#   bash scripts/verify-linux-chat-remote.sh                     # 真实成功路径（零推理）
#   bash scripts/verify-linux-chat-remote.sh --fake --interact   # 替身交互回归
#   bash scripts/verify-linux-chat-remote.sh --expect=auth-failed --fake
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

command -v node >/dev/null 2>&1 || { echo "缺少 node（需要 22.12+）" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "缺少 pnpm（需要 pnpm install）" >&2; exit 1; }

exec node --experimental-strip-types scripts/verify-remote-entry.mjs "$@"
