/**
 * 夹具固定输入、种子和契约期望，不另写一套决策。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { NORMATIVE_EXAMPLES, REQUIRED_FIXTURE_NAMES, SUSTAINED_LOAD, mulberry32, type ArbiterSource } from '../../../contracts/index.ts';
import { buildSustainedInputs, listArbiterFixtures } from './catalog.ts';

function sourceForRoll(roll: number): ArbiterSource {
  if (roll < SUSTAINED_LOAD.dragBelow) return 'drag';
  if (roll < SUSTAINED_LOAD.clickBelow) return 'click';
  return 'auto';
}

describe('listArbiterFixtures', () => {
  test('规范性夹具沿用契约里的同一份输入和期望', () => {
    const fixtures = listArbiterFixtures();
    assert.deepEqual(
      fixtures.map((fixture) => fixture.name),
      [...REQUIRED_FIXTURE_NAMES],
    );
    for (const example of NORMATIVE_EXAMPLES) {
      const fixture = fixtures.find((item) => item.name === example.name);
      assert.ok(fixture, example.name);
      assert.equal(fixture.inputs, example.inputs);
      assert.equal(fixture.expected, example.expected);
      assert.equal(fixture.seed, null);
    }
  });

  test('持续负载：固定种子、时间步长，且没有完成回调', () => {
    const first = buildSustainedInputs();
    const second = buildSustainedInputs();
    assert.deepEqual(first, second);
    assert.equal(first.length, SUSTAINED_LOAD.count);
    const random = mulberry32(SUSTAINED_LOAD.seed);
    assert.equal(random(), 0.850172859383747);
    const replay = mulberry32(SUSTAINED_LOAD.seed);
    for (let index = 0; index < SUSTAINED_LOAD.count; index += 1) {
      const input = first[index];
      assert.ok(input);
      assert.equal(input.type, 'deliver');
      if (input.type !== 'deliver') continue;
      const timeMs = index * SUSTAINED_LOAD.timeStepMs;
      assert.equal(input.event.source, sourceForRoll(replay()));
      assert.equal(input.event.id, `sustained-${index}`);
      assert.equal(input.event.seq, index);
      assert.equal(input.event.timeMs, timeMs);
      assert.equal(input.event.expiresAtMs, timeMs + SUSTAINED_LOAD.ttlMs);
      assert.equal(input.nowMs, timeMs);
    }
    const sustained = listArbiterFixtures().find((fixture) => fixture.name === 'sustained-high-priority');
    assert.ok(sustained);
    assert.equal(sustained.seed, SUSTAINED_LOAD.seed);
    assert.equal(sustained.expected, null);
    assert.equal(sustained.inputs[0]?.type, 'deliver');
    if (sustained.inputs[0]?.type === 'deliver') assert.equal(sustained.inputs[0].event.source, 'auto');
  });
});
