/**
 * D4b 成本研究的小样本自检：确定性、等价性、操作量方向。
 * 大样本结果由 runner/p2.ts 生成并落盘，测试只守住机制。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { makeStream, mechanismCheck, median, scaleCheck } from './cost.ts';

describe('成本研究机制', () => {
  test('事件流对 seed 确定：同 seed 输出完全一致', () => {
    const a = makeStream({ events: 40, subjects: 5, requests: 3, seed: 3 });
    const b = makeStream({ events: 40, subjects: 5, requests: 3, seed: 3 });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    const c = makeStream({ events: 40, subjects: 5, requests: 3, seed: 4 });
    assert.notEqual(JSON.stringify(a), JSON.stringify(c));
  });

  test('小样本下全量与局部仍然等价', () => {
    const report = mechanismCheck(2, 60, 3);
    assert.equal(report.equivalent, true);
    assert.deepEqual(report.mismatchedSeeds, []);
    assert.equal(report.totalEvents, 120);
  });

  test('局部重建扫描的事件数明显少于全量', () => {
    const cells = scaleCheck([200], 4, 1);
    const cell = cells[0];
    assert.ok(cell !== undefined);
    assert.equal(cell.equivalent, true);
    const full = cell.measures.filter((item) => item.op === 'full');
    const inc = cell.measures.filter((item) => item.op === 'incremental');
    assert.equal(full.length, inc.length);
    const fullScanned = full.reduce((sum, item) => sum + item.eventsScanned, 0);
    const incScanned = inc.reduce((sum, item) => sum + item.eventsScanned, 0);
    assert.ok(incScanned < fullScanned, `${incScanned} !< ${fullScanned}`);
  });

  test('中位数不依赖排序输入', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), 0);
  });
});
