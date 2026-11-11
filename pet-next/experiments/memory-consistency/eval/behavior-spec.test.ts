/**
 * R2-B 回归：反事实必须核对输出字段，输入差异不能充当行为差异。
 *
 * 三组负控（都对 24 对全量跑）：
 * 1. 输入不同、输出冻结相同 -> 必须判「无行为差异」；
 * 2. 应保持字段被额外改动 -> 必须判「无行为差异」，且 stable 不成立；
 * 3. 同内容换名 -> 不产生差异。
 * 正控：真实配对必须判差异，且 flip/presence 有具体证据。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadDevTracks, loadExpectations } from './dataset.ts';
import { runTrack } from './harness.ts';
import {
  buildPairSpec,
  compareBehavior,
  tamperStableField,
  withFrozenOutputs,
  type PairSpec,
} from './behavior-spec.ts';

const tracks = loadDevTracks();
const expectations = loadExpectations();
const byPair = new Map<string, typeof tracks>();
for (const track of tracks) {
  const list = byPair.get(track.pairId) ?? [];
  list.push(track);
  byPair.set(track.pairId, list);
}
const pairs = [...byPair.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

function specOf(pairId: string): { spec: PairSpec; left: ReturnType<typeof runTrack>; right: ReturnType<typeof runTrack> } {
  const pair = byPair.get(pairId);
  assert.ok(pair !== undefined && pair.length === 2, pairId);
  const [left, right] = pair;
  assert.ok(left !== undefined && right !== undefined);
  const leftExpect = expectations.assertions[left.trackId];
  const rightExpect = expectations.assertions[right.trackId];
  assert.ok(leftExpect !== undefined && rightExpect !== undefined);
  return {
    spec: buildPairSpec(pairId, left.trackId, leftExpect.checks, right.trackId, rightExpect.checks),
    left: runTrack(left),
    right: runTrack(right),
  };
}

describe('R2-B 行为判据', () => {
  test('判据来自期望字段：24 对都有 flip 或 presence 证据', () => {
    for (const [pairId] of pairs) {
      const { spec } = specOf(pairId);
      assert.ok(
        spec.flipFields.length + spec.presenceFields.length > 0,
        `${pairId} 没有可判定的字段`,
      );
      assert.ok(spec.fields.length > 0);
    }
  });

  test('真实配对全部判为行为不同，且给出具体翻转字段', () => {
    for (const [pairId] of pairs) {
      const { spec, left, right } = specOf(pairId);
      const comparison = compareBehavior(left, right, spec);
      assert.equal(comparison.classifiedDifferent, true, pairId);
      assert.deepEqual(comparison.violatedFlip, [], `${pairId} flip 未成立`);
      assert.deepEqual(comparison.violatedStable, [], `${pairId} stable 被破坏`);
      assert.ok(comparison.differingChecks.length > 0, pairId);
    }
  });

  test('负控 1：输入不同、输出冻结相同 -> 不算行为差异（24/24）', () => {
    for (const [pairId] of pairs) {
      const { spec, left, right } = specOf(pairId);
      const frozen = withFrozenOutputs(left, right);
      const comparison = compareBehavior(frozen, left, spec);
      assert.equal(comparison.classifiedDifferent, false, `${pairId} 被输入差异骗过`);
      assert.equal(comparison.outputsDiffer, false, `${pairId} 输出其实相同`);
    }
  });

  test('负控 2：应保持字段被改动 -> stable 不成立（有可改动字段的对）', () => {
    let applicable = 0;
    for (const [pairId] of pairs) {
      const { spec, left, right } = specOf(pairId);
      const tampered = tamperStableField(left, spec);
      if (tampered === undefined) continue;
      applicable += 1;
      const comparison = compareBehavior(tampered.observation, right, spec);
      assert.equal(comparison.stableHeld, false, `${pairId} 未检出 ${tampered.field}`);
      assert.equal(comparison.classifiedDifferent, false, `${pairId} 被篡改字段骗过`);
    }
    assert.ok(applicable >= 10, `可改动样本太少：${applicable}`);
  });

  test('负控 3：同内容换名不产生差异', () => {
    for (const [pairId] of pairs) {
      const { spec, left } = specOf(pairId);
      const renamed = { ...left, trackId: `${left.trackId}-renamed` };
      assert.equal(compareBehavior(left, renamed, spec).classifiedDifferent, false, pairId);
    }
  });

  test('仅一侧断言的配对（C3/C5）靠 presence 证据成立，不靠硬编码', () => {
    for (const pairId of ['C3', 'C5']) {
      const { spec, left, right } = specOf(pairId);
      assert.equal(spec.flipFields.length, 0, `${pairId} 这对应只有仅一侧断言`);
      const comparison = compareBehavior(left, right, spec);
      assert.ok(comparison.satisfiedPresence.length > 0, pairId);
      assert.equal(comparison.classifiedDifferent, true, pairId);
    }
  });
});
