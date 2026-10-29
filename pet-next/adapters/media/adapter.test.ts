/**
 * 媒体契约：正常播放、加载失败、播放拒绝、超时、替换与卸载、A→B→C、资源清理。
 * 时钟和加载器由测试推进，不使用真实延时。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createMediaAdapter } from './adapter.ts';
import { createElementLoader } from './element-loader.ts';
import type { LoadToken, MediaAdapter, MediaClock, MediaElement, MediaLoader, MediaStatusEvent } from './types.ts';

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

  load(url: string, token: LoadToken): Promise<{ src: string }> {
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

  failDecode(): void {
    this.onerror?.();
  }
}

function harness(): {
  element: FakeElement;
  loader: FakeLoader;
  clock: FakeClock;
  reports: MediaStatusEvent[];
  adapter: MediaAdapter;
} {
  const element = new FakeElement();
  const loader = new FakeLoader();
  const clock = new FakeClock();
  const reports: MediaStatusEvent[] = [];
  const adapter = createMediaAdapter({
    element,
    loader,
    clock,
    timeoutMs: 1000,
    onStatus(event) {
      reports.push(event);
    },
  });
  return { element, loader, clock, reports, adapter };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function playThrough(env: ReturnType<typeof harness>, index: number, src?: string): Promise<void> {
  env.loader.succeed(index, src);
  await flush();
  env.element.settle(true);
  await flush();
}

describe('createMediaAdapter', () => {
  test('正常播放会上报 playing 和 ended，循环片段的 ended 会重播而不是结束', async () => {
    const env = harness();
    env.adapter.begin({ playbackId: 'reaction:1', url: 'react.webm', once: true });
    assert.equal(env.adapter.phase, 'loading');
    assert.equal(env.clock.pending, 1);
    await playThrough(env, 0, 'mem:react');
    assert.equal(env.adapter.phase, 'playing');
    assert.equal(env.element.loop, false);
    assert.equal(env.element.muted, true);
    assert.equal(env.clock.pending, 0);
    env.element.end();
    assert.equal(env.adapter.phase, 'ended');
    assert.deepEqual(env.reports, [
      { playbackId: 'reaction:1', status: 'playing' },
      { playbackId: 'reaction:1', status: 'ended' },
    ]);

    const loop = harness();
    loop.adapter.begin({ playbackId: 'idle:1', url: 'idle.webm', once: false });
    await playThrough(loop, 0, 'mem:idle');
    loop.element.end();
    assert.equal(loop.adapter.phase, 'playing');
    assert.equal(loop.element.playCalls, 2);
    assert.deepEqual(loop.reports, [{ playbackId: 'idle:1', status: 'playing' }]);
  });

  test('加载失败、播放拒绝和超时各自失败，迟到的成功不能复活', async () => {
    const failed = harness();
    failed.adapter.begin({ playbackId: 'idle:1', url: 'missing.webm', once: false });
    failed.loader.fail(0, 'asset-load');
    await flush();
    assert.equal(failed.adapter.phase, 'failed');
    assert.equal(failed.element.playCalls, 0);
    assert.deepEqual(failed.reports, [{ playbackId: 'idle:1', status: 'failed', reason: 'asset-load' }]);
    assert.equal(failed.clock.pending, 0);

    const decode = harness();
    decode.adapter.begin({ playbackId: 'idle:2', url: 'bad.webm', once: false });
    decode.loader.fail(0, 'decode-error');
    await flush();
    assert.deepEqual(decode.reports[0], { playbackId: 'idle:2', status: 'failed', reason: 'decode-error' });

    const rejected = harness();
    rejected.adapter.begin({ playbackId: 'reaction:1', url: 'react.webm', once: true });
    rejected.loader.succeed(0);
    await flush();
    rejected.element.settle(false);
    await flush();
    assert.equal(rejected.adapter.phase, 'failed');
    assert.deepEqual(rejected.reports, [{ playbackId: 'reaction:1', status: 'failed', reason: 'play-rejected' }]);
    rejected.element.end();
    assert.equal(rejected.adapter.phase, 'failed');

    const timed = harness();
    timed.adapter.begin({ playbackId: 'idle:3', url: 'slow.webm', once: false });
    timed.clock.fireNext();
    assert.equal(timed.adapter.phase, 'failed');
    assert.deepEqual(timed.reports, [{ playbackId: 'idle:3', status: 'failed', reason: 'timeout' }]);
    timed.loader.succeed(0);
    await flush();
    assert.equal(timed.element.playCalls, 0);
    assert.equal(timed.adapter.phase, 'failed');
    assert.equal(timed.clock.pending, 0);
  });

  test('替换会取消旧请求并在新源就绪时释放旧地址', async () => {
    const env = harness();
    env.adapter.begin({ playbackId: 'A', url: 'a.webm', once: true });
    await playThrough(env, 0, 'mem:a');
    env.adapter.begin({ playbackId: 'B', url: 'b.webm', once: true });
    assert.equal(env.adapter.generation, 2);
    assert.equal(env.clock.pending, 1);
    env.element.end();
    assert.equal(env.adapter.phase, 'loading');
    await playThrough(env, 1, 'mem:b');
    assert.deepEqual(env.loader.released, ['mem:a']);
    assert.equal(env.adapter.phase, 'playing');
    assert.equal(
      env.reports.some((report) => report.playbackId === 'A' && report.status === 'cancelled'),
      true,
    );
    assert.equal(
      env.reports.some((report) => report.playbackId === 'A' && report.status === 'ended'),
      false,
    );
  });

  test('A→B→C 时旧加载、旧 play 和旧 ended 都不影响 C', async () => {
    const env = harness();
    env.adapter.begin({ playbackId: 'A', url: 'a.webm', once: true });
    env.adapter.begin({ playbackId: 'B', url: 'b.webm', once: true });
    env.adapter.begin({ playbackId: 'C', url: 'c.webm', once: true });
    assert.equal(env.adapter.generation, 3);
    assert.equal(env.loader.pending[0]?.token.aborted, true);
    assert.equal(env.loader.pending[1]?.token.aborted, true);
    assert.equal(env.loader.pending[2]?.token.aborted, false);
    env.loader.succeed(0, 'mem:a');
    env.loader.succeed(1, 'mem:b');
    await flush();
    assert.equal(env.element.playCalls, 0);
    await playThrough(env, 2, 'mem:c');
    env.element.end();
    assert.equal(env.adapter.phase, 'ended');
    assert.deepEqual(
      env.reports.map((report) => `${report.playbackId}:${report.status}`),
      ['A:cancelled', 'B:cancelled', 'C:playing', 'C:ended'],
    );
  });

  test('卸载后清理监听、计时器和已持有地址，迟到回调不能再播放', async () => {
    const env = harness();
    env.adapter.begin({ playbackId: 'idle:1', url: 'idle.webm', once: false });
    await playThrough(env, 0, 'mem:idle');
    env.adapter.dispose();
    assert.equal(env.adapter.phase, 'disposed');
    assert.equal(env.element.onended, null);
    assert.equal(env.element.onerror, null);
    assert.deepEqual(env.element.removed, ['src']);
    assert.equal(env.element.loadCalls, 1);
    assert.deepEqual(env.loader.released, ['mem:idle']);
    assert.equal(env.clock.pending, 0);
    env.element.end();
    env.adapter.begin({ playbackId: 'idle:2', url: 'idle.webm', once: false });
    assert.equal(env.adapter.phase, 'disposed');
    assert.equal(env.loader.pending.length, 1);

    const loading = harness();
    loading.adapter.begin({ playbackId: 'idle:1', url: 'idle.webm', once: false });
    loading.adapter.dispose();
    assert.equal(loading.clock.pending, 0);
    assert.equal(loading.loader.pending[0]?.token.aborted, true);
    loading.loader.succeed(0);
    await flush();
    assert.equal(loading.element.playCalls, 0);
    assert.equal(loading.adapter.phase, 'disposed');
  });

  test('播放中的解码错误进入 failed', async () => {
    const env = harness();
    env.adapter.begin({ playbackId: 'reaction:1', url: 'react.webm', once: true });
    await playThrough(env, 0);
    env.element.failDecode();
    assert.equal(env.adapter.phase, 'failed');
    assert.equal(env.reports.at(-1)?.reason, 'decode-error');
    env.element.failDecode();
    assert.equal(env.reports.filter((report) => report.status === 'failed').length, 1);
  });
});

describe('createElementLoader', () => {
  test('就绪、失败、中止都会卸下监听，release 清掉地址', async () => {
    const video = fakeVideo();
    const loader = createElementLoader(video as unknown as HTMLVideoElement);
    const token = manualToken();
    let settled: { src: string } | Error | undefined;
    const pending = loader.load('file:///clip.webm', token).then(
      (value) => {
        settled = value;
      },
      (error: Error) => {
        settled = error;
      },
    );
    assert.equal(video.listenerCount('loadeddata'), 1);
    video.emit('loadeddata');
    await pending;
    assert.deepEqual(settled, { src: 'file:///clip.webm' });
    assert.equal(video.listenerCount('loadeddata'), 0);
    assert.equal(video.listenerCount('error'), 0);

    const failing = manualToken();
    const failed = loader.load('file:///missing.webm', failing);
    video.emit('error');
    await assert.rejects(failed, /asset-load/);
    assert.equal(video.listenerCount('error'), 0);

    const aborted = manualToken();
    const hanging = loader.load('file:///slow.webm', aborted);
    assert.equal(video.listenerCount('loadeddata'), 1);
    aborted.abort();
    await assert.rejects(hanging, /aborted/);
    assert.equal(video.listenerCount('loadeddata'), 0);
    video.emit('loadeddata');

    video.src = 'file:///clip.webm';
    loader.release('file:///clip.webm');
    assert.equal(video.src, '');
    assert.equal(video.loadCalls, 4);
  });
});

function manualToken(): LoadToken & { abort(): void } {
  const listeners: Array<() => void> = [];
  const token: LoadToken & { abort(): void } = {
    aborted: false,
    onAbort(listener) {
      if (token.aborted) listener();
      else listeners.push(listener);
    },
    abort() {
      if (token.aborted) return;
      token.aborted = true;
      for (const listener of listeners.splice(0)) listener();
    },
  };
  return token;
}

function fakeVideo() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    src: '',
    currentSrc: '',
    loadCalls: 0,
    onended: null as (() => void) | null,
    onerror: null as (() => void) | null,
    addEventListener(type: string, fn: () => void) {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
    emit(type: string) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    load() {
      this.loadCalls += 1;
    },
    getAttribute(name: string) {
      return name === 'src' ? this.src || null : null;
    },
    removeAttribute(name: string) {
      if (name === 'src') this.src = '';
    },
  };
}
