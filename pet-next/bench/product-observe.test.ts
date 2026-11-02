/**
 * 产品回应观测纯计算的单元测试：正控/负控/旧帧/取消/产品事件优先。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { criterionFor, evaluateSample, type PageEvent } from './product-observe.ts';
import type { OnsetMeasurement } from './onset.ts';

const onset: OnsetMeasurement = {
  sha256: 'deadbeef',
  fps: 24,
  onsetMs: 250,
  onsetFrame: 6,
  frames: 120,
};
const criterion = criterionFor(onset, 'file:///reaction/short.webm', 'deadbeef');

function frameEvent(mediaTime: number, ts: number, extra: Partial<PageEvent> = {}): PageEvent {
  return {
    event: 'bench-frame',
    src: 'file:///reaction/short.webm',
    mediaTime,
    presentedFrames: Math.round(mediaTime * 24),
    rVfcNow: ts,
    injected: true,
    ts,
    ...extra,
  };
}

test('正控：观测到目标回应帧才记 responseObservedMs', () => {
  const events: PageEvent[] = [
    { event: 'bench-frame', src: 'file:///reaction/idle.webm', mediaTime: 1.5, injected: true, ts: 100 },
    { event: 'bench-input', kind: 'pointerdown', injected: true, ts: 200 },
    { event: 'bench-input', kind: 'pointerup', injected: true, ts: 260 },
    { event: 'bench-click', requestId: 'reaction:1', ts: 262 },
    { event: 'bench-media', status: 'resolved', requestId: 'reaction:1', ts: 280 },
    frameEvent(0, 300),
    frameEvent(0.125, 312),
    frameEvent(0.25, 324),
  ];
  const result = evaluateSample('positive', 1, events, criterion);
  assert.equal(result.endState, 'response-observed');
  assert.equal(result.inputPointerdownMs, 200);
  assert.equal(result.playResolvedMs, 80);
  assert.equal(result.firstFrameObservedMs, 100);
  assert.equal(result.responseObservedMs, 124);
  assert.equal(result.responseObservedMediaTimeSec, 0.25);
  assert.equal(result.responseObservedFrameIndex, 6);
});

test('负控：装载失败 → 未完成，观察字段全 null', () => {
  const events: PageEvent[] = [
    { event: 'bench-input', kind: 'pointerdown', injected: true, ts: 200 },
    { event: 'bench-click', requestId: 'reaction:2', ts: 262 },
    { event: 'bench-media', status: 'failed', requestId: 'reaction:2', ts: 8000 },
  ];
  const result = evaluateSample('negative', 1, events, criterion);
  assert.equal(result.endState, 'load-failed');
  assert.equal(result.responseObservedMs, null);
  assert.equal(result.firstFrameObservedMs, null);
  assert.equal(result.playResolvedMs, null);
});

test('旧帧不算：click 之前的回应素材帧被排除', () => {
  const events: PageEvent[] = [
    frameEvent(0.25, 150),
    { event: 'bench-input', kind: 'pointerdown', injected: true, ts: 200 },
    { event: 'bench-click', requestId: 'reaction:3', ts: 262 },
    frameEvent(0.3, 300),
  ];
  const result = evaluateSample('stale', 1, events, criterion);
  assert.equal(result.endState, 'response-observed');
  assert.equal(result.responseObservedMediaTimeSec, 0.3);
  assert.equal(result.responseObservedFrameIndex, 7);
});

test('产品自带 bench-frame（带 requestId）优先于注入帧', () => {
  const events: PageEvent[] = [
    { event: 'bench-input', kind: 'pointerdown', injected: true, ts: 200 },
    { event: 'bench-input', kind: 'pointerdown', ts: 201 },
    { event: 'bench-click', requestId: 'reaction:4', ts: 260 },
    frameEvent(0, 300),
    { event: 'bench-frame', requestId: 'reaction:4', mediaTime: 0.25, presentedFrames: 6, ts: 330 },
  ];
  const result = evaluateSample('product-events', 1, events, criterion);
  assert.equal(result.endState, 'response-observed');
  assert.equal(result.responseObservedMs, 129);
  assert.equal(result.inputPointerdownMs, 201);
});

test('pointercancel → cancelled，不计成功', () => {
  const events: PageEvent[] = [
    { event: 'bench-input', kind: 'pointerdown', injected: true, ts: 200 },
    { event: 'bench-input', kind: 'pointercancel', injected: true, ts: 210 },
    { event: 'bench-click', requestId: 'reaction:5', ts: 260 },
  ];
  const result = evaluateSample('cancel', 1, events, criterion);
  assert.equal(result.endState, 'cancelled');
  assert.equal(result.responseObservedMs, null);
});

test('结束但未到目标帧 → ended-before-target，不算成功', () => {
  const farOnset: OnsetMeasurement = { ...onset, onsetFrame: 1000, onsetMs: 41666.7 };
  const far = criterionFor(farOnset, 'file:///reaction/short.webm', 'deadbeef');
  const events: PageEvent[] = [
    { event: 'bench-input', kind: 'pointerdown', injected: true, ts: 200 },
    { event: 'bench-click', requestId: 'reaction:6', ts: 262 },
    { event: 'bench-media', status: 'resolved', requestId: 'reaction:6', ts: 280 },
    frameEvent(0, 300),
    frameEvent(0.5, 350),
    { event: 'bench-media', status: 'ended', requestId: 'reaction:6', ts: 4600 },
  ];
  const result = evaluateSample('short', 1, events, far);
  assert.equal(result.endState, 'ended-before-target');
  assert.equal(result.responseObservedMs, null);
  assert.notEqual(result.firstFrameObservedMs, null);
});

test('覆盖后迟到帧：同素材的后续请求帧不能归到旧请求', () => {
  const events: PageEvent[] = [
    { event: 'bench-input', kind: 'pointerdown', injected: true, ts: 100 },
    { event: 'bench-click', requestId: 'r1', ts: 160 },
    { event: 'bench-input', kind: 'pointerdown', injected: true, ts: 200 },
    { event: 'bench-click', requestId: 'r2', ts: 260 },
    frameEvent(0.25, 520),
  ];
  const result = evaluateSample('superseded-late-frame', 1, events, criterion);
  assert.equal(result.requestId, 'r1');
  assert.equal(result.endState, 'superseded');
  assert.equal(result.firstFrameObservedMs, null);
  assert.equal(result.responseObservedMs, null);
});

test('取消后迟到帧：目标帧不能越过 pointercancel 计成功', () => {
  const events: PageEvent[] = [
    { event: 'bench-input', kind: 'pointerdown', injected: true, ts: 100 },
    { event: 'bench-click', requestId: 'r1', ts: 160 },
    { event: 'bench-input', kind: 'pointercancel', injected: true, ts: 200 },
    frameEvent(0, 300),
    frameEvent(0.25, 520),
  ];
  const result = evaluateSample('cancelled-late-frame', 1, events, criterion);
  assert.equal(result.endState, 'cancelled');
  assert.equal(result.firstFrameObservedMs, null);
  assert.equal(result.responseObservedMs, null);
});

test('成功之后再发生输入：已经兑现的原成功保留', () => {
  const events: PageEvent[] = [
    { event: 'bench-input', kind: 'pointerdown', injected: true, ts: 100 },
    { event: 'bench-click', requestId: 'r1', ts: 160 },
    frameEvent(0, 300),
    frameEvent(0.25, 320),
    { event: 'bench-input', kind: 'pointerdown', injected: true, ts: 400 },
    { event: 'bench-click', requestId: 'r2', ts: 460 },
    frameEvent(0.25, 520),
  ];
  const result = evaluateSample('success-before-next-input', 1, events, criterion);
  assert.equal(result.requestId, 'r1');
  assert.equal(result.endState, 'response-observed');
  assert.equal(result.firstFrameObservedMs, 200);
  assert.equal(result.responseObservedMs, 220);
});
