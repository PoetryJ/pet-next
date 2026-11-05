/**
 * launcher 运行选项映射的行为锁定（缺陷 1 的回归门）。
 * 覆盖：companion 补齐 short,behavior + companion；standard 两项都清空；
 * context 开关透传；父 env 残留不影响结果；无模型调用、无副作用。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CHAT_EXPERIENCE_ENV,
  COMPANION_EXPERIENCE,
} from '../contracts/chat.ts';
import { PREVIEW_ENV } from '../contracts/preview.ts';
import { COMPANION_PREVIEW, launcherRunOptions } from './launcher-run-options.ts';

describe('launcherRunOptions companion', () => {
  test('companion 补齐短片与行为令牌，并给出 companion 体验口径', () => {
    const run = launcherRunOptions({ experience: 'companion', chatContext: false });
    assert.equal(run.preview, COMPANION_PREVIEW);
    assert.equal(run.preview, 'short,behavior');
    assert.equal(run.experience, COMPANION_EXPERIENCE);
    assert.equal(run.contextEnabled, false);
  });

  test('companion 同时打开会话时 contextEnabled 原样为 true', () => {
    const run = launcherRunOptions({ experience: 'companion', chatContext: true });
    assert.equal(run.contextEnabled, true);
    assert.equal(run.preview, COMPANION_PREVIEW);
    assert.equal(run.experience, COMPANION_EXPERIENCE);
  });
});

describe('launcherRunOptions standard', () => {
  test('standard 不产生 preview 与 experience（反馈与行为都不创建）', () => {
    const run = launcherRunOptions({ experience: 'standard', chatContext: false });
    assert.equal(run.preview, undefined);
    assert.equal(run.experience, undefined);
    assert.equal(run.contextEnabled, false);
  });

  test('standard 的 context 开关同样透传', () => {
    const run = launcherRunOptions({ experience: 'standard', chatContext: true });
    assert.equal(run.contextEnabled, true);
    assert.equal(run.preview, undefined);
    assert.equal(run.experience, undefined);
  });
});

describe('launcherRunOptions 不读父环境变量、无副作用', () => {
  test('父进程残留 PET_NEXT_PREVIEW / PET_NEXT_EXPERIENCE 不污染 standard', () => {
    const previousPreview = process.env[PREVIEW_ENV];
    const previousExperience = process.env[CHAT_EXPERIENCE_ENV];
    process.env[PREVIEW_ENV] = 'short,behavior,bench-observe';
    process.env[CHAT_EXPERIENCE_ENV] = COMPANION_EXPERIENCE;
    try {
      const run = launcherRunOptions({ experience: 'standard', chatContext: false });
      assert.equal(run.preview, undefined);
      assert.equal(run.experience, undefined);
    } finally {
      if (previousPreview === undefined) delete process.env[PREVIEW_ENV];
      else process.env[PREVIEW_ENV] = previousPreview;
      if (previousExperience === undefined) delete process.env[CHAT_EXPERIENCE_ENV];
      else process.env[CHAT_EXPERIENCE_ENV] = previousExperience;
    }
  });

  test('companion 结果只来自本次选择：每次返回新对象，互不共享可变状态', () => {
    const first = launcherRunOptions({ experience: 'companion', chatContext: true });
    const second = launcherRunOptions({ experience: 'companion', chatContext: true });
    assert.notEqual(first, second);
    assert.deepEqual(first, second);
    first.preview = 'two-slot';
    assert.equal(second.preview, COMPANION_PREVIEW);
  });

  test('不发起任何模型调用：映射前后不含网络/进程副作用', () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: unknown[]) => {
      calls.push(String(args[0]));
      throw new Error('unexpected fetch');
    }) as typeof globalThis.fetch;
    try {
      launcherRunOptions({ experience: 'companion', chatContext: true });
      launcherRunOptions({ experience: 'standard', chatContext: false });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(calls, []);
  });
});
