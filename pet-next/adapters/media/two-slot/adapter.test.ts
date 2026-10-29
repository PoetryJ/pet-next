/**
 * 双槽适配器：切换顺序、旧回调隔离、准备失败时保留画面。
 * 时钟和加载器由测试推进，不使用真实延时。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SlotPlayRequest, TwoSlotNotice } from '../../../contracts/media-slot.ts';
import { createTwoSlotAdapter } from './adapter.ts';
import type { SlotSurface, TwoSlotRuntime } from './types.ts';
import type { LoadToken, MediaClock, MediaElement, MediaLoader } from '../types.ts';

class FakeClock implements MediaClock {
  private nextId = 1;
  readonly timers = new Map<number, () => void>();

  set(fn: () => void): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, fn);
    return id;
  }

  clear(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle);
  }

  get pending(): number {
    return this.timers.size;
  }

  fireNext(): void {
    const id = this.timers.keys().next().value;
    if (id === undefined) throw new Error('no timer');
    const fn = this.timers.get(id);
    this.timers.delete(id);
    fn?.();
  }
}

interface PendingLoad {
  url: string;
  token: LoadToken;
  resolve: (value: { src: string }) => void;
  reject: (error: Error) => void;
}

class FakeLoader implements MediaLoader {
  readonly pending: PendingLoad[] = [];
  readonly released: string[] = [];
  loadCount = 0;

  load(url: string, token: LoadToken): Promise<{ src: string }> {
    this.loadCount += 1;
    return new Promise((resolve, reject) => {
      this.pending.push({ url, token, resolve, reject });
    });
  }

  release(src: string): void {
    this.released.push(src);
  }

  succeed(index: number, src?: string): void {
    const item = this.pending[index];
    if (!item) throw new Error(`missing load ${index}`);
    item.resolve({ src: src ?? `mem:${item.url}` });
  }

  fail(index: number, reason = 'asset-load'): void {
    const item = this.pending[index];
    if (!item) throw new Error(`missing load ${index}`);
    item.reject(Object.assign(new Error(reason), { reason }));
  }
}

class FakeElement implements MediaElement {
  src = '';
  loop = false;
  muted = false;
  paused = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  playCalls = 0;
  pauseCalls = 0;
  loadCalls = 0;
  removed: string[] = [];
  private waiters: Array<(ok: boolean) => void> = [];

  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    return new Promise((resolve, reject) => {
      this.waiters.push((ok) => {
        if (ok) resolve();
        else {
          this.paused = true;
          reject(new Error('play-rejected'));
        }
      });
    });
  }

  settle(ok = true): void {
    const waiter = this.waiters.shift();
    if (!waiter) throw new Error('no pending play');
    waiter(ok);
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }

  load(): void {
    this.loadCalls += 1;
  }

  removeAttribute(name: string): void {
    this.removed.push(name);
    if (name === 'src') this.src = '';
  }

  end(): void {
    this.onended?.();
  }
}

class FakeSurface implements SlotSurface {
  readonly element = new FakeElement();
  readonly loader = new FakeLoader();
  watchCalls = 0;
  private listeners: Array<() => void> = [];

  watchFirstFrame(listener: () => void): () => void {
    this.watchCalls += 1;
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  emitFrame(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function request(requestId: string, url: string, once = true, clip: SlotPlayRequest['clip'] = 'reaction'): SlotPlayRequest {
  return { requestId, url, once, clip };
}

function harness(mode: TwoSlotRuntime['mode'] = 'two-slot') {
  const slots: [FakeSurface, FakeSurface] = [new FakeSurface(), new FakeSurface()];
  const clock = new FakeClock();
  const notices: TwoSlotNotice[] = [];
  const pausedAtShown: boolean[] = [];
  const adapter = createTwoSlotAdapter({
    mode,
    slots,
    clock,
    timeoutMs: 1000,
    onNotice(notice) {
      if (notice.type === 'shown') pausedAtShown.push(slots[0].element.paused);
      notices.push(notice);
    },
  });
  return { slots, clock, notices, pausedAtShown, adapter };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function prepare(slot: FakeSurface, index = slot.loader.pending.length - 1): Promise<void> {
  const item = slot.loader.pending[index];
  if (!item) throw new Error(`missing load ${index}`);
  slot.loader.succeed(index, `mem:${item.url}`);
  await flush();
}

function typesOf(notices: readonly TwoSlotNotice[]): string[] {
  return notices.map((notice) => `${notice.type}:${notice.requestId}`);
}

describe('createTwoSlotAdapter', () => {
  test('旧槽继续显示，新槽准备完成后才切换并暂停旧槽', async () => {
    const env = harness();
    env.adapter.begin(request('idle-1', 'idle.webm', false, 'idle'));
    await prepare(env.slots[0]);
    env.slots[0].element.settle(true);
    await flush();
    env.slots[0].emitFrame();
    assert.equal(env.slots[0].element.paused, false);
    assert.equal(env.slots[0].element.src, 'mem:idle.webm');
    assert.deepEqual(typesOf(env.notices), [
      'prepared:idle-1',
      'shown:idle-1',
      'playing:idle-1',
      'first-frame:idle-1',
    ]);

    env.adapter.begin(request('react-1', 'react.webm'));
    assert.equal(env.slots[0].element.paused, false);
    assert.equal(env.slots[1].element.playCalls, 0);
    await prepare(env.slots[1]);
    assert.equal(env.pausedAtShown[1], false);
    assert.equal(env.slots[0].element.paused, true);
    assert.equal(env.slots[0].element.src, 'mem:idle.webm');
    env.slots[1].element.settle(true);
    await flush();
    const shown = env.notices.find((notice) => notice.type === 'shown' && notice.requestId === 'react-1');
    assert.equal(shown?.type === 'shown' && shown.token.slot, 1);
    assert.equal(env.notices.some((notice) => notice.type === 'playing' && notice.requestId === 'react-1'), true);
    assert.equal(env.slots[0].loader.released.includes('mem:idle.webm'), false);
    env.slots[1].element.end();
    env.slots[0].element.end();
    const ended = env.notices.filter((notice) => notice.type === 'ended');
    assert.deepEqual(
      ended.map((notice) => notice.requestId),
      ['react-1'],
    );
    assert.equal(ended[0]?.type === 'ended' && ended[0].token.slot === 1, true);
  });

  test('旧世代的加载和 play 兑现不影响新请求', async () => {
    const env = harness();
    env.adapter.begin(request('A', 'a.webm'));
    env.adapter.begin(request('B', 'b.webm'));
    env.adapter.begin(request('C', 'c.webm'));
    assert.equal(env.slots[0].loader.pending[0]?.token.aborted, true);
    assert.equal(env.slots[0].loader.pending[1]?.token.aborted, true);
    assert.equal(env.slots[0].loader.pending[2]?.token.aborted, false);
    env.slots[0].loader.succeed(0, 'mem:a.webm');
    env.slots[0].loader.succeed(1, 'mem:b.webm');
    await flush();
    assert.equal(env.slots[0].element.playCalls, 0);
    assert.equal(env.slots[1].element.playCalls, 0);
    await prepare(env.slots[0], 2);
    env.slots[0].element.settle(true);
    await flush();
    assert.deepEqual(typesOf(env.notices), ['prepared:C', 'shown:C', 'playing:C']);
    const playing = env.notices.find((notice) => notice.type === 'playing');
    assert.equal(playing?.type === 'playing' && playing.token.generation > 0, true);
  });

  test('另一个槽先准备好时，不能把当前播放请求切过去', async () => {
    const env = harness('two-slot-preheat');
    env.adapter.preheat(request('pre-1', 'react.webm'));
    env.adapter.begin(request('play-1', 'idle.webm', false, 'idle'));
    await prepare(env.slots[1]);
    assert.deepEqual(typesOf(env.notices), ['prepared:pre-1']);
    assert.equal(env.slots[1].element.playCalls, 0);
    assert.equal(env.slots[1].element.paused, true);
    assert.equal(env.slots[1].watchCalls, 0);
    env.slots[1].element.end();
    env.slots[1].emitFrame();
    assert.equal(env.notices.some((notice) => notice.type === 'playing' || notice.type === 'ended'), false);

    await prepare(env.slots[0]);
    env.slots[0].element.settle(true);
    await flush();
    env.slots[1].element.end();
    const playing = env.notices.find((notice) => notice.type === 'playing');
    const prepared = env.notices.find((notice) => notice.type === 'prepared' && notice.requestId === 'pre-1');
    assert.equal(playing?.type === 'playing' && playing.requestId === 'play-1' && playing.token.slot === 0, true);
    assert.equal(prepared?.type === 'prepared' && prepared.token.slot === 1, true);
    if (playing?.type === 'playing' && prepared?.type === 'prepared') {
      assert.equal(playing.token.generation === prepared.token.generation, false);
    }
    assert.equal(env.notices.some((notice) => notice.type === 'playing' && notice.requestId === 'pre-1'), false);
    assert.equal(env.notices.some((notice) => notice.type === 'ended'), false);
  });

  test('准备失败保留可见画面，并带上仍在显示的请求', async () => {
    const env = harness();
    env.adapter.begin(request('idle-1', 'idle.webm', false, 'idle'));
    await prepare(env.slots[0]);
    env.slots[0].element.settle(true);
    await flush();
    const pauseCalls = env.slots[0].element.pauseCalls;
    env.adapter.begin(request('react-1', 'react.webm'));
    env.slots[1].loader.fail(0, 'asset-load');
    await flush();
    assert.equal(env.slots[0].element.paused, false);
    assert.equal(env.slots[0].element.src, 'mem:idle.webm');
    assert.equal(env.slots[0].element.pauseCalls, pauseCalls);
    assert.equal(env.slots[0].loader.released.includes('mem:idle.webm'), false);
    assert.equal(env.notices.some((notice) => notice.type === 'shown' && notice.requestId === 'react-1'), false);
    const failed = env.notices.find((notice) => notice.type === 'failed');
    assert.equal(failed?.type === 'failed', true);
    if (failed?.type !== 'failed') return;
    assert.equal(failed.requestId, 'react-1');
    assert.equal(failed.reason, 'asset-load');
    assert.equal(failed.keptRequestId, 'idle-1');
    assert.equal(failed.token.slot, 1);
    const shown = env.notices.find((notice) => notice.type === 'shown' && notice.requestId === 'idle-1');
    assert.equal(shown?.type === 'shown' && failed.token.generation !== shown.token.generation, true);
  });

  test('进行中的预热被新播放请求接过时，仍只有一次加载且预热编号不会 playing', async () => {
    const env = harness('two-slot-preheat');
    env.adapter.preheat(request('pre-1', 'react.webm'));
    env.adapter.begin(request('play-2', 'react.webm'));
    assert.equal(env.slots[0].loader.loadCount + env.slots[1].loader.loadCount, 1);
    await prepare(env.slots[1]);
    env.slots[1].element.settle(true);
    await flush();
    assert.deepEqual(typesOf(env.notices), ['prepared:play-2', 'shown:play-2', 'playing:play-2']);
    assert.equal(env.notices.some((notice) => notice.requestId === 'pre-1' && notice.type !== 'prepared'), false);
    assert.equal(env.notices.some((notice) => notice.type === 'playing' && notice.requestId === 'pre-1'), false);
  });

  test('预热不产生 playing 或 ended；同一资源换新请求编号才会播放', async () => {
    const cold = harness('two-slot');
    cold.adapter.preheat(request('pre-1', 'react.webm'));
    assert.equal(cold.slots[0].loader.loadCount + cold.slots[1].loader.loadCount, 0);
    assert.equal(cold.notices.length, 0);

    const env = harness('two-slot-preheat');
    env.adapter.preheat(request('idle-pre', 'idle.webm', false, 'idle'));
    assert.equal(env.slots[1].loader.loadCount, 0);
    env.adapter.preheat(request('pre-1', 'react.webm'));
    await prepare(env.slots[1]);
    env.slots[1].emitFrame();
    env.slots[1].element.end();
    assert.deepEqual(typesOf(env.notices), ['prepared:pre-1']);
    assert.equal(env.slots[1].element.playCalls, 0);
    assert.equal(env.slots[1].watchCalls, 0);

    env.adapter.begin(request('pre-1', 'react.webm'));
    assert.equal(env.slots[1].loader.loadCount, 1);
    assert.equal(env.notices.some((notice) => notice.type === 'playing'), false);

    env.adapter.begin(request('play-2', 'react.webm'));
    await flush();
    assert.equal(env.slots[1].loader.loadCount, 1);
    assert.equal(env.slots[0].loader.loadCount, 0);
    env.slots[1].element.settle(true);
    await flush();
    const playing = env.notices.find((notice) => notice.type === 'playing');
    const prepared = env.notices.find((notice) => notice.type === 'prepared');
    assert.equal(playing?.type === 'playing' && playing.requestId === 'play-2', true);
    if (playing?.type === 'playing' && prepared?.type === 'prepared') {
      assert.equal(playing.token.generation === prepared.token.generation, false);
      assert.equal(playing.token.slot, prepared.token.slot);
    }
  });

  test('预热失败和准备超时都留下正在显示的画面', async () => {
    const env = harness('two-slot-preheat');
    env.adapter.begin(request('idle-1', 'idle.webm', false, 'idle'));
    await prepare(env.slots[0]);
    env.slots[0].element.settle(true);
    await flush();
    env.adapter.preheat(request('pre-1', 'react.webm'));
    env.slots[1].loader.fail(0, 'decode-error');
    await flush();
    assert.equal(env.slots[0].element.paused, false);
    assert.equal(env.slots[0].element.src, 'mem:idle.webm');
    const preheatFailed = env.notices.find((notice) => notice.type === 'failed' && notice.requestId === 'pre-1');
    assert.equal(preheatFailed?.type === 'failed' && preheatFailed.keptRequestId === 'idle-1', true);
    assert.equal(preheatFailed?.type === 'failed' && preheatFailed.reason === 'decode-error', true);
    assert.equal(env.notices.some((notice) => notice.type === 'playing' && notice.requestId === 'pre-1'), false);

    env.adapter.begin(request('react-2', 'react.webm'));
    assert.equal(env.clock.pending, 1);
    env.clock.fireNext();
    await flush();
    assert.equal(env.slots[0].element.paused, false);
    assert.equal(env.slots[0].element.src, 'mem:idle.webm');
    const timed = env.notices.find((notice) => notice.type === 'failed' && notice.requestId === 'react-2');
    assert.equal(timed?.type === 'failed' && timed.reason === 'timeout' && timed.keptRequestId === 'idle-1', true);
    env.slots[1].loader.succeed(env.slots[1].loader.pending.length - 1, 'mem:react.webm');
    await flush();
    assert.equal(env.slots[1].element.playCalls, 0);
    assert.equal(env.slots[0].element.paused, false);
  });

  test('同一播放请求不重复加载；销毁后的回调不能再播放', async () => {
    const env = harness();
    env.adapter.begin(request('idle-1', 'idle.webm', false, 'idle'));
    env.adapter.begin(request('idle-1', 'idle.webm', false, 'idle'));
    assert.equal(env.slots[0].loader.loadCount, 1);
    env.adapter.dispose();
    env.slots[0].loader.succeed(0, 'mem:idle.webm');
    await flush();
    assert.equal(env.slots[0].element.playCalls, 0);
    assert.equal(env.notices.length, 0);
    env.adapter.begin(request('idle-2', 'idle.webm', false, 'idle'));
    assert.equal(env.slots[0].loader.loadCount, 1);
    assert.equal(env.slots[1].loader.loadCount, 0);
  });

  test('旧槽迟到的 play 兑现不会给新请求发出 playing', async () => {
    const env = harness();
    env.adapter.begin(request('A', 'a.webm'));
    await prepare(env.slots[0]);
    env.adapter.begin(request('B', 'b.webm'));
    await prepare(env.slots[1]);
    env.slots[0].element.settle(true);
    await flush();
    assert.equal(env.notices.some((notice) => notice.type === 'playing'), false);
    env.slots[1].element.settle(true);
    await flush();
    assert.deepEqual(
      env.notices.filter((notice) => notice.type === 'playing').map((notice) => notice.requestId),
      ['B'],
    );
    env.slots[0].element.end();
    assert.equal(env.notices.some((notice) => notice.type === 'ended'), false);
  });

  test('超过两个槽时直接拒绝', () => {
    const slots = [new FakeSurface(), new FakeSurface(), new FakeSurface()];
    assert.throws(
      () =>
        createTwoSlotAdapter({
          mode: 'two-slot',
          slots: slots as unknown as [FakeSurface, FakeSurface],
          clock: new FakeClock(),
          timeoutMs: 1000,
          onNotice() {
            return undefined;
          },
        }),
      /2 media slots/,
    );
  });
});
