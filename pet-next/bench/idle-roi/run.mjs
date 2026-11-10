#!/usr/bin/env node
/**
 * M3-12 D：可见待机三臂（O/F/C）资源对照 + 行为回归采集器。
 *
 * 用法（Linux + 真实 Electron，零真实模型请求）：
 *   自检（只 O，证明工具可用）：
 *     node bench/idle-roi/run.mjs --mode=selfcheck --seconds=60 --display=:154
 *   完整三臂（画质门通过后，负责人确认其他 agent 停手再跑）：
 *     node bench/idle-roi/run.mjs --plan=O,F,C --reps=3 --seconds=60 --warmup=10 --display=:154
 *   行为回归（每臂 ≥10 次点击 + 拖动/隐藏恢复/失败占位/退出）：
 *     node bench/idle-roi/run.mjs --mode=behavior --plan=O,F,C --seconds=0 --probe=click,drag,hidden,failure
 *   只复算已有目录：
 *     node bench/idle-roi/run.mjs --mode=analyze --run=bench/idle-roi/runs/<stamp>
 *
 * 三臂同 URL/env：都走 `electron dist/electron/main.js`（无聊天、无 SSH），
 * 唯一差别是产品已有的 `PET_NEXT_IDLE_URL`（electron/main.ts:248）指向的 idle 文件。
 * 交替顺序：rep 偶数按 --plan，奇数按反向（O,F,C → C,F,O），得到 O→F→C→C→F→O。
 *
 * 产物：bench/idle-roi/runs/<stamp>/raw.ndjson（每行一个 1s 样本）
 *       bench/idle-roi/runs/<stamp>/summary.json（每臂聚合、配对、判定、loadavg）
 *       bench/idle-roi/runs/<stamp>/arms/<arm>-r<rep>/{product-stdout.log,product-stderr.log,probes.json}
 *
 * 口径：CPU 是归属进程树 utime+stime 差；RSS 是进程 RSS 求和（共享页重复计），
 * PSS 来自 smaps_rollup；真实解码帧取 `getVideoPlaybackQuality().totalVideoFrames`。
 * 所有 CPU 数值必须连 loadavg 一起读——本机 1 核且外部评测常把 load 拉到 10+。
 * @module pet-next/bench/idle-roi/run
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { connectCdp, delay, freePort, waitForPageSocket } from './lib/cdp.mjs';
import { loadManifest, resolveArmSource, resolveAssetsDir, stageCommittedAssets, verifyLayout } from './lib/artifacts.mjs';
import { probeClicks, probeDrag, probeExit, probeHidden } from './lib/probes.mjs';
import {
  findProcessesMatching,
  readHostCpu,
  readLoadavg,
  sampleTree,
} from './lib/proc.mjs';
import {
  electronPreflight,
  ensureBuild,
  ensureDisplay,
  findMainPid,
  findWindow,
  launchProduct,
  loadavgText,
  petRoot,
  petRootSource,
  sha256,
  sleep,
  WINDOW,
  windowGeometry,
  xdo,
} from './lib/session.mjs';
import { median, pairDrops, summarizeArm, verdict } from './lib/stats.mjs';

const rawArgs = process.argv.slice(2);
const value = (name, fallback) => {
  const hit = rawArgs.find((item) => item.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const has = (name) => rawArgs.some((item) => item === `--${name}` || item.startsWith(`--${name}=`));

if (process.platform !== 'linux') {
  console.error('bench/idle-roi 只用 /proc + X11 读数，需要 Linux。');
  process.exit(2);
}
if (process.env.NODE_OPTIONS !== undefined) {
  console.error('先清 NODE_OPTIONS：env -u NODE_OPTIONS node bench/idle-roi/run.mjs ...');
  process.exit(2);
}

const mode = value('mode', 'perf');
if (!['perf', 'behavior', 'selfcheck', 'analyze'].includes(mode)) {
  console.error('--mode 必须是 perf | behavior | selfcheck | analyze');
  process.exit(2);
}
const display = value('display', ':154');
if (display !== ':154') {
  console.error('本任务固定显示号 :154（他人的 :131/:144/:145 不许用）。');
  process.exit(2);
}
const seconds = Number(value('seconds', '60'));
const warmupSec = Number(value('warmup', mode === 'selfcheck' ? '8' : '10'));
const reps = Number(value('reps', mode === 'selfcheck' ? '1' : '3'));
let stamp = value('stamp', new Date().toISOString().replace(/[:.]/g, '-'));
const probesRequested = new Set(value('probe', '').split(',').filter(Boolean));
const clickCount = Number(value('clicks', '12'));
const overrides = { src: value('src', ''), fSrc: value('f-src', ''), cSrc: value('c-src', '') };
const allowMissing = has('allow-missing');

/** 证据永远写在工具所在目录（被测产品根可能是另一份已提交源码）。 */
const resultsRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
let outDir = path.join(resultsRoot, 'runs', stamp);
let armsDir = path.join(outDir, 'arms');
let rawPath = path.join(outDir, 'raw.ndjson');
let summaryPath = path.join(outDir, 'summary.json');
const lockPath = path.join(resultsRoot, 'runs/.lock');

