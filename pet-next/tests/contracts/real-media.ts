/**
 * 用真实双槽工厂跑契约用例。
 * 加载和时钟仍由测试推进；元素是替身，不启动 Electron。
 * @module pet-next/tests/contracts/real-media
 */
import { createTwoSlotAdapter } from '../../adapters/media/two-slot/adapter.ts';
import type { SlotSurface } from '../../adapters/media/two-slot/types.ts';
import type { LoadToken, MediaClock, MediaElement, MediaLoader } from '../../adapters/media/types.ts';
import type { MediaSlotIndex, SlotToken, TwoSlotAdapter, TwoSlotNotice } from '../../contracts/media-slot.ts';
import { FakeClock } from './controlled.ts';
import type { PrepareResult } from './media-double.ts';

interface PendingLoad {
  url: string;
  token: LoadToken;
  resolve(value: { src: string }): void;
  reject(reason: unknown): void;
  settled: boolean;
}

interface FrameListener {
  token: SlotToken;
  requestId: string;
  listener: () => void;
}

export interface MediaHarness {
  readonly adapter: TwoSlotAdapter;
  readonly notices: TwoSlotNotice[];
  readonly clock: FakeClock;
  settlePrepare(requestId: string, result: PrepareResult): void;
  emitEnded(token: SlotToken, requestId: string): void;
  emitFirstFrame(token: SlotToken, requestId: string): void;
  tokenFor(requestId: string): SlotToken;
  clearNotices(): void;
}

class HarnessElement implements MediaElement {
  src = '';
  loop = false;
  muted = false;
  paused = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;

  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {
    return undefined;
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
}

class HarnessLoader implements MediaLoader {
  readonly pending: PendingLoad[] = [];

  load(url: string, token: LoadToken): Promise<{ src: string }> {
    return new Promise((resolve, reject) => {
      this.pending.push({ url, token, resolve, reject, settled: false });
    });
  }

  release(_src: string): void {
    return undefined;
  }
}

class HarnessSurface implements SlotSurface {
  readonly element = new HarnessElement();
  readonly loader = new HarnessLoader();
  readonly frames: FrameListener[] = [];
  lastShown: SlotToken | null = null;
  lastRequestId: string | null = null;

