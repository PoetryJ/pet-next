/**
 * 真实 Electron 缩放对齐：100 / 125 / 150。
 *
 * 这层只回答一件事：按契约 §4 的 contain 公式用 CSS(DIP) 摆候选视频时，
 * 角色在**设备像素**里的包围盒是否和原片一致。缩放的来源必须分别标注：
 *
 * - `simulated`：`--force-device-scale-factor`，本轮真跑；
 * - `system`：真实系统 DPI。本机是无头 Xvfb（默认 96dpi），没有系统缩放可验，
 *   一律记 `not-run`，不拿模拟值冒充。
 *
 * 布局用 CDP 注入到页面（`#clip` 的 inline style），因为产品侧 ROI 接线不归 C；
 * 这样测的是渲染路径本身：同一个 640×360 素材按公式摆放后，角色落点不变。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { fixtureArmsDir, petRoot } from './lib/arms.ts';
import { writeJson } from './lib/report.ts';
import { readPngAlpha } from '../platform/png-alpha.ts';

const OUT = path.join(petRoot(), 'tests', 'idle-roi', 'out', 'scale');
const RERUN = 'pnpm build && env -u NODE_OPTIONS node --experimental-strip-types --test --test-reporter spec tests/idle-roi/scale.test.ts';
const ORIGINAL_CANVAS = { width: 640, height: 360 };
const CROP = { x: 208, y: 52, width: 226, height: 286 };
const SIMULATED_SCALES = [1, 1.25, 1.5] as const;
/**
 * 判据用的 alpha 下限：只拿「看得见的角色」量包围盒。
 *
 * 源片背景是 alpha=1，重编码后在边缘会留下 alpha 8..40 的虚边；原片与候选又是
 * 不同分辨率下采样，虚边落在哪一行本来就会差 1 个设备像素（1.25 缩放时实测
 * 0.8–1.6 DIP 抖动）。用 alpha>=64 量位置，虚边只留档不参与判定。
 */
const CHARACTER_ALPHA = 64;
/** 诊断用的低阈值，只写进报告，不当判据。 */
const DIAGNOSTIC_ALPHA = 8;
/** 允许的包围盒偏差，单位 DIP。 */
const TOLERANCE_DIP = 1.5;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface CdpLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

function layoutFor(viewWidth: number, viewHeight: number): { left: number; top: number; width: number; height: number } {
  const scale = Math.min(viewWidth / ORIGINAL_CANVAS.width, viewHeight / ORIGINAL_CANVAS.height);
  return {
    left: (viewWidth - ORIGINAL_CANVAS.width * scale) / 2 + CROP.x * scale,
    top: (viewHeight - ORIGINAL_CANVAS.height * scale) / 2 + CROP.y * scale,
    width: CROP.width * scale,
    height: CROP.height * scale,
  };
}

/** 截图像素里的角色包围盒，只统计 `clipBox` 之内的 alpha>8 像素。 */
function characterBox(png: Buffer, clip: Box, threshold: number = CHARACTER_ALPHA): Box | null {
  const image = readPngAlpha(png);
  const minX = Math.max(0, Math.floor(clip.x));
  const minY = Math.max(0, Math.floor(clip.y));
  const maxX = Math.min(image.width - 1, Math.ceil(clip.x + clip.width));
  const maxY = Math.min(image.height - 1, Math.ceil(clip.y + clip.height));
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = -1;
  let bottom = -1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if ((image.alpha[y * image.width + x] ?? 0) <= threshold) continue;
      if (x < left) left = x;
      if (y < top) top = y;
      if (x > right) right = x;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

async function screenshot(cdp: CdpLike, file: string): Promise<Buffer> {
  const result = (await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })) as { data?: string };
  if (typeof result.data !== 'string' || result.data.length === 0) throw new Error('截图失败');
  const buffer = Buffer.from(result.data, 'base64');
  writeFileSync(file, buffer);
  return buffer;
}

