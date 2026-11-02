#!/bin/bash
# M3-2 测试用 SSH 替身可执行包装（Linux/macOS）：把参数交给 fake-ssh.mjs。
# 通过 PET_NEXT_SSH_BIN=<此文件绝对路径> 注入；Windows 复跑用真实 OpenSSH，不需要本文件。
exec node "$(cd "$(dirname "$0")" && pwd)/fake-ssh.mjs" "$@"
