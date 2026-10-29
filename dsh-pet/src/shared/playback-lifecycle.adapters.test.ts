/**
 * 同一组点播场景分别驱动浏览器动画链和桌面 playback.js。
 * 断言写的是契约：提前 playing、回执串号、缺终态都会失败。退出码本身不是通过标准。
 * 时钟、加载器和 play() 都由测试推进，不靠 sleep。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { createOwnAnimation, type PlaybackClock } from '../client/pet/animation/animation.ts';
import type { AssetHandlers, AssetLoader } from '../client/pet/animation/asset-loader.ts';
import { applyPlaybackCue } from '../client/pet/card/animation.ts';
import { PlaybackStore, type PlaybackRecord } from '../host/playback.ts';
import { initialPlaybackState, reducePlayback, type PlaybackCueIdentity } from './playback-lifecycle.ts';
import type { Animations } from './types.ts';

interface Report {
  id: string;
  status: string;
  reason?: string;
}

interface Deferred {
  resolve: () => void;
  reject: (error: Error) => void;
}

/** 适配器写到元素上的 onended。按赋值顺序记录，含后来的 null。 */
interface EndedAssignment {
  element: Media;
  handler: ((event?: Event) => void) | null;
}

class Media {
  src = '';
  loop = true;
  muted = false;
  autoplay = false;
  playsInline = false;
  readyState = 0;
  paused = true;
  error: { code: number } | null = null;
  style: Record<string, string> = {};
  playCalls = 0;
  loadCalls = 0;
  private endedHandler: ((event?: Event) => void) | null = null;
  private errorHandler: (() => void) | null = null;
  readonly classes = new Set<string>();
  readonly listeners = new Map<string, Array<() => void>>();
  readonly plays: Deferred[];
  private readonly readyLog: Array<() => void>;
  private readonly errorLog: Array<() => void>;
  private readonly endedLog: EndedAssignment[];

  constructor(
    plays: Deferred[],
    readyLog: Array<() => void>,
    errorLog: Array<() => void>,
    endedLog: EndedAssignment[],
  ) {
    this.plays = plays;
    this.readyLog = readyLog;
    this.errorLog = errorLog;
    this.endedLog = endedLog;
  }

  set onended(handler: ((event?: Event) => void) | null) {
    this.endedHandler = handler;
    this.endedLog.push({ element: this, handler });
  }

  get onended(): ((event?: Event) => void) | null {
    return this.endedHandler;
  }

  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  };

  set onerror(fn: (() => void) | null) {
    this.errorHandler = fn;
    if (fn) this.errorLog.push(fn);
  }

  get onerror(): (() => void) | null {
    return this.errorHandler;
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
    if (type === 'loadeddata') this.readyLog.push(fn);
  }

  removeEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((entry) => entry !== fn),
    );
  }

  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    return new Promise((resolve, reject) => {
      this.plays.push({ resolve, reject });
    });
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {
    this.loadCalls += 1;
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
}

interface Driver {
  reports: Report[];
  start: (playbackId: string | null, options?: { once?: boolean; url?: string; anim?: string }) => void;
  deliver: (index: number) => void;
  releaseReady: (index: number) => void;
  settlePlay: (index: number, ok?: boolean) => Promise<void>;
  failLoad: (index: number) => void;
  failDecode: (index: number) => void;
  fireTimeout: () => void;
  end: () => void;
  freeze: () => void;
  dispose: () => void;
  loadCount: () => number;
  playCalls: () => number;
  listenerCount: () => number;
  pendingTimers: () => number;
  released: () => string[];
  src: () => string;
  /** 按时间顺序记下的 onended 赋值，函数是适配器当时装上的那个。 */
  endedAssignments: () => EndedAssignment[];
}

const animations = {
  idle: ['idle1'],
  turn: ['turn1'],
  drag: [],
  clicks: [],
  moves: { default: {}, actions: [] },
  categories: [],
  events: {},
} as unknown as Animations;

