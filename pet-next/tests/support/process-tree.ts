/**
 * 从已记录的根 PID 算出要结束的进程，不看进程名。
 * 负 PID 在 POSIX 上表示进程组，这里一律拒绝。
 */

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
}

export interface TerminatePlan {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * 沿直接子进程关系向下收集后代，不含根自己。
 * 没有父链通向根的 PID 不会入选，环会被截断。
 */
export function descendantPids(rootPid: number, directChildren: (pid: number) => readonly number[]): number[] {
  const found: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const child of directChildren(current)) {
      if (!Number.isInteger(child) || child <= 0 || seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** 后发现的后代在前，根进程在最后。 */
export function killOrder(rootPid: number, tracked: readonly number[]): number[] {
  const body: number[] = [];
  const seen = new Set<number>();
  for (let index = tracked.length - 1; index >= 0; index -= 1) {
    const pid = tracked[index];
    if (pid === undefined || pid === rootPid || seen.has(pid)) continue;
    seen.add(pid);
    body.push(pid);
  }
  body.push(rootPid);
  return body;
}

/** 只允许信号一个普通正 PID。拒绝 0、1、自己和负值。 */
export function assertSignalablePid(pid: number, selfPid: number): void {
  if (!Number.isInteger(pid) || pid <= 1 || pid === selfPid) {
    throw new Error(`refuse to signal pid ${pid}`);
  }
}

/** Windows 结束指定 PID。includeTree 时 /T 只展开这个 PID 的子树。 */
export function windowsTerminatePlan(pid: number, includeTree: boolean, selfPid: number): TerminatePlan {
  assertSignalablePid(pid, selfPid);
  const args = includeTree ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/F'];
  return { command: 'taskkill', args };
}

/** 解析 /proc 的 children 文件。空文件表示当前没有子进程。 */
export function parseChildrenFile(text: string): number[] {
  const ids: number[] = [];
  for (const part of text.trim().split(/\s+/)) {
    if (!part) continue;
    const pid = Number(part);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    ids.push(pid);
  }
  return ids;
}

/** 解析 `pid ppid` 行。无法解析的行丢掉。 */
export function parsePidPpidLines(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    const pidText = match?.[1];
    const ppidText = match?.[2];
    if (!pidText || !ppidText) continue;
    rows.push({ pid: Number(pidText), ppid: Number(ppidText) });
  }
  return rows;
}

/**
 * 读 /proc/pid/stat 的 starttime（开机后的时钟滴答）。
 * comm 可以含空格和括号，所以从最后一个右括号之后数。
 * @returns 解析不到时返回 undefined。
 */
export function readStartTicks(stat: string): number | undefined {
  const close = stat.lastIndexOf(')');
  if (close === -1) return undefined;
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const start = fields[19];
  if (!start || !/^\d+$/.test(start)) return undefined;
  return Number(start);
}

/** 从 Pid/PPid 字段读一行进程。不读进程名。 */
export function readProcStatus(text: string): ProcessRow | undefined {
  const pidMatch = /^Pid:\s+(\d+)/m.exec(text);
  const ppidMatch = /^PPid:\s+(\d+)/m.exec(text);
  const pidText = pidMatch?.[1];
  const ppidText = ppidMatch?.[1];
  if (!pidText || !ppidText) return undefined;
  return { pid: Number(pidText), ppid: Number(ppidText) };
}

/** 把父子行折成「给定 PID，返回其直接子进程」。 */
export function directChildrenFromRows(rows: readonly ProcessRow[]): (pid: number) => readonly number[] {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    if (!Number.isInteger(row.pid) || row.pid <= 0) continue;
    if (!Number.isInteger(row.ppid) || row.ppid < 0) continue;
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  return (pid) => children.get(pid) ?? [];
}
