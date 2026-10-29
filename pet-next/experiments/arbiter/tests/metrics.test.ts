/**
 * 指标用手工步骤钉住，不借两套实现的输出。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ArbiterDecision, ArbiterInput } from '../../../contracts/index.ts';
import { expiredExecutions, queuePeak, simulatedWaitMs, starvationCount, type MetricStep } from '../check/metrics.ts';

function started(eventId: string): ArbiterDecision {
  return { outcome: 'execute', reason: 'started', eventId, actionId: eventId };
}

function decision(
  outcome: ArbiterDecision['outcome'],
  reason: ArbiterDecision['reason'],
  eventId: string | null,
  actionId: string | null,
): ArbiterDecision {
  return { outcome, reason, eventId, actionId };
}

function deliver(id: string, source: 'drag' | 'click' | 'auto', timeMs: number, expiresAtMs: number): ArbiterInput {
  return { type: 'deliver', event: { id, source, seq: timeMs, timeMs, expiresAtMs }, nowMs: timeMs };
}

describe('arbiter metrics', () => {
  test('模拟等待用事件时间，未结束的等待用最后一步', () => {
    const inputs = [deliver('a', 'click', 0, 100), deliver('b', 'auto', 5, 100)];
    const steps: MetricStep[] = [
      { nowMs: 0, decisions: [started('a')], queueLength: 0 },
      { nowMs: 5, decisions: [decision('wait', 'queued-lower-rank', 'b', null)], queueLength: 1 },
      { nowMs: 20, decisions: [decision('execute', 'completed', 'a', 'a')], queueLength: 1 },
    ];
    assert.equal(simulatedWaitMs(inputs, steps), 15);
    assert.equal(expiredExecutions(inputs, steps), 0);
    assert.equal(starvationCount(inputs, steps), 0);
    assert.equal(queuePeak(steps), 1);
  });

  test('等待期间有更高优先级开始、最终过期，记一次饥饿', () => {
    const inputs = [deliver('c', 'click', 0, 100), deliver('a', 'auto', 5, 30), deliver('d', 'drag', 10, 100)];
    const steps: MetricStep[] = [
      { nowMs: 0, decisions: [started('c')], queueLength: 0 },
      { nowMs: 5, decisions: [decision('wait', 'queued-lower-rank', 'a', null)], queueLength: 1 },
      { nowMs: 10, decisions: [decision('discard', 'preempted', 'c', 'c'), started('d')], queueLength: 1 },
      { nowMs: 30, decisions: [decision('discard', 'expired', 'a', null)], queueLength: 0 },
    ];
    assert.equal(simulatedWaitMs(inputs, steps), 25);
    assert.equal(starvationCount(inputs, steps), 1);
    assert.equal(expiredExecutions(inputs, steps), 0);
  });

  test('开始落在已过期事件上时记过期执行', () => {
    const inputs = [deliver('late', 'click', 20, 20)];
    const steps: MetricStep[] = [{ nowMs: 10, decisions: [started('late')], queueLength: 0 }];
    assert.equal(expiredExecutions(inputs, steps), 1);
    assert.equal(simulatedWaitMs(inputs, steps), 0);
  });

  test('已经开始的事件，后面的重复不再延长模拟等待', () => {
    const inputs = [deliver('c', 'click', 0, 100), deliver('c', 'click', 40, 100)];
    const steps: MetricStep[] = [
      { nowMs: 0, decisions: [started('c')], queueLength: 0 },
      { nowMs: 8, decisions: [decision('discard', 'duplicate', 'c', null)], queueLength: 0 },
    ];
    assert.equal(simulatedWaitMs(inputs, steps), 0);
    assert.equal(queuePeak([]), 0);
  });
});
