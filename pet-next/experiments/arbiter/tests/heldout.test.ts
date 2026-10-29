/**
 * held-out 不复用持续负载的种子，并且两种实现对同一参照。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { REQUIRED_FIXTURE_NAMES, SUSTAINED_LOAD } from '../../../contracts/index.ts';
import { replayOracle } from '../check/oracle.ts';
import { sameStep } from '../check/compare.ts';
import { replayFactory } from '../check/replay.ts';
import { HELDOUT_MIX_SEED, buildHeldoutMix, listHeldoutSequences } from '../heldout/sequences.ts';
import { createBaseline } from '../baseline/index.ts';
import { createStateMachine } from '../state-machine/index.ts';

describe('listHeldoutSequences', () => {
  test('名字不与规范性夹具重复，混合序列使用另一颗种子并包含完成回调', () => {
    const sequences = listHeldoutSequences();
    const names = sequences.map((sequence) => sequence.name);
    assert.equal(new Set(names).size, names.length);
    const required = new Set<string>(REQUIRED_FIXTURE_NAMES);
    for (const name of names) {
      assert.equal(required.has(name), false, name);
      assert.equal(name.startsWith('heldout-'), true, name);
    }
    assert.notEqual(HELDOUT_MIX_SEED, SUSTAINED_LOAD.seed);
    const mix = buildHeldoutMix();
    assert.equal(mix.some((input) => input.type === 'complete'), true);
    assert.equal(
      mix.some((input) => input.type === 'deliver' && input.event.id.startsWith('sustained-')),
      false,
    );
    const again = buildHeldoutMix();
    assert.deepEqual(mix, again);
  });

  test('基线和状态机与独立参照逐步一致', () => {
    for (const sequence of listHeldoutSequences()) {
      const oracle = replayOracle(sequence.inputs);
      const baseline = replayFactory(createBaseline, sequence.inputs);
      const stateMachine = replayFactory(createStateMachine, sequence.inputs);
      assert.equal(baseline.error, null, sequence.name);
      assert.equal(stateMachine.error, null, sequence.name);
      assert.equal(baseline.steps.length, oracle.length, sequence.name);
      for (let index = 0; index < oracle.length; index += 1) {
        assert.equal(sameStep(baseline.steps[index], oracle[index]), true, `${sequence.name} baseline#${index}`);
        assert.equal(sameStep(stateMachine.steps[index], oracle[index]), true, `${sequence.name} state-machine#${index}`);
        assert.equal(sameStep(baseline.steps[index], stateMachine.steps[index]), true, `${sequence.name} diverge#${index}`);
      }
    }
  });
});
