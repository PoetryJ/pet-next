/**
 * 按协议展开持续负载。不读取夹具目录。
 */
import { SUSTAINED_LOAD, mulberry32, type ArbiterInput, type ArbiterSource } from '../../../contracts/index.ts';

function sourceForRoll(roll: number): ArbiterSource {
  if (roll < SUSTAINED_LOAD.dragBelow) return 'drag';
  if (roll < SUSTAINED_LOAD.clickBelow) return 'click';
  return 'auto';
}

/** 种子 `20261029` 的 100 条投递。本场景不插入完成回调。 */
export function buildProtocolSustainedInputs(): readonly ArbiterInput[] {
  const random = mulberry32(SUSTAINED_LOAD.seed);
  const inputs: ArbiterInput[] = [];
  for (let index = 0; index < SUSTAINED_LOAD.count; index += 1) {
    const timeMs = index * SUSTAINED_LOAD.timeStepMs;
    inputs.push({
      type: 'deliver',
      nowMs: timeMs,
      event: {
        id: `sustained-${index}`,
        source: sourceForRoll(random()),
        seq: index,
        timeMs,
        expiresAtMs: timeMs + SUSTAINED_LOAD.ttlMs,
      },
    });
  }
  return inputs;
}
