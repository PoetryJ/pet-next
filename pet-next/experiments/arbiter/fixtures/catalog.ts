/**
 * 仲裁夹具：规范性例子沿用契约原件，持续负载只按固定种子展开。
 * 不写日志，也不调用仲裁。
 * @module pet-next/experiments/arbiter/fixtures
 */
import {
  NORMATIVE_EXAMPLES,
  REQUIRED_FIXTURE_NAMES,
  SUSTAINED_LOAD,
  mulberry32,
  type ArbiterEvent,
  type ArbiterInput,
  type ArbiterSource,
  type ArbiterStepExpectation,
} from '../../../contracts/index.ts';

/** 造持续负载时需要的参数。阈值比较顺序见协议。 */
export interface SustainedLoadSpec {
  seed: number;
  count: number;
  timeStepMs: number;
  ttlMs: number;
  dragBelow: number;
  clickBelow: number;
}

/** 一次可回放的输入。`expected` 为空表示没有手写期望，只和其他实现比较。 */
export interface ArbiterFixture {
  name: string;
  /** 手写例子为 null。 */
  seed: number | null;
  inputs: readonly ArbiterInput[];
  expected: readonly ArbiterStepExpectation[] | null;
}

function sourceForRoll(roll: number, dragBelow: number, clickBelow: number): ArbiterSource {
  if (roll < dragBelow) return 'drag';
  if (roll < clickBelow) return 'click';
  return 'auto';
}

/**
 * 展开持续负载。每个下标只取一次随机数，并且不插入完成回调。
 *
 * @param load - 种子、条数和时间步长。缺省为 {@link SUSTAINED_LOAD}。
 * @returns 按时间递交的投递序列。
 */
export function buildSustainedInputs(load: SustainedLoadSpec = SUSTAINED_LOAD): readonly ArbiterInput[] {
  const random = mulberry32(load.seed);
  const inputs: ArbiterInput[] = [];
  for (let index = 0; index < load.count; index += 1) {
    const timeMs = index * load.timeStepMs;
    const event: ArbiterEvent = {
      id: `sustained-${index}`,
      source: sourceForRoll(random(), load.dragBelow, load.clickBelow),
      seq: index,
      timeMs,
      expiresAtMs: timeMs + load.ttlMs,
    };
    inputs.push({ type: 'deliver', event, nowMs: timeMs });
  }
  return inputs;
}

/**
 * 规范性例子加上持续负载。例子的输入和期望保持契约里的同一引用。
 *
 * @returns 覆盖 `REQUIRED_FIXTURE_NAMES` 的夹具。
 * @throws {Error} 名单与契约不一致时。
 */
export function listArbiterFixtures(): readonly ArbiterFixture[] {
  const fixtures: ArbiterFixture[] = NORMATIVE_EXAMPLES.map((example) => ({
    name: example.name,
    seed: null,
    inputs: example.inputs,
    expected: example.expected,
  }));
  fixtures.push({
    name: SUSTAINED_LOAD.fixture,
    seed: SUSTAINED_LOAD.seed,
    inputs: buildSustainedInputs(SUSTAINED_LOAD),
    expected: null,
  });
  assertRequiredNames(fixtures);
  return fixtures;
}

function assertRequiredNames(fixtures: readonly ArbiterFixture[]): void {
  const names = new Set(fixtures.map((fixture) => fixture.name));
  const coversAll = fixtures.length === REQUIRED_FIXTURE_NAMES.length && REQUIRED_FIXTURE_NAMES.every((name) => names.has(name));
  if (names.size !== fixtures.length || !coversAll) {
    throw new Error(`夹具名单与 REQUIRED_FIXTURE_NAMES 不一致：${[...names].join(',')}`);
  }
}