const failures = [];
const notRun = [];
const cleanupHooks = [];
let cleaned = false;
let xvfbOwned = false;
let build = { built: false, reason: 'pending' };

function recordFailure(message) {
  failures.push(message);
  console.error(`[idle-roi] 失败：${message}`);
}

function cleanupAll() {
  if (cleaned) return;
  cleaned = true;
  for (const hook of cleanupHooks.reverse()) {
    try {
      hook();
    } catch {
      /* 收尾失败不掩盖主结果 */
    }
  }
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    cleanupAll();
    process.exit(143);
  });
}

function acquireLock() {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    const owner = Number(readFileSync(lockPath, 'utf8').trim().split('\n')[0]);
    let alive = false;
    if (Number.isFinite(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) throw new Error(`另一个 bench 正在跑（pid ${owner}）；本机单核必须串行。锁：${lockPath}`);
  }
  writeFileSync(lockPath, `${process.pid}\n${outDir}\n`);
  cleanupHooks.push(() => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* 已被清理 */
    }
  });
}

const mb = (bytes) => (typeof bytes === 'number' ? Math.round((bytes / 1024 / 1024) * 10) / 10 : null);
const round = (value2, digits = 3) =>
  typeof value2 === 'number' && Number.isFinite(value2) ? Math.round(value2 * 10 ** digits) / 10 ** digits : null;

async function snapshot(cdp, timeoutMs = 4000) {
  try {
    return await cdp.evaluate('window.__idleRoi ? window.__idleRoi.snapshot() : null', timeoutMs);
  } catch {
    return null;
  }
}

async function injectObserver(cdp) {
  const text = readFileSync(path.join(petRoot, 'bench/idle-roi/lib/observe.js'), 'utf8');
  const applied = await cdp.evaluate(text);
  if (applied !== 'ok' && applied !== 'already') recordFailure(`注入 observe.js 返回 ${String(applied)}`);
}

/** 从产品 stdout 里找最后一条 `{"event":"ready",...}`（窗口/透明/边界证据）。 */
function parseReadyEvent(stdout) {
  if (!stdout) return null;
  let found = null;
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const event = JSON.parse(text);
      if (event.event === 'ready') found = event;
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
  return found;
}

/** 当前正在播放的 idle 视频（按 src 短名匹配，避免把 reaction 的帧算进 idle）。 */
function idleVideoOf(page, idleBase) {
  if (!page) return null;
  const matched = page.videos.find((video) => video.src === idleBase && video.readyState >= 1);
  return matched ?? page.videos.find((video) => !video.paused) ?? page.videos[0] ?? null;
}

/**
 * 跑一支臂：启动→预热→采样→探针→退出。返回该臂结果（失败也返回，留证据）。
 */
