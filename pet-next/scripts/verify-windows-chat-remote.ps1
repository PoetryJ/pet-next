# M3-2 Windows 本机验收脚本（薄封装；实际断言在 scripts/verify-remote-entry.mjs）。
# 服务端无 Windows：本脚本由 Codex 在负责人电脑执行；不安装/修改系统 SSH，不写真实地址。
#
# 默认零推理：只验证 隧道 → /models → 面板就绪 → 关窗收尾 → 本次 PID/端口清理 → 无关进程存活。
# 交互（发送/取消/重发）必须配合 -Fake（fake SSH + fake 模型，零推理）。
# 真实推理只在显式 -AllowRealInference 时发生，恰好一次，不可循环；不加参数永不触发。
#
# 用法（在仓库 pet-next 目录）：
#   powershell -ExecutionPolicy Bypass -File scripts\verify-windows-chat-remote.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\verify-windows-chat-remote.ps1 -Fake -Interact
#   powershell -ExecutionPolicy Bypass -File scripts\verify-windows-chat-remote.ps1 -Expect auth-failed -Fake
param(
  [ValidateSet('ok', 'auth-failed', 'probe-failed', 'not-ready', 'port-conflict', 'cancelled')]
  [string]$Expect = 'ok',
  [switch]$Fake,
  [switch]$Interact,
  [switch]$AllowRealInference,
  [int]$ReadyTimeoutSec = 120,
  [int]$TotalTimeoutSec = 300,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
$petRoot = Split-Path -Parent $PSScriptRoot
Push-Location $petRoot
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '缺少 node（需要 22.12+）' }
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw '缺少 pnpm（先 pnpm install）' }

  $nodeArgs = @(
    '--experimental-strip-types', 'scripts/verify-remote-entry.mjs',
    "--expect=$Expect",
    "--ready-timeout-ms=$($ReadyTimeoutSec * 1000)",
    "--total-timeout-ms=$($TotalTimeoutSec * 1000)"
  )
  if ($Fake) { $nodeArgs += '--fake' }
  if ($Interact) { $nodeArgs += '--interact' }
  if ($AllowRealInference) { $nodeArgs += '--allow-real-inference' }
  if ($OutDir) { $nodeArgs += "--out=$OutDir" }

  & node @nodeArgs
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
