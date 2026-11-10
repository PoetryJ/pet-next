/**
 * M3-12 D：一支臂的产品进程生命周期（真实 Electron，无聊天、无模型请求）。
 *
 * 入口和 `tests/platform/session.ts` 一致：直接 `electron dist/electron/main.js`，
 * 只加 `PET_NEXT_TEST=1` / `PET_NEXT_USER_DATA` / `PET_NEXT_IDLE_URL`(+可选 reaction)。
 * 与 bench/idle-profile 的 chat-trial 入口不同点：这里**不建 SSH 隧道、不挂聊天**，
 * 从环境上就没有模型调用路径（见 sanitizedEnv 的删除清单）。
 *
 * 素材选择只走产品已有的 `PET_NEXT_IDLE_URL` 查询注入（electron/main.ts:248），
 * 三臂因此是同一份产品代码、同一窗口、同一入口，只有 idle 源文件不同。
 * @module pet-next/bench/idle-roi/lib/session
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, delay, freePort, waitForPageSocket } from './cdp.mjs';

export const petRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
export const electronBinary = path.join(petRoot, 'node_modules/electron/dist/electron');

/** 产品自身的最大窗口（与 M3-8/契约同一 320x240 视口口径）。 */
export const WINDOW = { width: 320, height: 240 };

const sleep = delay;
export { sleep };

