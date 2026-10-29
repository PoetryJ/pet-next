/**
 * 点播生命周期内核：不碰 DOM、时钟和宿主记录表。
 * 提前 playing、世代串号、重复终态都要在这里失败。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  initialPlaybackState,
  isPlaybackCueEcho,
  reducePlayback,
  type PlaybackRequest,
  type PlaybackState,
} from './playback-lifecycle.ts';

function request(playbackId: string | null, url = 'https://assets.example/idle1.webm', once = true): PlaybackRequest {
  return { playbackId, asset: { url, once } };
}

function effectsOf(state: PlaybackState, event: Parameters<typeof reducePlayback>[1]) {
  return reducePlayback(state, event);
}

describe('reducePlayback', () => {
  test('begin 只加载，loaded 只允许 play，playing 要等 play 兑现', () => {
    const begun = effectsOf(initialPlaybackState(), { type: 'begin', request: request('pb-1') });
    assert.equal(begun.state.phase, 'loading');
    assert.equal(begun.state.generation, 1);
    assert.deepEqual(
      begun.effects.map((effect) => effect.type),
      ['load'],
    );
    const loaded = effectsOf(begun.state, { type: 'loaded', generation: 1 });
    assert.equal(loaded.state.phase, 'ready');
    assert.deepEqual(loaded.effects, [{ type: 'play', generation: 1 }]);
    const playing = effectsOf(loaded.state, { type: 'playResolved', generation: 1, ok: true });
    assert.equal(playing.state.phase, 'playing');
    assert.deepEqual(playing.effects, [{ type: 'report', playbackId: 'pb-1', status: 'playing' }]);
    const ended = effectsOf(playing.state, { type: 'ended', generation: 1 });
    assert.equal(ended.state.phase, 'ended');
    assert.deepEqual(ended.effects, [{ type: 'report', playbackId: 'pb-1', status: 'ended' }]);
  });

  test('新编号覆盖旧请求并升代，同名也要重新 load', () => {
    const first = effectsOf(initialPlaybackState(), { type: 'begin', request: request('pb-1') });
    const second = effectsOf(first.state, { type: 'begin', request: request('pb-2') });
    assert.equal(second.state.generation, 2);
    assert.equal(second.state.request?.playbackId, 'pb-2');
    assert.deepEqual(second.effects, [
      { type: 'report', playbackId: 'pb-1', status: 'cancelled', reason: 'superseded' },
      { type: 'abort', generation: 1 },
      { type: 'load', generation: 2, request: request('pb-2') },
    ]);
    assert.equal(effectsOf(second.state, { type: 'loaded', generation: 1 }).effects.length, 0);
    assert.equal(effectsOf(second.state, { type: 'playResolved', generation: 1, ok: true }).effects.length, 0);
    const failed = effectsOf(second.state, { type: 'failed', generation: 2, reason: 'asset-load' });
    assert.equal(failed.state.phase, 'failed');
    assert.deepEqual(failed.effects[1], { type: 'report', playbackId: 'pb-2', status: 'failed', reason: 'asset-load' });
  });

  test('同一当前请求重复提交没有加载也没有回执', () => {
    const first = effectsOf(initialPlaybackState(), { type: 'begin', request: request('pb-1') });
    const again = effectsOf(first.state, { type: 'begin', request: request('pb-1') });
    assert.equal(again.state, first.state);
    assert.deepEqual(again.effects, []);
    const playing = effectsOf(effectsOf(first.state, { type: 'loaded', generation: 1 }).state, {
      type: 'playResolved',
      generation: 1,
      ok: true,
    }).state;
    const replay = effectsOf(playing, { type: 'begin', request: request('pb-1') });
    assert.equal(replay.state, playing);
    assert.deepEqual(replay.effects, []);
  });

  test('同名不同 URL、once 变化都是新请求', () => {
    const first = effectsOf(initialPlaybackState(), {
      type: 'begin',
      request: request('pb-1', 'https://a/1.webm', false),
    });
    const otherUrl = effectsOf(first.state, { type: 'begin', request: request('pb-1', 'https://a/2.webm', false) });
    assert.equal(otherUrl.state.generation, 2);
    assert.equal(
      otherUrl.effects.some((effect) => effect.type === 'load'),
      true,
    );
    assert.equal(
      otherUrl.effects.some((effect) => effect.type === 'report'),
      false,
    );
    const otherOnce = effectsOf(otherUrl.state, { type: 'begin', request: request('pb-1', 'https://a/2.webm', true) });
    assert.equal(otherOnce.state.generation, 3);
  });

  test('A→B→C 后旧世代的 loaded、play 与 failed 都丢弃', () => {
    let state = effectsOf(initialPlaybackState(), { type: 'begin', request: request('A') }).state;
    state = effectsOf(state, { type: 'begin', request: request('B') }).state;
    const last = effectsOf(state, { type: 'begin', request: request('C') });
    state = last.state;
    assert.equal(state.generation, 3);
    for (const generation of [1, 2]) {
      assert.equal(effectsOf(state, { type: 'loaded', generation }).effects.length, 0);
      assert.equal(effectsOf(state, { type: 'playResolved', generation, ok: true }).effects.length, 0);
      assert.equal(effectsOf(state, { type: 'failed', generation, reason: 'timeout' }).effects.length, 0);
      assert.equal(effectsOf(state, { type: 'ended', generation }).effects.length, 0);
    }
    state = effectsOf(state, { type: 'loaded', generation: 3 }).state;
    state = effectsOf(state, { type: 'playResolved', generation: 3, ok: true }).state;
    assert.deepEqual(effectsOf(state, { type: 'ended', generation: 3 }).effects, [
      { type: 'report', playbackId: 'C', status: 'ended' },
    ]);
  });

  test('加载、解码、拒绝、超时各自失败，且只有一个终态', () => {
    const loading = effectsOf(initialPlaybackState(), { type: 'begin', request: request('pb-1') }).state;
    const timedOut = effectsOf(loading, { type: 'failed', generation: 1, reason: 'timeout' });
    assert.deepEqual(timedOut.effects[1], { type: 'report', playbackId: 'pb-1', status: 'failed', reason: 'timeout' });
    assert.equal(effectsOf(timedOut.state, { type: 'loaded', generation: 1 }).effects.length, 0);
    assert.equal(effectsOf(timedOut.state, { type: 'playResolved', generation: 1, ok: true }).effects.length, 0);
    assert.equal(effectsOf(timedOut.state, { type: 'ended', generation: 1 }).effects.length, 0);

    const decoded = effectsOf(loading, { type: 'failed', generation: 1, reason: 'decode-error' });
    assert.equal(decoded.state.phase, 'failed');
    const ready = effectsOf(loading, { type: 'loaded', generation: 1 }).state;
    const rejected = effectsOf(ready, { type: 'playResolved', generation: 1, ok: false });
    assert.deepEqual(rejected.effects[1], {
      type: 'report',
      playbackId: 'pb-1',
      status: 'failed',
      reason: 'play-rejected',
    });
    assert.equal(effectsOf(rejected.state, { type: 'failed', generation: 1, reason: 'timeout' }).state.phase, 'failed');
  });

  test('超时不能在 play 之后把正在播的请求打成失败', () => {
    let state = effectsOf(initialPlaybackState(), { type: 'begin', request: request('pb-1') }).state;
    state = effectsOf(state, { type: 'loaded', generation: 1 }).state;
    state = effectsOf(state, { type: 'playResolved', generation: 1, ok: true }).state;
    const late = effectsOf(state, { type: 'failed', generation: 1, reason: 'timeout' });
    assert.equal(late.state, state);
    assert.deepEqual(late.effects, []);
  });

  test('取消、冻结、卸载之后旧回调不能恢复', () => {
    const loading = effectsOf(initialPlaybackState(), { type: 'begin', request: request('pb-1') }).state;
    const frozen = effectsOf(loading, { type: 'cancel', reason: 'frozen' });
    assert.equal(frozen.state.phase, 'cancelled');
    assert.deepEqual(frozen.effects, [
      { type: 'abort', generation: 1 },
      { type: 'pause' },
      { type: 'report', playbackId: 'pb-1', status: 'cancelled', reason: 'frozen' },
    ]);
    assert.equal(effectsOf(frozen.state, { type: 'loaded', generation: 1 }).effects.length, 0);
    const disposed = effectsOf(loading, { type: 'dispose' });
    assert.equal(disposed.state.phase, 'disposed');
    assert.equal(effectsOf(disposed.state, { type: 'begin', request: request('pb-2') }).state.phase, 'disposed');
    assert.equal(effectsOf(disposed.state, { type: 'loaded', generation: 1 }).effects.length, 0);
    assert.deepEqual(effectsOf(disposed.state, { type: 'dispose' }).effects, []);
  });

  test('自播在 play 兑现前去重，兑现后允许重播', () => {
    const first = effectsOf(initialPlaybackState(), { type: 'begin', request: request(null) });
    assert.equal(effectsOf(first.state, { type: 'begin', request: request(null) }).effects.length, 0);
    let state = effectsOf(first.state, { type: 'loaded', generation: 1 }).state;
    state = effectsOf(state, { type: 'playResolved', generation: 1, ok: true }).state;
    const again = effectsOf(state, { type: 'begin', request: request(null) });
    assert.equal(again.state.generation, 2);
    assert.equal(
      again.effects.some((effect) => effect.type === 'report'),
      false,
    );
  });
});

describe('isPlaybackCueEcho', () => {
  const base = { anim: 'idle1', once: true, seq: 3, cuePlayback: 'pb-1' as string | null };

  test('只有编号从有值变成 null 且 anim、once、seq 都没变才是回声', () => {
    assert.equal(isPlaybackCueEcho(base, { ...base, cuePlayback: null }), true);
    assert.equal(isPlaybackCueEcho(base, { ...base, cuePlayback: 'pb-2' }), false);
    assert.equal(isPlaybackCueEcho(base, { ...base, seq: 4, cuePlayback: null }), false);
    assert.equal(isPlaybackCueEcho(base, { ...base, anim: 'turn1', cuePlayback: null }), false);
    assert.equal(isPlaybackCueEcho(base, { ...base, once: false, cuePlayback: null }), false);
    assert.equal(isPlaybackCueEcho({ ...base, cuePlayback: null }, { ...base, cuePlayback: null }), false);
  });
});
