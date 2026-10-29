/**
 * 消费点播编号之后的 React 回声：只有这一条跳过换源。
 * 真实点击、自播和 seq 变化仍要执行。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { applyPlaybackCue } from './animation.ts';
import type { PlaybackCueIdentity } from '../../../shared/playback-lifecycle.ts';

describe('applyPlaybackCue', () => {
  test('编号从有值变成 null 且 anim、once、seq 未变时不执行', () => {
    const ran: Array<string | null> = [];
    let prev: PlaybackCueIdentity | null = null;
    const step = (next: PlaybackCueIdentity): void => {
      prev = applyPlaybackCue(prev, next, (cue) => {
        ran.push(cue.cuePlayback);
      });
    };
    step({ anim: 'idle1', once: true, seq: 1, cuePlayback: 'pb-1' });
    step({ anim: 'idle1', once: true, seq: 1, cuePlayback: null });
    step({ anim: 'idle1', once: true, seq: 2, cuePlayback: null });
    step({ anim: 'idle1', once: true, seq: 2, cuePlayback: 'pb-2' });
    step({ anim: 'turn1', once: false, seq: 3, cuePlayback: null });
    assert.deepEqual(ran, ['pb-1', null, 'pb-2', null]);
  });
});