  watchFirstFrame(listener: () => void): () => void {
    const token = this.lastShown;
    const requestId = this.lastRequestId;
    if (token === null || requestId === null) return () => undefined;
    const entry = { token, requestId, listener };
    this.frames.push(entry);
    return () => {
      const index = this.frames.indexOf(entry);
      if (index >= 0) this.frames.splice(index, 1);
    };
  }
}

/**
 * 创建接到 `createTwoSlotAdapter` 的用例夹具。
 * 还没有通知时，按加载落到哪个槽记下世代；通知里的 token 覆盖推断值。
 */
export function createRealMedia(options: { mode: TwoSlotAdapter['mode']; timeoutMs: number }): MediaHarness {
  const clock = new FakeClock();
  const surfaces: [HarnessSurface, HarnessSurface] = [new HarnessSurface(), new HarnessSurface()];
  const notices: TwoSlotNotice[] = [];
  const tokens = new Map<string, SlotToken>();
  const loads = new Map<string, PendingLoad>();
  let epoch = 0;
  let visible: SlotToken | null = null;
  let visibleRequestId: string | null = null;
  const clockProbe = probeClock(clock);

  const adapter = createTwoSlotAdapter({
    mode: options.mode,
    slots: surfaces,
    clock: clockProbe.clock,
    timeoutMs: options.timeoutMs,
    onNotice(notice) {
      notices.push(notice);
      tokens.set(notice.requestId, notice.token);
      epoch = Math.max(epoch, notice.token.generation);
      if (notice.type !== 'shown') return;
      visible = notice.token;
      visibleRequestId = notice.requestId;
      const surface = surfaces[notice.token.slot];
      surface.lastShown = notice.token;
      surface.lastRequestId = notice.requestId;
    },
  });

  const begin = adapter.begin.bind(adapter);
  const preheat = adapter.preheat.bind(adapter);
  adapter.begin = (request) => {
    note(request.requestId, request.url, () => {
      begin(request);
    });
  };
  adapter.preheat = (request) => {
    note(request.requestId, request.url, () => {
      preheat(request);
    });
  };

  function note(requestId: string, url: string, run: () => void): void {
    const beforeLoads = [surfaces[0].loader.pending.length, surfaces[1].loader.pending.length] as const;
    const beforeSets = clockProbe.sets;
    const beforeNotices = notices.length;
    run();
    const announced = notices.slice(beforeNotices).find((notice) => notice.requestId === requestId);
    if (announced) {
      tokens.set(requestId, announced.token);
      epoch = Math.max(epoch, announced.token.generation);
      return;
    }
    const gained = gainedSlot(beforeLoads, surfaces);
    if (clockProbe.sets === beforeSets && gained === null) return;
    epoch += 1;
    const slot = gained ?? inflightSlot(surfaces, url) ?? 0;
    tokens.set(requestId, { slot, generation: epoch });
    if (gained !== null) {
      const pending = surfaces[gained].loader.pending.at(-1);
      if (pending) loads.set(requestId, pending);
      return;
    }
    const shared = inflightLoad(surfaces, url);
    if (shared) loads.set(requestId, shared);
  }

  return {
    adapter,
    notices,
    clock,
    settlePrepare(requestId, result) {
      const pending = loads.get(requestId);
      if (!pending || pending.settled) return;
      pending.settled = true;
      if (result.ok) pending.resolve({ src: `mem:${pending.url}` });
      else pending.reject(Object.assign(new Error(result.reason), { reason: result.reason }));
    },
    emitEnded(token, requestId) {
      if (!sameToken(visible, token) || visibleRequestId !== requestId) return;
      surfaces[token.slot].element.onended?.();
    },
    emitFirstFrame(token, requestId) {
      const entry = surfaces[token.slot].frames.find(
        (frame) => sameToken(frame.token, token) && frame.requestId === requestId,
      );
      entry?.listener();
    },
    tokenFor(requestId) {
      const token = tokens.get(requestId);
      if (!token) throw new Error(`no token for ${requestId}`);
      return token;
    },
    clearNotices() {
      notices.length = 0;
    },
  };
}

function probeClock(clock: FakeClock): { clock: MediaClock; sets: number } {
  const probe = { sets: 0 };
  const original = clock.set.bind(clock);
  return {
    get sets() {
      return probe.sets;
    },
    clock: {
      set(fn, delayMs) {
        probe.sets += 1;
        return original(fn, delayMs);
      },
      clear(handle) {
        clock.clear(handle);
      },
    },
  };
}

function gainedSlot(
  before: readonly [number, number],
  surfaces: readonly [HarnessSurface, HarnessSurface],
): MediaSlotIndex | null {
  if (surfaces[0].loader.pending.length > before[0]) return 0;
  if (surfaces[1].loader.pending.length > before[1]) return 1;
  return null;
}

function inflightSlot(surfaces: readonly [HarnessSurface, HarnessSurface], url: string): MediaSlotIndex | null {
  if (surfaces[1].loader.pending.some((item) => item.url === url && !item.token.aborted && !item.settled)) return 1;
  if (surfaces[0].loader.pending.some((item) => item.url === url && !item.token.aborted && !item.settled)) return 0;
  return null;
}

function inflightLoad(surfaces: readonly [HarnessSurface, HarnessSurface], url: string): PendingLoad | null {
  for (const surface of surfaces) {
    for (const item of surface.loader.pending) {
      if (item.url === url && !item.token.aborted && !item.settled) return item;
    }
  }
  return null;
}

function sameToken(left: SlotToken | null, right: SlotToken): boolean {
  return left !== null && left.slot === right.slot && left.generation === right.generation;
}
