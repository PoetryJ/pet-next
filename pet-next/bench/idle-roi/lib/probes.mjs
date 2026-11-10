/**
 * M3-12 D：行为回归探针（在采样窗**之外**跑，避免给 CPU 数据加负载）。
 *
 * 全部是产品既有语义：合成鼠标输入走 CDP Input（与 tests/platform/session.ts 同口径），
 * “首回应”= 注入观察器看到的**首个 reaction 呈帧**（rVFC），是软件呈帧证据，
 * 不是物理屏幕延迟；位置/可见性读的是产品 DOM 与 X11 窗口，不改产品代码。
 * @module pet-next/bench/idle-roi/lib/probes
 */
import { delay } from './cdp.mjs';
import { median } from './stats.mjs';

/** 有界轮询：条件命中返回其值，超时返回 null（绝不无限等待）。 */
async function pollUntil(fn, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== null && value !== undefined && value !== false) return value;
    await delay(intervalMs);
  }
  return null;
}

async function snapshot(cdp) {
  try {
    return await cdp.evaluate('window.__idleRoi ? window.__idleRoi.snapshot() : null', 4000);
  } catch {
    return null;
  }
}

/** 观察器 bySrc 的键是带扩展名的短文件名；按子串归并。 */
function framesForKey(bySrc, hint) {
  if (!bySrc) return 0;
  let total = 0;
  for (const [key, count] of Object.entries(bySrc)) {
    if (key.includes(hint)) total += count;
  }
  return total;
}

function idleVideo(page) {
  if (!page) return null;
  const playing = page.videos.find((video) => !video.paused && video.readyState >= 2);
  return playing ?? page.videos[0] ?? null;
}

/**
 * 连续点击：每次记录“输入 → 首个 reaction 呈帧”的软件时延与是否漏回应。
 * @param {{cdp:any, count?:number, reactionHint:string, clickPoint?:{x:number,y:number}, idleHint:string}} options
 */
export async function probeClicks(options) {
  const count = options.count ?? 12;
  const point = options.clickPoint ?? { x: 160, y: 120 };
  const samples = [];
  let missed = 0;
  for (let index = 1; index <= count; index += 1) {
    const before = await snapshot(options.cdp);
    await options.cdp.evaluate("window.__idleRoi.mark('click')");
    const issuedAt = Date.now();
    try {
      await options.cdp.click(point.x, point.y);
    } catch (error) {
      missed += 1;
      samples.push({ sample: index, error: String(error?.message ?? error), latencyMs: null, missed: true });
      continue;
    }
    const hit = await pollUntil(
      async () => options.cdp.evaluate(`window.__idleRoi.sinceMark('click', ${JSON.stringify(options.reactionHint)})`),
      5000,
      40,
    );
    const after = await snapshot(options.cdp);
    if (hit === null) {
      missed += 1;
      samples.push({
        sample: index,
        latencyMs: null,
        missed: true,
        wallMs: Date.now() - issuedAt,
        visualBefore: before?.visual ?? null,
        visualAfter: after?.visual ?? null,
      });
    } else {
      samples.push({
        sample: index,
        latencyMs: hit.latencyMs,
        src: hit.src,
        mediaTimeMs: hit.mediaTimeMs,
        wallMs: Date.now() - issuedAt,
        visualBefore: before?.visual ?? null,
        visualAfter: after?.visual ?? null,
      });
    }
    // 等回到 idle（有界），下一次点击才是干净起点；回不去只记事实不补刀。
    const back = await pollUntil(
      async () => {
        const page = await snapshot(options.cdp);
        const video = idleVideo(page);
        return page && page.visual === 'idle' && video && video.src.includes(options.idleHint) && !video.paused
          ? { visual: page.visual, idleSrc: video.src, currentTime: video.currentTime }
          : null;
      },
      6000,
      100,
    );
    const latest = samples[samples.length - 1];
    latest.returnedToIdle = latest.missed ? null : back !== null;
    await delay(250);
  }
  const latencies = samples.map((sample) => sample.latencyMs).filter((value) => typeof value === 'number');
  return {
    clickPoint: point,
    requested: count,
    observed: latencies.length,
    missed,
    medianMs: median(latencies),
    minMs: latencies.length > 0 ? Math.min(...latencies) : null,
    maxMs: latencies.length > 0 ? Math.max(...latencies) : null,
    samples,
    evidence: '软件输入 + rVFC 呈帧（非物理帧/物理延迟）',
  };
}

/** 拖动：合成按下→移动→释放，比对 X11 窗口位置与 body.dragging 类。 */
export async function probeDrag(options) {
  const before = options.geometry();
  await options.cdp.evaluate("window.__idleRoi.mark('drag')");
  await options.cdp.drag(160, 120, 24);
  await delay(400);
  const after = options.geometry();
  const dragging = await options.cdp.evaluate("document.body.classList.contains('dragging')").catch(() => null);
  const movedDelta = before && after ? { dx: after.x - before.x, dy: after.y - before.y } : null;
  return {
    before,
    after,
    draggingClassAfter: dragging,
    moved: Boolean(movedDelta && (movedDelta.dx !== 0 || movedDelta.dy !== 0)),
    movedDelta,
  };
}

/**
 * 隐藏→恢复：unmap 窗口，量隐藏期间是否还有 idle 呈帧；map 回来量恢复后首个 idle 呈帧时延。
 * 注意 M3-9 的暂停开关默认关闭——本探针只记录实际观察，不假设暂停生效。
 */
export async function probeHidden(options) {
  const pageBefore = await snapshot(options.cdp);
  const framesBefore = pageBefore?.bySrc?.[options.idleHint] ?? 0;
  let unmapError = null;
  try {
    options.unmap();
  } catch (error) {
    unmapError = String(error?.message ?? error);
  }
  await delay(2000);
  const pageHidden = await snapshot(options.cdp);
  const framesHidden = framesForKey(pageHidden?.bySrc, options.idleHint) - framesBefore;
  await options.cdp.evaluate("window.__idleRoi.mark('resume')").catch(() => null);
  let mapError = null;
  try {
    options.map();
  } catch (error) {
    mapError = String(error?.message ?? error);
  }
  const hit = await pollUntil(
    async () => options.cdp.evaluate(`window.__idleRoi.sinceMark('resume', ${JSON.stringify(options.idleHint)})`),
    8000,
    60,
  );
  const pageAfter = await snapshot(options.cdp);
  return {
    unmapError,
    mapError,
    visibilityWhileHidden: pageHidden?.visibility ?? null,
    idleFramesWhileHidden2s: framesHidden,
    resumeFirstIdleFrameMs: hit?.latencyMs ?? null,
    visibilityAfterResume: pageAfter?.visibility ?? null,
    visualAfterResume: pageAfter?.visual ?? null,
  };
}

/** 关窗（Escape 是产品既有退出键）：返回退出码与残留进程。 */
export async function probeExit(options) {
  const started = Date.now();
  await Promise.race([options.cdp.escape().catch(() => undefined), delay(2000)]);
  const deadline = Date.now() + 15000;
  while (options.exitCode() === null && Date.now() < deadline) await delay(100);
  return {
    exitCode: options.exitCode(),
    signal: options.signalCode(),
    ms: Date.now() - started,
  };
}
