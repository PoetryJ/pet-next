/**
 * M3-9 单槽适配器的呈现暂停测试：假元素/假加载器/假时钟，不启 Electron。
 * 覆盖 CONTRACT 的归属、换代、晚到 Promise、循环闸门与恢复失败。
 * @module pet-next/adapters/media/idle-suspension.test
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaAdapter } from './adapter.ts';
import type { LoadToken, MediaAdapter, MediaClock, MediaElement, MediaLoader, MediaStatusEvent } from './types.ts';

class FakeElement implements MediaElement {
  src = '';
  loop = false;
  muted = false;
  paused = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  playCalls = 0;
  pauseCalls = 0;
  private waiters: Array<(ok: boolean) => void> = [];

  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    return new Promise<void>((resolve, reject) => {
      this.waiters.push((ok) => {
        if (ok) resolve();
        else reject(new Error('play rejected'));
      });
    });
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }

  load(): void {}

  removeAttribute(): void {
    this.src = '';
  }

  settle(ok = true): void {
    const waiter = this.waiters.shift();
    if (!waiter) throw new Error('no pending play');
    if (!ok) this.paused = true;
    waiter(ok);
  }

  get pending(): number {
    return this.waiters.length;
  }

  end(): void {
    this.onended?.();
  }
}

class FakeLoader implements MediaLoader {
  private pending: Array<{ resolve: (value: { src: string }) => void; reject: (error: unknown) => void }> = [];

  load(_url: string, _token: LoadToken): Promise<{ src: string }> {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  release(): void {}

  succeed(index: number, src: string): void {
    this.pending[index]?.resolve({ src });
  }

  fail(index: number): void {
    this.pending[index]?.reject(new Error('asset-load'));
  }
}

class FakeClock implements MediaClock {
  set(): unknown {
    return 1;
  }
  clear(): void {}
}

interface Env {
  element: FakeElement;
  loader: FakeLoader;
  reports: MediaStatusEvent[];
  adapter: MediaAdapter;
}

function harness(options: { idlePause?: boolean } = {}): Env {
  const element = new FakeElement();
  const loader = new FakeLoader();
  const reports: MediaStatusEvent[] = [];
  const adapter = createMediaAdapter({
    element,
    loader,
    clock: new FakeClock(),
    timeoutMs: 1000,
    idlePause: options.idlePause,
    onStatus(event) {
      reports.push(event);
    },
  });
  return { element, loader, reports, adapter };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** 让第 index 次加载兑现，并让紧随其后的 play 兑现。 */
async function playThrough(env: Env, index: number, src = `mem:${index}`): Promise<void> {
  env.loader.succeed(index, src);
  await flush();
  env.element.settle(true);
  await flush();
}

test('默认关闭：setHidden 不产生任何暂停/恢复，也不记 lease', async () => {
  const env = harness();
  env.adapter.begin({ playbackId: 'idle:1', url: 'idle.webm', once: false, clip: 'idle' });
  await playThrough(env, 0);
  env.adapter.setHidden(true);
  assert.equal(env.element.pauseCalls, 0);
  assert.equal(env.element.paused, false);
  assert.deepEqual(env.adapter.idleSuspensionState().lease, null);
  assert.equal(env.adapter.idleSuspensionState().enabled, false);
});

test('隐藏时暂停当前 idle；恢复时只恢复该 owner 且不重报 playing', async () => {
  const env = harness({ idlePause: true });
  env.adapter.begin({ playbackId: 'idle:1', url: 'idle.webm', once: false, clip: 'idle' });
  await playThrough(env, 0);
  const reportsBefore = env.reports.length;

  env.adapter.setHidden(true);
  assert.equal(env.element.paused, true);
  assert.equal(env.adapter.idleSuspensionState().pauseCount, 1);
  assert.equal(env.adapter.idleSuspensionState().lease?.elementIdentity, 'single-primary');

  env.adapter.setHidden(false);
  assert.equal(env.element.paused, false);
  assert.equal(env.element.pending, 1);
  env.element.settle(true);
  await flush();
  assert.equal(env.adapter.idleSuspensionState().resumeCount, 1);
  // 恢复不是新的 begin：没有额外的 playing 上报。
  assert.equal(env.reports.length, reportsBefore);
  assert.equal(env.adapter.phase, 'playing');
});