async function runArm(context, { arm, rep }) {
  const tag = `${arm}-r${rep}`;
  const armDir = path.join(armsDir, tag);
  mkdirSync(armDir, { recursive: true });
  const userDataDir = path.join(armDir, 'user-data');
  mkdirSync(userDataDir, { recursive: true });
  const source = context.sources[arm];
  const idleBase = source.path ? path.basename(source.path) : `${arm}.webm`;
  const result = {
    arm,
    rep,
    tag,
    idleSource: source,
    startedAt: new Date().toISOString(),
    loadavgStart: readLoadavg(),
    failures: [],
    notRun: [],
    samples: [],
    probes: {},
    layout: null,
    exit: null,
    leftovers: [],
  };
  const armFail = (message) => {
    result.failures.push(message);
    recordFailure(`${tag}: ${message}`);
  };

  if (!source.exists) {
    armFail(`素材不存在：${source.path ?? '(未解析到路径)'}`);
    result.notRun.push('source-missing');
    return result;
  }
  if (source.shaMatched === false) {
    armFail(`素材 SHA 与 manifest 不符：实际 ${source.sha256}，期望 ${source.expectedSha}`);
    result.notRun.push('sha-mismatch');
    return result;
  }

  const debugPort = await freePort();
  const product = launchProduct({
    display,
    userDataDir,
    debugPort,
    idleUrl: pathToFileURL(source.path).href,
    reactionUrl: context.reactionUrl ? pathToFileURL(context.reactionUrl).href : null,
    roiLayout: context.roiLayout,
    roiManifest: context.manifestInfo?.found ? context.manifestInfo.path : null,
    logTag: tag,
  });
  cleanupHooks.push(() => product.kill());
  result.pid = product.child.pid;

  let cdp = null;
  try {
    const socket = await waitForPageSocket(debugPort, () => product.exitCode !== null, Date.now() + 150000);
    cdp = await connectCdp(socket);
    await injectObserver(cdp);
    result.pageAtMs = Date.now() - Date.parse(result.startedAt);

    const rootPid = (await waitMain(context, userDataDir, () => product.exitCode !== null)) ?? product.child.pid;
    result.rootPid = rootPid;

    // 等 idle 真正开始播放（readyState>=2 且 paused=false），最多 45s。
    const playDeadline = Date.now() + 45000;
    let page = null;
    while (Date.now() < playDeadline) {
      page = await snapshot(cdp);
      const video = idleVideoOf(page, idleBase);
      if (video && !video.paused && video.readyState >= 2) break;
      if (product.exitCode !== null) {
        armFail(`启动后提前退出 code=${product.exitCode}`);
        break;
      }
      await delay(250);
    }
    const firstVideo = idleVideoOf(page, idleBase);
    if (!firstVideo || firstVideo.readyState < 2) armFail('45s 内 idle 未进入可播放/播放状态');
    result.firstFrame = firstVideo
      ? { src: firstVideo.src, width: firstVideo.videoWidth, height: firstVideo.videoHeight, rect: firstVideo.rect }
      : null;
    // 主进程 ready 事件是“窗口真的起来了”的独立证据（stdout 单行 JSON）。
    result.readyEvent = parseReadyEvent(product.stdout());
    if (result.readyEvent === null) armFail('stdout 里没有读到 {event:"ready"}');

    // 布局核对：只有 C 需要 ROI；F/O 只记录实际 rect 供比对。
    if (context.manifest) {
      result.layout = verifyLayout(page, context.manifest, { expectRoi: arm === 'C' });
      const layoutDigest = result.layout.checked
        ? `rect=${JSON.stringify(result.layout.rect)} expected=${JSON.stringify(result.layout.expected)} objectFit=${String(result.layout.objectFit)} bodyIdleRoi=${String(result.layout.bodyIdleRoiClass)}`
        : String(result.layout.reason ?? 'unchecked');
      if (arm === 'C' && result.layout.checked && !result.layout.roiLayoutWired) {
        result.notRun.push('roi-layout-not-wired');
        recordFailure(`${tag}: C 的 ROI 布局未生效（${layoutDigest}）；该臂 CPU 数据不能当作采用收益`);
      }
      if (arm === 'C' && !result.layout.checked) {
        result.notRun.push('roi-layout-unchecked');
        recordFailure(`${tag}: C 的 ROI 布局无法核对（没有视频快照或 manifest 无效）`);
      }
      if (arm === 'C' && result.layout.checked && result.layout.bodyIdleRoiClass === false) {
        recordFailure(`${tag}: body.idle-roi 类缺失——页面没有进入 ROI 稳态，不能当接线成功`);
      }
      if (arm !== 'C' && result.layout.checked && result.layout.layoutMatches === false) {
        recordFailure(`${tag}: ${arm} 的 contain 基线不符（${layoutDigest}），该臂不能与后续 C 直接比较`);
      }
    }

    // 预热段单列（phase=warmup，不进 summary 的 measure 聚合）。
    let prev = sampleTree(rootPid);
    let prevAt = Date.now();
    let prevHost = readHostCpu();
    let prevDecoded = idleVideoOf(await snapshot(cdp), idleBase)?.totalVideoFrames ?? null;
    const totalTicks = Math.max(0, Number(seconds) + Number(warmupSec));
    let lastPage = page;
    for (let index = 1; index <= totalTicks; index += 1) {
      await sleep(1000);
      if (product.exitCode !== null) {
        armFail(`采样中产品退出 code=${product.exitCode}`);
        break;
      }
      const now = sampleTree(rootPid);
      const at = Date.now();
      const wallMs = Math.max(1, at - prevAt);
      const host = readHostCpu();
      const pageNow = await snapshot(cdp);
      if (pageNow) lastPage = pageNow;
      const video = idleVideoOf(lastPage, idleBase);
      const decoded = video?.totalVideoFrames ?? null;
      const decodedDelta = decoded !== null && prevDecoded !== null && decoded >= prevDecoded ? decoded - prevDecoded : null;
      const roles = {};
      for (const [role, data] of Object.entries(now.roles)) {
        const before = prev.roles[role] ?? { cpuTicks: 0, rssBytes: 0, pssBytes: 0, pids: 0 };
        roles[role] = {
          cpuSeconds: round(Math.max(0, data.cpuTicks - before.cpuTicks) / 100, 3),
          rssMb: mb(data.rssBytes),
          pssMb: mb(data.pssBytes),
          pids: data.pids,
        };
      }
      const deltaTicks = Math.max(0, now.total.cpuTicks - prev.total.cpuTicks);
      const hostBusy =
        host && prevHost && host.totalTicks > prevHost.totalTicks
          ? round(
              ((host.totalTicks - prevHost.totalTicks - (host.idleTicks - prevHost.idleTicks)) /
                (host.totalTicks - prevHost.totalTicks)) *
                100,
              1,
            )
          : null;
      const sample = {
        stamp,
        arm,
        rep,
        phase: index <= warmupSec ? 'warmup' : 'measure',
        sourceSha256: source.sha256,
        t: index,
        at,
        wallMs,
        cpu: {
          seconds: round(deltaTicks / 100, 3),
          percent: round((deltaTicks / 100 / (wallMs / 1000)) * 100, 1),
        },
        roles,
        rss: { sumBytes: now.total.rssBytes, pssBytes: now.total.pssBytes, pids: now.total.pids },
        loadavg: readLoadavg(),
        host: { busyPercent: hostBusy },
        frames: {
          idleSrc: video?.src ?? null,
          decodedTotal: decoded,
          decodedDelta,
          bySrc: pageNow?.bySrc ?? null,
          rVfcTotal: pageNow?.frames ?? null,
        },
        video: video
          ? { width: video.videoWidth, height: video.videoHeight, rect: video.rect, currentTime: video.currentTime }
          : null,
        page: pageNow
          ? { visibility: pageNow.visibility, visual: pageNow.visual, request: pageNow.request, viewport: pageNow.viewport }
          : null,
      };
      appendFileSync(rawPath, `${JSON.stringify(sample)}\n`);
      result.samples.push(sample);
      prev = now;
      prevAt = at;
      prevHost = host;
      prevDecoded = decoded;
    }
    result.wallSec = round(result.samples.reduce((sum, sample) => sum + sample.wallMs, 0) / 1000, 3);

    // ---- 探针（采样窗之外；不给 CPU 数据加负载） ----
    const windowId = findWindow(display, rootPid);
    const reactionBase = context.reactionUrl ? path.basename(context.reactionUrl).replace(/\.webm$/i, '') : 'reaction';
    if (probesRequested.has('click') || mode === 'behavior') {
      result.probes.click = await probeClicks({
        cdp,
        count: clickCount,
        reactionHint: reactionBase,
        idleHint: idleBase.replace(/\.webm$/i, ''),
      });
      if (result.probes.click.missed > 0) armFail(`点击探针漏回应 ${result.probes.click.missed}/${result.probes.click.requested}`);
    }
    if (probesRequested.has('drag')) {
      result.probes.drag = await probeDrag({
        cdp,
        geometry: () => (windowId === null ? null : windowGeometry(display, windowId)),
      });
      if (result.probes.drag.before && result.probes.drag.after && !result.probes.drag.moved) {
        armFail('拖动探针：窗口位置未变化');
      }
    }
    if (probesRequested.has('hidden')) {
      if (windowId === null) {
        result.notRun.push('hidden-probe-window-not-found');
        armFail('隐藏探针：找不到产品窗');
      } else {
        result.probes.hidden = await probeHidden({
          cdp,
          idleHint: idleBase.replace(/\.webm$/i, ''),
          unmap: () => xdo(display, ['windowunmap', windowId]),
          map: () => xdo(display, ['windowmap', windowId]),
        });
        if (result.probes.hidden.resumeFirstIdleFrameMs === null) armFail('隐藏恢复后 8s 内没有新的 idle 呈帧');
      }
    }
    if (probesRequested.has('failure')) {
      result.probes.failure = await runMissingIdleProbe({ arm, rep, source, display, armDir, context });
      if (result.probes.failure.placeholderVisible !== true) armFail('失败占位探针：placeholder 未显示');
    }

    // ---- 退出（产品既有 Escape 键），并查残留 ----
    result.probes.exit = await probeExit({
      cdp,
      exitCode: () => product.exitCode,
      signalCode: () => product.signalCode,
    });
    if (result.probes.exit.exitCode !== 0) armFail(`Escape 退出 code=${String(result.probes.exit.exitCode)}`);
  } catch (error) {
    armFail(String(error?.message ?? error));
  } finally {
    cdp?.close();
    product.kill();
    await sleep(400);
    result.leftovers = findProcessesMatching(userDataDir);
    if (result.leftovers.length > 0) armFail(`退出后残留 ${result.leftovers.length} 个进程`);
    result.stdout = product.stdout();
    result.stderr = product.stderr();
    writeFileSync(path.join(armDir, 'product-stdout.log'), result.stdout);
    writeFileSync(path.join(armDir, 'product-stderr.log'), result.stderr);
    writeFileSync(path.join(armDir, 'probes.json'), JSON.stringify(result.probes, null, 2));
  }

  result.summary = summarizeArm(result.samples);
  result.loadavgEnd = readLoadavg();
  result.finishedAt = new Date().toISOString();
  return result;
}

