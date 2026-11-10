/**
 * B1 四策略测试：同源输入、统一预算口径、超限显式失败。
 *
 * 这里不断言「哪个策略更好」。策略优劣要等维护等价与固定规模成本比较之后才谈。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { POLICY_IDS, measureUsage, type Budget, type MemoryEvent, type MemoryState, type PolicyInput } from '../contracts.ts';
import { loadTrack } from '../eval/harness.ts';
import { runTrack } from '../eval/harness.ts';
import { POLICIES, policyById } from './compile.ts';

function stateOf(trackId: string): { state: MemoryState; events: readonly MemoryEvent[] } {
  const track = loadTrack(fileURLToPath(new URL(`../cases/dev/${trackId}.json`, import.meta.url)));
  const observation = runTrack(track);
  return { state: observation.state, events: observation.state.events };
}

const BUDGETS: readonly Budget[] = [
  { utf16Units: 512, utf8Bytes: 1536 },
  { utf16Units: 2000, utf8Bytes: 6000 },
  { utf16Units: 8000, utf8Bytes: 24000 },
];

function input(trackId: string, budget: Budget, text = '周报怎么处理？'): PolicyInput {
  const { state, events } = stateOf(trackId);
  return { state, events, query: { text }, budget };
}

describe('四策略共同契约', () => {
  test('四个策略 id 与冻结枚举一致', () => {
    assert.deepEqual(POLICIES.map((policy) => policy.id).sort(), [...POLICY_IDS].sort());
  });

  test('任何预算下都不越界，也不会返回半截隐藏内容', () => {
    for (const trackId of ['A5-v1', 'A5-v2', 'D5-v1']) {
      for (const budget of BUDGETS) {
        for (const policy of POLICIES) {
          const context = policy.compile(input(trackId, budget));
          const usage = measureUsage(context.text);
          assert.equal(context.usage.utf16Units, usage.utf16Units);
          assert.equal(context.usage.utf8Bytes, usage.utf8Bytes);
          if (context.exceeded) {
            assert.equal(context.text, '');
            assert.ok(context.diagnostics.some((item) => item.code === 'budget_exceeded'));
          } else {
            assert.ok(usage.utf16Units <= budget.utf16Units, `${policy.id} utf16 overflow`);
            assert.ok(usage.utf8Bytes <= budget.utf8Bytes, `${policy.id} utf8 overflow`);
          }
        }
      }
    }
  });

  test('头部行标出策略与版本，便于事后核对是谁产出的上下文', () => {
    for (const policy of POLICIES) {
      const context = policy.compile(input('A5-v1', BUDGETS[2] as Budget));
      assert.ok(context.text.startsWith(`policy=${policy.id} v1`), policy.id);
    }
  });

  test('预算极小时整段显式失败，不退化成静默空上下文', () => {
    const tiny: Budget = { utf16Units: 4, utf8Bytes: 4 };
    for (const policy of POLICIES) {
      const context = policy.compile(input('A5-v1', tiny));
      assert.equal(context.exceeded, true, policy.id);
      assert.equal(context.text, '');
    }
  });
});

describe('策略差异', () => {
  test('状态账本排除已失效笔记', () => {
    const context = policyById('state-ledger').compile(input('A5-v2', BUDGETS[2] as Budget));
    assert.ok(context.text.includes('语言偏好：中文'));
    assert.ok(!context.text.includes('周报任务进行中'), 'invalidated note leaked into current facts');
    assert.ok(context.diagnostics.some((item) => item.code === 'excluded_invalidated'));
  });

  test('近期轮历史不看笔记，只看事件原文', () => {
    const context = policyById('recent-turns').compile(input('A5-v2', BUDGETS[2] as Budget));
    assert.ok(context.text.includes('以后都用中文。'));
    assert.ok(!context.text.includes('语言偏好：中文'));
  });

  test('分层笔记给出 layer 分组', () => {
    const context = policyById('layered-notes').compile(input('A5-v1', BUDGETS[2] as Budget));
    assert.ok(context.text.includes('layer=preference'));
    assert.ok(context.text.includes('layer=task'));
  });

  test('依赖笔记保留失效原因与来源', () => {
    const context = policyById('dependency-notes').compile(input('A5-v2', BUDGETS[2] as Budget));
    assert.ok(context.text.includes('invalidated'));
    assert.ok(context.text.includes('reason=subject_superseded'));
    assert.ok(context.sourceIds.length > 0);
  });

  test('查询可按 subject 过滤，四个策略一致遵守', () => {
    const { state, events } = stateOf('A5-v1');
    const filtered: PolicyInput = {
      state,
      events,
      query: { text: '语言偏好', subjectKeys: ['pref:language'] },
      budget: BUDGETS[2] as Budget,
    };
    const ledger = policyById('state-ledger').compile(filtered);
    assert.ok(ledger.text.includes('语言偏好：中文'));
    assert.ok(!ledger.text.includes('周报任务进行中'));
    const layered = policyById('layered-notes').compile(filtered);
    assert.ok(!layered.text.includes('layer=task'));
  });
});
