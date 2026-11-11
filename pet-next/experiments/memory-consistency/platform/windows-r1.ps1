<#
R3 Windows 验收入口：**只支持 PowerShell 7（pwsh）**。PS5.1 在本机实测会把 node 的 stderr 当 NativeCommandError，已明确不验收。
文件以 UTF-8 BOM + CRLF 保存：Windows PowerShell 5 读无 BOM 的 UTF-8 会在中文处 ParserError。

用法（在任意目录）：
  pwsh -NoProfile -File <repo>\pet-next\experiments\memory-consistency\platform\windows-r1.ps1 -SourceCommit <40位sha>
  pwsh -File ... -SourceCommit <sha> [-OutDir <目录>] [-SelfTest]

约束：
- 低于 PowerShell 7 直接 exit 2，并打印正确命令（不尝试兼容 PS5.1）。
- 必须显式给 -SourceCommit；归档没有 .git，不允许借用外层仓库 HEAD。
- 每个子命令的退出码都记录；任何一步非零，脚本最终非零退出。
- -SelfTest 用 fake-node（全部 exit 7）验证「子进程失败 => 包装脚本失败」，不跑真实测试。
#>
param(
  [Parameter(Mandatory = $true)][string]$SourceCommit,
  [string]$OutDir = "",
  [switch]$SelfTest
)

$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSVersion.Major -lt 7) {
  Write-Host ("需要 PowerShell 7 (pwsh)；当前版本 {0}" -f $PSVersionTable.PSVersion)
  Write-Host "正确命令： pwsh -NoProfile -File <脚本路径> -SourceCommit <40位sha> [-OutDir <目录>]"
  Write-Host "PS5.1 不在验收范围（node stderr 会被当成 NativeCommandError）。"
  exit 2
}

# 脚本位于 <repo>/pet-next/experiments/memory-consistency/platform/
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$ExperimentRoot = Join-Path $RepoRoot "experiments\memory-consistency"

