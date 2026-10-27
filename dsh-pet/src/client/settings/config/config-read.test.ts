/**
 * 成品配置读取（src/client/settings/config-read.ts）的契约测试。
 *
 * 三条契约：
 *   1. 坏响应要显式失败：`main.pets` 缺失或不是数组时返回 `null`，让调用方报错而不是渲染半张空表单；
 *   2. 没写或写成坏值的字段不出现在补丁里，表单保留自己手里的值，绝不拿坏数据覆盖；
 *   3. 成品里已填满的段落（物理参数、字体）缺子键时用内置默认补满，读出来的始终是完整对象。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { readMainConfig } from './config-read.ts';
import { DEFAULT_PHYSICS } from '../../../shared/physics.ts';
import { DEFAULT_FONT } from '../../../shared/fonts.ts';

describe('readMainConfig —— 成品聚合 → 表单补丁', () => {
  test('main.pets 缺失或不是数组：返回 null（响应坏了）', () => {
    assert.equal(readMainConfig({}), null);
    assert.equal(readMainConfig({ main: {} }), null);
    assert.equal(readMainConfig({ main: { pets: 'oops' } }), null);
  });

  test('pets 深拷贝位置：编辑列表与成品列表是两份数据', () => {
    const merged = {
      main: { pets: [{ id: 'pet-1', position: { corner: 'top-left', marginX: 1, marginY: 2 } }] },
    };
    const patch = readMainConfig(merged);
    assert.ok(patch?.pets);
    patch.pets[0].position.marginX = 99;
    assert.equal(merged.main.pets[0].position.marginX, 1, '不允许共享同一份 position 对象');
  });

  test('物理参数与字体：成品缺子键时用内置默认补满', () => {
    const patch = readMainConfig({ main: { pets: [], physics: { gravity: 3 }, font: { size: 20 } } });
    assert.deepEqual(patch?.physics, { ...DEFAULT_PHYSICS, gravity: 3 });
    assert.deepEqual(patch?.font, { ...DEFAULT_FONT, size: 20 });
  });

  test('模型选择只写一半：整对都当没写（宿主会按非法拒绝）', () => {
    const half = readMainConfig({ main: { pets: [], whisperModel: { provider: 'openai' } } });
    assert.equal(half?.whisperModel, undefined);
    const full = readMainConfig({ main: { pets: [], chatModel: { provider: 'a', model: 'b' } } });
    assert.deepEqual(full?.chatModel, { provider: 'a', model: 'b' });
  });

  test('数值字段：负数与非数字当没写，0 是合法值', () => {
    assert.equal(readMainConfig({ main: { pets: [], chatMemoryRounds: -1 } })?.chatMemoryRounds, undefined);
    assert.equal(readMainConfig({ main: { pets: [], chatMemoryRounds: 'x' } })?.chatMemoryRounds, undefined);
    assert.equal(readMainConfig({ main: { pets: [], chatImageLimit: 0 } })?.chatImageLimit, 0);
  });

  test('布尔字段缺失就不进补丁，避免把默认值当用户选择写回去', () => {
    const patch = readMainConfig({ main: { pets: [] } });
    assert.equal('notificationsEnabled' in (patch ?? {}), false);
    assert.equal('trayEnabled' in (patch ?? {}), false);
    const withFlag = readMainConfig({ main: { pets: [], trayEnabled: false } });
    assert.equal(withFlag?.trayEnabled, false);
  });

  test('条目人设原样带出，供「留空时跟随什么」的预览', () => {
    assert.equal(readMainConfig({ main: { pets: [], whisperPrompt: '条目人设' } })?.entryPrompt, '条目人设');
  });
});
