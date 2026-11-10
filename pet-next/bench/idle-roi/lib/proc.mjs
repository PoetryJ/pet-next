/**
 * M3-12 D：/proc 只读计量（归属进程树 CPU / RSS / PSS / 主机负载）。
 *
 * 口径声明（和 bench/idle-profile/lib/proc-roles.mjs 同源，但这里按**树**归账）：
 * - CPU：/proc/<pid>/stat 的 utime+stime（jiffies，HZ=100）之和对墙钟求百分比。
 *   一只臂的“归属进程树”= 本轮 electron main pid 的全部后代
 *   （renderer/gpu-process/utility/zygote/crashpad，BFS 遍历 ppid）。
 * - RSS：/proc/<pid>/status VmRSS 求和，**共享页会重复计入**，不等于整机增量。
 * - PSS：/proc/<pid>/smaps_rollup 的 Pss 求和（内核已做共享页分摊），能用就用，
 *   读不到（权限/内核）时返回 null，不拿 RSS 冒充。
 * - 主机负载必须同报：/proc/loadavg 与 /proc/stat 的 CPU busy。
 * @module pet-next/bench/idle-roi/lib/proc
 */
import { readdirSync, readFileSync } from 'node:fs';

export const HZ = 100;

/** 角色只用于分账展示，判据始终看整棵树。 */
export const ROLES = ['main', 'renderer', 'gpu', 'utility', 'zygote', 'crashpad', 'other'];

/** 本机没有 CLK_TCK 读取手段时按 Linux 常见值 100；已在 summary 里写明。 */
export function roleOf(argvText) {
  if (argvText.includes('--type=renderer')) return 'renderer';
  if (argvText.includes('--type=gpu-process')) return 'gpu';
  if (argvText.includes('--type=utility')) return 'utility';
  if (argvText.includes('--type=zygote')) return 'zygote';
  if (argvText.includes('--type=crashpad-handler')) return 'crashpad';
  if (argvText.includes('electron/main.js') || argvText.includes('dist/electron/main.js')) return 'main';
  return 'other';
}

function readStat(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = text.lastIndexOf(')');
    const rest = text.slice(close + 2).split(' ');
    return {
      ppid: Number(rest[1]),
      utime: Number(rest[11]),
      stime: Number(rest[12]),
      starttime: Number(rest[19]),
      rssPages: Number(rest[21]),
    };
  } catch {
    return null;
  }
}

function readStatusRss(pid) {
  try {
    const match = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function readPss(pid) {
  try {
    const match = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function readCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
  } catch {
    return '';
  }
}

/**
 * 采一次整棵树的读数。
 * @param {number} rootPid electron main pid
 * @returns {{at:number,total:{cpuTicks:number,rssBytes:number,pssBytes:number|null,pids:number},roles:Record<string,{cpuTicks:number,rssBytes:number,pssBytes:number|null,pids:number}>}}
 */
export function sampleTree(rootPid) {
  const parents = new Map();
  const stats = new Map();
  let entries = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    /* /proc 不可读时返回空树，由调用方记为失败 */
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const stat = readStat(pid);
    if (!stat) continue;
    parents.set(pid, stat.ppid);
    stats.set(pid, stat);
  }
  // BFS 取全部后代（不限深度；zygote 在中间层也能覆盖）。
  const tree = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (stats.has(pid)) tree.push(pid);
    for (const [child, parent] of parents) {
      if (parent === pid) queue.push(child);
    }
  }
  const roles = {};
  for (const role of ROLES) roles[role] = { cpuTicks: 0, rssBytes: 0, pssBytes: 0, pssKnown: true, pids: 0 };
  let totalTicks = 0;
  let totalRss = 0;
  let totalPss = 0;
  let pssKnown = true;
  for (const pid of tree) {
    const stat = stats.get(pid);
    const role = roleOf(readCmdline(pid));
    const rss = readStatusRss(pid) ?? 0;
    const pss = readPss(pid);
    if (pss === null) pssKnown = false;
    const ticks = stat.utime + stat.stime;
    totalTicks += ticks;
    totalRss += rss;
    if (pss !== null) totalPss += pss;
    const slot = roles[role];
    slot.cpuTicks += ticks;
    slot.rssBytes += rss;
    if (pss !== null) slot.pssBytes += pss;
    else slot.pssKnown = false;
    slot.pids += 1;
  }
  for (const slot of Object.values(roles)) {
    if (!slot.pssKnown) slot.pssBytes = null;
    delete slot.pssKnown;
  }
  return {
    at: Date.now(),
    total: {
      cpuTicks: totalTicks,
      rssBytes: totalRss,
      pssBytes: pssKnown ? totalPss : null,
      pids: tree.length,
    },
    roles,
  };
}

/** /proc/loadavg：1/5/15 分钟 + 可运行/总线程。CPU 数值必须与它一起报。 */
export function readLoadavg() {
  try {
    const parts = readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/);
    const [running, total] = (parts[3] ?? '0/0').split('/').map(Number);
    return {
      one: Number(parts[0]),
      five: Number(parts[1]),
      fifteen: Number(parts[2]),
      running: Number.isFinite(running) ? running : null,
      threads: Number.isFinite(total) ? total : null,
    };
  } catch {
    return null;
  }
}

/** /proc/stat 首行：整机 CPU 忙闲累计（jiffies），用于给负载一个绝对刻度。 */
export function readHostCpu() {
  try {
    const line = readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const nums = line.trim().split(/\s+/).slice(1).map(Number);
    const total = nums.reduce((a, b) => a + b, 0);
    const idle = (nums[3] ?? 0) + (nums[4] ?? 0);
    return { totalTicks: total, idleTicks: idle };
  } catch {
    return null;
  }
}

/** 扫 /proc 找带指定标记的存活进程（退出后残留检查用）。 */
export function findProcessesMatching(marker) {
  const hits = [];
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return hits;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    const cmd = readCmdline(pid);
    if (cmd === '' || !cmd.includes(marker)) continue;
    let environ = '';
    try {
      environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      /* 读不到 environ 的进程不认 */
    }
    if (!cmd.includes(marker) && !environ.includes(marker)) continue;
    hits.push({ pid, cmdline: cmd });
  }
  return hits;
}
