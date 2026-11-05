/**
 * M3-7 D：launcher 测试的「本次归属进程」快照与存活检查（跨平台，只读）。
 *
 * 用途（C 的 tests/launcher/first-run.e2e.test.ts 在 finally 清理之前调用）：
 * REVIEW 第 22 行指出 Windows 侧只回到入口 PID，不能据此声称整棵树零残留。
 * 这里在启动前/退出前捕获 root 及其后代 PID，退出后轮询确认全部消失，
 * 从而断言「本次树零残留」，而不是只看入口 PID。
 *
 * 只读、无副作用：不杀进程、不改全局表、不按映像名搜索。
 * - linux：读 /proc/<pid>/stat 的 ppid 一列，整表折成父子关系后从 rootPid 递归向下裁；
 * - win32：一次同步进程表查询（PowerShell Get-CimInstance），同样只解析 "pid ppid"
 *   两列后从 rootPid 裁剪。
 * 进程表整体拿不到时直接报错，不静默降级成「只有根」：降级会让「零残留」结论失真。
 *
 * pids 语义：按发现顺序排列，第一个元素恒为 rootPid（含根自身）。
 * 这样调用方 `alive.length === 0` 就同时覆盖入口进程与后代。
 *
 * win32 查询是同步子进程（签名要求同步捕获）。调用点在测试断言处、不在 20ms 轮询里，
 * 单次约 0.5~2s，可接受；轮询等待用的 waitOwnedGone 走 process.kill(pid, 0)，不 spawn。
 *
 * not-run：win32 分支本机（Linux）未实测，需在 Windows 复验；不要在这里宣称通过。
 * @module pet-next/tests/launcher/owned-processes
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import {
  descendantPids,
  directChildrenFromRows,
  parsePidPpidLines,
  type ProcessRow,
} from '../support/process-tree.ts';

/** 一次归属捕获的结果。pids 含 rootPid 自身，且以 rootPid 开头。 */
export interface OwnedProcessSnapshot {
  rootPid: number;
  pids: number[];
}

export interface CaptureOwnedProcessesOptions {
  /** 目标平台（单测注入，默认 process.platform）。只支持 linux / win32。 */
  platform?: NodeJS.Platform;
  /** 目录列举（linux 读 /proc；单测注入）。 */
  readDir?: (dir: string) => string[];
  /**
   * 文件读取（linux 读 /proc/<pid>/stat）。
   * win32 下注入时收到的路径是固定哨兵 {@link WIN32_TABLE_PATH}，返回进程表文本。
   */
  readFile?: (path: string) => string;
}

export interface WaitOwnedGoneOptions {
  /** 总等待上限，默认 5000ms。到点返回仍存活的 PID，不抛错。 */
  timeoutMs?: number;
  /** 目标平台（单测注入，默认 process.platform）。 */
  platform?: NodeJS.Platform;
}

/** win32 进程表的哨兵路径：注入 readFile 时用来区分「读进程表」和「读真实文件」。 */
export const WIN32_TABLE_PATH = 'win32:process-table';

/** 轮询间隔：足够快看到退出，又不至于把 CPU 打满。 */
const POLL_MS = 50;

/** 固定查询，不拼接 PID，也不按映像名过滤（与 tests/support/process-table.ts 同法）。 */
const WINDOWS_PROCESS_QUERY =
  "Get-CimInstance -ClassName Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }";

/** win32 进程表查询超时。查询失败由调用方降级为「没看到后代」，不挂死。 */
const WINDOWS_QUERY_TIMEOUT_MS = 5000;

/**
 * 解析 /proc/<pid>/stat 的 ppid。
 * comm 可以含空格和括号（如 `(a b)`），所以从最后一个右括号之后数：
 * 之后第一个字段是 state，第二个才是 ppid。
 * @returns 解析不到时返回 undefined。
 */
export function parseStatPpid(stat: string): number | undefined {
  const close = stat.lastIndexOf(')');
  if (close === -1) return undefined;
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const ppid = fields[1];
  if (!ppid || !/^\d+$/.test(ppid)) return undefined;
  return Number(ppid);
}

/**
 * /proc/<pid>/stat 的 state 是否为 Z（僵尸）。
 * 僵尸已经退出、只是等父进程回收；`kill(pid, 0)` 仍然成功，
 * 不算「还活着」，否则会误报残留。
 */
