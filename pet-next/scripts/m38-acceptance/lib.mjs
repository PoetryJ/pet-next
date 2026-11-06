/**
 * M3-8 验收脚本的共用工具：子进程执行、计数解析、自起自收 Xvfb、环境净化。
 * 只被 scripts/m38-acceptance/*.mjs 引用；不参与产品运行路径。
 */
import { spawn } from 'node:child_process';
import { createHash, } from 'node:crypto';
import { existsSync, openSync, closeSync } from 'node:fs';
import { execFile } from 'node:child_process';

export const TOOLS_PREFIX = '/tmp/m38-tools/bin';

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 子进程环境：剔除 NODE_OPTIONS 与父级预览/体验开关，PATH 前置冻结工具链。 */
export function childEnv(display, extra = {}) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  for (const key of [
    'PET_NEXT_CHAT_PREVIEW',
    'PET_NEXT_EXPERIENCE',
    'PET_NEXT_PREVIEW',
    'PET_NEXT_CONTEXT',
    'PET_NEXT_LAUNCHER_E2E',
    'PET_NEXT_E2E_DISPLAY',
  ]) {
    delete env[key];
  }
  const current = env.PATH ?? '';
  if (!current.split(':').includes(TOOLS_PREFIX)) env.PATH = `${TOOLS_PREFIX}:${current}`;
  const merged = { ...env, ...extra };
  if (display !== undefined) {
    merged.DISPLAY = display;
    merged.PET_NEXT_E2E_DISPLAY = display;
  }
  return merged;
}

export function execCapture(cmd, argv, options = {}) {
  return new Promise((resolve) => {
    execFile(cmd, argv, { timeout: 30_000, ...options }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        code: error?.code ?? 0,
        stdout: String(stdout ?? '').trim(),
        stderr: String(stderr ?? '').trim(),
      });
    });
  });
}

/** 解析 node --test 汇总块（`# tests 7` 或 `ℹ tests 7`），取最后一个完整块。 */
export function parseCounts(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const hit = line.match(/^\s*(?:#|ℹ)\s*(tests|pass|fail|skipped|cancelled|todo)\s+(\d+)\s*$/);
    if (hit === null) continue;
    const key = hit[1];
    const value = Number(hit[2]);
    if (key === 'tests') {
      current = { tests: value };
      blocks.push(current);
      continue;
    }
    if (current === null) continue;
    current[key] = value;
  }
  const last = blocks.at(-1);
  if (last === undefined) return { counts: null, blocks: 0 };
  return {
    counts: {
      tests: last.tests ?? null,
      pass: last.pass ?? null,
      fail: last.fail ?? null,
      skipped: last.skipped ?? null,
      cancelled: last.cancelled ?? null,
    },
    blocks: blocks.length,
  };
}

/**
 * 跑一个子进程：stdout+stderr 原样写入 logPath（纯子进程字节，不掺笔记）。
 * 超时只对本轮 detached 进程组发信号，不碰他人进程。
 */
export function runChild(spec) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const fd = openSync(spec.logPath, 'w');
    let child;
    try {
      child = spawn(spec.cmd, spec.argv, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['ignore', fd, fd],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      closeSync(fd);
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnError: String(error),
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    let timedOut = false;
    let hardKill = null;
    const killGroup = (signal) => {
      if (child.pid === undefined) return;
      try {
        process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
      } catch {
        /* 已退出 */
      }
    };
    const timer =
      spec.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killGroup('SIGTERM');
            hardKill = setTimeout(() => killGroup('SIGKILL'), 5000);
          }, spec.timeoutMs)
        : null;
    const done = (payload) => {
      if (timer !== null) clearTimeout(timer);
      if (hardKill !== null) clearTimeout(hardKill);
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      resolve({ ...payload, timedOut, durationMs: Date.now() - startedAt });
    };
    child.on('error', (error) => done({ exitCode: null, signal: null, spawnError: String(error) }));
    child.on('close', (code, signal) => done({ exitCode: code, signal }));
  });
}

/** 自起自收的 Xvfb 管理（默认 :96；不占 :94，不杀他人）。 */
export class DisplayManager {
  constructor(display, log) {
    this.display = display;
    this.log = log;
    this.child = null;
    this.owned = false;
  }

  socketPath() {
    return `/tmp/.X11-unix/X${this.display.replace(/^:/, '')}`;
  }

  async ensure(allowStart = true) {
    if (process.platform !== 'linux') {
      return { ready: true, owned: false, reason: `平台 ${process.platform}（无 X11 需求判断）` };
    }
    if (existsSync(this.socketPath())) return { ready: true, owned: false, reason: 'socket 已存在，复用' };
    if (!allowStart) return { ready: false, owned: false, reason: '禁止自起 Xvfb' };
    this.child = spawn('Xvfb', [this.display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
      stdio: 'ignore',
      detached: true,
    });
    this.owned = true;
    const deadline = Date.now() + 8000;
    while (!existsSync(this.socketPath()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const ready = existsSync(this.socketPath());
    this.log(`display ${this.display}: 自起 Xvfb，ready=${ready}`);
    return { ready, owned: true, reason: ready ? `自起 Xvfb ${this.display}` : `Xvfb ${this.display} 8s 未就绪` };
  }

  async stop() {
    if (this.child === null || !this.owned) return;
    const pid = this.child.pid;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* 已退出 */
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && existsSync(this.socketPath())) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (existsSync(this.socketPath())) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
    this.log(`display ${this.display}: 已收 Xvfb`);
    this.child = null;
  }
}
