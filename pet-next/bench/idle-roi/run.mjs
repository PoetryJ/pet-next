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
// resolveAssetsDir 已由 lib/gate.mjs 交叉核对时调用，这里不再直接用。
import { loadManifest, resolveArmSource, stageCommittedAssets, verifyLayout } from './lib/artifacts.mjs';
import { ARM_ALIASES, QUALITY_REPORT_REL, evaluateStageGate, readQualityReport } from './lib/gate.mjs';
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
if (!['perf', 'behavior', 'selfcheck', 'preflight', 'analyze'].includes(mode)) {
  console.error('--mode 必须是 perf | behavior | selfcheck | preflight | analyze');
  process.exit(2);
}
// M3-12 R1：本 worktree 用 :157；:154 仅保留给上一轮已归档证据，其他显示号一律拒绝。
const ALLOWED_DISPLAYS = [':157', ':154'];
const display = value('display', ':157');
if (!ALLOWED_DISPLAYS.includes(display)) {
  console.error(`显示号只能是 ${ALLOWED_DISPLAYS.join(' / ')}（他人的 :131/:144/:145 不许用）。`);
  process.exit(2);
}
const seconds = Number(value('seconds', '60'));
const warmupSec = Number(value('warmup', mode === 'selfcheck' ? '8' : '10'));
const reps = Number(value('reps', mode === 'selfcheck' ? '1' : '3'));
let stamp = value('stamp', new Date().toISOString().replace(/[:.]/g, '-'));
const probesRequested = new Set(value('probe', '').split(',').filter(Boolean));
const clickCount = Number(value('clicks', '12'));
// 阶段门的"反放行"硬规则：任何能让本次采集绕过机器门的开关都直接拒绝（退出 2）。
// 门在 lib/gate.mjs：素材目录 + quality-report.json 的 verdict.status + 三个素材 SHA。
const FORBIDDEN_FLAGS = ['force', 'skip-gate', 'allow-missing'];
if (mode !== 'analyze') {
  const usedForbidden = FORBIDDEN_FLAGS.filter((name) => has(name));
  if (usedForbidden.length > 0) {
    console.error(
      `本轮禁止绕过阶段门：${usedForbidden.map((name) => `--${name}`).join(' ')}（放行只看 report 的 verdict.status 与素材 SHA，无人工记忆开关）`,
    );
    process.exit(2);
  }
  const usedOverrides = ['src', 'f-src', 'c-src'].filter((name) => value(name, '') !== '');
  if (usedOverrides.length > 0) {
    console.error(
      `本轮禁止 ${usedOverrides.map((name) => `--${name}`).join(' ')}：臂素材只能来自 --assets-ref 的已提交 subpath，并被质量报告 SHA 钉住。`,
    );
    process.exit(2);
  }
}

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
    label: context.armLabels?.[arm] ?? arm,
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
    roiEnvApplied: {
      enabled: context.roiLayout === true && arm === 'C',
      env: context.roiLayout === true && arm === 'C'
        ? {
            PET_NEXT_IDLE_ROI: '1',
            PET_NEXT_IDLE_ROI_MANIFEST: context.manifestInfo?.path ?? null,
          }
        : null,
    },
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
    // 关键：只有 C 臂注入 ROI。O/F 必须两个 env 都不存在——sha 门比对的是
    // assets/idle.webm，开着开关播 O 也会套上 ROI 盒，O 基线会“假失败”。
    roiLayout: context.roiLayout && arm === 'C',
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

    result.observedDpr = page?.viewport?.dpr ?? null;
    result.sourceShaVerified = source.expectedSha ? source.shaMatched === true : null;

    // C 的稳态前置：body.idle-roi 是 media.begin('idle') 之后才加的，但首个 idle
    // 要等加载兑现；固定 sleep 会把“还没到 idle”误记成“接线失败”。
    if (arm === 'C' && context.roiLayout) {
      const steadyDeadline = Date.now() + 15000;
      let steady = null;
      while (Date.now() < steadyDeadline) {
        page = (await snapshot(cdp)) ?? page;
        const clip = page?.videos.find((video) => video.id === 'clip') ?? null;
        if (page && page.bodyIdleRoi === true && clip && clip.hidden === false && clip.readyState >= 2) {
          steady = { bodyIdleRoi: true, clipHidden: false, readyState: clip.readyState, waitedMs: 15000 - (steadyDeadline - Date.now()) };
          break;
        }
        if (product.exitCode !== null) break;
        await delay(200);
      }
      result.steadyState = steady ?? { bodyIdleRoi: page?.bodyIdleRoi ?? null, clipHidden: page?.videos.find((video) => video.id === 'clip')?.hidden ?? null, timeout: true };
      if (steady === null) {
        result.notRun.push('roi-class-timeout');
        armFail(`${tag}: 15s 内未进入 idle-roi 稳态（body.idle-roi / #clip.hidden 未同时满足），与“接线错误”分开记录`);
      }
    }

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

    // 布局被否决时不烧 CPU：直接跳过采样，只留证据（C 的 CPU 不能当采用收益）。
    const canSample =
      !(arm === 'C' && result.layout?.checked && !result.layout.roiLayoutWired) && !result.notRun.includes('roi-class-timeout');
    if (!canSample) {
      result.notRun.push('sampling-skipped-layout-not-wired');
      printStatus(`${tag}: 布局/稳态未通过，跳过 ${Number(seconds) + Number(warmupSec)}s 采样`);
      result.summary = summarizeArm(result.samples);
      result.loadavgEnd = readLoadavg();
      result.finishedAt = new Date().toISOString();
      return result;
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
      // 失败占位用的是缺失的 idle 副本，与 ROI 无关；只有 C 臂保持与主跑一致的开关。
      roiLayout: context.roiLayout && arm === 'C',
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

/**
 * dist 侧 CSS 证据：`scripts/copy-static.mjs` 是原样 cp，所以
 * `dist/app/page.css` 的 SHA 必须等于源 `app/page.css` 的 SHA；不等就说明“没重建”，
 * 不能把旧 dist 的 object-fit 当成被测源码的真实值。
 */
function distCssEvidence() {
  const file = path.join(petRoot, 'dist/app/page.css');
  const source = path.join(petRoot, 'app/page.css');
  if (!existsSync(file)) return { exists: false, path: file };
  const text = readFileSync(file, 'utf8');
  const sourceText = existsSync(source) ? readFileSync(source, 'utf8') : null;
  const distSha = sha256(file);
  const sourceSha = sourceText === null ? null : sha256(source);
  const objectFitLines = [];
  const idleRoiLines = [];
  text.split('\n').forEach((line, index) => {
    if (line.includes('object-fit')) objectFitLines.push({ line: index + 1, text: line.trim() });
    if (line.includes('idle-roi')) idleRoiLines.push({ line: index + 1, text: line.trim() });
  });
  // 只看 computed style 不够：ROI 规则整块被删时，#clip 会退回默认 contain 而“碰巧通过”。
  // 这里在 CSS 文本层面查 ROI 规则是否存在、是否还有 object-fit:none。
  const roiBlock = /body\.idle-roi[^{]*\{[^}]*\}/.exec(text)?.[0] ?? null;
  const preflightWarnings = [];
  if (roiBlock === null) {
    preflightWarnings.push('dist CSS 里没有 body.idle-roi 规则块（dfeca20 基线正常；接线落地后应出现，届时仍缺即整块丢失）');
  }
  else if (!/object-fit\s*:\s*contain/.test(roiBlock)) {
    preflightWarnings.push(`body.idle-roi 规则没有 object-fit: contain：${roiBlock.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  const objectFitNoneLines = objectFitLines.filter((item) => /object-fit\s*:\s*none/.test(item.text));
  if (objectFitNoneLines.length > 0) {
    preflightWarnings.push(`dist CSS 仍有 object-fit: none（行 ${objectFitNoneLines.map((item) => item.line).join(',')}）`);
  }
  return {
    exists: true,
    path: file,
    sha256: distSha,
    sourcePath: source,
    sourceSha256: sourceSha,
    matchesSource: sourceSha === null ? null : distSha === sourceSha,
    objectFitLines,
    objectFitNoneLines,
    idleRoiLines: idleRoiLines.slice(0, 20),
    roiRulePresent: roiBlock !== null,
    roiRuleObjectFitContain: roiBlock !== null && /object-fit\s*:\s*contain/.test(roiBlock),
    preflightWarnings,
    note: 'copy-static 原样复制；matchesSource=false 说明 dist 未重建；roiRule* 是文本层预检，最终仍以运行时 computed style 为准',
  };
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
    armLabels: context.armLabels ?? null,
    // 阶段门判定（lib/gate.mjs 的原始证据）：报告路径/字节 SHA/verdict/gates/阈值/三臂 SHA 对照。
    qualityGate: context.stageGate
      ? {
          ok: context.stageGate.ok,
          code: context.stageGate.code,
          checkedAt: context.stageGate.evidence?.checkedAt ?? null,
          qualityReport: context.stageGate.evidence?.qualityReport ?? null,
          assetsDir: context.stageGate.evidence?.assetsDir ?? null,
          arms: context.stageGate.evidence?.arms ?? null,
          armShaClaims: context.stageGate.evidence?.armShaClaims ?? null,
        }
      : null,
    arms: armResults.map((entry) => ({
      arm: entry.arm,
      label: entry.label ?? entry.arm,
      rep: entry.rep,
      tag: entry.tag,
      idleSource: entry.idleSource,
      pid: entry.pid ?? null,
      wallSec: entry.wallSec ?? null,
      readyEvent: entry.readyEvent ?? null,
      roiEnvApplied: entry.roiEnvApplied ?? null,
      steadyState: entry.steadyState ?? null,
      observedDpr: entry.observedDpr ?? null,
      sourceShaVerified: entry.sourceShaVerified ?? null,
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

/** 本轮默认 subpath：B 的原生 YUVA 产物（O/F3/C3）。 */
const DEFAULT_ASSETS_SUBPATH = 'experiments/idle-roi/out-v3-yuva';

/**
 * 阶段门：在启动任何产品进程之前把"素材目录 + 质量报告 + 三臂 SHA"锁死。
 * 不通过就非零退出（2/4/5），并把判定写进 runs/<stamp>/gate.json 作为证据。
 * 返回 { archive, assetsDir, manifestInfo, manifest, sources, gate }。
 */
function runStageGate() {
  const assetsRef = value('assets-ref', '');
  const assetsRepo = value('assets-repo', path.resolve(petRoot, '..'));
  const assetsDirArg = value('assets-dir', '');
  const assetsSubpath = value('assets-subpath', DEFAULT_ASSETS_SUBPATH);
  const qualityReportArg = value('quality-report', '');
  const repo = path.dirname(petRoot);
  const strictReport = mode !== 'preflight';
  mkdirSync(outDir, { recursive: true });

  if (strictReport && qualityReportArg !== '') {
    console.error('--quality-report 只给 --mode=preflight 的负控/正控自检用；性能/行为采集只读仓内已提交的报告。');
    process.exit(2);
  }
  if (assetsRef === '' && assetsDirArg === '') {
    console.error('阶段门：必须给 --assets-ref=<已提交 ref>（推荐）或 --assets-dir=<本次 subpath 已解出的目录>。');
    console.error('  不再回退到工作区里的 experiments/：那既可能未提交，也可能选回上一次的 out。');
    process.exit(2);
  }

  let archive = null;
  let dest = null;
  let namingOnlyFailure = null;
  if (assetsRef !== '') {
    dest = path.join(outDir, 'assets-committed');
    archive = stageCommittedAssets({ repo: assetsRepo, ref: assetsRef, dest, subpath: assetsSubpath });
    printStatus(
      `assets-ref=${assetsRef}(${archive.commit ?? '?'}) subpath=${assetsSubpath} -> ${archive.ok ? archive.assetsDir ?? dest : `失败：${archive.error}`}`,
    );
    if (!archive.ok) {
      // A 的实现在候选名里只认 F.webm/C.webm；本轮臂叫 F3.webm/C3.webm 时它会报 missing-file，
      // 但字节已经解出来了。这种情况不当作"取素材失败"放行，而是交给阶段门逐臂按报告 SHA 核验；
      // 判定理由原样写进 gate.json（命名不符是我们自己的账，不藏）。
      const extractedDir = archive.assetsDir && existsSync(archive.assetsDir) ? archive.assetsDir : null;
      namingOnlyFailure = archive.code === 'missing-file' && extractedDir ? { code: archive.code, error: archive.error, assetsDir: extractedDir } : null;
      if (!namingOnlyFailure) {
        writeFileSync(
          path.join(outDir, 'gate.json'),
          JSON.stringify({ ok: false, stage: 'stage-committed-assets', code: archive.code ?? null, assetsRepo, assetsRef, assetsSubpath, command: archive.command, error: archive.error, checkedAt: new Date().toISOString() }, null, 2),
        );
        console.error(`git archive 取已提交素材失败：${archive.command}\n${archive.error}`);
        process.exit(4);
      }
      printStatus(
        `  注意：A 的 verifyAssetsDir 因候选名不含 F3/C3 判 ${archive.code}（${archive.error}）；门会用 ${extractedDir} 逐臂核验并记账`,
      );
    }
  }

  const candidateDir = namingOnlyFailure?.assetsDir
    ?? (dest ? path.join(dest, path.basename(assetsSubpath)) : path.resolve(assetsDirArg));
  const stagedManifest = loadManifest(path.join(candidateDir, 'manifest.json')).manifest;
  const reportPath = qualityReportArg === '' ? path.join(petRoot, QUALITY_REPORT_REL) : path.resolve(qualityReportArg);
  const reportRel = qualityReportArg === '' ? `pet-next/${QUALITY_REPORT_REL}` : null;

  const gate = evaluateStageGate({
    repo,
    subpath: assetsSubpath,
    dest,
    assetsDirArg: assetsDirArg === '' ? null : assetsDirArg,
    expectedDir: namingOnlyFailure?.assetsDir ?? null,
    qualityReportPath: reportPath,
    qualityReportRel: reportRel,
    strictReport,
    stagedManifest,
    petRootDir: petRoot,
  });
  gate.evidence.staging = {
    assetsRepo,
    assetsRef,
    commit: archive?.commit ?? null,
    subpath: assetsSubpath,
    dest,
    archiveOk: archive?.ok ?? null,
    archiveCode: archive?.code ?? null,
    namingOnlyFailure,
    note: 'namingOnlyFailure 非空表示 A 的候选名不含 F3/C3，但不是取素材失败；本门逐臂按报告 SHA 核验',
  };
  writeFileSync(path.join(outDir, 'gate.json'), JSON.stringify(gate, null, 2));

  if (!gate.ok) {
    console.error(`[idle-roi] 阶段门拒绝（code=${gate.code}）：${gate.errors.length} 项`);
    for (const message of gate.errors) console.error(`  - ${message}`);
    console.error(`  质量报告：${reportPath}（sha256=${readQualityReport(reportPath).sha256}）`);
    console.error(`  素材 subpath：${assetsSubpath}；判定细节见 ${path.join(outDir, 'gate.json')}`);
    process.exit(gate.code || 5);
  }

  const assetsDir = gate.evidence.assetsDir.expected;
  const manifestInfo = loadManifest(path.join(assetsDir, 'manifest.json'));
  const picks = gate.evidence.arms;
  const sources = {
    O: resolveArmSource('O', { src: picks.O.chosen.path }, manifestInfo.manifest, assetsDir),
    F: resolveArmSource('F', { fSrc: picks.F.chosen.path }, manifestInfo.manifest, assetsDir),
    C: resolveArmSource('C', { cSrc: picks.C.chosen.path }, manifestInfo.manifest, assetsDir),
  };
  for (const arm of ['O', 'F', 'C']) {
    sources[arm].gateExpectedSha256 = picks[arm].expectedSha256;
    sources[arm].gateShaMatched = sources[arm].sha256 === picks[arm].expectedSha256;
    sources[arm].gateChosenFrom = picks[arm].chosen.origin;
    sources[arm].gateChosenName = picks[arm].chosen.name;
  }
  return { archive, assetsDir, manifestInfo, manifest: manifestInfo.manifest, sources, gate };
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

  // 阶段门先跑（lib/gate.mjs）：素材目录 + quality-report.json + 三臂 SHA。
  // 任何一项不满足都在**没有 Xvfb、没有 Electron、没有 build** 的情况下非零退出。
  const staged = runStageGate();
  if (mode === 'preflight') {
    console.log(path.join(outDir, 'gate.json'));
    console.log(JSON.stringify({ gate: { ok: staged.gate.ok, code: staged.gate.code, errors: staged.gate.errors } }, null, 2));
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
  build.distCss = distCssEvidence();
  printStatus(
    `build=${build.built ? `yes(${build.ms}ms)` : build.reason} distCss.objectFit=${JSON.stringify(build.distCss.objectFitLines ?? null)} matchesSource=${String(build.distCss.matchesSource)}`,
  );
  const preflight = electronPreflight();
  printStatus(`electron=${preflight.version} attempts=${preflight.attempt ?? preflight.attempts ?? '?'}`);

  // 素材与 SHA 已由阶段门确定（见 runStageGate）：这里只取结果，不再自行解析路径。
  const { archive, assetsDir, manifestInfo, manifest, sources, gate } = staged;
  printStatus(`assetsDir=${assetsDir}（subpath=${gate.evidence.assetsDir.subpathName}）`);
  for (const arm of ['O', 'F', 'C']) {
    printStatus(
      `  ${arm}: ${sources[arm].path} sha256=${String(sources[arm].sha256).slice(0, 12)} bytes=${sources[arm].bytes} 报告SHA=${String(sources[arm].gateExpectedSha256).slice(0, 12)} match=${String(sources[arm].gateShaMatched)}`,
    );
  }
  // 阶段一自检只跑 O；臂别名 F3/C3 映射到内部 F/C（本轮 B 的产物命名）。
  const requestedArms = [];
  const armLabels = {};
  const planTokens = mode === 'selfcheck'
    ? ['O']
    : value('plan', 'O,F,C')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
  for (const token of planTokens) {
    const upper = token.toUpperCase();
    const base = ARM_ALIASES[upper] ?? upper;
    if (!['O', 'F', 'C'].includes(base)) {
      console.error(`--plan 里有未知臂 ${token}`);
      process.exit(2);
    }
    if (!requestedArms.includes(base)) {
      requestedArms.push(base);
      armLabels[base] = upper;
    }
  }
  const missing = requireArms(requestedArms, sources);
  if (missing.length > 0) {
    console.error(`素材前置不满足（阶段门已过但臂解析仍缺文件，属工具 bug）：${missing.join(' | ')}`);
    cleanupAll();
    process.exit(4);
  }
  // 双重核对：门算过的报告 SHA 必须与本轮真正加载的字节相同（门已查，这里再挡一次回归）。
  const shaDrift = requestedArms.filter((arm) => sources[arm].gateShaMatched !== true);
  if (shaDrift.length > 0) {
    console.error(
      `素材 SHA 与质量报告不一致：${shaDrift.map((arm) => `${arm}(${sources[arm].sha256} != ${sources[arm].gateExpectedSha256})`).join(' | ')}`,
    );
    cleanupAll();
    process.exit(5);
  }
  // C 的布局接线（负责人 830b7cb + 9dc035e）：--roi-layout=on 会设
  // PET_NEXT_IDLE_ROI=1 + PET_NEXT_IDLE_ROI_MANIFEST=<staged>/manifest.json。
  const roiLayout = value('roi-layout', 'off') !== 'off';
  let productSupportsRoiWiring = null;
  if (roiLayout) {
    // 接线只存在于产品 dist（main.js 读 env/校验，contracts/idle-roi.js 存公式）；
    // experiments/** 永远不进 dist，别去那里找。
    const readDist = (relative) => {
      try {
        return readFileSync(path.join(petRoot, 'dist', relative), 'utf8');
      } catch {
        return '';
      }
    };
    const wiringText = `${readDist('electron/main.js')}\n${readDist('contracts/idle-roi.js')}\n${readDist('app/page.js')}`;
    productSupportsRoiWiring = wiringText.includes('PET_NEXT_IDLE_ROI');
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
    armLabels,
    stageGate: gate,
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
