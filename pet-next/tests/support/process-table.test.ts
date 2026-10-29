/**
 * 当前平台的进程表要能从父进程看到这次测试进程。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { snapshotChildren } from './process-table.ts';

test('父进程的直接子进程列表包含当前进程', () => {
  const directChildren = snapshotChildren(process.platform);
  const children = directChildren(process.ppid);
  assert.ok(children.includes(process.pid), '父进程的直接子进程应该包含当前进程');
});
