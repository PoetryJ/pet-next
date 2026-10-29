/**
 * 未参与基线和状态机调试的输入。期望由核对器按协议现算，不写在这里。
 */
import {
  SUSTAINED_LOAD,
  mulberry32,
  type ArbiterEvent,
  type ArbiterInput,
  type ArbiterSource,
} from '../../../contracts/index.ts';

/** 一段留出的序列。 */
export interface HeldoutSequence {
  name: string;
  /** 这段在打哪条规则组合。 */
  note: string;
  inputs: readonly ArbiterInput[];
}

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

/** 固定种子。故意不等于持续负载的种子，并且会插入完成回调。 */
export const HELDOUT_MIX_SEED = 9173;

const MIX_COUNT = 36;
const MIX_TIME_STEP_MS = 15;
const MIX_TTL_MS = 70;
const MIX_DRAG_BELOW = 0.55;
const MIX_CLICK_BELOW = 0.8;

function mixSource(roll: number): ArbiterSource {
  if (roll < MIX_DRAG_BELOW) return 'drag';
  if (roll < MIX_CLICK_BELOW) return 'click';
  return 'auto';
}

/** 另一套种子的投递，并按固定节拍补上完成回调。回调 id 不看当时谁在执行。 */
export function buildHeldoutMix(): readonly ArbiterInput[] {
  const random = mulberry32(HELDOUT_MIX_SEED);
  const inputs: ArbiterInput[] = [];
  for (let index = 0; index < MIX_COUNT; index += 1) {
    const timeMs = index * MIX_TIME_STEP_MS;
    inputs.push(deliver(`mix-${index}`, mixSource(random()), index, timeMs, timeMs + MIX_TTL_MS, timeMs));
    if (index >= 5 && index % 6 === 5) inputs.push(complete(`mix-${index - 5}`, timeMs));
  }
  return inputs;
}

function assertDistinctSeed(heldoutSeed: number, sustainedSeed: number): void {
  if (heldoutSeed === sustainedSeed) throw new Error('held-out 种子不能与持续负载相同');
}

/** F 的留出序列。名字不与规范性夹具重复。 */
export function listHeldoutSequences(): readonly HeldoutSequence[] {
  assertDistinctSeed(HELDOUT_MIX_SEED, SUSTAINED_LOAD.seed);
  return [
    {
      name: 'heldout-stale-expires',
      note: '对不上的完成回调仍先清过期等待，且不补位',
      inputs: [
        deliver('drag-hold', 'drag', 0, 0, 1000, 0),
        deliver('auto-short', 'auto', 1, 5, 20, 5),
        deliver('auto-stay', 'auto', 2, 6, 40, 6),
        complete('missing-action', 20),
      ],
    },
    {
      name: 'heldout-id-order',
      note: 'seq 与 timeMs 相同时按 id 的 JavaScript 序开始',
      inputs: [
        deliver('drag-hold', 'drag', 0, 0, 100, 0),
        deliver('id-b', 'click', 3, 4, 80, 4),
        deliver('id-a', 'click', 3, 4, 80, 4),
        deliver('id-A', 'click', 3, 4, 80, 4),
        complete('drag-hold', 9),
        complete('id-A', 10),
        complete('id-a', 11),
      ],
    },
    {
      name: 'heldout-rank-before-seq',
      note: '腾出当前动作后，更高优先级先于更小的 seq',
      inputs: [
        deliver('click-late', 'click', 5, 0, 400, 0),
        deliver('auto-early', 'auto', 0, 5, 400, 5),
        deliver('click-early', 'click', 1, 6, 400, 6),
        complete('click-late', 10),
        complete('click-early', 12),
      ],
    },
    {
      name: 'heldout-preempt-keeps-waiter',
      note: '抢占不把旧动作送回队列，已经在等的较低优先级留下',
      inputs: [
        deliver('click-main', 'click', 0, 0, 400, 0),
        deliver('auto-wait', 'auto', 1, 5, 400, 5),
        deliver('drag-in', 'drag', 2, 10, 400, 10),
        complete('drag-in', 20),
      ],
    },
    {
      name: 'heldout-duplicate-queued',
      note: '重复的是队列里的 id，不改变等待数，也不改当前动作',
      inputs: [
        deliver('click-main', 'click', 0, 0, 400, 0),
        deliver('click-wait', 'click', 1, 5, 400, 5),
        deliver('click-wait', 'click', 9, 6, 400, 6),
        complete('click-main', 8),
      ],
    },
    {
      name: 'heldout-double-expire',
      note: '同一步先按序丢掉到期等待，再丢掉到达即过期的新事件',
      inputs: [
        deliver('drag-hold', 'drag', 0, 0, 1000, 0),
        deliver('auto-old', 'auto', 2, 4, 10, 4),
        deliver('click-old', 'click', 1, 5, 10, 5),
        deliver('auto-dead', 'auto', 3, 20, 20, 10),
      ],
    },
    {
      name: 'heldout-starve-window',
      note: '等待期间出现更高优先级的开始，另一条在开始之前就已经在等的过期不重复计',
      inputs: [
        deliver('click-block', 'click', 0, 0, 1000, 0),
        deliver('auto-starve', 'auto', 1, 5, 50, 5),
        deliver('drag-cut', 'drag', 2, 10, 1000, 10),
        deliver('auto-late', 'auto', 3, 12, 40, 12),
        deliver('click-filler', 'click', 4, 40, 200, 40),
        deliver('auto-end', 'auto', 5, 50, 80, 50),
      ],
    },
    {
      name: 'heldout-seeded-mix',
      note: '种子 9173 的混合来源，并插入可能对不上的完成回调',
      inputs: buildHeldoutMix(),
    },
  ];
}
