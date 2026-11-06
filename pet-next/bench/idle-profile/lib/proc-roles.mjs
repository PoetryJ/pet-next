/**
 * M3-8 C：/proc 读数 + 进程角色归类（与 bench/feedback/resource.mjs 同源口径）。
 *
 * 口径声明：RSS 是**进程 RSS 求和**（共享库/字体会被多个进程各自计入，
 * 不等于整机增量，也不能直接说成"桌宠自身开销"）。CPU 是 utime+stime 的
 * jiffies 差（HZ=100），按角色求和后除以采样窗墙钟得到百分比。
 * @module pet-next/bench/idle-profile/lib/proc-roles
 */
import { readdirSync, readFileSync } from 'node:fs';

export const HZ = 100;

export const ROLES = ['main', 'renderer', 'gpu', 'utility', 'zygote', 'crashpad', 'cli', 'fake-ssh', 'fake-model', 'other'];

export function roleOf(argv, extraRole) {
  if (extraRole) return extraRole;
  const text = argv.join(' ');
  if (text.includes('--type=renderer')) return 'renderer';
  if (text.includes('--type=gpu-process')) return 'gpu';
  if (text.includes('--type=utility')) return 'utility';
  if (text.includes('--type=zygote')) return 'zygote';
  if (text.includes('--type=crashpad-handler')) return 'crashpad';
  if (text.includes('dist/electron/main.js')) return 'main';
  if (text.includes('chat-trial.mjs') || text.includes('chat-remote.mjs')) return 'cli';
  if (text.includes('fake-ssh.mjs')) return 'fake-ssh';
  if (text.includes('fake-model-service.mjs')) return 'fake-model';
  if (text.includes('pnpm')) return 'cli';
  return 'other';
}

function readStat(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = text.lastIndexOf(')');
    const rest = text.slice(close + 2).split(' ');
    return { ppid: Number(rest[1]), utime: Number(rest[11]), stime: Number(rest[12]) };
  } catch {
    return null;
  }
}

function readRss(pid) {
  try {
    const match = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function readArgv(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .split('\0')
      .filter((item) => item !== '');
  } catch {
    return [];
  }
}

function treePids(rootPid, parents) {
  const pids = [];
  for (const pid of parents.keys()) {
    let cursor = pid;
    for (let guard = 0; guard < 16; guard += 1) {
      const up = parents.get(cursor);
      if (up === undefined) break;
      if (up === rootPid) {
        pids.push(pid);
        break;
      }
      cursor = up;
    }
  }
  return pids;
}

/**
 * 采一次样：每角色累计 CPU ticks、RSS 求和、pid 数。
 * @param rootPid CLI 入口 pid
 * @param extra {{ pid: number, role: string }[]} 树外需分账的进程（fake 模型/SSH）
 */
export function sampleRoles(rootPid, extra = []) {
  const parents = new Map();
  const stats = new Map();
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const stat = readStat(pid);
    if (!stat) continue;
    parents.set(pid, stat.ppid);
    stats.set(pid, stat);
  }
  const extraRole = new Map(extra.map((item) => [item.pid, item.role]));
  const roles = {};
  for (const role of ROLES) roles[role] = { cpuTicks: 0, rssBytes: 0, pids: [] };
  const visit = (pid, role) => {
    const stat = stats.get(pid);
    if (!stat) return;
    roles[role].cpuTicks += stat.utime + stat.stime;
    roles[role].rssBytes += readRss(pid);
    roles[role].pids.push(pid);
  };
  // 根进程本身（node chat-trial.mjs）计入 cli。
  visit(rootPid, 'cli');
  for (const pid of treePids(rootPid, parents)) visit(pid, roleOf(readArgv(pid), extraRole.get(pid)));
  for (const item of extra) {
    if (item.pid === rootPid) continue;
    visit(item.pid, item.role);
  }
  return { roles, at: Date.now() };
}

export function commandsOf(pid) {
  return readArgv(pid);
}
