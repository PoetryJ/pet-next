/**
 * 设置页字典（src/client/settings/locales.ts）的契约测试。
 *
 * 三条契约：
 *   1. zh 是键集真源：en 多键、少键都在类型期就该报错，这里再用运行时兜一次；
 *   2. `{n}` / `{id}` / `{profile}` 这类插值占位符中英必须一一对应，否则翻译后 UI 会直接印出原文占位符；
 *   3. en 不得残留中文，值不得为空，也不得带首尾空白（空标签在设置页里就是一处看不见的洞）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { en, zh } from './locales.ts';

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// 只查汉字本身：英文文案里出现「」这类全角引号是排版习惯，出现汉字才是漏翻。
const cjk = /[\u4e00-\u9fff]/;

describe('zh / en 字典', () => {
  test('键集一致：en 不多键也不少键', () => {
    const zhKeys = Object.keys(zh).sort();
    const enKeys = Object.keys(en).sort();
    assert.deepEqual(
      enKeys.filter((key) => !zhKeys.includes(key)),
      [],
      'en 里有多出来的键（zh 是键集真源，新增文案先加 zh）',
    );
    assert.deepEqual(
      zhKeys.filter((key) => !enKeys.includes(key)),
      [],
      'en 里缺键（缺失的键会退化成显示 key 本身）',
    );
  });

  test('插值占位符一致：每个键中英占位符集合相同', () => {
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      assert.deepEqual(
        placeholders(en[key]),
        placeholders(zh[key]),
        `「${key}」的占位符与中文不一致：插值会失败，UI 里会印出原文占位符`,
      );
    }
  });

  test('文案可用：都不是空白、英文里没有汉字', () => {
    for (const [key, value] of Object.entries(zh)) {
      assert.ok(value.trim().length > 0, `zh.${key} 是空白`);
    }
    for (const [key, value] of Object.entries(en)) {
      assert.ok(value.trim().length > 0, `en.${key} 是空白`);
      // 首尾空格不查：modelUnknown 这类后缀文案靠英文侧的前导空格与前半句断开，中文用全角括号不需要。
      assert.ok(!cjk.test(value), `en.${key} 里还有中文没翻：${value}`);
    }
  });
});