test('重复 hidden 不重复 pause；重复 visible 不重复 resume', async () => {
  const env = harness({ idlePause: true });
  env.adapter.begin({ playbackId: 'idle:1', url: 'idle.webm', once: false, clip: 'idle' });
  await playThrough(env, 0);
  env.adapter.setHidden(true);
  env.adapter.setHidden(true);
  assert.equal(env.element.pauseCalls, 1);
  env.adapter.setHidden(false);
  env.element.settle(true);
  await flush();
  env.adapter.setHidden(false);
  assert.equal(env.element.pending, 0);
  assert.equal(env.adapter.idleSuspensionState().resumeCount, 1);
});

test('加载中隐藏不暂停；兑现后按最新状态暂停', async () => {
  const env = harness({ idlePause: true });
  env.adapter.begin({ playbackId: 'idle:1', url: 'idle.webm', once: false, clip: 'idle' });
  env.adapter.setHidden(true);
  assert.equal(env.element.paused, true, '元素初始即 paused');
  assert.equal(env.element.playCalls, 0);
  env.loader.succeed(0, 'mem:0');
  await flush();
  assert.equal(env.element.playCalls, 1, '加载兑现后仍要 play 一次以进入 playing');
  env.element.settle(true);
  await flush();
  assert.equal(env.element.paused, true);
  assert.equal(env.adapter.idleSuspensionState().pauseCount, 1);
});

test('once 动作在隐藏时不暂停，结束后再回到 idle 才暂停', async () => {
  const env = harness({ idlePause: true });
  env.adapter.begin({ playbackId: 'idle:1', url: 'idle.webm', once: false, clip: 'idle' });
  await playThrough(env, 0);
  env.adapter.setHidden(true);
  assert.equal(env.adapter.idleSuspensionState().pauseCount, 1);

  env.adapter.begin({ playbackId: 'reaction:1', url: 'react.webm', once: true, clip: 'reaction' });
  await playThrough(env, 1, 'mem:1');
  assert.equal(env.adapter.phase, 'playing');
  assert.equal(env.element.paused, false, 'once 动作照常播放');
  assert.equal(env.adapter.idleSuspensionState().pauseCount, 1);

  env.element.end();
  await flush();
  assert.equal(env.adapter.phase, 'ended');

  env.adapter.begin({ playbackId: 'idle:2', url: 'idle.webm', once: false, clip: 'idle' });
  await playThrough(env, 2, 'mem:2');
  assert.equal(env.adapter.idleSuspensionState().pauseCount, 2);
});

test('隐藏期换素材并复用同一素材：旧归属作废，不会永久冻帧', async () => {
  const env = harness({ idlePause: true });
  env.adapter.begin({ playbackId: 'idle:1', url: 'idle.webm', once: false, clip: 'idle' });
  await playThrough(env, 0, 'mem:same');
  env.adapter.setHidden(true);
  assert.equal(env.element.paused, true);

  // 隐藏期换绑：新 idle 兑现后立即再暂停（新 owner），旧 owner 不再被引用。
  env.adapter.begin({ playbackId: 'idle:2', url: 'idle.webm', once: false, clip: 'idle' });
  await playThrough(env, 1, 'mem:same');
  assert.equal(env.adapter.idleSuspensionState().pauseCount, 2);
  assert.equal(env.adapter.idleSuspensionState().generation, 2);

  env.adapter.setHidden(false);
  env.element.settle(true);
  await flush();
  assert.equal(env.element.paused, false, '恢复后必须真的在播');

  // 再换回旧素材：不因残留标记被冻住。
  env.adapter.begin({ playbackId: 'idle:3', url: 'idle.webm', once: false, clip: 'idle' });
  await playThrough(env, 2, 'mem:same');
  assert.equal(env.element.paused, false);
  assert.equal(env.adapter.phase, 'playing');
});

test('旧的 play Promise 晚到不影响新 owner', async () => {
  const env = harness({ idlePause: true });
  env.adapter.begin({ playbackId: 'idle:1', url: 'idle.webm', once: false, clip: 'idle' });
  env.loader.succeed(0, 'mem:0');
  await flush();
  // 第一代 play 还悬着就换代。
  env.adapter.begin({ playbackId: 'reaction:1', url: 'react.webm', once: true, clip: 'reaction' });
  env.loader.succeed(1, 'mem:1');
  await flush();
  env.element.settle(true); // 旧代 play 兑现（应被世代判断丢弃）
  await flush();
  env.element.settle(true);
  await flush();
  assert.equal(env.adapter.phase, 'playing');
  assert.equal(env.adapter.idleSuspensionState().pauseCount, 0, 'once 动作不暂停');
});

