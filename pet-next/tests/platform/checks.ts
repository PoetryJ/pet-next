/**
 * 一次真实会话里的点击、拖动、透明和退出观察。
 * 坐标断言用指针的 screen 增量，不除以 scaleFactor。
 * @module pet-next/tests/platform/checks
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readPngAlpha, sampleAlpha } from './png-alpha.ts';
import { cursorButton, moveCursor } from './cursor.ts';
import {
  evaluate,
  readTrace,
  waitForTrace,
  type Bounds,
  type PetSession,
} from './session.ts';
import { argbWindowDepth } from './x11-window.ts';

const DRAG_PHYSICAL = { x: 48, y: 24 };
/** 设备像素取整的上限。窗口请求值仍要和 screen 增量对齐。 */
const MAX_DEVICE_PIXEL_ERROR = 1;

export interface DragObservation {
  ok: boolean;
  reason: string | null;
  screenDelta: { x: number; y: number } | null;
  requested: { x: number; y: number } | null;
  readback: Bounds | null;
  devicePixelRatio: number | null;
  trace: string;
}

export interface TransparentObservation {
  ok: boolean;
  reason: string | null;
  cssBackground: string;
  reportedBackground: string;
  depth: number | null;
  screenshot: { colorType: number; samples: Array<{ x: number; y: number; alpha: number }> } | { error: string } | null;
}

export async function waitIdle(session: PetSession): Promise<string> {
  return waitForTrace(session, 'idle', (trace) => trace === 'idle:1');
}

export async function checkClick(session: PetSession): Promise<{ ok: boolean; reason: string | null; trace: string }> {
  const point = cursorPoint(session, 80, 60);
  moveCursor(point.x, point.y);
  cursorButton('click');
  try {
    const trace = await waitForTrace(session, 'click', (value) => value === 'idle:1,reaction:2,idle:3');
    return { ok: true, reason: null, trace };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), trace: await readTrace(session).catch(() => '') };
  }
}

export async function checkDrag(session: PetSession, beforeTrace: string): Promise<DragObservation> {
  await installSampler(session);
  const origin = cursorPoint(session, 80, 60);
  moveCursor(origin.x, origin.y);
  await delay(40);
  cursorButton('down');
  await delay(40);
  for (let step = 1; step <= 6; step += 1) {
    moveCursor(origin.x + step * 8, origin.y + step * 4);
    await delay(40);
  }
  cursorButton('up');
  try {
    const samples = await waitSamples(session);
    const down = samples.find((sample) => sample.t === 'pointerdown');
    const move = [...samples].reverse().find((sample) => sample.t === 'pointermove' && sample.buttons === 1);
    if (!down || !move) return dragFail('没有采到按下和拖动', beforeTrace, null);
    if (Math.abs(down.sx - (down.wx + down.cx)) > 0.05 || Math.abs(down.sy - (down.wy + down.cy)) > 0.05) {
      return dragFail(`screen 和窗口加视口不一致 ${JSON.stringify(down)}`, beforeTrace, down.dpr);
    }
    const screenDelta = { x: move.sx - down.sx, y: move.sy - down.sy };
    const scale = session.ready.scaleFactor;
    const xError = Math.abs(screenDelta.x * scale - DRAG_PHYSICAL.x);
    const yError = Math.abs(screenDelta.y * scale - DRAG_PHYSICAL.y);
    if (xError > MAX_DEVICE_PIXEL_ERROR + 1e-4) {
      return dragFail(
        `screenX ${screenDelta.x} * scale ${scale} 与物理位移 ${DRAG_PHYSICAL.x} 相差 ${xError} samples=${brief(samples)}`,
        beforeTrace,
        down.dpr,
      );
    }
    if (yError > MAX_DEVICE_PIXEL_ERROR + 1e-4) {
      return dragFail(
        `screenY ${screenDelta.y} * scale ${scale} 与物理位移 ${DRAG_PHYSICAL.y} 相差 ${yError} samples=${brief(samples)}`,
        beforeTrace,
        down.dpr,
      );
    }
    const expected = { x: Math.round(down.wx + screenDelta.x), y: Math.round(down.wy + screenDelta.y) };
    const placed = await waitRequested(session, (point) => point.x === expected.x && point.y === expected.y);
    if (scale === 1 && (placed.bounds.x !== placed.requested.x || placed.bounds.y !== placed.requested.y)) {
      return dragFail('scaleFactor 为 1 时回读和请求不一致', beforeTrace, down.dpr);
    }
    if (Math.abs(placed.bounds.x - placed.requested.x) > 1 || Math.abs(placed.bounds.y - placed.requested.y) > 1) {
      return dragFail('窗口回读偏离请求超过 1 DIP', beforeTrace, down.dpr);
    }
    const trace = await readTrace(session);
    if (trace !== beforeTrace) return dragFail(`拖动改变了点击轨迹 ${trace}`, beforeTrace, down.dpr);
    return {
      ok: true,
      reason: null,
      screenDelta,
      requested: placed.requested,
      readback: placed.bounds,
      devicePixelRatio: down.dpr,
      trace,
    };
  } catch (error) {
    return dragFail(error instanceof Error ? error.message : String(error), beforeTrace, null);
  }
}

