/**
 * 独立模式真实 Electron 验收：同动画连续点播，以及加载失败。
 *
 * 不启动 DSH。测试专用 DSH_HOME，素材用包内 webm，媒体请求先挂起。
 * 第一个点播的素材请求必须已经进渲染端并挂着；第二个同地址点播在素材仍挂起时
 * 查询必须仍是 accepted。放行第二个之后要先 playing 再 ended，第一个则是
 * cancelled/superseded。缺失地址要落到 failed（asset-load 或 decode-error）。
 * 收尾关掉挂起服务、等独立进程和它的 Electron 子进程退出、删掉临时目录。
 * 起不来或超时退出码非 0，收尾照样做。
 *
 * 用法（在 dsh-pet 目录）：
 *   node scripts/verify/playback-lifecycle-electron.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLIP = join(ROOT, 'assets', 'webm', '待机呼吸休闲.webm');
const ROUTE = '/dsh-pet-7340';
const PET = 'main';
/** SIGTERM 之后留给独立进程和 Electron 自己收尾的时间；到点改 SIGKILL 并判失败。 */
const STOP_GRACE_MS = 15_000;
const KILL_GRACE_MS = 3_000;

const log = (line) => {
  const text = new Date().toISOString() + ' ' + line;
  process.stdout.write(text + '\n');
};

function fail(message) {
  process.stderr.write(message + '\n');
  if (!process.exitCode) process.exitCode = 2;
}

async function pickPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function isHung(hit) {
  return Boolean(hit) && !hit.closed && !hit.res.writableEnded && !hit.res.headersSent;
}

function startHangServer(port, bytes) {
  /** @type {Array<{ url: string, at: number, res: import('node:http').ServerResponse, closed: boolean }>} */
  const hits = [];
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/missing')) {
      res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('missing');
      return;
    }
    const hit = { url, at: Date.now(), res, closed: false };
    hits.push(hit);
    log('渲染端开始取素材 ' + url + '（先挂起，不回字节）');
    req.on('close', () => {
      hit.closed = true;
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, hits, bytes, sockets }));
  });
}

/** 停接受新连接，并拆掉还挂着的素材连接，避免 close 一直等这些请求。 */
function closeHangServer(hang) {
  if (!hang) return Promise.resolve();
  return new Promise((resolve) => {
    hang.server.close(() => resolve());
    if (typeof hang.server.closeAllConnections === 'function') hang.server.closeAllConnections();
    for (const socket of hang.sockets) socket.destroy();
  });
}

function releaseClip(hit, bytes) {
  if (!isHung(hit)) return false;
  hit.res.writeHead(200, {
    'content-type': 'video/webm',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
    'accept-ranges': 'none',
  });
  hit.res.end(bytes);
  return true;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

/** /proc/pid/stat 的 comm 可以带括号和空格，ppid 在最后一个 `)` 之后的第二列。 */
function childPids(pid) {
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  const children = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(join('/proc', entry, 'stat'), 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) continue;
      const fields = stat
        .slice(close + 2)
        .trim()
        .split(/\s+/);
      if (Number(fields[1]) === pid) children.push(Number(entry));
    } catch {
      /* 进程在读的瞬间退出 */
    }
  }
  return children;
}

function processTree(root) {
  const pids = [];
  const queue = [root];
  const seen = new Set();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid == null || seen.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);
    if (!isAlive(pid)) continue;
    for (const child of childPids(pid)) queue.push(child);
  }
  return pids;
}

/**
 * SIGTERM 独立进程（或 Xvfb），并等到它和当时已经拉起的子进程都退出。
 * 时限到了就 SIGKILL，并让调用方把这一轮判失败。
 */
async function stopSpawned(child, label) {
  if (!child || child.pid == null) return;
  const tracked = new Set();
  const refresh = () => {
    const seeds = new Set(tracked);
    seeds.add(child.pid);
    for (const pid of seeds) {
      if (!isAlive(pid)) continue;
      for (const descendant of processTree(pid)) tracked.add(descendant);
    }
  };
  refresh();
  try {
    child.kill('SIGTERM');
  } catch {
    /* 已经退出 */
  }
  const termDeadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < termDeadline) {
    refresh();
    if ([...tracked].every((pid) => !isAlive(pid))) return;
    await delay(100);
  }
  refresh();
  for (const pid of tracked) {
    if (!isAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经退出 */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已经退出 */
  }
  const killDeadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < killDeadline) {
    if ([...tracked].every((pid) => !isAlive(pid))) break;
    await delay(100);
  }
  const leftover = [...tracked].filter((pid) => isAlive(pid));
  const detail = leftover.length > 0 ? '，仍存活 ' + leftover.join(',') : '';
  throw new Error(label + ' 未在时限内退出，已 SIGKILL' + detail);
}