/** 文件 SHA-256；文件不存在返回 null（不把缺失伪装成空串）。 */
export function sha256(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** 采一次整机负载文本，用于错误里带上当时的 loadavg。 */
export function loadavgText() {
  try {
    return readFileSync('/proc/loadavg', 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

/** 与 bench/idle-profile 相同的探活/自起逻辑，显示号由调用方固定（本轮 :154）。 */
export async function ensureDisplay(display) {
  const number = display.startsWith(':') ? display.slice(1) : display;
  const socket = `/tmp/.X11-unix/X${number}`;
  const alive = await new Promise((resolve) => {
    if (!existsSync(socket)) return resolve(false);
    const client = net.connect({ path: socket });
    const done = (value) => {
      client.removeAllListeners();
      client.destroy();
      resolve(value);
    };
    client.setTimeout(300, () => done(false));
    client.once('connect', () => done(true));
    client.once('error', () => done(false));
  });
  if (alive) return { owned: false, child: null, socket };
  for (const stale of [socket, `/tmp/.X${number}-lock`]) {
    if (existsSync(stale)) {
      try {
        unlinkSync(stale);
      } catch {
        /* 已被他人清理 */
      }
    }
  }
  const child = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  for (let i = 0; i < 60; i += 1) {
    if (existsSync(socket)) return { owned: true, child, socket };
    await sleep(100);
  }
  throw new Error(`Xvfb ${display} 10s 未就绪（loadavg=${loadavgText()}）`);
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else if (/\.(ts|js|mjs|cjs|json|html|css)$/.test(entry.name)) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

/** 构建只做一次；构建 CPU 单独记在 summary.build，不混进任何臂的采样窗。 */
export function ensureBuild() {
  const mainJs = path.join(petRoot, 'dist/electron/main.js');
  if (existsSync(mainJs)) {
    let newest = statSync(path.join(petRoot, 'tsconfig.json')).mtimeMs;
    for (const dir of ['electron', 'app', 'core', 'adapters', 'contracts', 'scripts']) {
      newest = Math.max(newest, newestMtime(path.join(petRoot, dir)));
    }
    if (newest < statSync(mainJs).mtimeMs) return { built: false, reason: 'up-to-date' };
  }
  const started = Date.now();
  execFileSync(path.join(path.dirname(process.execPath), 'pnpm'), ['build'], {
    cwd: petRoot,
    env: { ...process.env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return { built: true, reason: 'stale-or-missing', ms: Date.now() - started };
}

export function electronPreflight() {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const version = execFileSync(electronBinary, ['--no-sandbox', '--version'], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20000,
      })
        .toString()
        .trim();
      return { version, attempt };
    } catch (error) {
      if (attempt === 2) {
        throw new Error(`electron preflight 失败：${error?.stderr?.toString?.() ?? error.message}`, { cause: error });
      }
    }
  }
  return null;
}

/**
 * 清掉一切可能触发真实模型/SSH/预览策略的环境变量。
 * 只留下本 bench 显式设置的四类：TEST / USER_DATA / IDLE_URL / REACTION_URL (+可选 ROI 接线开关)。
 */
export function sanitizedEnv(extra) {
  const env = { ...process.env };
  const drop = [
    'PET_NEXT_CHAT_PREVIEW',
    'PET_NEXT_CHAT_FAKE_URL',
    'PET_NEXT_CHAT_LOCAL',
    'PET_NEXT_CHAT_TRANSPORT',
    'PET_NEXT_CHAT_CONTEXT',
    'PET_NEXT_CHAT_DEBUG_PORT',
    'PET_NEXT_EXPERIENCE',
    'PET_NEXT_PREVIEW',
    'PET_NEXT_QWEN_BASE_URL',
    'PET_NEXT_QWEN_MODEL',
    'PET_NEXT_QWEN_API_KEY',
    'PET_NEXT_SSH_HOST',
    'PET_NEXT_SSH_PORT',
    'PET_NEXT_SSH_USER',
    'PET_NEXT_SSH_BIN',
    'PET_NEXT_TUNNEL_LOCAL_PORT',
    'PET_NEXT_IDLE_PAUSE',
    'PET_NEXT_IDLE_URL',
    'PET_NEXT_REACTION_URL',
    'PET_NEXT_IDLE_ROI',
    'PET_NEXT_IDLE_ROI_MANIFEST',
    'FAKE_SSH_LOG',
    'FAKE_SSH_MODE',
    'FAKE_SSH_TARGET_PORT',
    'FAKE_MODEL_LOG',
    'FAKE_MODEL_MODE',
    'FAKE_MODEL_DELAY_MS',
  ];
  for (const key of drop) delete env[key];
  delete env.NODE_OPTIONS;
  return Object.assign(env, extra);
}

/**
 * 起一支臂的产品进程。
 * @param {{display:string,userDataDir:string,debugPort:number,idleUrl:string|null,reactionUrl:string|null,roiLayout?:boolean,logTag:string}} options
 */
export function launchProduct(options) {
  const extra = {
    DISPLAY: options.display,
    PET_NEXT_TEST: '1',
    PET_NEXT_USER_DATA: options.userDataDir,
  };
  if (options.idleUrl) extra.PET_NEXT_IDLE_URL = options.idleUrl;
  if (options.reactionUrl) extra.PET_NEXT_REACTION_URL = options.reactionUrl;
  // 负责人已落地（830b7cb + 9dc035e）：PET_NEXT_IDLE_ROI=1 且
  // PET_NEXT_IDLE_ROI_MANIFEST=<abs>/manifest.json 才注入几何；缺 manifest 时产品应回原路径。
  if (options.roiLayout === true) {
    extra.PET_NEXT_IDLE_ROI = '1';
    if (options.roiManifest) extra.PET_NEXT_IDLE_ROI_MANIFEST = options.roiManifest;
  }
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${options.debugPort}`,
    path.join(petRoot, 'dist/electron/main.js'),
  ];
  const child = spawn(electronBinary, args, {
    cwd: petRoot,
    env: sanitizedEnv(extra),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk) => (out += String(chunk)));
  child.stderr?.on('data', (chunk) => (err += String(chunk)));
  return {
    child,
    logTag: options.logTag,
    stdout: () => out,
    stderr: () => err,
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill() {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
      }
    },
  };
}

/** 只认本轮 userData 标记的 electron main（同名窗口/别人的 GUI 都不认）。 */
export function findMainPid(marker) {
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let cmd;
    try {
      cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (!cmd.includes('electron/main.js') || cmd.includes('--type=')) continue;
    try {
      if (readFileSync(`/proc/${entry}/environ`, 'utf8').includes(marker)) return Number(entry);
    } catch {
      /* 读不到 environ 不认 */
    }
  }
  return null;
}

export async function waitForMainPid(marker, isDead, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = findMainPid(marker);
    if (pid !== null) return pid;
    if (isDead()) return null;
    await sleep(200);
  }
  return null;
}

export function xdo(display, args) {
  return execFileSync('xdotool', args, {
    env: { ...process.env, DISPLAY: display },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
}

export function findWindow(display, mainPid) {
  const selectors = [];
  if (mainPid !== null) selectors.push(['search', '--onlyvisible', '--pid', String(mainPid)]);
  selectors.push(['search', '--onlyvisible', '--name', 'pet-next']);
  for (const args of selectors) {
    try {
      const ids = xdo(display, args).split('\n').filter((item) => item.trim() !== '');
      if (ids.length > 0) return ids[ids.length - 1];
    } catch {
      /* 试下一个选择器 */
    }
  }
  return null;
}

export function windowGeometry(display, id) {
  try {
    const text = xdo(display, ['getwindowgeometry', '--shell', id]);
    const map = Object.fromEntries(
      text
        .split('\n')
        .map((line) => line.split('='))
        .filter((pair) => pair.length === 2),
    );
    return { x: Number(map.X), y: Number(map.Y), width: Number(map.WIDTH), height: Number(map.HEIGHT) };
  } catch {
    return null;
  }
}

/** 连接页面 target；renderer 未就绪时按 deadline 轮询。 */
export async function openPage(debugPort, isDead, deadlineMs = 150000) {
  const socket = await waitForPageSocket(debugPort, isDead, Date.now() + deadlineMs);
  const cdp = await connectCdp(socket);
  return cdp;
}

export { freePort };
