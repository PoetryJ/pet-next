/**
 * 测量页：同一窗口里跑单槽或双槽，记录点击到画面和 play() 兑现。
 * 不接入行为调度。人工延迟只在压力任务里包住加载。
 */
import { createMediaAdapter, systemMediaClock } from '../adapters/media/adapter.ts';
import type { MediaAdapter, MediaLoader } from '../adapters/media/types.ts';
import { bindTwoSlotSurface } from '../adapters/media/two-slot/bind-surface.ts';
import { createTwoSlotAdapter } from '../adapters/media/two-slot/adapter.ts';
import type { TwoSlotAdapter } from '../contracts/media-slot.ts';
import { assembleLatency, stageKind, type TimedFrame } from './frames.ts';
import {
  BEHAVIOR_ENABLED,
  EMPTY_OPAQUE,
  GRID_H,
  GRID_W,
  LOAD_TIMEOUT_MS,
  OPAQUE_ALPHA,
  TRIAL_TIMEOUT_MS,
  type BenchMode,
} from './protocol.ts';

interface BenchHost {
  send(message: unknown): void;
  onCommand(listener: (command: unknown) => void): void;
}

declare const benchHost: BenchHost;

interface TrialCommand {
  id: number;
  type: 'hold-idle' | 'trial' | 'demo';
  dwellMs?: number;
  wait?: 'frame' | 'ended';
  play?: 'first' | 'repeat' | 'warmup';
  index?: number;
}

interface LoadMark {
  url: string;
  t: number;
}

if (BEHAVIOR_ENABLED) throw new Error('bench keeps behavior off');

const params = new URLSearchParams(location.search);
const mode = readMode(params.get('mode'));
const idleUrl = requiredParam('idle');
const reactionUrl = requiredParam('reaction');
const stressDelayMs = Number(params.get('stress') ?? '0');

const stage = document.querySelector('#stage');
if (!(stage instanceof HTMLElement)) throw new Error('stage missing');

const videos = mode === 'single' ? [createVideo(stage)] : [createVideo(stage), createVideo(stage)];
const stack: HTMLVideoElement[] = [];
for (const video of videos) raise(video);

const loads: LoadMark[] = [];
for (const video of videos) watchLoads(video);

const measure = document.createElement('canvas');
measure.width = GRID_W;
measure.height = GRID_H;
const hashCanvas = document.createElement('canvas');
hashCanvas.width = 8;
hashCanvas.height = 8;
const measureContext = measure.getContext('2d', { willReadFrequently: true });
const hashContext = hashCanvas.getContext('2d', { willReadFrequently: true });
if (!measureContext || !hashContext) throw new Error('canvas missing');
const measureCtx: CanvasRenderingContext2D = measureContext;
const hashCtx: CanvasRenderingContext2D = hashContext;

const single = mode === 'single' ? createSingle(videos[0]!) : null;
const two = mode === 'single' ? null : createTwo(videos);

let seq = 0;
let idleId = '';
let reactionId = '';
let preheatId = '';
let idleVideo: HTMLVideoElement | null = mode === 'single' ? videos[0]! : null;
let preheatReady = false;
let playResolvedAt: number | null = null;
let adapterFirstFrameAt: number | null = null;
let shownAt: number | null = null;
let presentationAt: number | null = null;
let ended = false;
let failed = false;
let target: HTMLVideoElement | null = null;
let rvfcSinceArm = 0;
let staleHash: Uint8Array | null = null;
let cancelRvfc: (() => void) | null = null;
let active = false;
let presented = false;
let clickAt = 0;
let trialStart = 0;
const frames: TimedFrame[] = [];
const shots: HTMLCanvasElement[] = [];
let shotsAfter = 0;

