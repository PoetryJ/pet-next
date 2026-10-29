/**
 * 按窗口 PID 读 X11 视觉深度。深度 32 才是 ARGB。
 * 找不到窗口时返回 null，调用方不能把 null 当成透明。
 * @module pet-next/tests/platform/x11-window
 */
import { execFileSync } from 'node:child_process';

/** 在已跟踪的 PID 里找标题为 pet-next 的窗口深度。 */
export function argbWindowDepth(pids: readonly number[]): number | null {
  const ids = windowIds();
  for (const id of ids) {
    const owner = windowPid(id);
    if (owner === null || !pids.includes(owner)) continue;
    const depth = depthOf(id);
    if (depth !== null) return depth;
  }
  return null;
}

function windowIds(): string[] {
  try {
    return execFileSync('xdotool', ['search', '--name', 'pet-next'], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function windowPid(id: string): number | null {
  try {
    const text = execFileSync('xdotool', ['getwindowpid', id], { encoding: 'utf8' }).trim();
    const pid = Number(text);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function depthOf(id: string): number | null {
  try {
    const info = execFileSync('xwininfo', ['-id', id], { encoding: 'utf8' });
    const match = /Depth:\s+(\d+)/.exec(info);
    return match?.[1] === undefined ? null : Number(match[1]);
  } catch {
    return null;
  }
}
