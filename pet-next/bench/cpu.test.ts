import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cpuPercent, parseProcStat } from './cpu.ts';

describe('CPU 采样', () => {
  test('进程名里的括号不影响 utime 和 stime', () => {
    const parsed = parseProcStat('12 (chrome (gpu)) S 1 2 3 4 5 6 7 8 9 10 40 50');
    assert.deepEqual(parsed, { utime: 40, stime: 50 });
    assert.equal(parseProcStat('nope'), null);
  });

  test('100 个 tick、1 秒、每秒 100 tick，等于一个核', () => {
    assert.equal(cpuPercent({ startTicks: 0, endTicks: 100, wallMs: 1000, clkTck: 100 }), 100);
    assert.equal(cpuPercent({ startTicks: 10, endTicks: 0, wallMs: 1000, clkTck: 100 }), null);
  });
});