requestAnimationFrame(observe);
benchHost.send({ type: 'ready', boot: params.get('boot') ?? '' });
benchHost.onCommand((command) => {
  void runCommand(command as TrialCommand).catch((error: unknown) => {
    const id = typeof command === 'object' && command !== null && 'id' in command ? Number(command.id) : 0;
    benchHost.send({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
  });
});

function readMode(value: string | null): BenchMode {
  if (value === 'single' || value === 'two-slot' || value === 'two-slot-preheat') return value;
  throw new Error(`unknown mode ${value ?? ''}`);
}

function requiredParam(name: string): string {
  const value = params.get(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function createVideo(parent: HTMLElement): HTMLVideoElement {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = false;
  parent.append(video);
  return video;
}

function raise(video: HTMLVideoElement): void {
  const index = stack.indexOf(video);
  if (index >= 0) stack.splice(index, 1);
  stack.push(video);
  video.style.zIndex = String(stack.length);
}

function watchLoads(video: HTMLVideoElement): void {
  video.addEventListener('loadstart', () => {
    const url = video.currentSrc || video.src;
    if (!url) return;
    loads.push({ url, t: performance.now() });
  });
}

function delayLoader(inner: MediaLoader, delayMs: number): MediaLoader {
  if (delayMs <= 0) return inner;
  return {
    load(url, token) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          inner.load(url, token).then(resolve, reject);
        }, delayMs);
        token.onAbort(() => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { reason: 'aborted' }));
        });
      });
    },
    release(src) {
      inner.release(src);
    },
  };
}

function createSingle(video: HTMLVideoElement): MediaAdapter {
  const surface = bindTwoSlotSurface(video);
  return createMediaAdapter({
    element: surface.element,
    loader: delayLoader(surface.loader, stressDelayMs),
    clock: systemMediaClock(),
    timeoutMs: LOAD_TIMEOUT_MS,
    onStatus(event) {
      if (event.playbackId !== reactionId) return;
      if (event.status === 'playing') playResolvedAt = performance.now();
      if (event.status === 'ended') ended = true;
      if (event.status === 'failed') failed = true;
    },
  });
}

function twoMode(): 'two-slot' | 'two-slot-preheat' {
  if (mode === 'two-slot' || mode === 'two-slot-preheat') return mode;
  throw new Error('single has no two-slot adapter');
}

function createTwo(pair: HTMLVideoElement[]): TwoSlotAdapter {
  const first = pair[0];
  const second = pair[1];
  if (!first || !second) throw new Error('expected 2 videos');
  return createTwoSlotAdapter({
    mode: twoMode(),
    slots: [surface(first), surface(second)],
    clock: systemMediaClock(),
    timeoutMs: LOAD_TIMEOUT_MS,
    onNotice(notice) {
      if (notice.type === 'prepared' && notice.requestId === preheatId) preheatReady = true;
      if (notice.type === 'shown' && notice.requestId === idleId) {
        idleVideo = pair[notice.token.slot] ?? null;
        if (idleVideo) raise(idleVideo);
      }
      if (notice.requestId !== reactionId) return;
      if (notice.type === 'shown') {
        shownAt = performance.now();
        const video = pair[notice.token.slot];
        if (video) {
          raise(video);
          armTarget(video);
        }
      }
      if (notice.type === 'playing') playResolvedAt = performance.now();
      if (notice.type === 'first-frame') adapterFirstFrameAt = performance.now();
      if (notice.type === 'ended') ended = true;
      if (notice.type === 'failed') failed = true;
    },
  });
}

function surface(video: HTMLVideoElement) {
  const bound = bindTwoSlotSurface(video);
  return {
    element: bound.element,
    loader: delayLoader(bound.loader, stressDelayMs),
    watchFirstFrame: (listener: () => void) => bound.watchFirstFrame(listener),
  };
}

function armTarget(video: HTMLVideoElement): void {
  cancelRvfc?.();
  target = video;
  rvfcSinceArm = 0;
  staleHash = hashVideo(video);
  if (typeof video.requestVideoFrameCallback !== 'function') return;
  const handle = video.requestVideoFrameCallback(function onFrame() {
    if (target !== video) return;
    rvfcSinceArm += 1;
    if (!presented) {
      const next = video.requestVideoFrameCallback(onFrame);
      cancelRvfc = () => video.cancelVideoFrameCallback(next);
    }
  });
  cancelRvfc = () => video.cancelVideoFrameCallback(handle);
}

function hashVideo(video: HTMLVideoElement): Uint8Array | null {
  if (video.readyState < 2 || video.videoWidth === 0) return null;
  hashCtx.clearRect(0, 0, 8, 8);
  hashCtx.drawImage(video, 0, 0, 8, 8);
  const data = hashCtx.getImageData(0, 0, 8, 8).data;
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) {
    const offset = i * 4;
    out[i] = Math.round((data[offset]! * 0.3 + data[offset + 1]! * 0.59 + data[offset + 2]! * 0.11));
  }
  return out;
}

function hashDistance(left: Uint8Array, right: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) sum += Math.abs(left[i]! - right[i]!);
  return sum / left.length;
}

