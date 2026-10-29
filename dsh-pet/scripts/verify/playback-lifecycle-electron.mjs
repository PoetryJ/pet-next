/**
 * 独立模式真实 Electron 验收：同动画连续点播，以及加载失败。
 *
 * 不启动 DSH。测试专用 DSH_HOME，素材用包内 webm。
 * 先等第一个点播进入渲染端并挂起加载，再发第二个，避免 /state 快照把两次叶子合成一次。
 *
 * 用法（在 dsh-pet 目录）：
 *   node scripts/verify/playback-lifecycle-electron.mjs
 *
 * 退出码 0 只表示两条链的断言都成立。环境起不来时退出码 2，并把原因打到标准错误。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLIP = join(ROOT, 'assets', 'webm', '待机呼吸休闲.webm');
const ROUTE = '/dsh-pet-7340';
const PET = 'main';

const log = (line) => {
  const text = new Date().toISOString() + ' ' + line;
  process.stdout.write(text + '\n');
};

function fail(message) {
  process.stderr.write(message + '\n');
  process.exitCode = 2;
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

function startHangServer(port, bytes) {
  /** @type {Array<{ url: string, at: number, res: import('node:http').ServerResponse, closed: boolean }>} */
  const hits = [];
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
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, hits, bytes }));
  });
}

function releaseClip(hit, bytes) {
  if (hit.closed || hit.res.writableEnded) return false;
  hit.res.writeHead(200, {
    'content-type': 'video/webm',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
    'accept-ranges': 'none',
  });
  hit.res.end(bytes);
  return true;
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
  const bytes = readFileSync(CLIP);
  const home = mkdtempSync(join(tmpdir(), 'dsh-pet-playback-'));
  const hangPort = await pickPort();
  const appPort = await pickPort();
  const clipUrl = 'http://127.0.0.1:' + hangPort + '/clip.webm';
  const missingUrl = 'http://127.0.0.1:' + hangPort + '/missing.webm';
  let electronPath;
  try {
    electronPath = await ensureElectron();
  } catch (error) {
    fail('Electron 未就位：' + (error instanceof Error ? error.message : String(error)));
    return;
  }
  log('electron ' + electronPath);
  const hang = await startHangServer(hangPort, bytes);
  const display =
    process.env.DISPLAY || process.env.WAYLAND_DISPLAY
      ? null
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
  const standalone = spawn(process.execPath, ['lib/standalone.js', '--port', String(appPort)], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  standalone.stdout.on('data', (chunk) => process.stdout.write(chunk));
  standalone.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const stop = () => {
    hang.server.close();
    standalone.kill('SIGTERM');
    if (display) display.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  };
  process.on('SIGINT', () => {
    stop();
    process.exit(130);
  });
  try {
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
    const firstHit = await waitFor('第一个素材请求', 30_000, async () => hang.hits.find((hit) => !hit.closed) ?? null);
    const held = await api(runtime.port, '', 'GET', ROUTE + '/playback/' + encodeURIComponent(firstId));
    log('挂起时查询 ' + firstId + ' = ' + JSON.stringify(held.json));
    if (held.json.status === 'playing') throw new Error('素材还挂着时不应该是 playing');

    const second = await api(runtime.port, runtime.token, 'POST', ROUTE + '/anim?pet=' + PET + '&surface=desktop', {
      url: clipUrl,
    });
    if (!second.json.playbackId) throw new Error('第二次点播没有 playbackId：' + JSON.stringify(second.json));
    const secondId = second.json.playbackId;
    log('第二次点播 ' + secondId + '（第一次已经进入渲染端）');
    const secondHit = await waitFor(
      '第二个素材请求',
      20_000,
      async () => hang.hits.find((hit) => hit.at > firstHit.at && !hit.closed) ?? null,
    );
    if (!releaseClip(secondHit, bytes)) throw new Error('第二个加载在放行前就断开了');
    log('放行第二个加载');

    const success = await waitFor('第二次点播进入 playing 或终态', 25_000, async () => {
      const result = await api(runtime.port, '', 'GET', ROUTE + '/playback/' + encodeURIComponent(secondId));
      const status = result.json.status;
      if (status === 'playing' || status === 'ended' || status === 'failed' || status === 'cancelled')
        return result.json;
      return null;
    });
    log('第二次查询 ' + JSON.stringify(success));
    const firstAfter = await api(runtime.port, '', 'GET', ROUTE + '/playback/' + encodeURIComponent(firstId));
    log('第一次查询 ' + JSON.stringify(firstAfter.json));
    if (firstAfter.json.status !== 'cancelled') {
      throw new Error('旧请求应被新请求取消，实际 ' + JSON.stringify(firstAfter.json));
    }
    if (success.status === 'failed' || success.status === 'cancelled') {
      throw new Error('同动画连续点播没有成功：' + JSON.stringify(success));
    }
    const ended = await waitFor('第二次点播结束', 30_000, async () => {
      const result = await api(runtime.port, '', 'GET', ROUTE + '/playback/' + encodeURIComponent(secondId));
      if (result.json.status === 'ended' || result.json.status === 'failed' || result.json.status === 'cancelled') {
        return result.json;
      }
      return null;
    });
    log('第二次终态 ' + JSON.stringify(ended));
    if (ended.status !== 'ended') throw new Error('连续点播应播完，实际 ' + JSON.stringify(ended));

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
    stop();
    await delay(500);
  }
}

await main();
