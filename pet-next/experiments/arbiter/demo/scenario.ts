/**
 * 演示用的固定输入。同一段交给两种实现，用来标出执行、等待和丢弃。
 */
import type { ArbiterEvent, ArbiterInput } from '../../../contracts/arbiter.ts';

function deliver(
  id: string,
  source: ArbiterEvent['source'],
  seq: number,
  timeMs: number,
  expiresAtMs: number,
  nowMs = timeMs,
): ArbiterInput {
  return { type: 'deliver', event: { id, source, seq, timeMs, expiresAtMs }, nowMs };
}

function complete(actionId: string, nowMs: number): ArbiterInput {
  return { type: 'complete', actionId, nowMs };
}

/** 一段能同时出现执行、等待和丢弃的输入。 */
export function demoInputs(): readonly ArbiterInput[] {
  return [
    deliver('auto-start', 'auto', 0, 0, 500, 0),
    deliver('auto-same', 'auto', 1, 10, 500, 10),
    deliver('click-cut', 'click', 2, 20, 500, 20),
    deliver('drag-cut', 'drag', 3, 30, 500, 30),
    deliver('auto-blocked', 'auto', 4, 40, 500, 40),
    deliver('click-queued', 'click', 5, 45, 500, 45),
    deliver('click-dead', 'click', 6, 50, 40, 50),
    deliver('drag-cut', 'drag', 7, 60, 500, 60),
    complete('auto-start', 70),
    complete('drag-cut', 80),
    complete('auto-same', 90),
  ];
}