if ($OutDir -eq "") {
  $OutDir = Join-Path $env:TEMP ("petmem-r2-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$script:steps = @()

function Invoke-Step {
  param(
    [string]$Name,
    [string]$NodeExe,
    [string[]]$Arguments,
    [string]$WorkDir
  )
  $log = Join-Path $OutDir ($Name + ".log")
  Push-Location $WorkDir
  try {
    $output = & $NodeExe @Arguments 2>&1
    $code = $LASTEXITCODE
  }
  finally {
    Pop-Location
  }
  if ($null -eq $output) { $output = @() }
  $output | Out-File -FilePath $log -Encoding utf8
  $script:steps += [pscustomobject]@{ name = $Name; exit = $code; log = $log }
  Write-Host ("[{0}] exit={1}" -f $Name, $code)
  return $code
}

function Assert-GateArtifact {
  param([string]$Path, [string]$GateId)
  if (-not (Test-Path $Path)) {
    Write-Host ("missing gate artifact: {0}" -f $Path)
    return $false
  }
  $parsed = Get-Content -Path $Path -Raw -Encoding utf8 | ConvertFrom-Json
  if ($null -eq $parsed.envelope) { Write-Host ("no envelope: {0}" -f $Path); return $false }
  $ok = $true
  if ($parsed.envelope.schemaVersion -ne "memory-gate/v1") { Write-Host "schema mismatch"; $ok = $false }
  if ($parsed.envelope.gateId -ne $GateId) { Write-Host "gateId mismatch"; $ok = $false }
  if ($parsed.envelope.sourceCommit -ne $SourceCommit) { Write-Host ("sourceCommit mismatch: {0}" -f $parsed.envelope.sourceCommit); $ok = $false }
  if ($parsed.envelope.passed_gate -ne $true) { Write-Host "passed_gate is not true"; $ok = $false }
  if ($ok) { Write-Host ("[{0}] envelope ok runId={1}" -f $GateId, $parsed.envelope.runId) }
  return $ok
}

$node = (Get-Command node).Source
Write-Host ("repo={0}" -f $RepoRoot)
Write-Host ("node={0}" -f $node)
Write-Host ("out={0}" -f $OutDir)

if ($SelfTest) {
  $fake = Join-Path $OutDir "fake-node.cmd"
  $lines = @("@echo off", "exit /b 7")
  $lines | Out-File -FilePath $fake -Encoding ascii
  $code = Invoke-Step -Name "selftest-negative" -NodeExe $fake -Arguments @("--version") -WorkDir $RepoRoot
  if ($code -ne 7) {
    Write-Host ("SELFTEST FAILED: fake node should exit 7, got {0}" -f $code)
    exit 1
  }
  Write-Host "SELFTEST PASSED: child exit 7 propagated to step record"
  exit 0
}

# 1) 全套 + 门禁
$allOut = Join-Path $OutDir "all"
New-Item -ItemType Directory -Force -Path $allOut | Out-Null
$exitAll = Invoke-Step -Name "all" -NodeExe $node -Arguments @(
  "--experimental-strip-types",
  (Join-Path $ExperimentRoot "run.mjs"),
  "--all",
  ("--out=" + $allOut),
  ("--source-commit=" + $SourceCommit)
) -WorkDir $RepoRoot

$gateOk = $true
foreach ($gate in @(@("G1", "g1.json"), @("P1", "p1.json"), @("P2", "p2.json"))) {
  $path = Join-Path $allOut $gate[1]
  if (-not (Assert-GateArtifact -Path $path -GateId $gate[0])) { $gateOk = $false }
}

# 2) gate-only：必须真的产出结果文件
$gateOut = Join-Path $OutDir "gate-only"
New-Item -ItemType Directory -Force -Path $gateOut | Out-Null
$exitGate = Invoke-Step -Name "gate-only" -NodeExe $node -Arguments @(
  "--experimental-strip-types",
  (Join-Path $ExperimentRoot "run.mjs"),
  "--gate=G1",
  ("--out=" + $gateOut),
  ("--source-commit=" + $SourceCommit)
) -WorkDir $RepoRoot
if (-not (Assert-GateArtifact -Path (Join-Path $gateOut "g1.json") -GateId "G1")) { $gateOk = $false }

# 3) 中文 + 空格路径：复制 experiments/memory-consistency 到 <spaced>/experiments/... 再跑真实入口
$spacedRoot = Join-Path $OutDir "记忆 实验"
$spacedExp = Join-Path $spacedRoot "experiments\memory-consistency"
New-Item -ItemType Directory -Force -Path (Join-Path $spacedRoot "experiments") | Out-Null
Copy-Item -Path $ExperimentRoot -Destination $spacedExp -Recurse -Force
$spacedOut = Join-Path $spacedRoot "out"
New-Item -ItemType Directory -Force -Path $spacedOut | Out-Null
$exitSpaced = Invoke-Step -Name "spaced" -NodeExe $node -Arguments @(
  "--experimental-strip-types",
  (Join-Path $spacedExp "run.mjs"),
  "--gate=G1",
  ("--out=" + $spacedOut),
  ("--source-commit=" + $SourceCommit)
) -WorkDir $spacedRoot
if (-not (Assert-GateArtifact -Path (Join-Path $spacedOut "g1.json") -GateId "G1")) { $gateOk = $false }

# 4) 类型检查与 lint（实验范围）
$exitTsc = Invoke-Step -Name "tsc" -NodeExe $node -Arguments @(
  (Join-Path $RepoRoot "node_modules\typescript\bin\tsc"),
  "-p", (Join-Path $ExperimentRoot "tsconfig.json"), "--noEmit"
) -WorkDir $RepoRoot

$exitLint = Invoke-Step -Name "lint" -NodeExe $node -Arguments @(
  (Join-Path $RepoRoot "node_modules\eslint\bin\eslint.js"),
  $ExperimentRoot
) -WorkDir $RepoRoot

Write-Host ""
$table = $script:steps | Format-Table -AutoSize | Out-String
Write-Host $table
Write-Host ("gate artifacts ok: {0}" -f $gateOk)

$failed = @($script:steps | Where-Object { $_.exit -ne 0 })
if ($failed.Count -gt 0 -or -not $gateOk) {
  Write-Host ("FAILED steps: {0}" -f ($failed | ForEach-Object { $_.name }) -join ",")
  exit 1
}
Write-Host "ALL STEPS PASSED"
exit 0
