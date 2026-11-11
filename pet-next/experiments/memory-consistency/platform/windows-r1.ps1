# R1 Windows 待复验脚本（本机无 Windows，未执行；不得据此标通过）
# 用法：在 pet-next 仓库根目录、Node v24.x 已安装的 PowerShell 中运行。
$ErrorActionPreference = "Stop"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $env:TEMP "petmem-r1-windows-$stamp"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$commit = (git rev-parse HEAD).Trim()

Write-Host "[1/4] 全套测试 + 门禁（源码身份显式传入）"
node --experimental-strip-types experiments/memory-consistency/run.mjs --all --out="$out/all" --source-commit=$commit
$allExit = $LASTEXITCODE

Write-Host "[2/4] 仅门禁，验证信封与结果文件"
node --experimental-strip-types experiments/memory-consistency/run.mjs --gate=G1 --out="$out/gate-only" --source-commit=$commit
$gateExit = $LASTEXITCODE
Get-ChildItem -Path "$out/gate-only" -Filter "g1.json" | ForEach-Object { Get-Content $_.FullName -TotalCount 20 }

Write-Host "[3/4] 含空格与中文的路径"
$spaced = Join-Path $env:TEMP "记忆 实验\r1"
New-Item -ItemType Directory -Force -Path $spaced | Out-Null
Copy-Item -Recurse -Force "experiments/memory-consistency" $spaced
Push-Location $spaced
node --experimental-strip-types .\run.mjs --gate=G1 --out="$spaced\out" --source-commit=$commit
$spacedExit = $LASTEXITCODE
Pop-Location

Write-Host "[4/4] 类型检查与 lint（实验范围）"
node node_modules/typescript/bin/tsc -p experiments/memory-consistency/tsconfig.json --noEmit
$tscExit = $LASTEXITCODE
node node_modules/eslint/bin/eslint.js experiments/memory-consistency
$lintExit = $LASTEXITCODE

Write-Host ""
Write-Host "全部退出码：all=$allExit gate=$gateExit spaced=$spacedExit tsc=$tscExit lint=$lintExit"
Write-Host "输出目录：$out"
Write-Host "注意：checkpoint fsync 的 EPERM 修复必须在 storage/recovery 测试里实跑通过，才算 Windows 门通过。"