function browserDriver(onReport?: (report: Report) => void): Driver {
  const plays: Deferred[] = [];
  const readyLog: Array<() => void> = [];
  const errorLog: Array<() => void> = [];
  const endedLog: EndedAssignment[] = [];
  const videoA = new Media(plays, readyLog, errorLog, endedLog);
  const videoB = new Media(plays, readyLog, errorLog, endedLog);
  const requests: Array<{ url: string; handlers: AssetHandlers }> = [];
  const released: string[] = [];
  const timers = new Map<number, () => void>();
  let timerSeq = 0;
  const reports: Report[] = [];
  const clock: PlaybackClock = {
    set: (fn) => {
      const id = ++timerSeq;
      timers.set(id, fn);
      return id;
    },
    clear: (handle) => {
      timers.delete(Number(handle));
    },
  };
  const loader: AssetLoader = {
    load: (url, handlers) => {
      requests.push({ url, handlers });
    },
    abortAll: () => undefined,
    release: (objectUrl) => {
      released.push(objectUrl);
    },
  };
  const anim = createOwnAnimation({
    videoA: () => videoA as unknown as HTMLVideoElement,
    videoB: () => videoB as unknown as HTMLVideoElement,
    cfg: () => ({ id: 'pet-1', assetRoot: 'duck', animations }),
    currentAnim: () => 'idle1',
    workStatus: () => null,
    facing: () => 'left',
    report: (id, status, reason) => {
      const report = { id, status, reason };
      reports.push(report);
      onReport?.(report);
    },
    clearCuePlayback: () => undefined,
    onFrontReady: () => undefined,
    onEnded: () => undefined,
    isDragging: () => false,
    initiallyFrozen: false,
    loader,
    clock,
  });
  return {
    reports,
    start: (playbackId, options = {}) => {
      if (options.url) anim.setCueUrl(options.url);
      anim.switchTo(options.anim ?? 'idle1', options.once ?? true, playbackId);
    },
    deliver: (index) => {
      requests[index]?.handlers.onObjectUrl('blob:' + index);
    },
    releaseReady: (index) => {
      readyLog[index]?.();
    },
    settlePlay: async (index, ok = true) => {
      const play = plays[index];
      assert.ok(play, 'play() 还没调用，不能结算 #' + index);
      if (ok) play.resolve();
      else play.reject(new Error('play-rejected'));
      await Promise.resolve();
    },
    failLoad: (index) => {
      requests[index]?.handlers.onError(new Error('asset'));
    },
    failDecode: (index) => {
      errorLog[index]?.();
    },
    fireTimeout: () => {
      const entry = timers.entries().next().value as [number, () => void] | undefined;
      if (!entry) return;
      timers.delete(entry[0]);
      entry[1]();
    },
    end: () => {
      const front = anim.frontVideo() as unknown as Media | null;
      anim.handleEnded({ currentTarget: front } as unknown as Event);
    },
    freeze: () => {
      anim.setFrozen(true);
    },
    dispose: () => {
      anim.dispose();
    },
    loadCount: () => requests.length,
    playCalls: () => videoA.playCalls + videoB.playCalls,
    listenerCount: () => videoA.listenerCount('loadeddata') + videoB.listenerCount('loadeddata'),
    pendingTimers: () => timers.size,
    released: () => released.slice(),
    src: () => videoB.src || videoA.src,
    endedAssignments: () => endedLog.slice(),
  };
}

interface DesktopSprite {
  pet: { id: string };
  front: number;
  videoA: Media;
  videoB: Media;
  assetBase: string;
  facing: string;
  pendingSquash: boolean;
  pendingMove: null;
  playback: string | null;
  playbackDisposed: boolean;
  playbackAnimName: string;
  frozen: boolean;
  dragState: { active: boolean };
  anim: string;
  animations: { idle: string[]; turn: string[]; drag: string[]; clicks: string[]; events: object };
  workTimer: null;
  workOn: boolean;
  scheduleTimeout: (fn: () => void, ms: number) => number;
  clearScheduledTimeout: (handle: number) => void;
  reportPlayback: (id: string, status: string, reason?: string) => void;
  startSquash: () => void;
  startMoveDrive: () => void;
  stopMove: () => void;
  renderBubble: () => void;
  playIdle: () => void;
  resumeWorkStatusAnim: () => boolean;
  switchTo: (next: string, once: boolean, playbackId: string | null, url?: string) => void;
  handleEnded: () => void;
  applyFreeze: (next: boolean) => void;
  disposePlayback: () => void;
}

let desktopProto: object | null = null;