async function evaluate<T>(cdp: CdpLike, expression: string): Promise<T> {
  const result = (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
    result?: { value?: T };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed');
  return result.result?.value as T;
}

interface PageState {
  readonly viewWidth: number;
  readonly viewHeight: number;
  readonly dpr: number;
  readonly rect: Box;
  readonly readyState: number;
}

/** 把 `#clip` 按给定 DIP 布局摆好，并跳到固定时间点后暂停。 */
function applyLayoutScript(options: { left: number; top: number; width: number; height: number; src: string | null; time: number }): string {
  const src = options.src === null ? 'null' : JSON.stringify(options.src);
  return `(async () => {
    const video = document.getElementById('clip');
    if (!video) throw new Error('#clip 不存在');
    video.pause();
    video.removeAttribute('hidden');
    Object.assign(video.style, {
      position: 'absolute',
      left: '${options.left}px',
      top: '${options.top}px',
      width: '${options.width}px',
      height: '${options.height}px',
      objectFit: 'fill'
    });
    if (${src} !== null) { video.src = ${src}; }
    await new Promise((resolve) => {
      if (video.readyState >= 2) resolve(); else video.addEventListener('loadeddata', resolve, { once: true });
    });
    video.currentTime = ${options.time};
    await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
    video.pause();
    // 1 核机器上合成可能落后一拍；给一拍时间再连等两帧，避免截到半绘制画面。
    await new Promise((resolve) => setTimeout(resolve, 80));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = video.getBoundingClientRect();
    return {
      viewWidth: innerWidth,
      viewHeight: innerHeight,
      dpr: devicePixelRatio,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      readyState: video.readyState
    };
  })()`;
}

/** 原片按 contain 铺满（产品当前布局），候选按 §4 公式摆放。 */
function containedRect(viewWidth: number, viewHeight: number): { left: number; top: number; width: number; height: number } {
  const scale = Math.min(viewWidth / ORIGINAL_CANVAS.width, viewHeight / ORIGINAL_CANVAS.height);
  return {
    left: (viewWidth - ORIGINAL_CANVAS.width * scale) / 2,
    top: (viewHeight - ORIGINAL_CANVAS.height * scale) / 2,
    width: ORIGINAL_CANVAS.width * scale,
    height: ORIGINAL_CANVAS.height * scale,
  };
}

interface ScaleRow {
  readonly scale: number;
  readonly origin: 'simulated' | 'system';
  readonly status: 'passed' | 'failed' | 'not-run';
  readonly reason: string | null;
  readonly dpr: number | null;
  readonly originalBoxDip: Box | null;
  readonly candidateBoxDip: Box | null;
  readonly maxDeltaDip: number | null;
  readonly dprDoubleControlDeltaDip: number | null;
  /** alpha>8 虚边包围盒的偏差，只留档不判定。 */
  readonly diagnosticAlpha8DeltaDip: number | null;
  readonly screenshots: readonly string[];
}

function toDip(box: Box, dpr: number): Box {
  return { x: box.x / dpr, y: box.y / dpr, width: box.width / dpr, height: box.height / dpr };
}

function boxDelta(left: Box, right: Box): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y), Math.abs(left.width - right.width), Math.abs(left.height - right.height));
}

function candidatePath(): string {
  // 优先 A 的已提交候选，其次本地已提交副本，最后才是自造 fixture。
  const ordered = [
    path.join(petRoot(), 'experiments', 'idle-roi', 'out', 'C.webm'),
    path.join(fixtureArmsDir(), 'C.webm'),
    path.join(petRoot(), 'tests', 'idle-roi', 'out', 'fixture', 'C.webm'),
  ];
  return ordered.find((file) => existsSync(file)) ?? ordered[2]!;
}

