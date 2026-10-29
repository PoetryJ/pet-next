/**
 * 读取某个 PID 的直接子进程，并结束一个正 PID。
 * Linux 用 /proc children；Windows 用 Win32_Process 再 taskkill；darwin 才用 ps 取 pid/ppid。
 * 选择目标只看父子关系，不按映像名搜索。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import {
  assertSignalablePid,
  directChildrenFromRows,
  parseChildrenFile,
  parsePidPpidLines,
  readProcStatus,
  windowsTerminatePlan,
} from './process-tree.ts';

/** 固定查询，不拼接 PID，也不按映像名过滤。 */
const WINDOWS_PROCESS_QUERY =
  "Get-CimInstance -ClassName Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }";

const CHILDREN_PROBE_PID = process.pid;

/**
 * 进程是否仍存在。信号 0 只探测，不是进程组信号。
 * EPERM 表示进程在，但当前用户不能结束它。
 */
export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

/**
 * 结束一个正 PID。根进程在 Windows 上加 /T，仍然只展开这个 PID。
 * 进程已经消失时吞掉错误。
 */
export function signalPid(pid: number, includeTree: boolean, platform: NodeJS.Platform = process.platform): void {
  assertSignalablePid(pid, process.pid);
  if (!pidIsAlive(pid)) return;
  if (platform === 'win32') {
    const plan = windowsTerminatePlan(pid, includeTree, process.pid);
    try {
      execFileSync(plan.command, [...plan.args], { stdio: 'ignore', windowsHide: true });
    } catch {
      // taskkill 在进程刚退出时返回非零。
    }
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 已经退出。
  }
}

/** 一次采样用的「直接子进程」查询。Windows / darwin 的快照在这次调用里取完。 */
export function snapshotChildren(platform: NodeJS.Platform = process.platform): (pid: number) => readonly number[] {
  if (platform === 'linux') return linuxSnapshot();
  if (platform === 'win32') return windowsSnapshot();
  if (platform === 'darwin') return darwinSnapshot();
  throw new Error(`no process tree adapter for ${platform}`);
}

function linuxSnapshot(): (pid: number) => readonly number[] {
  if (linuxChildrenFileMissing()) {
    const lookup = directChildrenFromRows(listLinuxByPpid());
    return lookup;
  }
  return directChildrenFromProc;
}

function linuxChildrenFileMissing(): boolean {
  const probe = `/proc/${CHILDREN_PROBE_PID}/task/${CHILDREN_PROBE_PID}/children`;
  try {
    readFileSync(probe, 'utf8');
    return false;
  } catch (error) {
    return errorCode(error) === 'ENOENT' && existsSync(`/proc/${CHILDREN_PROBE_PID}`);
  }
}

function directChildrenFromProc(pid: number): readonly number[] {
  if (!Number.isInteger(pid) || pid <= 1) return [];
  let threads: string[];
  try {
    threads = readdirSync(`/proc/${pid}/task`);
  } catch {
    return [];
  }
  const ids = new Set<number>();
  for (const thread of threads) {
    try {
      const text = readFileSync(`/proc/${pid}/task/${thread}/children`, 'utf8');
      for (const child of parseChildrenFile(text)) ids.add(child);
    } catch {
      // 线程在枚举期间退出。
    }
  }
  return [...ids];
}

function listLinuxByPpid(): Array<{ pid: number; ppid: number }> {
  const rows: Array<{ pid: number; ppid: number }> = [];
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch (error) {
    throw new Error('cannot read /proc', { cause: error });
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const row = readProcStatus(readFileSync(`/proc/${name}/status`, 'utf8'));
      if (row) rows.push(row);
    } catch {
      // 进程在枚举期间退出。
    }
  }
  return rows;
}

function windowsSnapshot(): (pid: number) => readonly number[] {
  const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_QUERY], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return directChildrenFromRows(parsePidPpidLines(text));
}

function darwinSnapshot(): (pid: number) => readonly number[] {
  const text = execFileSync('ps', ['-ax', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  return directChildrenFromRows(parsePidPpidLines(text));
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}
