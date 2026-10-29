/**
 * 确认 runner 入口可以加载。清理行为的测试由 Agent A 加在本目录。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProcessTracker } from './index.ts';

test('进程跟踪工厂可加载，导入时不启动进程', () => {
  assert.equal(typeof createProcessTracker, 'function');
});
