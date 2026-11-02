# M3-2 Windows 本机复跑脚本：chat:remote 正式入口验收。
# 服务端无 Windows：本脚本交负责人在 Windows 电脑执行；不自动安装 SSH、不写入真实地址。
# 用法（在仓库 pet-next 目录）：powershell -ExecutionPolicy Bypass -File scripts\verify-windows-chat-remote.ps1
# 前置：已安装 OpenSSH 客户端；已配置 PET_NEXT_SSH_* 或 %USERPROFILE%\.pet-next\qwen-remote.json；
#       已执行 pnpm install 与 pnpm build。
$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$petRoot = Split-Path -Parent $PSScriptRoot
$out = Join-Path $petRoot "tests\chat-evidence\remote\windows-$stamp"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$summary = New-Object System.Collections.Generic.List[string]
function Add-Summary([string]$text) { $summary.Add($text); Write-Host $text }

Add-Summary "chat:remote Windows 复跑记录 $stamp（本文件为自动生成，随证据提交）"
Add-Summary "OS: $([System.Environment]::OSVersion.VersionString)"
try { Add-Summary "OSCaption: $((Get-CimInstance Win32_OperatingSystem).Caption)" } catch { Add-Summary "OSCaption: unknown" }
Add-Summary "PSVersion: $($PSVersionTable.PSVersion)"
Add-Summary "Node: $(node -v 2>&1)"
Add-Summary "pnpm: $(pnpm -v 2>&1)"
Add-Summary "Electron: $(pnpm exec electron --version 2>&1)"
Add-Summary "ssh: $(ssh -V 2>&1)"
Add-Summary "工作目录: $petRoot"

if (-not (Test-Path (Join-Path $petRoot 'dist\electron\main.js'))) {
  Add-Summary "失败：缺少 dist\electron\main.js，请先 pnpm build"
  $summary | Set-Content (Join-Path $out 'SUMMARY.txt') -Encoding UTF8
  exit 1
}

Add-Summary ''
Add-Summary '=== 请在弹出的 320x240 宠物窗口里依次操作（步骤会在 run.log 里对照） ==='
Add-Summary '1) 点「聊」打开面板；2) 输入中文并 Enter 发送；3) 等真实回复；4) 再发一句并在发送中点「取消」；5) 立即重发；6) 关窗'
Add-Summary ''

Start-Sleep -Seconds 2
$logPath = Join-Path $out 'run.log'
$start = Get-Date
pnpm chat:remote 2>&1 | Tee-Object -FilePath $logPath
$code = $LASTEXITCODE
Add-Summary "命令: pnpm chat:remote"
Add-Summary "退出码: $code"
Add-Summary "耗时: $(([DateTime]::Now) - $start)"
Add-Summary ('run.log 末尾: ' + (Get-Content $logPath -Tail 8 | Out-String))

# 残留检查：只报告，不主动杀无关进程
try {
  $sshProcs = @(Get-Process ssh -ErrorAction SilentlyContinue)
  Add-Summary "本次结束后 ssh 进程数: $($sshProcs.Count)"
  foreach ($p in $sshProcs) { Add-Summary "  ssh pid=$($p.Id) start=$($p.StartTime)" }
} catch { Add-Summary 'ssh 进程检查失败' }
try {
  $elecProcs = @(Get-Process electron -ErrorAction SilentlyContinue)
  Add-Summary "本次结束后 electron 进程数: $($elecProcs.Count)"
  foreach ($p in $elecProcs) { Add-Summary "  electron pid=$($p.Id) start=$($p.StartTime)" }
} catch { Add-Summary 'electron 进程检查失败' }

# 全屏截图（用户操作后由人补；这里抓一次当前桌面）
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bitmap.Save((Join-Path $out 'desktop.png'))
  $graphics.Dispose()
  $bitmap.Dispose()
  Add-Summary '截图: desktop.png（当前桌面）'
} catch { Add-Summary "截图失败: $($_.Exception.Message)" }

$summary | Set-Content (Join-Path $out 'SUMMARY.txt') -Encoding UTF8
Write-Host "证据目录: $out"
if ($code -eq 0) { exit 0 } else { exit 1 }
