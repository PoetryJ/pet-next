<#
  R6-live Windows 一键启动（PowerShell 5.1+ / Windows Terminal 均可）。

  用法：
    .\W1-RUN.ps1 -ModelBaseUrl http://127.0.0.1:18882/v1 -ModelName Qwen3-8B [-Workspace <绝对路径>] [-Timezone Asia/Shanghai]

  行为：
    - 检查 node 版本；
    - 设置 PET_MODEL_*（不注入任何 stub）；
    - 启动真实宿主（--assessor capability-conditions）并打开带 token 的面板。

  注意：中文/空格路径都支持；工作区会建在 -Workspace 指定位置（默认 .\out\demo-ws）。
#>
param(
  [Parameter(Mandatory = $true)][string]$ModelBaseUrl,
  [Parameter(Mandatory = $true)][string]$ModelName,
  [string]$Workspace = "",
  [string]$Timezone = "Asia/Shanghai",
  [int]$TimeoutMs = 240000
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here "..")

if (-not $Workspace) { $Workspace = Join-Path $root "out\demo-ws" }
New-Item -ItemType Directory -Force -Path $Workspace | Out-Null

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "未找到 node。请先安装 Node 24（或把 node 加入 PATH）。" }
$version = (& node --version).Trim()
Write-Host "node $version"

$env:PET_MODEL_BASE_URL = $ModelBaseUrl
$env:PET_MODEL_NAME = $ModelName
$env:PET_MODEL_DISABLE_THINKING = "1"
$env:PET_MODEL_TEMPERATURE = "0"
$env:PET_MODEL_TIMEOUT_MS = "$TimeoutMs"
$env:PET_MODEL_MAX_TOKENS = "4096"
$env:PET_FOLLOWUP_RECHECK_MS = "20000"

Write-Host "workspace: $Workspace"
Push-Location $root
try {
  & node --experimental-transform-types --no-warnings (Join-Path $root "demo\condition-launcher.mjs") --workspace $Workspace --timezone $Timezone
} finally {
  Pop-Location
}
