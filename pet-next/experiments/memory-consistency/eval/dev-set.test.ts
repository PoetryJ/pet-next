/**
 * G1 门禁：48 条开发轨迹可复跑、独立评分可运行、六种负控均检出。
 *
 * 断言的是「机制」：轨迹数量、断言数、失败数、负控检出面。
 * 这里没有任何模型能力分数，也不应被读成模型效果。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  evaluateDataset,
  loadDevTracks,
  loadExpectations,
  observationDigest,
  runMutationSuite,
} from './dataset.ts';

const tracks = loadDevTracks();
const expectations = loadExpectations();

describe('开发契约集', () => {
  test('轨迹数量与配对数符合设计（24 对 48 条，四类各 12 条）', () => {
    assert.equal(tracks.length, 48);
    const pairs = new Set(tracks.map((track) => track.pairId));
    assert.equal(pairs.size, 24);
    for (const cls of ['state-update', 'generation-presentation', 'tool-result', 'stale-patch']) {
      assert.equal(tracks.filter((track) => track.class === cls).length, 12, cls);
    }
  });

  test('每对两条轨迹只差一个关键条件', () => {
    for (const pairId of new Set(tracks.map((track) => track.pairId))) {
      const pair = tracks.filter((track) => track.pairId === pairId);
      assert.equal(pair.length, 2, pairId);
      assert.notEqual(pair[0]?.variant, pair[1]?.variant, pairId);
      assert.equal(pair[0]?.keyCondition, pair[1]?.keyCondition, pairId);
    }
  });

  test('期望与轨迹一一对应，没有缺失也没有多余', () => {
    const { score } = evaluateDataset(tracks, expectations);
    assert.deepEqual(score.missingExpectations, []);
    assert.deepEqual(score.orphanExpectations, []);
    assert.equal(score.tracks, 48);
  });

  test('正确实现下全部断言通过', () => {
    const { score } = evaluateDataset(tracks, expectations);
    assert.equal(score.failed, 0, JSON.stringify(score.trackFailures.map((item) => item.trackId)));
    assert.ok(score.checks >= 100, `checks=${score.checks}`);
  });

  test('重复执行结果一致（确定性）', () => {
    const a = evaluateDataset(tracks, expectations).observations;
    const b = evaluateDataset(tracks, expectations).observations;
    assert.equal(observationDigest(a), observationDigest(b));
  });
});

describe('六种负控', () => {
  const reports = runMutationSuite(tracks, expectations);

  test('负控数量为六且 id 唯一', () => {
    assert.equal(reports.length, 6);
    assert.equal(new Set(reports.map((report) => report.id)).size, 6);
  });

  for (const report of reports) {
    test(`${report.id} 被指定反例检出：${report.title}`, () => {
      assert.equal(report.detected, true, `failed=${report.failedTracks.join(',')}`);
      assert.ok(report.caughtByExpected.length > 0);
      assert.equal(report.caughtByExpected[0], report.expectedCaughtBy[0]);
    });
  }

  test('每个负控都不是「全盘失败」的假检出', () => {
    for (const report of reports) {
      assert.ok(report.failedTracks.length < tracks.length, `${report.id} failed everything`);
    }
  });
});
