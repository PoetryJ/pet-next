/**
 * 进程树选择只看父子关系：旁支、环、负 PID 和映像名都不构成结束理由。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  assertSignalablePid,
  descendantPids,
  directChildrenFromRows,
  killOrder,
  parseChildrenFile,
  parsePidPpidLines,
  readProcStatus,
  readStartTicks,
  windowsTerminatePlan,
} from './process-tree.ts';

describe('descendantPids', () => {
  test('只收集根的后代：旁支进程同时出现也不会入选', () => {
    const children = new Map<number, readonly number[]>([
      [10, [11, 13]],
      [11, [12]],
      [99, [100]],
    ]);
    assert.deepEqual(
      descendantPids(10, (pid) => children.get(pid) ?? []),
      [11, 13, 12],
    );
  });

  test('父子成环时枚举会停，不会把环外的进程卷进来', () => {
    const children = (pid: number) => {
      if (pid === 15) return [16];
      if (pid === 16) return [15, 17];
      return [];
    };
    assert.deepEqual(descendantPids(15, children), [16, 17]);
  });
});

describe('killOrder', () => {
  test('后发现的后代排在前面，根进程排在最后', () => {
    assert.deepEqual(killOrder(10, [10, 11, 12]), [12, 11, 10]);
  });
});

describe('windowsTerminatePlan', () => {
  test('只指向一个 PID，根进程才带 /T，不用映像名', () => {
    assert.deepEqual(windowsTerminatePlan(42, false, 7), { command: 'taskkill', args: ['/PID', '42', '/F'] });
    assert.deepEqual(windowsTerminatePlan(42, true, 7), { command: 'taskkill', args: ['/PID', '42', '/T', '/F'] });
  });

  test('拒绝负 PID、1 号进程和自己', () => {
    assert.throws(() => windowsTerminatePlan(-5, false, 7), /refuse to signal pid -5/);
    assert.throws(() => windowsTerminatePlan(1, true, 7), /refuse to signal pid 1/);
    assert.throws(() => assertSignalablePid(0, 7), /refuse to signal pid 0/);
    assert.throws(() => assertSignalablePid(7, 7), /refuse to signal pid 7/);
  });
});

describe('proc parsers', () => {
  test('children 文件按空白拆 PID，空文件就是没有子进程', () => {
    assert.deepEqual(parseChildrenFile(''), []);
    assert.deepEqual(parseChildrenFile(' 12 13 \n'), [12, 13]);
  });

  test('pid/ppid 行丢掉无法解析的内容', () => {
    assert.deepEqual(parsePidPpidLines('1 0\nfoo\n 12 1 \n'), [
      { pid: 1, ppid: 0 },
      { pid: 12, ppid: 1 },
    ]);
  });

  test('status 只读 Pid 和 PPid，不看进程名', () => {
    const text = 'Name:\telectron\nPid:\t42\nPPid:\t7\n';
    assert.deepEqual(readProcStatus(text), { pid: 42, ppid: 7 });
    assert.equal(readProcStatus('Name:\telectron\n'), undefined);
  });

  test('stat 的 starttime 从最后一个括号之后数，名字里的括号不影响', () => {
    const fields = ['S', '1', '12', '12', '0', '-1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '20', '0', '1', '0', '999'];
    assert.equal(readStartTicks(`12 (a) b) ${fields.join(' ')}`), 999);
    assert.equal(readStartTicks('no-paren'), undefined);
  });

  test('父子行折成直接子进程后，仍然到不了旁支', () => {
    const direct = directChildrenFromRows([
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 11 },
      { pid: 50, ppid: 1 },
    ]);
    assert.deepEqual(descendantPids(10, direct), [11, 12]);
  });
});
