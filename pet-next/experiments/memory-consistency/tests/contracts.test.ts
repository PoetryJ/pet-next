/**
 * 契约层冻结自检（G0）。
 *
 * 只验证四件事，全部是纯函数：
 * 1) 一条样例事件经 canonicalJson 往返后摘要稳定（期望值冻结在 json 里，不由被测代码生成）。
 * 2) 预算计量按 UTF-16 code units 与 UTF-8 bytes 分别给出，中文不再相等。
 * 3) 同 eventId 换 sequence 仍算同载荷；换文本必须变载荷哈希。
 * 4) 身份键与依赖节点 id 不串代际。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  canonicalJson,
  countUtf8,
  depIdForNote,
  depIdForSubject,
  eventPayloadDigest,
  measureUsage,
  payloadHash,
  requestKey,
  requiredIdsPresent,
  sessionKey,
  taskKey,
  type MemoryEvent,
} from '../contracts.ts';

const SAMPLE_PATH = new URL('../samples/roundtrip-v1.json', import.meta.url);

interface SampleFile {
  readonly event: MemoryEvent;
  readonly expected: {
    readonly requiredIdsPresent: boolean;
    readonly payloadHash: string;
    readonly canonicalUtf16: number;
    readonly canonicalUtf8: number;
  };
}

const sample = JSON.parse(readFileSync(SAMPLE_PATH, 'utf8')) as SampleFile;

describe('contracts v1', () => {
  test('样例事件的形状守卫与载荷哈希与冻结值一致', () => {
    assert.equal(requiredIdsPresent(sample.event), sample.expected.requiredIdsPresent);
    assert.equal(payloadHash(sample.event), sample.expected.payloadHash);
  });

  test('样例序列化后的两种计量与冻结值一致', () => {
    const usage = measureUsage(canonicalJson(sample.event));
    assert.equal(usage.utf16Units, sample.expected.canonicalUtf16);
    assert.equal(usage.utf8Bytes, sample.expected.canonicalUtf8);
  });

  test('canonicalJson 与键顺序无关', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } });
    const b = canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 });
    assert.equal(a, b);
  });

  test('中文预算不能只算字符数', () => {
    const text = '记忆';
    assert.equal(text.length, 2);
    assert.equal(countUtf8(text), 6);
  });

  test('同 eventId 换 sequence 仍是同载荷', () => {
    const later: MemoryEvent = { ...sample.event, sequence: 9 };
    assert.equal(eventPayloadDigest(later), eventPayloadDigest(sample.event));
  });

  test('改文本必须改载荷哈希', () => {
    const changed: MemoryEvent = {
      ...sample.event,
      payload: { ...sample.event.payload, text: '以后周报直接发。' },
    };
    assert.notEqual(payloadHash(changed), payloadHash(sample.event));
  });

  test('身份键不跨代际串用', () => {
    assert.notEqual(sessionKey('s', 1), sessionKey('s', 2));
    assert.notEqual(requestKey('s', 1, 'r'), requestKey('s', 2, 'r'));
    assert.equal(taskKey('s', 't'), 's::t');
    assert.notEqual(depIdForSubject('pref:x'), depIdForNote('pref:x'));
  });
});
