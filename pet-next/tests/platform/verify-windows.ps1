# 在 Windows 上实测点击、拖动、透明背景、退出、进程清理和系统缩放。
# 退出码 0 只表示已执行的行没有失败。矩阵里的 not-run 不是通过。
# 结果写到 tests/platform/evidence/win32-matrix.json，不覆盖 Linux 已提交的 matrix.json。
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') {
  Write-Error "verify-windows.ps1 只能在 Windows 上跑。当前不是 Windows，这不是通过。"
  exit 2
}

$petRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $petRoot
Remove-Item Env:PET_NEXT_OS_SCALE -ErrorAction SilentlyContinue
Remove-Item Env:PET_NEXT_OS_SCALE_SOURCE -ErrorAction SilentlyContinue

try {
  if (-not ([System.Management.Automation.PSTypeName]'PetNextDpi').Type) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PetNextDpi {
  [DllImport("user32.dll")]
  public static extern uint GetDpiForSystem();
}
"@
  }
  $raw = [PetNextDpi]::GetDpiForSystem()
  if ($raw -gt 0) {
    $scale = [double]$raw / 96.0
    $env:PET_NEXT_OS_SCALE = $scale.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    $env:PET_NEXT_OS_SCALE_SOURCE = "GetDpiForSystem:$raw"
  }
} catch {
  Write-Warning "没有读到系统 DPI，system-* 会记 not-run。"
}

$env:PET_NEXT_PLATFORM_MATRIX = 'tests/platform/evidence/win32-matrix.json'
node --experimental-strip-types (Join-Path $PSScriptRoot 'run-platform.ts')
exit $LASTEXITCODE