function opaqueSamples(ctx: CanvasRenderingContext2D, width: number, height: number): number {
  const data = ctx.getImageData(0, 0, width, height).data;
  let count = 0;
  for (let i = 3; i < data.length; i += 16) {
    if (data[i]! > OPAQUE_ALPHA) count += 1;
  }
  return count;
}

function opaqueOfVideo(video: HTMLVideoElement): number {
  measureCtx.clearRect(0, 0, GRID_W, GRID_H);
  if (video.readyState < 2 || video.videoWidth === 0) return 0;
  measureCtx.drawImage(video, 0, 0, GRID_W, GRID_H);
  return opaqueSamples(measureCtx, GRID_W, GRID_H);
}

function stageOpaque(): number {
  measureCtx.clearRect(0, 0, GRID_W, GRID_H);
  for (const video of stack) {
    if (video.readyState < 2 || video.videoWidth === 0) continue;
    measureCtx.drawImage(video, 0, 0, GRID_W, GRID_H);
  }
  return opaqueSamples(measureCtx, GRID_W, GRID_H);
}

function isReactionSource(video: HTMLVideoElement): boolean {
  const src = video.currentSrc || video.src;
  return src === reactionUrl || src.endsWith('reaction.webm');
}

function targetPresented(): boolean {
  if (!target || rvfcSinceArm < 1 || !isReactionSource(target)) return false;
  if (presentationAt === null) presentationAt = performance.now();
  if (opaqueOfVideo(target) < EMPTY_OPAQUE) return false;
  if (staleHash && target.currentTime > 0.25) {
    const next = hashVideo(target);
    if (next && hashDistance(next, staleHash) < 8) return false;
  }
  return true;
}

function observe(): void {
  if (active) {
    const nowPresented = presented || targetPresented();
    if (presentationAt !== null && !markedPresentation) {
      markedPresentation = true;
      benchHost.send({ type: 'mark', id: currentCommandId });
    }
    if (nowPresented && !presented) presented = true;
    const kind = stageKind(presented, stageOpaque(), EMPTY_OPAQUE);
    frames.push({ tMs: performance.now() - clickAt, kind });
    if (shots.length < 60 && (!presented || shotsAfter < 2)) {
      shots.push(snapEvidence());
      if (presented) shotsAfter += 1;
    }
  }
  requestAnimationFrame(observe);
}

function snapEvidence(): HTMLCanvasElement {
  const shot = document.createElement('canvas');
  shot.width = GRID_W;
  shot.height = GRID_H;
  const ctx = shot.getContext('2d');
  if (!ctx) return shot;
  const size = 8;
  for (let y = 0; y < GRID_H; y += size) {
    for (let x = 0; x < GRID_W; x += size) {
      ctx.fillStyle = (x / size + y / size) % 2 === 0 ? '#d0d0d0' : '#7a7a7a';
      ctx.fillRect(x, y, size, size);
    }
  }
  for (const video of stack) {
    if (video.readyState < 2 || video.videoWidth === 0) continue;
    ctx.drawImage(video, 0, 0, GRID_W, GRID_H);
  }
  return shot;
}

function encodeStrip(): string | null {
  if (shots.length === 0) return null;
  const strip = document.createElement('canvas');
  strip.width = GRID_W * shots.length;
  strip.height = GRID_H;
  const ctx = strip.getContext('2d');
  if (!ctx) return null;
  shots.forEach((shot, index) => {
    ctx.drawImage(shot, index * GRID_W, 0);
  });
  const url = strip.toDataURL('image/png');
  const comma = url.indexOf(',');
  return comma < 0 ? null : url.slice(comma + 1);
}

let currentCommandId = 0;
let markedPresentation = false;

async function runCommand(command: TrialCommand): Promise<void> {
  currentCommandId = command.id;
  if (command.type === 'hold-idle') {
    const ok = await showIdle(command.dwellMs ?? 0);
    benchHost.send({ type: ok ? 'holding' : 'error', id: command.id, message: ok ? undefined : 'idle frame missing' });
    return;
  }
  if (command.type === 'demo') {
    await runTrial(command, 'ended');
    return;
  }
  await runTrial(command, command.wait ?? 'frame');
}