function desktopPrototype(): object {
  if (desktopProto) return desktopProto;
  const PetSprite = class PetSprite {};
  const sandbox = {
    PetSprite,
    S: { initialPlaybackState, reducePlayback, ANIMATION_EXT: '.webm', isEventAnim: () => false },
    window: { setTimeout, clearTimeout },
    console,
    Promise,
    encodeURIComponent,
    Object,
    Error,
  };
  vm.createContext(sandbox);
  const file = fileURLToPath(new URL('../../runtime/electron-helper/sprite/playback.js', import.meta.url));
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  desktopProto = PetSprite.prototype;
  return desktopProto;
}

function desktopDriver(onReport?: (report: Report) => void): Driver {
  const plays: Deferred[] = [];
  const readyLog: Array<() => void> = [];
  const errorLog: Array<() => void> = [];
  const endedLog: EndedAssignment[] = [];
  const videoA = new Media(plays, readyLog, errorLog, endedLog);
  const videoB = new Media(plays, readyLog, errorLog, endedLog);
  const timers = new Map<number, () => void>();
  let timerSeq = 0;
  const reports: Report[] = [];
  const sprite = Object.assign(Object.create(desktopPrototype()) as DesktopSprite, {
    pet: { id: 'pet-1' },
    front: 0,
    videoA,
    videoB,
    assetBase: '/dsh-pet-7340/thumb/duck/',
    facing: 'left',
    pendingSquash: false,
    pendingMove: null,
    playback: null,
    playbackDisposed: false,
    playbackAnimName: '',
    frozen: false,
    dragState: { active: false },
    anim: 'idle1',
    animations: { idle: ['idle1'], turn: [], drag: [], clicks: [], events: {} },
    workTimer: null,
    workOn: false,
    scheduleTimeout: (fn: () => void) => {
      const id = ++timerSeq;
      timers.set(id, fn);
      return id;
    },
    clearScheduledTimeout: (handle: number) => {
      timers.delete(handle);
    },
    reportPlayback: (id: string, status: string, reason?: string) => {
      const report = { id, status, reason };
      reports.push(report);
      onReport?.(report);
    },
    startSquash: () => undefined,
    startMoveDrive: () => undefined,
    stopMove: () => undefined,
    renderBubble: () => undefined,
    playIdle: () => undefined,
    resumeWorkStatusAnim: () => false,
  });
  return {
    reports,
    start: (playbackId, options = {}) => {
      sprite.switchTo(options.anim ?? 'idle1', options.once ?? true, playbackId, options.url);
    },
    deliver: () => undefined,
    releaseReady: (index) => {
      readyLog[index]?.();
    },
    settlePlay: async (index, ok = true) => {
      const play = plays[index];
      assert.ok(play, 'play() 还没调用，不能结算 #' + index);
      if (ok) play.resolve();
      else play.reject(new Error('play-rejected'));
      await Promise.resolve();
    },
    failLoad: (index) => {
      videoA.error = { code: 2 };
      videoB.error = { code: 2 };
      errorLog[index]?.();
    },
    failDecode: (index) => {
      videoA.error = { code: 3 };
      videoB.error = { code: 3 };
      errorLog[index]?.();
    },
    fireTimeout: () => {
      const entry = timers.entries().next().value as [number, () => void] | undefined;
      if (!entry) return;
      timers.delete(entry[0]);
      entry[1]();
    },
    end: () => {
      sprite.handleEnded();
    },
    freeze: () => {
      sprite.applyFreeze(true);
    },
    dispose: () => {
      sprite.disposePlayback();
    },
    loadCount: () => videoA.loadCalls + videoB.loadCalls,
    playCalls: () => videoA.playCalls + videoB.playCalls,
    listenerCount: () => videoA.listenerCount('loadeddata') + videoB.listenerCount('loadeddata'),
    pendingTimers: () => timers.size,
    released: () => [],
    src: () => videoB.src || videoA.src,
    endedAssignments: () => endedLog.slice(),
  };
}

const drivers = [
  ['浏览器', browserDriver],
  ['桌面', desktopDriver],
] as const;

function statuses(reports: Report[], status: string): Report[] {
  return reports.filter((report) => report.status === status);
}

