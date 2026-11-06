#!/usr/bin/env node
/**
 * M3-9 D：产品路径的待机节能对照（真实 BrowserWindow hide/show，不用 xdotool unmap）。
 *
 *   node bench/idle-profile/m39-run.mjs --arm=baseline|candidate --state=hidden|visible \
 *        --seconds=60 --warmup=8 --display=:97 --stamp=m39-p1 --label=p1
 *
 * 一支臂 = 一次产品入口（dist/electron/main.js）+ 真实窗口动作（经 PET_NEXT_TEST 的
 * `pet:test-window` 通道，最终调用 BrowserWindow.hide()/show()）。candidate 臂额外带
 * `PET_NEXT_IDLE_PAUSE=1`，即产品内建的呈现暂停；baseline 臂不带该开关——两臂唯一差异就是它。
 *
 * 口径：
 * - CPU = /proc utime+stime jiffies 差 / HZ(100)，按角色求和后除以实际采样窗。
 * - RSS = 各进程 RSS 求和（共享页重复计入），electron-only 与全部角色分开报。
 * - 解码帧数 = video.getVideoPlaybackQuality().totalVideoFrames 差（软件呈帧，不代表物理响应）。
 * - POST：本轮两条臂都不启用聊天服务，请求数恒为 0；这不等于"验证了隐藏不触发请求"，
 *   该点由 e2e 的 fake 路径覆盖。
 * @module pet-next/bench/idle-profile/m39-run
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, delay, freePort, waitForPageSocket } from './lib/cdp.mjs';
import { HZ, sampleRoles } from './lib/proc-roles.mjs';

const petRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const rawArgs = process.argv.slice(2);
const value = (name, fallback) => {
  const hit = rawArgs.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

if (process.platform !== 'linux') {
  console.error('m39-run 只用 /proc 读数，需要 Linux。');
  process.exit(2);
}

const arm = value('arm', 'baseline');
if (arm !== 'baseline' && arm !== 'candidate') {
  console.error('--arm 必须是 baseline 或 candidate');
  process.exit(2);
}
const state = value('state', 'hidden');
if (state !== 'visible' && state !== 'hidden') {
  console.error('--state 必须是 visible 或 hidden');
  process.exit(2);
}
const seconds = Number(value('seconds', '60'));
const warmupSec = Number(value('warmup', '8'));
const display = value('display', ':97');
const stamp = value('stamp', `m39-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const label = value('label', `${stamp}-${state}-${arm}`);
const probesEnabled = value('probe', '1') === '1';
const outDir = path.join(petRoot, 'bench/idle-profile/runs', stamp, `${state}-${arm}`);
mkdirSync(outDir, { recursive: true });

/** 两臂共用同一素材；哈希取自仓库文件本身，不是 blob URL。 */
const idleAssetPath = path.join(petRoot, 'assets/idle.webm');
const idleAssetSha = createHash('sha256').update(readFileSync(idleAssetPath)).digest('hex');

const ELECTRON_ROLES = new Set(['main', 'renderer', 'gpu', 'utility', 'zygote', 'crashpad']);

function cpuSeconds(roles) {
  let ticks = 0;
  for (const stat of Object.values(roles)) ticks += stat.cpuTicks;
  return ticks / HZ;
}

function electronCpuSeconds(roles) {
  let ticks = 0;
  for (const [role, stat] of Object.entries(roles)) {
    if (ELECTRON_ROLES.has(role)) ticks += stat.cpuTicks;
  }
  return ticks / HZ;
}

function rssBytes(roles, predicate = () => true) {
  let total = 0;
  for (const [role, stat] of Object.entries(roles)) if (predicate(role)) total += stat.rssBytes;
  return total;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

const failures = [];
const logs = [];
function log(line) {
  const text = `[m39 ${label}] ${line}`;
  logs.push(text);
  console.log(text);
}

async function cdpEvaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed');
  }
  return result.result?.value;
}

async function windowAct(cdp, action) {
  return cdpEvaluate(cdp, `window.petTestWindow.act(${JSON.stringify(action)})`);
}

async function readState(cdp) {
  return cdpEvaluate(cdp, 'window.__petIdleSuspension ? JSON.parse(JSON.stringify(window.__petIdleSuspension)) : null');
}

