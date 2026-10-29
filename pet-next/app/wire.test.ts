/**
 * 装配层把点击、拖动和媒体结果接到端口，不自己播放。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ClipKind } from '../core/interaction/types.ts';
import type { PetPorts, PlayClip } from './types.ts';
import { createPetController, parseClipRequest } from './wire.ts';

function recordingPorts(): PetPorts & {
  plays: PlayClip[];
  placeholders: number;
  moves: Array<{ dx: number; dy: number }>;
  visuals: string[];
  dragging: boolean[];
  quits: number;
} {
  const ports = {
    plays: [] as PlayClip[],
    placeholders: 0,
    moves: [] as Array<{ dx: number; dy: number }>,
    visuals: [] as string[],
    dragging: [] as boolean[],
    quits: 0,
    play(request: PlayClip) {
      ports.plays.push(request);
    },
    showPlaceholder() {
      ports.placeholders += 1;
    },
    moveBy(dx: number, dy: number) {
      ports.moves.push({ dx, dy });
    },
    quit() {
      ports.quits += 1;
    },
    setVisual(visual: string, requestId: number) {
      ports.visuals.push(`${visual}:${requestId}`);
    },
    setDragging(dragging: boolean) {
      ports.dragging.push(dragging);
    },
  };
  return ports;
}

describe('createPetController', () => {
  test('开机、单击和回应结束按顺序回到新的待机请求', () => {
    const ports = recordingPorts();
    const pet = createPetController({
      assets: { idleUrl: 'idle.webm', reactionUrl: 'react.webm' },
      dragThresholdPx: 5,
      ports,
    });
    pet.boot();
    pet.pointer({ type: 'pointerdown', pointerId: 1, x: 0, y: 0 });
    pet.pointer({ type: 'pointerup', pointerId: 1, x: 1, y: 1 });
    pet.notify({ type: 'clip-ended', requestId: 2, clip: 'reaction' });
    assert.deepEqual(
      ports.plays.map((play) => `${play.clip}:${play.requestId}:${play.once}`),
      ['idle:1:false', 'reaction:2:true', 'idle:3:false'],
    );
    assert.equal(ports.plays[1]?.url, 'react.webm');
    assert.equal(pet.visual, 'idle');
    assert.deepEqual(pet.trace, ['idle:1', 'reaction:2', 'idle:3']);
  });

  test('连续点击只让最新回应的 ended 回待机', () => {
    const ports = recordingPorts();
    const pet = createPetController({
      assets: { idleUrl: 'idle.webm', reactionUrl: 'react.webm' },
      dragThresholdPx: 5,
      ports,
    });
    pet.boot();
    for (const x of [0, 1, 2]) {
      pet.pointer({ type: 'pointerdown', pointerId: 1, x, y: 0 });
      pet.pointer({ type: 'pointerup', pointerId: 1, x, y: 0 });
    }
    pet.notify({ type: 'clip-ended', requestId: 2, clip: 'reaction' });
    pet.notify({ type: 'clip-failed', requestId: 3, clip: 'reaction' });
    pet.notify({ type: 'clip-ended', requestId: 4, clip: 'reaction' });
    assert.deepEqual(pet.trace, ['idle:1', 'reaction:2', 'reaction:3', 'reaction:4', 'idle:5']);
    assert.equal(ports.placeholders, 0);
  });

  test('拖动和 pointercancel 不触发点击，位移送到端口', () => {
    const ports = recordingPorts();
    const pet = createPetController({
      assets: { idleUrl: 'idle.webm', reactionUrl: 'react.webm' },
      dragThresholdPx: 5,
      ports,
    });
    pet.boot();
    pet.pointer({ type: 'pointerdown', pointerId: 1, x: 0, y: 0 });
    pet.pointer({ type: 'pointermove', pointerId: 1, x: 8, y: 3 });
    pet.pointer({ type: 'pointerup', pointerId: 1, x: 8, y: 3 });
    pet.pointer({ type: 'pointerdown', pointerId: 1, x: 0, y: 0 });
    pet.pointer({ type: 'pointercancel', pointerId: 1 });
    assert.deepEqual(ports.moves, [{ dx: 8, dy: 3 }]);
    assert.deepEqual(ports.dragging, [true, false]);
    assert.deepEqual(
      ports.plays.map((play) => play.clip),
      ['idle'],
    );
  });

  test('回应失败后的待机若再失败就停在占位，重复失败不再播放', () => {
    const ports = recordingPorts();
    const pet = createPetController({
      assets: { idleUrl: 'idle.webm', reactionUrl: 'react.webm' },
      dragThresholdPx: 5,
      ports,
    });
    pet.boot();
    pet.notify({ type: 'clip-failed', requestId: 1, clip: 'idle' });
    pet.pointer({ type: 'pointerdown', pointerId: 1, x: 0, y: 0 });
    pet.pointer({ type: 'pointerup', pointerId: 1, x: 0, y: 0 });
    pet.notify({ type: 'clip-failed', requestId: 2, clip: 'reaction' });
    pet.notify({ type: 'clip-failed', requestId: 3, clip: 'idle' });
    pet.notify({ type: 'clip-failed', requestId: 3, clip: 'idle' });
    assert.deepEqual(pet.trace, ['idle:1', 'placeholder', 'reaction:2', 'idle:3', 'placeholder']);
    assert.equal(ports.placeholders, 2);
    assert.equal(ports.plays.length, 3);
    assert.equal(pet.visual, 'placeholder');
  });
});

describe('parseClipRequest', () => {
  test('只接受 idle 和 reaction 编号', () => {
    const idle: ClipKind = 'idle';
    assert.deepEqual(parseClipRequest('idle:4'), { clip: idle, requestId: 4 });
    assert.equal(parseClipRequest('reaction:12')?.clip, 'reaction');
    assert.equal(parseClipRequest('other:1'), null);
    assert.equal(parseClipRequest('idle:x'), null);
  });
});