test('真实 Electron 100/125/150 缩放对齐（模拟 scale factor）', async (t) => {
  mkdirSync(OUT, { recursive: true });
  const rows: ScaleRow[] = [];
  const notRun = (reason: string): void => {
    for (const scale of SIMULATED_SCALES) {
      rows.push({ scale, origin: 'simulated', status: 'not-run', reason, dpr: null, originalBoxDip: null, candidateBoxDip: null, maxDeltaDip: null, dprDoubleControlDeltaDip: null, diagnosticAlpha8DeltaDip: null, screenshots: [] });
    }
    for (const scale of SIMULATED_SCALES) {
      rows.push({ scale, origin: 'system', status: 'not-run', reason: '本机无真实系统 DPI（无头 Xvfb），不拿模拟值冒充', dpr: null, originalBoxDip: null, candidateBoxDip: null, maxDeltaDip: null, dprDoubleControlDeltaDip: null, diagnosticAlpha8DeltaDip: null, screenshots: [] });
    }
    writeJson(path.join(OUT, 'scale-report.json'), {
      schemaVersion: 1,
      kind: 'idle-roi-scale',
      generatedAt: new Date().toISOString(),
      status: 'not-run',
      reason,
      osScale: null,
      osScaleSource: 'not-run: 无头 Xvfb，Electron scaleSource 不是 os',
      rows,
      rerun: RERUN,
    });
    t.skip(reason);
  };

  const distMain = path.join(petRoot(), 'dist', 'electron', 'main.js');
  if (!existsSync(distMain)) return notRun(`缺 ${path.relative(petRoot(), distMain)}，先跑 pnpm build`);
  const candidate = candidatePath();
  if (!existsSync(candidate)) return notRun(`缺候选 webm（${path.relative(petRoot(), candidate)}），先跑 tests/idle-roi/selfcheck.test.ts 或等 A 的产物`);
  try {
    createRequire(path.join(petRoot(), 'package.json'))('electron');
  } catch {
    return notRun('解析不到 electron 模块（node_modules 未安装）');
  }

  const isolation = (await import(path.join(petRoot(), 'scripts', 'test-run-context.mjs') as string)) as unknown as {
    startOwnXvfb: (options: { label: string }) => Promise<{ display: string; stop: () => Promise<void> }>;
  };
  const { openPet, closePet } = await import('../platform/session.ts');

  const xvfb = await isolation.startOwnXvfb({ label: 'm312c-scale' });
  const candidateUrl = `file://${candidate}`;
  try {
    for (const scale of SIMULATED_SCALES) {
      const session = await openPet({ label: `idle-roi-scale-${String(scale).replace('.', '')}`, forced: scale, env: { DISPLAY: xvfb.display } });
      const screenshots: string[] = [];
      try {
        const view = await evaluate<PageState>(
          session.cdp,
          '({ viewWidth: innerWidth, viewHeight: innerHeight, dpr: devicePixelRatio, rect: { x: 0, y: 0, width: innerWidth, height: innerHeight }, readyState: 4 })',
        );
        const contained = containedRect(view.viewWidth, view.viewHeight);
        await evaluate(session.cdp, applyLayoutScript({ ...contained, src: null, time: 0.5 }));
        const originalPng = await screenshot(session.cdp, path.join(OUT, `scale-${scale}-original.png`));
        screenshots.push(path.relative(petRoot(), path.join(OUT, `scale-${scale}-original.png`)));
        const originalClip: Box = { ...contained, x: contained.left, y: contained.top };

        const roi = layoutFor(view.viewWidth, view.viewHeight);
        const appliedState = await evaluate<PageState>(session.cdp, applyLayoutScript({ ...roi, src: candidateUrl, time: 0.5 }));
        const candidatePng = await screenshot(session.cdp, path.join(OUT, `scale-${scale}-roi.png`));
        screenshots.push(path.relative(petRoot(), path.join(OUT, `scale-${scale}-roi.png`)));

        const dpr = appliedState.dpr;
        const originalBox = characterBox(originalPng, { x: originalClip.x * dpr, y: originalClip.y * dpr, width: originalClip.width * dpr, height: originalClip.height * dpr });
        const candidateBox = characterBox(candidatePng, { x: 0, y: 0, width: 1e9, height: 1e9 });
        if (!originalBox || !candidateBox) {
          rows.push({ scale, origin: 'simulated', status: 'failed', reason: '截图像素里找不到角色（alpha>8 为空）', dpr, originalBoxDip: null, candidateBoxDip: null, maxDeltaDip: null, dprDoubleControlDeltaDip: null, diagnosticAlpha8DeltaDip: null, screenshots });
          continue;
        }
        const originalDip = toDip(originalBox, dpr);
        const candidateDip = toDip(candidateBox, dpr);
        const delta = boxDelta(originalDip, candidateDip);
        // 低阈值（alpha>8）的虚边包围盒只留档：不同分辨率下采样会让虚边差 1 个设备像素。
        const diagnostic = (): number | null => {
          const diagOriginal = characterBox(originalPng, { x: originalClip.x * dpr, y: originalClip.y * dpr, width: originalClip.width * dpr, height: originalClip.height * dpr }, DIAGNOSTIC_ALPHA);
          const diagCandidate = characterBox(candidatePng, { x: 0, y: 0, width: 1e9, height: 1e9 }, DIAGNOSTIC_ALPHA);
          if (!diagOriginal || !diagCandidate) return null;
          return boxDelta(toDip(diagOriginal, dpr), toDip(diagCandidate, dpr));
        };
        const diagnosticDelta = diagnostic();

        // 负控：把 CSS 再乘一次 DPR（常见错误），位移必须被这套测量抓到。
        const wrong = { left: roi.left * dpr, top: roi.top * dpr, width: roi.width * dpr, height: roi.height * dpr };
        await evaluate(session.cdp, applyLayoutScript({ ...wrong, src: candidateUrl, time: 0.5 }));
        const wrongPng = await screenshot(session.cdp, path.join(OUT, `scale-${scale}-dpr-double.png`));
        screenshots.push(path.relative(petRoot(), path.join(OUT, `scale-${scale}-dpr-double.png`)));
        const wrongBox = characterBox(wrongPng, { x: 0, y: 0, width: 1e9, height: 1e9 });
        const wrongDelta = wrongBox ? boxDelta(originalDip, toDip(wrongBox, dpr)) : null;

        rows.push({
          scale,
          origin: 'simulated',
          status: delta <= TOLERANCE_DIP ? 'passed' : 'failed',
          reason: delta <= TOLERANCE_DIP ? null : `角色包围盒最大偏差 ${delta.toFixed(2)} DIP > ${TOLERANCE_DIP}`,
          dpr,
          originalBoxDip: originalDip,
          candidateBoxDip: candidateDip,
          maxDeltaDip: delta,
          dprDoubleControlDeltaDip: wrongDelta,
          diagnosticAlpha8DeltaDip: diagnosticDelta,
          screenshots,
        });
        await t.test(`scale=${scale}`, () => {
          assert.ok(delta <= TOLERANCE_DIP, `角色包围盒偏差 ${delta.toFixed(2)} DIP（原片 ${JSON.stringify(originalDip)}，候选 ${JSON.stringify(candidateDip)}）`);
          if (dpr !== 1) {
            assert.ok(wrongDelta !== null && wrongDelta > TOLERANCE_DIP, `DPR 二次相乘应当被抓到，实测偏差 ${String(wrongDelta)} DIP`);
          }
        });
      } finally {
        await closePet(session);
      }
    }
    for (const scale of SIMULATED_SCALES) {
      rows.push({ scale, origin: 'system', status: 'not-run', reason: '本机无真实系统 DPI（无头 Xvfb），不拿模拟值冒充', dpr: null, originalBoxDip: null, candidateBoxDip: null, maxDeltaDip: null, dprDoubleControlDeltaDip: null, diagnosticAlpha8DeltaDip: null, screenshots: [] });
    }
  } finally {
    await xvfb.stop();
  }

  const failed = rows.filter((row) => row.status === 'failed');
  writeJson(path.join(OUT, 'scale-report.json'), {
    schemaVersion: 1,
    kind: 'idle-roi-scale',
    generatedAt: new Date().toISOString(),
    status: failed.length === 0 ? 'passed' : 'failed',
    candidate: path.relative(petRoot(), candidate),
    osScale: null,
    osScaleSource: 'not-run: 无头 Xvfb，Electron scaleSource 不是 os',
    originNotes: {
      simulated: '--force-device-scale-factor 启动参数',
      system: '真实系统 DPI，本机没有条件，全部 not-run',
    },
    rows,
    rerun: RERUN,
  });
});