async function waitMain(context, marker, isDead) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const pid = findMainPid(marker);
    if (pid !== null) return pid;
    if (isDead()) return null;
    await delay(250);
  }
  return null;
}

/**
 * 失败占位探针：复制一份 idle 副本 → 删掉副本 → 用该路径启动产品。
 * 观察产品既有失败语义（placeholder 显示、不崩），不改任何开关。
 */
async function runMissingIdleProbe({ arm, rep, source, armDir, context }) {
  const probeCopy = path.join(armDir, `idle-missing-${arm}-${rep}.webm`);
  const debugPort = await freePort();
  const userDataDir = path.join(armDir, 'user-data-failure');
  mkdirSync(userDataDir, { recursive: true });
  let product = null;
  let cdp = null;
  try {
    copyFileSync(source.path, probeCopy);
    const copiedSha = sha256(probeCopy);
    unlinkSync(probeCopy);
    product = launchProduct({
      display,
      userDataDir,
      debugPort,
      idleUrl: pathToFileURL(probeCopy).href,
      reactionUrl: context.reactionUrl ? pathToFileURL(context.reactionUrl).href : null,
      roiLayout: context.roiLayout,
      roiManifest: context.manifestInfo?.found ? context.manifestInfo.path : null,
      logTag: `${arm}-failure`,
    });
    const socket = await waitForPageSocket(debugPort, () => product.exitCode !== null, Date.now() + 60000);
    cdp = await connectCdp(socket);
    await injectObserver(cdp);
    await delay(2500);
    let page = await snapshot(cdp);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      page = await snapshot(cdp);
      if (page && page.visual === 'placeholder') break;
      await delay(200);
    }
    const idleVideo = page?.videos.find((video) => video.id === 'clip') ?? null;
    return {
      copiedSha,
      copyDeleted: !existsSync(probeCopy),
      visibility: page?.visibility ?? null,
      visual: page?.visual ?? null,
      placeholderVisible: page?.visual === 'placeholder',
      idleVideoHidden: idleVideo?.hidden ?? null,
      idleVideoPaused: idleVideo?.paused ?? null,
      idleVideoSrc: idleVideo?.src ?? null,
    };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  } finally {
    cdp?.close();
    product?.kill();
    await sleep(300);
  }
}

