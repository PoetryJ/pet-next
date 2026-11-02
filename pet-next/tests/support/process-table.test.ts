/**
 * 当前平台的进程表要能从父进程看到这次测试进程。
 * 快照是异步查询：并发请求共享同一条 in-flight 查询（单飞），不各自 spawn PowerShell/ps。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { snapshotChildren } from './process-table.ts';

test('父进程的直接子进程列表包含当前进程', async () => {
  const directChildren = await snapshotChildren(process.platform);
  const children = directChildren(process.ppid);
  assert.ok(children.includes(process.pid), '父进程的直接子进程应该包含当前进程');
});

test('并发快照请求共享同一次查询', async () => {
  const first = snapshotChildren(process.platform);
  const second = snapshotChildren(process.platform);
  assert.equal(second, first, '同一时刻的快照请求应该复用 in-flight 查询');
  const [fromFirst, fromSecond] = await Promise.all([first, second]);
  assert.equal(fromSecond, fromFirst);
});