for (const [name, create] of drivers) {
  describe(name + '适配器', () => {
    test('正常加载、播放、结束：playing 只出现在 play() 兑现之后', async () => {
      const driver = create();
      driver.start('pb-1');
      assert.equal(driver.playCalls(), 0);
      assert.deepEqual(statuses(driver.reports, 'playing'), []);
      driver.deliver(0);
      driver.releaseReady(0);
      assert.equal(driver.playCalls(), 1, 'loaded 之后才允许 play');
      assert.deepEqual(statuses(driver.reports, 'playing'), []);
      driver.end();
      assert.deepEqual(statuses(driver.reports, 'ended'), [], '还没 playing 不能先 ended');
      await driver.settlePlay(0);
      assert.deepEqual(statuses(driver.reports, 'playing'), [{ id: 'pb-1', status: 'playing', reason: undefined }]);
      driver.end();
      assert.deepEqual(driver.reports[driver.reports.length - 1], { id: 'pb-1', status: 'ended', reason: undefined });
      assert.equal(driver.pendingTimers(), 0, '播起来之后加载超时要取消');
    });

    test('pending 时新编号覆盖：成功分支只兑现当前编号', async () => {
      const driver = create();
      driver.start('pb-1');
      driver.start('pb-2');
      assert.equal(driver.loadCount(), 2);
      assert.equal(driver.playCalls(), 0);
      assert.deepEqual(statuses(driver.reports, 'playing'), []);
      assert.deepEqual(statuses(driver.reports, 'cancelled'), [
        { id: 'pb-1', status: 'cancelled', reason: 'superseded' },
      ]);
      driver.deliver(0);
      driver.deliver(1);
      driver.releaseReady(0);
      driver.releaseReady(1);
      assert.equal(driver.playCalls(), 1, '旧加载的 ready 不能再 play');
      await driver.settlePlay(0);
      assert.deepEqual(statuses(driver.reports, 'playing'), [{ id: 'pb-2', status: 'playing', reason: undefined }]);
      driver.end();
      assert.deepEqual(driver.reports[driver.reports.length - 1], { id: 'pb-2', status: 'ended', reason: undefined });
      assert.equal(statuses(driver.reports, 'playing').length, 1);
    });

    test('pending 时新编号覆盖：失败记在当前编号，不能停在 playing', () => {
      const driver = create();
      driver.start('pb-1');
      driver.start('pb-2');
      driver.failLoad(0);
      driver.failLoad(1);
      assert.equal(driver.playCalls(), 0);
      assert.deepEqual(statuses(driver.reports, 'playing'), []);
      assert.deepEqual(statuses(driver.reports, 'failed'), [{ id: 'pb-2', status: 'failed', reason: 'asset-load' }]);
    });

    test('同编号重复不加载；React 清空回声跳过，seq 和真实点击仍执行', () => {
      const same = create();
      same.start('pb-1');
      same.start('pb-1');
      assert.equal(same.loadCount(), 1);
      assert.deepEqual(same.reports, []);

      const driver = create();
      let prev: PlaybackCueIdentity | null = null;
      const ran: Array<string | null> = [];
      const step = (next: PlaybackCueIdentity): void => {
        prev = applyPlaybackCue(prev, next, (cue) => {
          ran.push(cue.cuePlayback);
          driver.start(cue.cuePlayback, { anim: cue.anim, once: cue.once });
        });
      };
      step({ anim: 'idle1', once: true, seq: 1, cuePlayback: 'pb-1' });
      step({ anim: 'idle1', once: true, seq: 1, cuePlayback: null });
      step({ anim: 'idle1', once: true, seq: 2, cuePlayback: null });
      step({ anim: 'idle1', once: true, seq: 3, cuePlayback: 'pb-9' });
      assert.deepEqual(ran, ['pb-1', null, 'pb-9']);
      assert.equal(driver.loadCount(), 3);
    });

    test('同名不同 URL、once 改变都重新加载', () => {
      const driver = create();
      driver.start('pb-1', { url: 'https://assets.example/a.webm' });
      driver.start('pb-1', { url: 'https://assets.example/b.webm' });
      driver.start('pb-1', { url: 'https://assets.example/b.webm', once: false });
      assert.equal(driver.loadCount(), 3);
      assert.deepEqual(statuses(driver.reports, 'cancelled'), []);
      assert.deepEqual(statuses(driver.reports, 'playing'), []);
    });

    test('A→B→C 后乱序释放旧加载和 play 回调', async () => {
      const driver = create();
      driver.start('pb-a');
      driver.deliver(0);
      driver.releaseReady(0);
      driver.start('pb-b');
      driver.deliver(1);
      driver.releaseReady(1);
      driver.start('pb-c');
      driver.deliver(2);
      driver.releaseReady(0);
      driver.releaseReady(1);
      driver.releaseReady(2);
      assert.equal(driver.playCalls(), 3, '三代各自调用一次 play');
      await driver.settlePlay(0);
      await driver.settlePlay(1);
      assert.deepEqual(statuses(driver.reports, 'playing'), []);
      await driver.settlePlay(2);
      assert.deepEqual(statuses(driver.reports, 'playing'), [{ id: 'pb-c', status: 'playing', reason: undefined }]);
      driver.end();
      assert.equal(driver.reports.filter((report) => report.id === 'pb-a' && report.status === 'ended').length, 0);
      assert.equal(driver.reports.filter((report) => report.id === 'pb-b' && report.status === 'ended').length, 0);
      assert.deepEqual(driver.reports[driver.reports.length - 1], { id: 'pb-c', status: 'ended', reason: undefined });
    });

    test('复用槽位后，旧 onended 不能结束当前请求', async () => {
      const driver = create();
      driver.start('pb-a');
      driver.deliver(0);
      driver.releaseReady(0);
      await driver.settlePlay(0);
      const savedA = driver.endedAssignments().find((entry) => entry.handler !== null);
      assert.ok(savedA, 'A 播起来时必须留下适配器装上的 onended');
      const callbackA = savedA.handler;
      assert.ok(callbackA, 'A 播起来时必须留下适配器装上的 onended');

      driver.start('pb-b');
      driver.deliver(1);
      driver.releaseReady(1);
      await driver.settlePlay(1);
      driver.start('pb-c');
      driver.deliver(2);
      driver.releaseReady(2);
      await driver.settlePlay(2);
      const installed = driver.endedAssignments().filter((entry) => entry.handler !== null);
      const savedC = installed[installed.length - 1];
      assert.ok(savedC, 'C 播起来时必须留下自己的 onended');
      const callbackC = savedC.handler;
      assert.ok(callbackC, 'C 播起来时必须留下自己的 onended');
      assert.equal(savedC.element, savedA.element, '双缓冲三轮后 C 与 A 是同一个槽位元素');
      assert.deepEqual(driver.reports[driver.reports.length - 1], {
        id: 'pb-c',
        status: 'playing',
        reason: undefined,
      });
      assert.equal(statuses(driver.reports, 'ended').length, 0);

      const before = driver.reports.length;
      const loads = driver.loadCount();
      callbackA({ currentTarget: savedA.element } as unknown as Event);
      assert.deepEqual(statuses(driver.reports, 'ended'), [], 'A 的旧回调不能给 A 或 C 回 ended');
      assert.equal(driver.reports.length, before, 'A 的旧回调不能产生回执');
      assert.equal(driver.loadCount(), loads, 'A 的旧回调不能开下一段');
      assert.deepEqual(driver.reports[driver.reports.length - 1], {
        id: 'pb-c',
        status: 'playing',
        reason: undefined,
      });

      callbackC({ currentTarget: savedC.element } as unknown as Event);
      assert.deepEqual(
        driver.reports.filter((report) => report.status === 'ended'),
        [{ id: 'pb-c', status: 'ended', reason: undefined }],
      );
    });

    test('解码失败、播放拒绝、超时各自一个 failed，迟到回调不再改状态', async () => {
      const decode = create();
      decode.start('pb-d');
      decode.failDecode(0);
      assert.deepEqual(decode.reports, [{ id: 'pb-d', status: 'failed', reason: 'decode-error' }]);
      decode.releaseReady(0);
      decode.fireTimeout();
      assert.equal(decode.reports.length, 1);

      const rejected = create();
      rejected.start('pb-r');
      rejected.deliver(0);
      rejected.releaseReady(0);
      await rejected.settlePlay(0, false);
      assert.deepEqual(statuses(rejected.reports, 'playing'), []);
      assert.deepEqual(statuses(rejected.reports, 'failed'), [
        { id: 'pb-r', status: 'failed', reason: 'play-rejected' },
      ]);

      const timed = create();
      timed.start('pb-t');
      assert.equal(timed.pendingTimers(), 1);
      timed.fireTimeout();
      assert.deepEqual(timed.reports, [{ id: 'pb-t', status: 'failed', reason: 'timeout' }]);
      timed.deliver(0);
      timed.releaseReady(0);
      assert.equal(timed.playCalls(), 0);
      assert.equal(timed.reports.length, 1);
      assert.equal(timed.pendingTimers(), 0);
    });

    test('取消、冻结、卸载后的迟到事件不恢复；显式点播在冻结后仍可加载', async () => {
      const driver = create();
      driver.start('pb-1');
      driver.deliver(0);
      driver.releaseReady(0);
      await driver.settlePlay(0);
      driver.freeze();
      assert.deepEqual(driver.reports[driver.reports.length - 1], {
        id: 'pb-1',
        status: 'cancelled',
        reason: 'frozen',
      });
      driver.end();
      driver.releaseReady(0);
      assert.equal(statuses(driver.reports, 'playing').length, 1, '冻结后不能再补 playing');
      assert.equal(statuses(driver.reports, 'ended').length, 0);
      driver.start('pb-2');
      assert.equal(driver.loadCount(), 2, '冻结不挡显式点播');

      const gone = create();
      gone.start('pb-1');
      gone.deliver(0);
      if (name === '浏览器') assert.deepEqual(gone.released(), []);
      gone.dispose();
      gone.releaseReady(0);
      gone.fireTimeout();
      assert.equal(gone.playCalls(), 0, '卸载后的 loaded 不能再 play');
      assert.deepEqual(gone.reports, []);
      assert.equal(gone.listenerCount(), 0);
      assert.equal(gone.pendingTimers(), 0);
      if (name === '浏览器') assert.deepEqual(gone.released(), ['blob:0']);
    });
  });
}

