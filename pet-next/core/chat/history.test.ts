/**
 * 有界历史单测：轮数/字符上界、整轮淘汰、快照不可变与隔离、清空。
 * @module pet-next/core/chat/history.test
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CHAT_HISTORY_MAX_CHARS, CHAT_HISTORY_MAX_TURNS, createChatHistory } from './history.ts';

describe('core/chat/history', () => {
  test('push/snapshot/turns/chars 基本语义，快照保持插入顺序', () => {
    const history = createChatHistory();
    history.push('我叫小林', '你好，小林！');
    history.push('今天有点累', '抱抱，早点休息。');
    assert.equal(history.turns(), 2);
    assert.equal(history.chars(), '我叫小林'.length + '你好，小林！'.length + '今天有点累'.length + '抱抱，早点休息。'.length);
    const snapshot = history.snapshot();
    assert.equal(snapshot.length, 2);
    assert.equal(snapshot[0]?.user, '我叫小林');
    assert.equal(snapshot[1]?.assistant, '抱抱，早点休息。');
  });

  test('冻结上界与契约一致：4 轮 / 2000 字符', () => {
    assert.equal(CHAT_HISTORY_MAX_TURNS, 4);
    assert.equal(CHAT_HISTORY_MAX_CHARS, 2000);
  });

  test('超过 4 轮：按最老完整轮淘汰，只留最近 4 轮', () => {
    const history = createChatHistory();
    for (let i = 1; i <= 6; i += 1) history.push(`第${i}句`, `第${i}答`);
    assert.equal(history.turns(), 4);
    const snapshot = history.snapshot();
    assert.deepEqual(
      snapshot.map((entry) => entry.user),
      ['第3句', '第4句', '第5句', '第6句'],
    );
  });

  test('字符上界：合计超 2000 时淘汰最老整轮，直到回到界内', () => {
    const history = createChatHistory();
    // 每轮 300+300=600 字符；4 轮=2400>2000 → 淘汰最老 1 轮，留 3 轮=1800。
    history.push('a'.repeat(300), 'b'.repeat(300));
    history.push('c'.repeat(300), 'd'.repeat(300));
    history.push('e'.repeat(300), 'f'.repeat(300));
    history.push('g'.repeat(300), 'h'.repeat(300));
    assert.equal(history.turns(), 3);
    assert.ok(history.chars() <= 2000, `chars=${history.chars()}`);
    assert.equal(history.snapshot()[0]?.user, 'c'.repeat(300));
  });

  test('单轮自身超字符上界：连本轮一起淘汰（宁空不过界，不留半轮）', () => {
    const history = createChatHistory();
    history.push('我叫小林', '你好');
    history.push('x'.repeat(1200), 'y'.repeat(1200)); // 单轮 2400 > 2000
    assert.equal(history.turns(), 0, '历史应为空而不是保留超界的完整单轮或半轮');
    assert.equal(history.chars(), 0);
  });

  test('注入更小上界（测试用）：按注入值淘汰', () => {
    const history = createChatHistory({ maxTurns: 2, maxChars: 100 });
    history.push('u1', 'a1');
    history.push('u2', 'a2');
    history.push('u3', 'a3');
    assert.equal(history.turns(), 2);
    assert.equal(history.snapshot()[0]?.user, 'u2');
  });

  test('快照不可变：数组与条目均冻结，改快照不影响仓库', () => {
    const history = createChatHistory();
    history.push('u', 'a');
    const snapshot = history.snapshot();
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot[0]), true);
    assert.throws(() => {
      (snapshot as unknown as { push(v: unknown): void }).push({ user: 'x', assistant: 'y' });
    });
    assert.throws(() => {
      (snapshot[0] as unknown as { user: string }).user = '改';
    });
    assert.equal(history.turns(), 1);
    assert.equal(history.snapshot()[0]?.user, 'u');
  });

  test('快照隔离：取得快照后继续 push/clear，已发出的快照不变', () => {
    const history = createChatHistory();
    history.push('u1', 'a1');
    const taken = history.snapshot();
    history.push('u2', 'a2');
    history.clear();
    assert.equal(taken.length, 1);
    assert.equal(taken[0]?.user, 'u1');
    assert.equal(history.turns(), 0);
    assert.deepEqual(history.snapshot(), []);
  });

  test('clear 后可重新累积', () => {
    const history = createChatHistory();
    history.push('u1', 'a1');
    history.clear();
    history.push('u2', 'a2');
    assert.equal(history.turns(), 1);
    assert.equal(history.snapshot()[0]?.user, 'u2');
  });
});
