/**
 * 从 /proc stat 算出进程树在一个墙钟窗口里的 CPU。
 * 百分比是单核占用：100 表示吃满一个核。
 */

export interface ProcCpu {
  utime: number;
  stime: number;
}

/** `comm` 可以含空格和括号，所以从最后一个 `)` 之后切开。 */
export function parseProcStat(text: string): ProcCpu | null {
  const end = text.lastIndexOf(')');
  if (end < 0) return null;
  const rest = text.slice(end + 1).trim().split(/\s+/);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { utime, stime };
}

export function cpuPercent(input: {
  startTicks: number;
  endTicks: number;
  wallMs: number;
  clkTck: number;
}): number | null {
  if (!(input.wallMs > 0) || !(input.clkTck > 0)) return null;
  const delta = input.endTicks - input.startTicks;
  if (!Number.isFinite(delta) || delta < 0) return null;
  return (delta / input.clkTck) / (input.wallMs / 1000) * 100;
}