async function readMedia(cdp) {
  return cdpEvaluate(
    cdp,
    `(() => { const v = document.querySelector('#clip');
      if (!v) return { ready: false, paused: null, src: '', total: null };
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      return { ready: true, paused: v.paused, src: v.currentSrc || v.src, total: q ? q.totalVideoFrames : (v.webkitDecodedFrameCount ?? null) }; })()`,
  );
}

async function waitFor(cdp, labelText, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readState(cdp);
    if (predicate(last)) return last;
    await delay(20);
  }
  throw new Error(`${labelText} 超时，最后状态=${JSON.stringify(last)}`);
}

const electronPath = path.join(petRoot, 'node_modules/electron/dist/electron');
const userData = path.join(outDir, 'userData');
mkdirSync(userData, { recursive: true });
const debugPort = await freePort();
const env = {
  ...process.env,
  DISPLAY: display,
  PET_NEXT_TEST: '1',
  PET_NEXT_USER_DATA: userData,
  ...(arm === 'candidate' ? { PET_NEXT_IDLE_PAUSE: '1' } : {}),
};
delete env.NODE_OPTIONS;

const child = spawn(
  electronPath,
  ['--no-sandbox', '--disable-dev-shm-usage', '--remote-allow-origins=*', `--remote-debugging-port=${debugPort}`, 'dist/electron/main.js'],
  { cwd: petRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
);
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += String(chunk);
});
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