test('隐藏中 onended 循环不重启解码', async () => {
  const env = harness({ idlePause: true });
  env.adapter.begin({ playbackId: 'idle:1', url: 'idle.webm', once: false, clip: 'idle' });
  await playThrough(env, 0);
  env.adapter.setHidden(true);
  const plays = env.element.playCalls;
  env.element.end();
  await flush();
  assert.equal(env.element.playCalls, plays);
  assert.equal(env.adapter.idleSuspensionState().lastSkipReason, 'looping-while-suspended');
});

test('恢复 play 失败走失败路径，不卡在 playing', async () => {
  const env = harness({ idlePause: true });
  env.adapter.begin({ playbackId: 'idle:1', url: 'idle.webm', once: false, clip: 'idle' });
  await playThrough(env, 0);
  env.adapter.setHidden(true);
  env.adapter.setHidden(false);
  env.element.settle(false);
  await flush();
  assert.equal(env.adapter.phase, 'failed');
  assert.ok(env.reports.some((event) => event.status === 'failed'));
  assert.deepEqual(env.adapter.idleSuspensionState().lease, null);
});

test('隐藏挂起期间解码失败：作废旧归属，可见后不把失败元素重新拉起', async () => {
  const env = harness({ idlePause: true });
  env.adapter.begin({ playbackId: 'idle:1', url: 'idle.webm', once: false, clip: 'idle' });
  await playThrough(env, 0);
  env.adapter.setHidden(true);
  assert.equal(env.element.paused, true);

  const plays = env.element.playCalls;
  env.element.onerror?.();
  await flush();
  assert.equal(env.adapter.phase, 'failed');
  assert.deepEqual(env.adapter.idleSuspensionState().lease, null, 'failed 必须先作废旧 lease');

  env.adapter.setHidden(false);
  await flush();
  assert.equal(env.element.playCalls, plays, '失败 owner 不得被恢复');
  assert.equal(env.adapter.idleSuspensionState().resumeCount, 0);
  assert.equal(env.adapter.idleSuspensionState().lastAction, 'none');
});

test('占位层接管：作废旧归属，可见后不为被遮住的元素白解码', async () => {
  const env = harness({ idlePause: true });
  env.adapter.begin({ playbackId: 'idle:1', url: 'idle.webm', once: false, clip: 'idle' });
  await playThrough(env, 0);
  env.adapter.setHidden(true);
  const plays = env.element.playCalls;

  env.adapter.releaseIdleLease('placeholder');
  assert.deepEqual(env.adapter.idleSuspensionState().lease, null, 'placeholder 必须先作废旧 lease');

  env.adapter.setHidden(false);
  await flush();
  assert.equal(env.element.playCalls, plays);
  assert.equal(env.adapter.idleSuspensionState().resumeCount, 0);
  assert.equal(env.element.paused, true);
});

test('恢复在途再次隐藏并由占位层接管：晚到的 play 不得在隐藏期无归属解码', async () => {
  const env = harness({ idlePause: true });
  env.adapter.begin({ playbackId: 'idle:1', url: 'idle.webm', once: false, clip: 'idle' });
  await playThrough(env, 0);
  env.adapter.setHidden(true);
  const plays = env.element.playCalls;

  // 恢复在途 → 再次隐藏（already-suspended，不立即补 pause）→ 占位层清掉归属。
  env.adapter.setHidden(false);
  env.adapter.setHidden(true);
  env.adapter.releaseIdleLease('placeholder');
  assert.equal(env.element.paused, false, 'play 在途时元素处于未暂停');

  env.element.settle(true);
  await flush();
  assert.equal(env.element.playCalls, plays + 1, '只允许在途的那一次 play');
  assert.equal(env.element.paused, true, '兑现后必须按最新隐藏状态重新暂停');
  assert.notEqual(env.adapter.idleSuspensionState().lease, null, '应重新取得归属');
  assert.equal(env.adapter.idleSuspensionState().resumeCount, 0);
  assert.equal(env.adapter.idleSuspensionState().lastAction, 'pause');
});

test('dispose 后到达的恢复结果不再动作', async () => {
  const env = harness({ idlePause: true });
  env.adapter.begin({ playbackId: 'idle:1', url: 'idle.webm', once: false, clip: 'idle' });
  await playThrough(env, 0);
  env.adapter.setHidden(true);
  env.adapter.setHidden(false);
  env.adapter.dispose();
  env.element.settle(true);
  await flush();
  assert.equal(env.adapter.idleSuspensionState().resumeCount, 0);
});