export async function checkClamp(session: PetSession, beforeTrace: string): Promise<{ ok: boolean; reason: string | null }> {
  cursorButton('down');
  moveCursor(0, 0);
  cursorButton('up');
  try {
    const placed = await waitRequested(
      session,
      (point) => point.x === session.ready.workArea.x && point.y === session.ready.workArea.y,
    );
    if (session.ready.scaleFactor === 1 && (placed.bounds.x !== placed.requested.x || placed.bounds.y !== placed.requested.y)) {
      return { ok: false, reason: '夹边时 scaleFactor 为 1，回读却偏离请求' };
    }
    if (Math.abs(placed.bounds.x - placed.requested.x) > 1 || Math.abs(placed.bounds.y - placed.requested.y) > 1) {
      return { ok: false, reason: `夹边回读偏离请求超过 1 DIP ${JSON.stringify(placed)}` };
    }
    const trace = await readTrace(session);
    if (trace !== beforeTrace) return { ok: false, reason: '夹边拖动触发了点击' };
    return { ok: true, reason: null };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function checkTransparent(session: PetSession): Promise<TransparentObservation> {
  const cssBackground = await evaluate<string>(session.cdp, 'getComputedStyle(document.body).backgroundColor');
  const depth = process.platform === 'linux' ? argbWindowDepth(session.tracked.trackedPids()) : null;
  const screenshot = await captureAlpha(session);
  const reportedBackground = session.ready.background;
  const requestedOk = session.ready.requestedBackground.toLowerCase() === '#00000000';
  const cssOk = cssBackground === 'rgba(0, 0, 0, 0)';
  const pixelOk = transparentPixel(screenshot);
  const depthOk = depth === 32;
  const observation = { cssBackground, reportedBackground, depth, screenshot };
  if (!session.ready.transparent || !requestedOk) {
    return { ok: false, reason: `窗口透明标记或请求背景不符：${session.ready.requestedBackground}`, ...observation };
  }
  if (!cssOk) return { ok: false, reason: `页面背景是 ${cssBackground}`, ...observation };
  if (!depthOk && !pixelOk) {
    return {
      ok: false,
      reason: `X11 深度 ${depth ?? '未读到'}，截图也没有 alpha 为 0 的采样点`,
      ...observation,
    };
  }
  return { ok: true, reason: null, ...observation };
}

export async function writeNotes(recordDir: string, notes: unknown): Promise<void> {
  await writeFile(path.join(recordDir, 'notes.json'), `${JSON.stringify(notes, null, 2)}\n`);
}

function cursorPoint(session: PetSession, dx: number, dy: number): { x: number; y: number } {
  return {
    x: Math.round(session.ready.physical.x + dx),
    y: Math.round(session.ready.physical.y + dy),
  };
}

async function installSampler(session: PetSession): Promise<void> {
  await evaluate(session.cdp, `(() => {
    window.__dragSamples = [];
    const el = document.querySelector('#pet');
    if (!(el instanceof HTMLElement)) throw new Error('missing pet');
    const record = (ev) => {
      window.__dragSamples.push({
        t: ev.type,
        sx: ev.screenX,
        sy: ev.screenY,
        cx: ev.clientX,
        cy: ev.clientY,
        wx: window.screenX,
        wy: window.screenY,
        buttons: ev.buttons,
        dpr: window.devicePixelRatio,
      });
    };
    el.addEventListener('pointerdown', record, true);
    el.addEventListener('pointermove', record, true);
    el.addEventListener('pointerup', record, true);
    return true;
  })()`);
}

interface Sample {
  t: string;
  sx: number;
  sy: number;
  cx: number;
  cy: number;
  wx: number;
  wy: number;
  buttons: number;
  dpr: number;
}

async function waitSamples(session: PetSession): Promise<Sample[]> {
  const deadline = Date.now() + 5000;
  let last: Sample[] = [];
  while (Date.now() < deadline) {
    last = await evaluate<Sample[]>(session.cdp, 'window.__dragSamples ?? []');
    if (last.some((sample) => sample.t === 'pointerdown') && last.some((sample) => sample.t === 'pointerup')) return last;
    await delay(30);
  }
  throw new Error(`samples ${JSON.stringify(last)}`);
}

async function waitRequested(
  session: PetSession,
  ok: (point: { x: number; y: number }) => boolean,
): Promise<{ bounds: Bounds; requested: { x: number; y: number } }> {
  const deadline = Date.now() + 5000;
  let last = '';
  while (Date.now() < deadline) {
    const found = latestRequested(session.stdout());
    if (found && ok(found.requested)) return found;
    last = JSON.stringify(found);
    await delay(30);
  }
  throw new Error(`requested ${last}`);
}

function latestRequested(text: string): { bounds: Bounds; requested: { x: number; y: number } } | null {
  let found: { bounds: Bounds; requested: { x: number; y: number } } | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const item = JSON.parse(trimmed) as { event?: string; bounds?: Bounds; requested?: { x: number; y: number } };
      if (item.event === 'bounds' && item.bounds && item.requested && typeof item.requested.x === 'number') {
        found = { bounds: item.bounds, requested: item.requested };
      }
    } catch {
      // 忽略非 JSON。
    }
  }
  return found;
}

async function captureAlpha(session: PetSession): Promise<TransparentObservation['screenshot']> {
  try {
    await session.cdp.send('Page.enable').catch(() => undefined);
    const shot = (await session.cdp.send('Page.captureScreenshot', { format: 'png' })) as { data?: string };
    if (!shot.data) return { error: 'screenshot missing' };
    const image = readPngAlpha(Buffer.from(shot.data, 'base64'));
    return { colorType: image.colorType, samples: sampleAlpha(image) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function transparentPixel(screenshot: TransparentObservation['screenshot']): boolean {
  if (!screenshot || 'error' in screenshot) return false;
  return screenshot.samples.some((sample) => sample.alpha === 0);
}

function brief(samples: Sample[]): string {
  return JSON.stringify(samples.map((sample) => ({ t: sample.t, sx: sample.sx, sy: sample.sy, cx: sample.cx, cy: sample.cy, wx: sample.wx, wy: sample.wy, b: sample.buttons })));
}

function dragFail(reason: string, trace: string, devicePixelRatio: number | null): DragObservation {
  return { ok: false, reason, screenDelta: null, requested: null, readback: null, devicePixelRatio, trace };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
