/**
 * 独立参照先对上规范性例子，再对上留出序列里手算过的两段。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { NORMATIVE_EXAMPLES, type ArbiterDecision, type ArbiterInput } from '../../../contracts/index.ts';
import { listHeldoutSequences } from '../heldout/sequences.ts';
import { oracleInitial, oracleStep, replayOracle } from '../check/oracle.ts';

function decided(
  outcome: ArbiterDecision['outcome'],
  reason: ArbiterDecision['reason'],
  eventId: string | null,
  actionId: string | null,
): ArbiterDecision {
  return { outcome, reason, eventId, actionId };
}

function started(eventId: string): ArbiterDecision {
  return decided('execute', 'started', eventId, eventId);
}

describe('replayOracle', () => {
  test('规范性例子：决策和 queueLength 与契约一致', () => {
    for (const example of NORMATIVE_EXAMPLES) {
      const steps = replayOracle(example.inputs);
      assert.equal(steps.length, example.expected.length, example.name);
      for (let index = 0; index < example.expected.length; index += 1) {
        const actual = steps[index];
        const want = example.expected[index];
        assert.ok(actual && want, `${example.name}#${index}`);
        assert.equal(actual.queueLength, want.queueLength, `${example.name}#${index}`);
        assert.deepEqual(actual.decisions, want.decisions, `${example.name}#${index}`);
      }
    }
  });

  test('step 不修改入参', () => {
    const state = oracleInitial();
    const event = { id: 'click-main', source: 'click' as const, seq: 0, timeMs: 0, expiresAtMs: 100 };
    const input: ArbiterInput = { type: 'deliver', event, nowMs: 0 };
    const result = oracleStep(state, input);
    event.id = 'changed';
    assert.equal(result.decisions[0]?.eventId, 'click-main');
    assert.equal(result.state.waiting.length, 0);
    assert.equal(state.seen.size, 0);
    assert.equal(state.active, null);
  });

  test('对不上的完成先丢掉到期等待，并且不开始下一个', () => {
    const sequence = listHeldoutSequences().find((item) => item.name === 'heldout-stale-expires');
    assert.ok(sequence);
    const steps = replayOracle(sequence.inputs);
    assert.deepEqual(steps[3], {
      decisions: [
        decided('discard', 'expired', 'auto-short', null),
        decided('discard', 'stale-completion', null, 'missing-action'),
      ],
      queueLength: 1,
    });
  });

  test('id 的字典序先于入队顺序', () => {
    const sequence = listHeldoutSequences().find((item) => item.name === 'heldout-id-order');
    assert.ok(sequence);
    const steps = replayOracle(sequence.inputs);
    assert.deepEqual(steps[4]?.decisions, [decided('execute', 'completed', 'drag-hold', 'drag-hold'), started('id-A')]);
    assert.equal(steps[4]?.queueLength, 2);
    assert.deepEqual(steps[5]?.decisions, [decided('execute', 'completed', 'id-A', 'id-A'), started('id-a')]);
    assert.deepEqual(steps[6]?.decisions, [decided('execute', 'completed', 'id-a', 'id-a'), started('id-b')]);
    assert.equal(steps[6]?.queueLength, 0);
  });
});
