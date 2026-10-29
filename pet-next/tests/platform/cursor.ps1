param(
  [Parameter(Mandatory = $true)][ValidateSet('move', 'down', 'up', 'click')][string]$Action,
  [int]$X = 0,
  [int]$Y = 0
)
$ErrorActionPreference = 'Stop'
if (-not ([System.Management.Automation.PSTypeName]'PetNextCursor').Type) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PetNextCursor {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.UIntPtr dwExtraInfo);
}
"@
}
switch ($Action) {
  'move' { [void][PetNextCursor]::SetCursorPos($X, $Y) }
  'down' { [PetNextCursor]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero) }
  'up' { [PetNextCursor]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
  'click' {
    [PetNextCursor]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [PetNextCursor]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  }
}
