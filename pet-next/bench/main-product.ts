/**
 * 产品真实回应观测的 Electron 主进程（bench 侧；不改产品文件）。
 *
 * 加载真实产品页 dist/app/page.html?preview=bench-observe&idle=…&reaction=…（不开行为，
 * pointer 点击路径与验收一致），合成点击输入（sendInputEvent），收集：
 * - 产品已有 bench-observe 打点：bench-click / bench-media（console.log 单行 JSON）。
 * - 过渡期注入观察器（dom-ready 后 executeJavaScript，产品文件零改动）：
 *   bench-input（document 捕获阶段 pointer 事件）+ bench-frame（video rVFC 元数据），
 *   带 injected:true。产品侧接线同事件后自动优先产品版（product-observe.select）。
 *
 * 全部时长差值用页面 performance.now() 域；这里只收集事件、套判据、写样本。
 * 回应判据（固定素材 + 固定帧号）在 bench/product-observe.ts，可复算。
 *
 * 环境变量：BENCH_PRODUCT_JOB（JSON，见 {@link ProductObservationJob}）、BENCH_ROOT、BENCH_USER_DATA。
 */
import { app, BrowserWindow } from 'electron';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateSample, criterionFor, type PageEvent, type ProductClickSample, type ProductEndState } from './product-observe.ts';
import type { OnsetMeasurement } from './onset.ts';
import { WINDOW_HEIGHT, WINDOW_WIDTH, WINDOW_X, WINDOW_Y } from './protocol.ts';

/** 注入观察器：只读转发（输入事件 + rVFC 元数据），不做任何计算/干预。 */
const OBSERVER_SCRIPT = [
  '(function () {',
  "  if (window.__benchProductObserve) return 'already';",
  '  window.__benchProductObserve = true;',
  '  var log = function (m) { try { console.log(JSON.stringify(m)); } catch (e) {} };',
  "  ['pointerdown', 'pointerup', 'pointercancel'].forEach(function (kind) {",
  '    document.addEventListener(kind, function (ev) {',
  '      log({ event: "bench-input", kind: kind, pointerId: ev.pointerId, x: ev.screenX, y: ev.screenY, injected: true, ts: performance.now() });',
  '    }, true);',
  '  });',
  '  var watch = function (v) {',
  "    if (!v || typeof v.requestVideoFrameCallback !== 'function') return;",
  '    v.requestVideoFrameCallback(function cb(now, meta) {',
  '      log({ event: "bench-frame", src: v.currentSrc || v.src || "", mediaTime: meta.mediaTime, presentedFrames: meta.presentedFrames, expectedDisplayTime: meta.expectedDisplayTime, rVfcNow: now, injected: true, ts: performance.now() });',
  '      v.requestVideoFrameCallback(cb);',
  '    });',
  '  };',
  '  Array.prototype.forEach.call(document.querySelectorAll("video"), watch);',
  "  return 'ok';",
  '})()',
].join('\n');

interface ProductObservationJob {
  label: string;
  outDir: string;
  runRoot: string;
  idleUrl: string;
  reactionUrl: string;
  samples: number;
  dwellMs: number;
  /** 素材内回应帧测量（bench/onset.ts）；负控可为 null（无判据，只验未完成）。 */
  onset: OnsetMeasurement | null;
  assetSha256: string;
  sampleTimeoutMs: number;
  captureEvidence: boolean;
  /** 控制组样本附带完整页面事件审计流；主臂不附（样本量大）。 */
  includeEvents: boolean;
}