export function isZombieStat(stat: string): boolean {
  const close = stat.lastIndexOf(')');
  if (close === -1) return false;
  return stat.charAt(close + 2) === 'Z';
}

/**
 * linux：整表枚举 /proc/<pid>/stat 的 pid/ppid。
 * 单个 PID 读不到（进程在枚举期间退出）跳过；整张表都读不到直接报错，
 * 不静默降级成「只有根」——那会让人误以为整棵树都收干净了。
 */
function linuxRows(readDir: (dir: string) => string[], readFile: (path: string) => string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  let names: string[];
  try {
    names = readDir('/proc');
  } catch (error) {
    throw new Error('captureOwnedProcesses 无法枚举 /proc，不能声称本次树零残留', { cause: error });
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid <= 0) continue;
    let stat: string;
    try {
      stat = readFile(`/proc/${name}/stat`);
    } catch {
      continue; // 枚举期间退出。
    }
    const ppid = parseStatPpid(stat);
    if (ppid === undefined) continue;
    rows.push({ pid, ppid });
  }
  return rows;
}

/**
 * win32：一次同步查询取整张 "pid ppid" 表。
 * 只用 PowerShell（Win10/11 必带）；不用 wmic：新 Windows 11 已移除，而且列序不可靠。
 * 查询失败直接报错，不降级成空表（同 linux 理由）。
 */
function windowsRows(): ProcessRow[] {
  let text: string;
  try {
    text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_QUERY], {
      encoding: 'utf8',
      timeout: WINDOWS_QUERY_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error('captureOwnedProcesses 无法获取 Windows 进程表（PowerShell 查询失败），不能声称本次树零残留', {
      cause: error,
    });
  }
  return parsePidPpidLines(text);
}

/**
 * 捕获 root 及其全部后代的 PID 快照。
 * rootPid 非法（非正整数）时返回空 pids，不读进程表。
 */
export function captureOwnedProcesses(
  rootPid: number,
  options: CaptureOwnedProcessesOptions = {},
): OwnedProcessSnapshot {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return { rootPid, pids: [] };
  const platform = options.platform ?? process.platform;

  let rows: ProcessRow[];
  if (platform === 'linux') {
    const readDir = options.readDir ?? ((dir: string) => readdirSync(dir));
    const readFile = options.readFile ?? ((file: string) => readFileSync(file, 'utf8'));
    rows = linuxRows(readDir, readFile);
  } else if (platform === 'win32') {
    rows = options.readFile ? parsePidPpidLines(options.readFile(WIN32_TABLE_PATH)) : windowsRows();
  } else {
    throw new Error(`captureOwnedProcesses 只支持 linux/win32，收到 ${platform}`);
  }

  const pids = [rootPid, ...descendantPids(rootPid, directChildrenFromRows(rows))];
  return { rootPid, pids };
}

/**
 * 单个 PID 是否「还算活着」。
 * linux 额外把僵尸当作已退出：僵尸占了 PID 但已经退出，不该算残留。
 */
function isAlive(pid: number, platform: NodeJS.Platform): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM 表示进程还在、只是当前用户不能给它发信号。
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
  }
  if (platform !== 'linux') return true;
  try {
    return !isZombieStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    // stat 读不到（已退出）或 /proc 不可用。
    return false;
  }
}

/** 快照里要等的 PID：pids 去重后再补上 rootPid（root 一定属于本次树）。 */
function awaitedPids(snapshot: OwnedProcessSnapshot): number[] {
  const pids = new Set<number>();
  if (Number.isInteger(snapshot.rootPid) && snapshot.rootPid > 0) pids.add(snapshot.rootPid);
  for (const pid of snapshot.pids) {
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 等到快照里的进程全部消失，或超时。
 * 返回 { alive }：空数组表示整棵本次树都收干净了；超时则给出仍存活的 PID，不抛错。
 * 只读探测，不做任何结束动作。
 */
export async function waitOwnedGone(
  snapshot: OwnedProcessSnapshot,
  options: WaitOwnedGoneOptions = {},
): Promise<{ alive: number[] }> {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 5000;
  const pids = awaitedPids(snapshot);
  if (pids.length === 0) return { alive: [] };

  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const alive = pids.filter((pid) => isAlive(pid, platform));
    if (alive.length === 0) return { alive };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { alive };
    await delay(Math.min(POLL_MS, remaining));
  }
}
