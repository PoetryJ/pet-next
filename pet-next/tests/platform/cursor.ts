/**
 * 系统光标。Linux 用 xdotool，Windows 用 user32。
 * CDP 视口坐标会随窗口移动叠到 screenX 上，不能拿来当光标位移。
 * @module pet-next/tests/platform/cursor
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const windowsScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cursor.ps1');

export function moveCursor(x: number, y: number): void {
  const point = { x: Math.round(x), y: Math.round(y) };
  if (process.platform === 'linux') {
    execFileSync('xdotool', ['mousemove', '--sync', String(point.x), String(point.y)], { stdio: 'ignore' });
    return;
  }
  if (process.platform === 'win32') {
    windowsCursor('move', point.x, point.y);
    return;
  }
  throw new Error(`没有系统光标驱动：${process.platform}`);
}

export function cursorButton(action: 'down' | 'up' | 'click'): void {
  if (process.platform === 'linux') {
    if (action === 'click') execFileSync('xdotool', ['click', '1'], { stdio: 'ignore' });
    else execFileSync('xdotool', [action === 'down' ? 'mousedown' : 'mouseup', '1'], { stdio: 'ignore' });
    return;
  }
  if (process.platform === 'win32') {
    windowsCursor(action, 0, 0);
    return;
  }
  throw new Error(`没有系统光标驱动：${process.platform}`);
}

function windowsCursor(action: 'move' | 'down' | 'up' | 'click', x: number, y: number): void {
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-File', windowsScript, '-Action', action, '-X', String(x), '-Y', String(y)],
    { stdio: 'ignore' },
  );
}