describe('适配器接入真实 PlaybackStore', () => {
  for (const [name, create] of drivers) {
    test(name + '：playing 后新请求取消旧请求，失败可查询，提前等待者被唤醒并清理', async () => {
      const store = new PlaybackStore();
      const seen: Array<{ status: string; matched: boolean }> = [];
      const driver = create((report) => {
        store.report(report.id, report.status, report.reason);
      });
      const first = store.create('pet-1', 'idle1');
      const cancelWait = store.wait({
        playbackId: first.playbackId,
        wait: ['playing', 'ended', 'failed', 'cancelled'],
        timeoutMs: 5_000,
        onWake: (record: PlaybackRecord, matched: boolean) => seen.push({ status: record.status, matched }),
      });
      assert.ok(cancelWait);
      driver.start(first.playbackId);
      driver.deliver(0);
      driver.releaseReady(0);
      assert.equal(store.get(first.playbackId)?.status, 'accepted', 'play() 之前宿主不能是 playing');
      assert.deepEqual(seen, []);
      await driver.settlePlay(0);
      assert.equal(store.get(first.playbackId)?.status, 'playing');
      assert.deepEqual(seen, [{ status: 'playing', matched: true }]);
      assert.equal(store.waiterCount(), 0);

      const second = store.create('pet-1', 'idle1');
      assert.equal(store.get(first.playbackId)?.status, 'cancelled');
      assert.equal(store.get(first.playbackId)?.reason, 'superseded');
      const failedSeen: Array<{ status: string; matched: boolean }> = [];
      store.wait({
        playbackId: second.playbackId,
        wait: ['failed', 'ended', 'cancelled'],
        timeoutMs: 5_000,
        onWake: (record, matched) => failedSeen.push({ status: record.status, matched }),
      });
      driver.start(second.playbackId);
      assert.equal(store.get(second.playbackId)?.status, 'accepted');
      driver.failLoad(driver.loadCount() - 1);
      assert.equal(store.get(second.playbackId)?.status, 'failed');
      assert.equal(store.get(second.playbackId)?.reason, 'asset-load');
      assert.deepEqual(failedSeen, [{ status: 'failed', matched: true }]);
      assert.equal(store.waiterCount(), 0);
      assert.equal(store.report(first.playbackId, 'ended'), 'ignored');
      assert.equal(store.get(second.playbackId)?.status, 'failed');
    });
  }
});