async function ensureElectron() {
  const cache = join(process.env.HOME || tmpdir(), '.dsh');
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/ensure-electron.mjs'], {
      cwd: ROOT,
      env: { ...process.env, DSH_HOME: cache },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('exit', (code) => {
      if (code === 0) resolve(out.trim().split('\n').pop());
      else reject(new Error(err || out || 'ensure-electron exit ' + code));
    });
  });
  return output;
}

async function readRuntime(home, timeoutMs) {
  const file = join(home, 'dsh-pet', 'standalone-runtime.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      await delay(200);
    }
  }
  throw new Error('独立模式没有写出 standalone-runtime.json');
}

async function api(port, token, method, path, body) {
  const response = await fetch('http://127.0.0.1:' + port + path, {
    method,
    headers: {
      host: '127.0.0.1:' + port,
      'content-type': 'application/json',
      ...(token ? { 'x-dsh-pet-token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

async function waitFor(label, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await delay(100);
  }
  throw new Error(label + ' 超时。最后一次观察：' + JSON.stringify(last));
}

async function main() {
  /** @type {string | undefined} */
  let home;
  /** @type {Awaited<ReturnType<typeof startHangServer>> | undefined} */
  let hang;
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let standalone;
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let display;
  /** @type {Promise<void> | undefined} */
  let cleanupTask;

  const cleanup = () => {
    if (!cleanupTask) cleanupTask = cleanupOnce();
    return cleanupTask;
  };

  async function cleanupOnce() {
    const problems = [];
    try {
      await closeHangServer(hang);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    try {
      await stopSpawned(standalone, '独立模式');
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    try {
      await stopSpawned(display, 'Xvfb');
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    if (home) {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (problems.length > 0) fail(problems.join('\n'));
  }

  process.on('SIGINT', () => {
    if (!process.exitCode) process.exitCode = 130;
    void cleanup();
  });

  try {
    const bytes = readFileSync(CLIP);
    home = mkdtempSync(join(tmpdir(), 'dsh-pet-playback-'));
    const hangPort = await pickPort();
    const appPort = await pickPort();
    const clipUrl = 'http://127.0.0.1:' + hangPort + '/clip.webm';
    const missingUrl = 'http://127.0.0.1:' + hangPort + '/missing.webm';
    const electronPath = await ensureElectron();
    log('electron ' + electronPath);
    hang = await startHangServer(hangPort, bytes);
    display =
      process.env.DISPLAY || process.env.WAYLAND_DISPLAY
        ? undefined
        : spawn('Xvfb', [':99', '-screen', '0', '1280x720x24'], {
            stdio: 'ignore',
          });
    const env = {
      ...process.env,
      DSH_HOME: home,
      DSH_PET_ELECTRON_PATH: electronPath,
      DISPLAY: process.env.DISPLAY || ':99',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    standalone = spawn(process.execPath, ['lib/standalone.js', '--port', String(appPort)], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    standalone.stdout.on('data', (chunk) => process.stdout.write(chunk));
    standalone.stderr.on('data', (chunk) => process.stderr.write(chunk));

    const runtime = await readRuntime(home, 120_000);
    log('独立模式端口 ' + runtime.port);
    await waitFor('配置接口', 30_000, async () => {
      const result = await api(runtime.port, '', 'GET', ROUTE + '/config').catch(() => null);
      return result && result.status === 200 ? result : null;
    });
    log('等待桌面窗口拉起');
    await delay(4000);

    const first = await api(runtime.port, runtime.token, 'POST', ROUTE + '/anim?pet=' + PET + '&surface=desktop', {
      url: clipUrl,
    });
    if (!first.json.playbackId) throw new Error('第一次点播没有 playbackId：' + JSON.stringify(first.json));
    const firstId = first.json.playbackId;
    log('第一次点播 ' + firstId + '，等待渲染端挂起加载');
    const firstHit = await waitFor('第一个素材请求', 30_000, async () => {
      return hang.hits.find((hit) => hit.url.startsWith('/clip.webm') && isHung(hit)) ?? null;
    });
    const held = await api(runtime.port, '', 'GET', ROUTE + '/playback/' + encodeURIComponent(firstId));
    log('挂起时查询 ' + firstId + ' = ' + JSON.stringify(held.json));
    if (!isHung(firstHit)) throw new Error('第一个素材请求在确认前就不再挂起');
    if (held.json.status === 'playing') throw new Error('素材还挂着时不应该是 playing');

    const second = await api(runtime.port, runtime.token, 'POST', ROUTE + '/anim?pet=' + PET + '&surface=desktop', {
      url: clipUrl,
    });
    if (!second.json.playbackId) throw new Error('第二次点播没有 playbackId：' + JSON.stringify(second.json));
    const secondId = second.json.playbackId;
    log('第二次点播 ' + secondId + '（第一次已经进入渲染端）');
    const secondHit = await waitFor('第二个素材请求', 20_000, async () => {
      return hang.hits.find((hit) => hit.url.startsWith('/clip.webm') && hit.at > firstHit.at && isHung(hit)) ?? null;
    });
    if (!isHung(secondHit)) throw new Error('第二个加载在查询前就不再挂起');
    const heldSecond = await api(runtime.port, '', 'GET', ROUTE + '/playback/' + encodeURIComponent(secondId));
    log('第二个仍挂起时查询 ' + secondId + ' = ' + JSON.stringify(heldSecond.json));
    if (heldSecond.json.status !== 'accepted') {
      throw new Error('第二个素材仍挂起时必须是 accepted，实际 ' + JSON.stringify(heldSecond.json));
    }
    if (!isHung(secondHit)) throw new Error('查询期间第二个加载被放行或断开了');
    if (!releaseClip(secondHit, bytes)) throw new Error('第二个加载在放行前就断开了');
    log('放行第二个加载');

    const playing = await waitFor('第二次点播进入 playing', 25_000, async () => {
      const result = await api(runtime.port, '', 'GET', ROUTE + '/playback/' + encodeURIComponent(secondId));
      const status = result.json.status;
      if (status === 'playing') return result.json;
      if (status === 'ended' || status === 'failed' || status === 'cancelled') {
        throw new Error('第二次点播在 playing 之前进入了 ' + status + '：' + JSON.stringify(result.json));
      }
      return null;
    });
    log('第二次 playing ' + JSON.stringify(playing));
    const ended = await waitFor('第二次点播结束', 30_000, async () => {
      const result = await api(runtime.port, '', 'GET', ROUTE + '/playback/' + encodeURIComponent(secondId));
      const status = result.json.status;
      if (status === 'ended') return result.json;
      if (status === 'failed' || status === 'cancelled') {
        throw new Error('连续点播应播完，实际 ' + JSON.stringify(result.json));
      }
      return null;
    });
    log('第二次终态 ' + JSON.stringify(ended));

    const firstAfter = await api(runtime.port, '', 'GET', ROUTE + '/playback/' + encodeURIComponent(firstId));
    log('第一次查询 ' + JSON.stringify(firstAfter.json));
    if (firstAfter.json.status !== 'cancelled' || firstAfter.json.reason !== 'superseded') {
      throw new Error('旧请求应被新请求取消（superseded），实际 ' + JSON.stringify(firstAfter.json));
    }

    const broken = await api(runtime.port, runtime.token, 'POST', ROUTE + '/anim?pet=' + PET + '&surface=desktop', {
      url: missingUrl,
    });
    if (!broken.json.playbackId) throw new Error('失败链没有 playbackId：' + JSON.stringify(broken.json));
    const brokenId = broken.json.playbackId;
    log('加载失败点播 ' + brokenId);
    const failed = await waitFor('加载失败终态', 20_000, async () => {
      const result = await api(runtime.port, '', 'GET', ROUTE + '/playback/' + encodeURIComponent(brokenId));
      if (result.json.status === 'failed' || result.json.status === 'cancelled' || result.json.status === 'ended') {
        return result.json;
      }
      if (result.json.status === 'playing') return result.json;
      return null;
    });
    log('失败链查询 ' + JSON.stringify(failed));
    if (failed.status !== 'failed') throw new Error('加载失败应进入 failed，实际 ' + JSON.stringify(failed));
    if (failed.reason !== 'asset-load' && failed.reason !== 'decode-error') {
      throw new Error('失败原因应为 asset-load 或 decode-error，实际 ' + JSON.stringify(failed));
    }
    log('两条链都通过');
  } catch (error) {
    fail(error instanceof Error ? error.stack || error.message : String(error));
  } finally {
    await cleanup();
  }
}

await main();
