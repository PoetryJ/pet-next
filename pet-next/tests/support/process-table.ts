/**
 * 读取某个 PID 的直接子进程，并结束一个正 PID。
 * Linux 用 /proc children；Windows 用 Win32_Process 再 taskkill；darwin 才用 ps 取 pid/ppid。
 * 选择目标只看父子关系，不按映像名搜索。
 *
 * 快照与结束都是异步子进程查询，带总超时：
 * 以前 Windows 同步跑 PowerShell 查进程表（execFileSync），查询期间事件循环整体挂起，
 * 子进程 stdout 的 READY/close 事件和 20ms 轮询都被拖住，
 * "正常退出后清理"在 Windows 上反复等 PowerShell 启动（每次 0.5~2s），把 20s 测试超时耗光。
 * 现在 execFile 不阻塞事件循环；同一平台同一时刻只发一条查询（单飞），并发请求共享同一个 Promise；
 * 查询超时或失败时调用方保留已看到的 PID，结束阶段仍会尝试信号它们。
 *
 * not-run（Windows 本机未实测，需在 Windows 复验；不要在 Linux 上宣称通过）：
 *   pnpm test:cleanup
 *   powershell -File tests/platform/verify-windows.ps1
 *   node scripts/record-platform-run.mjs -- node --experimental-strip-types --test --test-reporter spec tests/cleanup.test.ts tests/support/process-tree.test.ts tests/support/process-table.test.ts tests/support/run-record.test.ts tests/support/record-cli.test.ts
 * 复验观察点：tests/platform/evidence/win32-matrix.json 的 process-cleanup 行为 passed；
 * cleanup 三条用例都在各自 20s 超时内结束；decoy 存活断言不放松。
 */
import { execFile } from 'node:child_process';
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

/** 单次查询的总超时。到点杀掉查询进程，让轮询继续，而不是挂死等待。 */
const SNAPSHOT_TIMEOUT_MS = 5000;
const TERMINATE_TIMEOUT_MS = 5000;

const CHILDREN_PROBE_PID = process.pid;

/** 「给定 PID，返回其直接子进程」的查询结果。 */
export type ChildLookup = (pid: number) => readonly number[];

/** 单飞表：同一平台同一时刻只有一条 in-flight 查询，并发请求共享它。 */
const inflightSnapshots = new Map<NodeJS.Platform, Promise<ChildLookup>>();

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
 * 进程已经消失时吞掉错误。taskkill 走异步子进程，不再阻塞事件循环。
 */
export async function signalPid(
  pid: number,
  includeTree: boolean,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  assertSignalablePid(pid, process.pid);
  if (!pidIsAlive(pid)) return;
  if (platform === 'win32') {
    const plan = windowsTerminatePlan(pid, includeTree, process.pid);
    await runQuietly(plan.command, plan.args, TERMINATE_TIMEOUT_MS);
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 已经退出。
  }
}

/**
 * 一次采样用的「直接子进程」查询。Windows / darwin 的快照是一次异步子进程查询。
 * 并发调用共享同一条 in-flight 查询，避免每个轮询点各自spawn PowerShell/ps。
 */
export function snapshotChildren(platform: NodeJS.Platform = process.platform): Promise<ChildLookup> {
  const inflight = inflightSnapshots.get(platform);
  if (inflight) return inflight;
  const query = takeSnapshot(platform);
  inflightSnapshots.set(platform, query);
  const settle = () => {
    if (inflightSnapshots.get(platform) === query) inflightSnapshots.delete(platform);
  };
  query.then(settle, settle);
  return query;
}

async function takeSnapshot(platform: NodeJS.Platform): Promise<ChildLookup> {
  if (platform === 'linux') return linuxSnapshot();
  if (platform === 'win32') return windowsSnapshot();
  if (platform === 'darwin') return darwinSnapshot();
  throw new Error(`no process tree adapter for ${platform}`);
}

let linuxChildrenFileUsable: boolean | undefined;

function linuxSnapshot(): ChildLookup {
  // children 文件是否存在由内核配置决定，一次运行里不会变，缓存探测结果。
  if (linuxChildrenFileUsable === undefined) linuxChildrenFileUsable = !linuxChildrenFileMissing();
  if (!linuxChildrenFileUsable) return directChildrenFromRows(listLinuxByPpid());
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

async function windowsSnapshot(): Promise<ChildLookup> {
  // 查询本身与旧版相同（Get-CimInstance 输出 "pid ppid" 行），只是改成异步并带超时。
  // 没换成 tasklist：tasklist 不给 PPID 列；wmic 在新 Windows 11 已移除。
  const text = await runQuery('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_QUERY], SNAPSHOT_TIMEOUT_MS);
  return directChildrenFromRows(parsePidPpidLines(text));
}

async function darwinSnapshot(): Promise<ChildLookup> {
  const text = await runQuery('ps', ['-ax', '-o', 'pid=,ppid='], SNAPSHOT_TIMEOUT_MS);
  return directChildrenFromRows(parsePidPpidLines(text));
}

function runQuery(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function runQuietly(command: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    // taskkill 在进程刚退出时返回非零，照旧吞掉。
    execFile(command, [...args], { timeout: timeoutMs, windowsHide: true }, () => resolve());
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}