function gitOut(args) {
  try {
    return execFileSync('git', args, { cwd: petRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

function electronVersion() {
  try {
    return JSON.parse(readFileSync(path.join(petRoot, 'node_modules/electron/package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

/** 从 raw.ndjson 复算 summary（analyze 模式与正常结束共用）。 */
async function writeSummary(context, armResults) {
  const perArm = {};
  for (const arm of ['O', 'F', 'C']) {
    const runs = armResults.filter((entry) => entry.arm === arm);
    if (runs.length === 0) continue;
    const cpu = runs.map((entry) => entry.summary.cpuSecondsPerMinute).filter((item) => typeof item === 'number');
    const rss = runs.map((entry) => entry.summary.rssSumMbMedian).filter((item) => typeof item === 'number');
    const load = runs.map((entry) => entry.summary.loadavg1Median).filter((item) => typeof item === 'number');
    perArm[arm] = {
      reps: runs.length,
      cpuSecondsPerMinuteMedian: median(cpu),
      cpuSecondsPerMinuteValues: cpu,
      rssSumMbMedian: median(rss),
      rssSumMbValues: rss,
      loadavg1Median: median(load),
      loadavg1Values: load,
    };
  }
  const pairs = pairDrops(armResults.filter((entry) => entry.summary));
  const gate = verdict({ perArm, pairs });
  const cRuns = armResults.filter((entry) => entry.arm === 'C');
  if (cRuns.length > 0 && cRuns.every((entry) => entry.notRun.includes('roi-layout-not-wired'))) {
    gate.pass = false;
    gate.reasons.push('C 的 ROI 布局未接线（products 仍按 contain 全窗口铺满），C 只是“裁过的文件”，不是采用候选');
  }
  if (mode === 'selfcheck') {
    gate.pass = false;
    gate.reasons.push('自检模式（只有 O 臂）：不含任何 O/F/C 对照结论');
  }

  const summary = {
    schemaVersion: 1,
    task: 'M3-12-D',
    kind: 'idle-roi-bench',
    stamp,
    mode,
    generatedAt: new Date().toISOString(),
    command: `node bench/idle-roi/run.mjs ${rawArgs.join(' ')}`,
    host: os.hostname(),
    platform: `${process.platform} ${os.release()} ${os.arch()}`,
    cpus: os.cpus().length,
    node: process.version,
    electron: electronVersion(),
    electronPreflight: context.preflight?.version ?? null,
    head: gitOut(['rev-parse', 'HEAD']),
    branch: gitOut(['rev-parse', '--abbrev-ref', 'HEAD']),
    productRoot: petRoot,
    productRootSource: petRootSource,
    productRef: context.productRef ?? null,
    dirtyFiles: gitOut(['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean).length,
    productDirtyFiles: gitOut([
      'status',
      '--porcelain',
      '--untracked-files=no',
      '--',
      'app',
      'electron',
      'core',
      'adapters',
      'contracts',
      'scripts',
      'package.json',
    ]).split('\n').filter(Boolean).length,
    dirtyNote: 'dirtyFiles=已跟踪文件改动数（含本 bench 工具自身）；productDirtyFiles 只算 app/electron/core/adapters/contracts/scripts/package.json，应为 0',
    display,
    xvfbOwned,
    window: WINDOW,
    plan: context.order,
    seconds,
    warmupSec,
    build,
    loadavg: {
      start: context.loadavgStart,
      end: readLoadavg(),
      note: '本机 1 核共享；外部 eval 常把 load 拉到 10+，所有 CPU 数值必须与 loadavg 同时解读',
    },
    manifest: {
      path: context.manifestInfo.path,
      found: context.manifestInfo.found,
      error: context.manifestInfo.error,
      sourceSha256: context.manifestInfo.manifest?.sourceSha256 ?? null,
      candidateSha256: context.manifestInfo.manifest?.candidateSha256 ?? null,
      crop: context.manifestInfo.manifest?.crop ?? null,
      originalCanvas: context.manifestInfo.manifest?.originalCanvas ?? null,
      frameCount: context.manifestInfo.manifest?.frameCount ?? null,
    },
    reaction: context.reactionUrl
      ? { path: context.reactionUrl, sha256: sha256(context.reactionUrl) }
      : { path: null, sha256: null, note: '未指定，产品用默认 reaction.webm' },
    sources: context.sources,
    arms: armResults.map((entry) => ({
      arm: entry.arm,
      rep: entry.rep,
      tag: entry.tag,
      idleSource: entry.idleSource,
      pid: entry.pid ?? null,
      wallSec: entry.wallSec ?? null,
      readyEvent: entry.readyEvent ?? null,
      layout: entry.layout,
      summary: entry.summary,
      probes: entry.probes,
      exit: entry.probes?.exit ?? null,
      leftovers: entry.leftovers ?? [],
      failures: entry.failures,
      notRun: entry.notRun,
      stdoutTail: (entry.stdout ?? '').split('\n').slice(-30).join('\n'),
    })),
    perArm,
    pairs,
    verdict: gate,
    rawNdjson: rawPath,
    failures,
    notRun,
    roiWiring: {
      enabledByFlag: context.roiLayout === true,
      productSupportsWiring: context.productSupportsRoiWiring ?? null,
      env: context.roiLayout
        ? {
            PET_NEXT_IDLE_ROI: '1',
            PET_NEXT_IDLE_ROI_MANIFEST: context.manifestInfo?.path ?? null,
          }
        : null,
    },
    provenance: {
      assetArchive: context.archive ?? null,
      assetsDir: context.assetsDir ?? null,
      oSourceSha256: context.sources.O?.sha256 ?? null,
      fSourceSha256: context.sources.F?.sha256 ?? null,
      cSourceSha256: context.sources.C?.sha256 ?? null,
      oMatchesShipped: context.sources.O?.matchesShipped ?? null,
      note: '数据来自以上 SHA 的已提交字节；未提交工作区快照不作为结论依据',
    },
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  return summary;
}

function readRawSamples(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function requireArms(planArms, sources) {
  const missing = [];
  for (const arm of planArms) {
    const source = sources[arm];
    if (!source.exists) missing.push(`${arm}:${source.path ?? '(no path)'}`);
    else if (source.shaMatched === false) missing.push(`${arm}:sha-mismatch(${source.sha256} != ${source.expectedSha})`);
  }
  return missing;
}

async function main() {
  if (mode === 'analyze') {
    const runDir = value('run', '');
    if (runDir === '') {
      console.error('--mode=analyze 需要 --run=bench/idle-roi/runs/<stamp>');
      process.exit(2);
    }
    const dir = path.isAbsolute(runDir) ? runDir : path.join(petRoot, runDir);
    if (!existsSync(path.join(dir, 'raw.ndjson'))) {
      console.error(`没有 raw.ndjson：${dir}`);
      process.exit(2);
    }
    outDir = dir;
    armsDir = path.join(dir, 'arms');
    rawPath = path.join(dir, 'raw.ndjson');
    // 复算不覆盖原始 summary（探针/日志摘要只在首次运行里），另存一份。
    summaryPath = path.join(dir, 'summary.recomputed.json');
    stamp = path.basename(dir);
    const summaryRaw = existsSync(path.join(dir, 'summary.json')) ? JSON.parse(readFileSync(path.join(dir, 'summary.json'), 'utf8')) : null;
    const samples = readRawSamples(path.join(dir, 'raw.ndjson'));
    const armResults = [];
    const byKey = new Map();
    for (const sample of samples) {
      const key = `${sample.arm}#${sample.rep}`;
      if (!byKey.has(key)) {
        byKey.set(key, { arm: sample.arm, rep: sample.rep, tag: `${sample.arm}-r${sample.rep}`, samples: [], probes: {}, failures: [], notRun: [] });
        armResults.push(byKey.get(key));
      }
      byKey.get(key).samples.push(sample);
    }
    for (const entry of armResults) entry.summary = summarizeArm(entry.samples);
    const localManifest = loadManifest(
      summaryRaw?.manifest?.found && summaryRaw?.manifest?.path ? summaryRaw.manifest.path : undefined,
    );
    const context = {
      manifestInfo: localManifest,
      sources: summaryRaw?.sources ?? {},
      manifest: localManifest.manifest,
      archive: null,
      assetsDir: summaryRaw?.provenance?.assetsDir ?? null,
      productSupportsRoiWiring: summaryRaw?.roiWiring?.productSupportsWiring ?? null,
      reactionUrl: summaryRaw?.reaction?.path ?? null,
      order: summaryRaw?.plan ?? [],
      preflight: { version: summaryRaw?.electronPreflight ?? null },
      loadavgStart: summaryRaw?.loadavg?.start ?? null,
      roiLayout: summaryRaw?.roiWiring?.enabledByFlag ?? false,
    };
    const summary = await writeSummary(context, armResults);
    console.log(summaryPath);
    console.log(JSON.stringify({ perArm: summary.perArm, verdict: summary.verdict }, null, 2));
    return;
  }

  mkdirSync(armsDir, { recursive: true });
  acquireLock();

  const xvfb = await ensureDisplay(display);
  xvfbOwned = xvfb.owned;
  cleanupHooks.push(() => {
    if (!xvfb.owned) return;
    try {
      process.kill(-xvfb.child.pid, 'SIGKILL');
    } catch {
      try {
        xvfb.child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  });

  build = ensureBuild();
  printStatus(`build=${build.built ? `yes(${build.ms}ms)` : build.reason}`);
  const preflight = electronPreflight();
  printStatus(`electron=${preflight.version} attempts=${preflight.attempt ?? preflight.attempts ?? '?'}`);

  // 素材只认已提交字节：--assets-ref=<ref> 用 git archive 抽到 runs/<stamp>/assets-committed，
  // 不读任何人的未提交工作区；--assets-dir 用于直接给出已解出的 out 目录。
  const assetsRef = value('assets-ref', '');
  const assetsRepo = value('assets-repo', path.resolve(petRoot, '..'));
  const assetsDirArg = value('assets-dir', '');
  let archive = null;
  let assetsDir = null;
  if (assetsDirArg !== '') {
    assetsDir = resolveAssetsDir(path.resolve(assetsDirArg));
  } else if (assetsRef !== '') {
    const dest = path.join(outDir, 'assets-committed');
    archive = stageCommittedAssets({ repo: assetsRepo, ref: assetsRef, dest });
    printStatus(`assets-ref=${assetsRef} -> ${archive.ok ? dest : `失败：${archive.error}`}`);
    if (!archive.ok) {
      console.error(`git archive 取已提交素材失败：${archive.command}\n${archive.error}`);
      cleanupAll();
      process.exit(4);
    }
    assetsDir = resolveAssetsDir(dest);
  }
  const manifestInfo = loadManifest(assetsDir ? path.join(assetsDir, 'manifest.json') : undefined);
  const manifest = manifestInfo.manifest;
  const sources = {
    O: resolveArmSource('O', overrides, manifest, assetsDir),
    F: resolveArmSource('F', overrides, manifest, assetsDir),
    C: resolveArmSource('C', overrides, manifest, assetsDir),
  };
  // 阶段一自检只跑 O；A 的产物缺失时默认硬失败，不静默只跑 O。
  const requestedArms = mode === 'selfcheck' ? ['O'] : value('plan', 'O,F,C').split(',').map((item) => item.trim()).filter(Boolean);
  for (const arm of requestedArms) {
    if (!['O', 'F', 'C'].includes(arm)) {
      console.error(`--plan 里有未知臂 ${arm}`);
      process.exit(2);
    }
  }
  const missing = requireArms(requestedArms, sources);
  if (missing.length > 0 && !allowMissing) {
    console.error(`素材前置不满足：${missing.join(' | ')}`);
    console.error('A 的产物未落地时先只跑自检：--mode=selfcheck；或显式 --allow-missing（结果会标 notRun）。');
    cleanupAll();
    process.exit(4);
  }
  if (missing.length > 0) notRun.push(`missing-artifacts: ${missing.join(' | ')}`);
  // C 的布局接线（负责人 830b7cb + 9dc035e）：--roi-layout=on 会设
  // PET_NEXT_IDLE_ROI=1 + PET_NEXT_IDLE_ROI_MANIFEST=<staged>/manifest.json。
  const roiLayout = value('roi-layout', 'off') !== 'off';
  let productSupportsRoiWiring = null;
  if (roiLayout) {
    let mainJs;
    try {
      mainJs = readFileSync(path.join(petRoot, 'dist/electron/main.js'), 'utf8');
    } catch {
      mainJs = '';
    }
    productSupportsRoiWiring = mainJs.includes('PET_NEXT_IDLE_ROI_MANIFEST');
    if (!productSupportsRoiWiring) {
      console.error(
        '当前 dist 不含 ROI 接线（找不到 PET_NEXT_IDLE_ROI_MANIFEST）：产品建自本 worktree 的 dfeca20。\n' +
          '阶段二若要在 C 上用几何接线，先用含 830b7cb/9dc035e 的已提交源码构建（或让负责人给出该提交的 worktree），再重跑。',
      );
      cleanupAll();
      process.exit(4);
    }
    if (!manifestInfo.found) {
      console.error('--roi-layout=on 需要有效 manifest；当前 manifest 不存在。');
      cleanupAll();
      process.exit(4);
    }
    notRun.push('roi-layout-on-by-flag');
  }

  const reactionOverride = value('reaction', '');
  const reactionUrl = reactionOverride === '' ? path.join(petRoot, 'assets/reaction.webm') : path.resolve(reactionOverride);

  const order = [];
  for (let rep = 0; rep < reps; rep += 1) {
    const arms = rep % 2 === 0 ? requestedArms : [...requestedArms].reverse();
    for (const arm of arms) order.push({ arm, rep });
  }

  const context = {
    sources,
    manifest,
    manifestInfo,
    archive,
    assetsDir,
    productRef: value('product-ref', ''),
    productSupportsRoiWiring,
    reactionUrl,
    roiLayout,
    preflight,
    order: order.map((item) => `${item.arm}#${item.rep}`),
    loadavgStart: readLoadavg(),
  };

  const armResults = [];
  for (const [index, item] of order.entries()) {
    printStatus(`arm ${index + 1}/${order.length} ${item.arm} rep=${item.rep} loadavg=${loadavgText()}`);
    const result = await runArm(context, item);
    armResults.push(result);
    if (result.summary) {
      printStatus(
        `  cpu=${result.summary.cpuSecondsPerMinute} s/min (median ${result.summary.cpuPercentMedian}%) rss=${result.summary.rssSumMbMedian}MB fps=${result.summary.decodedFps} failures=${result.failures.length}`,
      );
    }
  }

  cleanupAll();
  const summary = await writeSummary(context, armResults);
  console.log(summaryPath);
  console.log(
    JSON.stringify(
      {
        stamp,
        perArm: summary.perArm,
        verdict: summary.verdict,
        failures: summary.failures,
        notRun: summary.notRun,
        loadavg: summary.loadavg,
      },
      null,
      2,
    ),
  );
  const hardFail = summary.failures.length > 0 && mode !== 'selfcheck';
  if (hardFail) process.exitCode = 1;
}

function printStatus(message) {
  console.log(`[idle-roi] ${message}`);
}

await main();