async function runTrial(command: TrialCommand, wait: 'frame' | 'ended'): Promise<void> {
  resetReaction();
  trialStart = performance.now();
  const idleOk = await showIdle(command.dwellMs ?? 0);
  if (!idleOk) {
    frames.length = 0;
    shots.length = 0;
    reply(command, null);
    return;
  }
  const before = stageOpaque();
  clickAt = performance.now();
  frames.length = 0;
  frames.push({ tMs: 0, kind: stageKind(false, before, EMPTY_OPAQUE) });
  shots.length = 0;
  shotsAfter = 0;
  presented = false;
  presentationAt = null;
  markedPresentation = false;
  active = true;
  reactionId = `play-${++seq}`;
  if (mode === 'single') {
    armTarget(videos[0]!);
    single?.begin({ playbackId: reactionId, url: reactionUrl, once: true });
  } else {
    two?.begin({ requestId: reactionId, url: reactionUrl, once: true, clip: 'reaction' });
  }
  await waitUntil(() => presented || presentationAt !== null || failed, TRIAL_TIMEOUT_MS);
  if ((wait === 'ended' || presentationAt !== null) && !failed) {
    await waitUntil(() => ended || failed, TRIAL_TIMEOUT_MS);
  }
  active = false;
  reply(command, clickAt);
}

function resetReaction(): void {
  cancelRvfc?.();
  cancelRvfc = null;
  target = null;
  rvfcSinceArm = 0;
  staleHash = null;
  playResolvedAt = null;
  adapterFirstFrameAt = null;
  shownAt = null;
  presentationAt = null;
  markedPresentation = false;
  ended = false;
  failed = false;
  presented = false;
  preheatReady = false;
}

async function showIdle(dwellMs: number): Promise<boolean> {
  idleId = `idle-${++seq}`;
  if (mode === 'single') {
    idleVideo = videos[0]!;
    raise(idleVideo);
    single?.begin({ playbackId: idleId, url: idleUrl, once: false });
  } else {
    idleVideo = null;
    two?.begin({ requestId: idleId, url: idleUrl, once: false, clip: 'idle' });
  }
  const visible = await waitUntil(() => {
    const video = idleVideo;
    return video !== null && video.readyState >= 2 && opaqueOfVideo(video) >= EMPTY_OPAQUE;
  }, TRIAL_TIMEOUT_MS);
  if (!visible) return false;
  if (mode === 'two-slot-preheat') {
    preheatId = `pre-${++seq}`;
    preheatReady = false;
    two?.preheat({ requestId: preheatId, url: reactionUrl, once: true, clip: 'reaction' });
  }
  if (dwellMs > 0) await sleep(dwellMs);
  return true;
}

function reply(command: TrialCommand, click: number | null): void {
  const reactionAt = frames.find((frame) => frame.kind === 'reaction')?.tMs ?? null;
  const latency =
    click === null
      ? { clickToFirstFrameMs: null, playResolvedMs: null, blankMs: null }
      : assembleLatency({
          clickAt: click,
          presentedAt: reactionAt === null ? null : click + reactionAt,
          playResolvedAt,
          frames,
          closed: ended || presented,
        });
  const presentedAt = click === null || latency.clickToFirstFrameMs === null ? null : click + latency.clickToFirstFrameMs;
  const loadCount = loads.filter((mark) => mark.t >= trialStart && (presentedAt === null || mark.t <= presentedAt)).length;
  benchHost.send({
    type: 'sample',
    id: command.id,
    commandType: command.type,
    play: command.play ?? 'warmup',
    index: command.index ?? 0,
    clickToFirstFrameMs: latency.clickToFirstFrameMs,
    playResolvedMs: latency.playResolvedMs,
    blankMs: latency.blankMs,
    loadCount,
    evidenceBase64: encodeStrip(),
    frames,
    sidecar: {
      adapterFirstFrameMs: click === null || adapterFirstFrameAt === null ? null : adapterFirstFrameAt - click,
      presentationMs: click === null || presentationAt === null ? null : presentationAt - click,
      playResolvedAtMs: latency.playResolvedMs,
      shownMs: click === null || shownAt === null ? null : shownAt - click,
      preheatReadyBeforeClick: preheatReady,
      currentTime: target?.currentTime ?? null,
      idleOpaque: idleVideo ? opaqueOfVideo(idleVideo) : null,
      failed,
      ended,
      stressDelayMs,
      loads: loads
        .filter((mark) => mark.t >= trialStart)
        .map((mark) => ({ url: mark.url, tFromTrialStartMs: click === null ? null : mark.t - click })),
    },
  });
}

function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = performance.now();
  return new Promise((resolve) => {
    const step = (): void => {
      if (predicate()) {
        resolve(true);
        return;
      }
      if (performance.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      requestAnimationFrame(step);
    };
    step();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