const job = readJob();
if (process.env.BENCH_USER_DATA) app.setPath('userData', process.env.BENCH_USER_DATA);
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
  app.disableHardwareAcceleration();
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function readJob(): ProductObservationJob {
  const raw = process.env.BENCH_PRODUCT_JOB;
  if (!raw) throw new Error('BENCH_PRODUCT_JOB missing');
  return JSON.parse(raw) as ProductObservationJob;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function pageFile(): string {
  const root = process.env.BENCH_ROOT;
  if (!root) throw new Error('BENCH_ROOT missing');
  return path.join(root, 'dist/app/page.html');
}

const TERMINAL: readonly ProductEndState[] = [
  'response-observed',
  'load-failed',
  'ended-before-target',
  'cancelled',
  'superseded',
];

void app.whenReady().then(async () => {
  mkdirSync(path.join(job.outDir, 'evidence'), { recursive: true });
  const win = new BrowserWindow({
    x: WINDOW_X,
    y: WINDOW_Y,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.webContents.setBackgroundThrottling(false);
  win.setIgnoreMouseEvents(false);

  const criterion = criterionFor(
    job.onset ?? { sha256: job.assetSha256, fps: 24, onsetMs: null, onsetFrame: null, frames: 0 },
    job.reactionUrl,
    job.assetSha256,
  );

  let events: PageEvent[] = [];
  /**
   * 只收当前文档的事件：reload 会重置 performance.now()，旧文档迟到的 console/rVFC
   * 事件时间戳在新文档里数值上可能"晚于"本次点击（跨文档比较无效）。dom-ready 之后
   * 才开始接收，旧文档残影一律丢弃（记数供审计）。
   */
  let accepting = false;
  let droppedStale = 0;
  win.webContents.on('console-message', (_event, _level, message) => {
    if (!message) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (parsed && typeof parsed === 'object' && typeof (parsed as PageEvent)['event'] === 'string') {
      const record = parsed as PageEvent;
      if (!String(record['event']).startsWith('bench-')) return;
      if (!accepting) {
        droppedStale += 1;
        return;
      }
      events.push(record);
      if (job.captureEvidence) maybeCapture(record, win);
    }
  });
  win.webContents.on('did-fail-load', (_event, code, description) => {
    console.log(JSON.stringify({ event: 'fail-load', code, description }));
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.log(JSON.stringify({ event: 'gone', reason: details.reason }));
  });

  const captures = new Map<string, string>();
  let captureInFlight = false;
  function maybeCapture(record: PageEvent, target: BrowserWindow): void {
    if (record['event'] !== 'bench-frame') return;
    const src = typeof record['src'] === 'string' ? record['src'] : '';
    const mediaTime = typeof record['mediaTime'] === 'number' ? record['mediaTime'] : null;
    if (src !== job.reactionUrl || mediaTime === null) return;
    const halfFrame = criterion.fps > 0 ? 0.5 / criterion.fps : 0;
    const isFirst = !captures.has('first') && mediaTime <= criterion.firstFrameMaxMediaTimeSec;
    const isResponse =
      !captures.has('response') &&
      criterion.targetMediaTimeSec !== null &&
      mediaTime >= criterion.targetMediaTimeSec - halfFrame;
    if (!isFirst && !isResponse) return;
    const slot = isFirst ? 'first' : 'response';
    const file = path.join(job.outDir, 'evidence', `${job.label}-${String(sampleCursor + 1).padStart(2, '0')}-${slot}.png`);
    captures.set(slot, file);
    void snap(target, file);
  }
  async function snap(target: BrowserWindow, file: string): Promise<void> {
    if (captureInFlight) return;
    captureInFlight = true;
    try {
      const image = await target.webContents.capturePage();
      writeFileSync(file, image.toPNG());
    } catch (error) {
      console.log(JSON.stringify({ event: 'capture-error', message: String(error) }));
    } finally {
      captureInFlight = false;
    }
  }

  async function loadDocument(): Promise<void> {
    accepting = false;
    droppedStale = 0;
    events = [];
    captures.clear();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('page load timeout')), 30000);
      win.webContents.once('dom-ready', () => {
        clearTimeout(timer);
        resolve();
      });
      if (documentLoads === 0) {
        void win.loadFile(pageFile(), {
          query: { preview: 'bench-observe', idle: job.idleUrl, reaction: job.reactionUrl },
        });
      } else {
        win.webContents.reload();
      }
    });
    documentLoads += 1;
    try {
      await win.webContents.executeJavaScript(OBSERVER_SCRIPT, false);
    } catch (error) {
      console.log(JSON.stringify({ event: 'inject-error', message: String(error) }));
      throw error;
    }
    accepting = true;
    if (droppedStale > 0) console.log(JSON.stringify({ event: 'stale-events-dropped', count: droppedStale }));
  }

  let documentLoads = 0;
  let sampleCursor = -1;

  async function waitUntil(read: () => boolean, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (!read()) {
      if (Date.now() - start > timeoutMs) return false;
      await delay(25);
    }
    return true;
  }

  const samplesFile = path.join(job.outDir, 'samples.jsonl');
  writeFileSync(samplesFile, '');

  try {
    for (let index = 1; index <= job.samples; index += 1) {
      sampleCursor = index - 1;
      await loadDocument();
      const idleVisible = await waitUntil(
        () =>
          events.some(
            (event) =>
              event['event'] === 'bench-frame' && typeof event['src'] === 'string' && event['src'] === job.idleUrl,
          ) ||
          events.some(
            (event) =>
              event['event'] === 'bench-media' && event['status'] === 'resolved' && String(event['requestId'] ?? '').startsWith('idle:'),
          ),
        15000,
      );
      if (!idleVisible) {
        appendFileSync(
          samplesFile,
          `${JSON.stringify({ ...evaluateSample(job.label, index, events, criterion), endState: 'idle-missing', pending: undefined })}\n`,
        );
        continue;
      }
      await delay(job.dwellMs);
      const clickSentAt = Date.now();
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.floor(WINDOW_WIDTH / 2), y: Math.floor(WINDOW_HEIGHT / 2) });
      win.webContents.sendInputEvent({
        type: 'mouseDown',
        x: Math.floor(WINDOW_WIDTH / 2),
        y: Math.floor(WINDOW_HEIGHT / 2),
        button: 'left',
        clickCount: 1,
      });
      await delay(60);
      win.webContents.sendInputEvent({
        type: 'mouseUp',
        x: Math.floor(WINDOW_WIDTH / 2),
        y: Math.floor(WINDOW_HEIGHT / 2),
        button: 'left',
        clickCount: 1,
      });
      const reached = await waitUntil(() => TERMINAL.includes(evaluateSample(job.label, index, events, criterion).endState), job.sampleTimeoutMs);
      const evaluated = evaluateSample(job.label, index, events, criterion);
      if (evaluated.endState === 'response-observed') await delay(300);
      const record: Record<string, unknown> = {
        ...evaluated,
        pending: undefined,
        clickSentAtMain: clickSentAt,
        evidence: { ...captures },
      };
      if (job.includeEvents) record.events = events;
      appendFileSync(samplesFile, `${JSON.stringify(record)}\n`);
      console.log(JSON.stringify({ event: 'sample-done', label: job.label, sample: index, endState: evaluated.endState, reached }));
    }
    console.log(JSON.stringify({ event: 'done', label: job.label, samples: job.samples }));
  } catch (error) {
    console.log(JSON.stringify({ event: 'fatal', message: String(error) }));
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