let cdp = null;
let sample;
try {
  const socket = await waitForPageSocket(debugPort, () => child.exitCode !== null, Date.now() + 30000);
  cdp = await connectCdp(socket);
  // 等页面与播放都就绪：CDP 的 page target 可能早于文档完成。
  const deadline = Date.now() + 20000;
  for (;;) {
    const media = await readMedia(cdp);
    if (media.ready === true && media.paused === false) break;
    if (Date.now() > deadline) throw new Error('等待 idle 播放超时');
    await delay(50);
  }
  log(`ready visible=${JSON.stringify(await windowAct(cdp, 'state'))}`);

  if (state === 'hidden') {
    await windowAct(cdp, 'hide');
    await delay(300);
  }

  // 预热（隐藏臂在隐藏态预热）。
  await delay(warmupSec * 1000);

  const start = sampleRoles(process.pid);
  const startMedia = await readMedia(cdp);
  const samples = [];
  const sampleDeadline = Date.now() + seconds * 1000;
  let ticks = 0;
  while (Date.now() < sampleDeadline) {
    const current = sampleRoles(process.pid);
    const media = await readMedia(cdp);
    const idle = await readState(cdp);
    samples.push({
      t: (Date.now() - start.at) / 1000,
      electronCpu: Number((electronCpuSeconds(current.roles) - electronCpuSeconds(start.roles)).toFixed(3)),
      totalCpu: Number((cpuSeconds(current.roles) - cpuSeconds(start.roles)).toFixed(3)),
      electronRss: rssBytes(current.roles, (role) => ELECTRON_ROLES.has(role)),
      totalRss: rssBytes(current.roles),
      decoded: media.total,
      paused: media.paused,
      hidden: idle === null ? null : idle.hidden,
      lease: idle === null ? null : idle.lease,
    });
    ticks += 1;
    await delay(700);
  }
  const end = sampleRoles(process.pid);
  const endMedia = await readMedia(cdp);
  const wall = (end.at - start.at) / 1000;
  const cpuDelta = electronCpuSeconds(end.roles) - electronCpuSeconds(start.roles);
  const totalCpuDelta = cpuSeconds(end.roles) - cpuSeconds(start.roles);
  const decodedDelta =
    startMedia.total !== null && endMedia.total !== null ? endMedia.total - startMedia.total : null;
  sample = {
    arm,
    state,
    label,
    asset: { path: 'assets/idle.webm', sha256: idleAssetSha },
    note: 'CPU/RSS 口径见文件头；两臂唯一差异 = PET_NEXT_IDLE_PAUSE；未启用 short,behavior（见报告未证明项）',
    wallSeconds: Number(wall.toFixed(2)),
    samples: ticks,
    electronCpuSeconds: Number(cpuDelta.toFixed(3)),
    totalCpuSeconds: Number(totalCpuDelta.toFixed(3)),
    electronCpuPerMinute: Number(((cpuDelta / wall) * 60).toFixed(3)),
    totalCpuPerMinute: Number(((totalCpuDelta / wall) * 60).toFixed(3)),
    electronRssBytes: rssBytes(end.roles, (role) => ELECTRON_ROLES.has(role)),
    totalRssBytes: rssBytes(end.roles),
    decodedFrames: decodedDelta,
    clip: { src: endMedia.src, sha256: null },
    pausedAtEnd: endMedia.paused,
    hiddenAtEnd: (await readState(cdp))?.hidden ?? null,
    leaseAtEnd: (await readState(cdp))?.lease ?? null,
    postCount: 0,
    postNote: '两条臂都未启用聊天服务：POST 恒为 0，不能据此宣称"隐藏不触发请求"（该点由 e2e fake 覆盖）',
    samples_detail: samples,
  };

  // 交互探针：10 次恢复 + 10 次点击（逐次记录，仅软件呈帧口径）。
  if (probesEnabled) {
    const restores = [];
    const clicks = [];
    // 隐藏臂先恢复可见，否则点击不会进产品窗口。
    await windowAct(cdp, 'show');
    await waitFor(cdp, '探针前可见', (value) => value === null || value.hidden === false, 8000);
    for (let index = 0; index < 10; index += 1) {
      await windowAct(cdp, 'hide');
      await delay(120);
      const t0 = Date.now();
      await windowAct(cdp, 'show');
      const visible = await waitFor(cdp, '恢复可见', (value) => value === null || value.hidden === false, 8000);
      restores.push({ ms: Date.now() - t0, hidden: visible === null ? null : visible.hidden });
      await delay(120);
    }
    const box = await cdpEvaluate(cdp, '(() => { const r = document.body.getBoundingClientRect(); return { x: Math.round(r.width / 2), y: Math.round(r.height / 2) }; })()');
    const frames = [];
    for (let index = 0; index < 10; index += 1) {
      const t0 = Date.now();
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse',
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 0, pointerType: 'mouse',
      });
      let latency = null;
      let shot = null;
      try {
        const reaction = await waitFor(cdp, 'reaction 起播', (value) => value !== null && value.clip === 'reaction' && value.phase === 'playing', 8000);
        latency = Date.now() - t0;
        const capture = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const data = String(capture.data ?? '');
        shot = {
          bytes: Buffer.from(data, 'base64').length,
          sha256: createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex'),
          generation: reaction?.generation ?? null,
        };
        frames.push({ latency, shot });
      } catch (error) {
        frames.push({ latency: null, error: String(error) });
      }
      clicks.push(frames.at(-1));
      await delay(900);
    }
    const restoreMs = restores.map((item) => item.ms);
    const clickMs = clicks.filter((item) => item.latency !== null).map((item) => item.latency);
    sample.probes = {
      restores,
      restoreMedianMs: median(restoreMs),
      restoreMaxMs: restoreMs.length > 0 ? Math.max(...restoreMs) : null,
      clicks: clicks.map((item) => ({ latency: item.latency, error: item.error ?? null, shot: item.shot ?? null })),
      clickMedianMs: median(clickMs),
      clickMaxMs: clickMs.length > 0 ? Math.max(...clickMs) : null,
      responseFrameNote: 'latency = 点击 → 页面状态进入 reaction/playing 的墙钟（软件呈帧）；不是物理渲染/显示延迟',
      decodedDuringProbes: null,
      validRestores: restores.filter((item) => item.hidden === false).length,
      validClicks: clickMs.length,
    };
  }

  sample.clip.sha256 = idleAssetSha;
  writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(sample, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'samples.json'), `${JSON.stringify(samples, null, 2)}\n`);
  log(`done wall=${sample.wallSeconds}s electronCpu=${sample.electronCpuSeconds}s (${sample.electronCpuPerMinute}/min) decoded=${decodedDelta}`);
} catch (error) {
  failures.push(String(error));
  writeFileSync(
    path.join(outDir, 'summary.json'),
    `${JSON.stringify({ arm, state, label, failures, stdout, stderr }, null, 2)}\n`,
  );
  console.error(`[m39 ${label}] FAILED: ${String(error)}`);
} finally {
  try {
    cdp?.close();
  } catch {
    // 退出时连接已断。
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // 已退出。
    }
  }
  await delay(800);
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // 已退出。
  }
  writeFileSync(path.join(outDir, 'product-stdout.log'), stdout);
  writeFileSync(path.join(outDir, 'product-stderr.log'), stderr);
}

if (failures.length > 0) process.exitCode = 1;
