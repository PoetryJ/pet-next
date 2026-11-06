/**
 * M3-9 暂停策略的纯单测：不碰 DOM/时钟，只验判定与归属。
 * @module pet-next/core/idle-suspension/policy.test
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  leaseStillCurrent,
  reconcileIdleSuspension,
  SINGLE_SLOT,
  type IdlePauseLease,
  type IdleSuspensionView,
} from './policy.ts';

const IDENTITY = 'single-primary';

function view(overrides: Partial<IdleSuspensionView> = {}): IdleSuspensionView {
  return {
    enabled: true,
    hidden: true,
    disposed: false,
    generation: 3,
    clip: 'idle',
    once: false,
    phase: 'playing',
    lease: null,
    resuming: false,
    ...overrides,
  };
}

function lease(generation = 3): IdlePauseLease {
  return { generation, slot: SINGLE_SLOT, elementIdentity: IDENTITY };
}

test('开关关闭时永不动手', () => {
  assert.deepEqual(reconcileIdleSuspension(view({ enabled: false }), IDENTITY), {
    type: 'none',
    reason: 'disabled',
  });
});

test('dispose 后不再暂停或恢复', () => {
  assert.deepEqual(reconcileIdleSuspension(view({ disposed: true }), IDENTITY), { type: 'none', reason: 'disposed' });
});

test('隐藏 + 当前 idle + playing → 暂停并取得归属', () => {
  const decision = reconcileIdleSuspension(view(), IDENTITY);
  assert.equal(decision.type, 'pause');
  assert.deepEqual(decision.type === 'pause' ? decision.lease : null, lease(3));
});

test('重复 hidden 事件不重复暂停同一 owner', () => {
  assert.deepEqual(reconcileIdleSuspension(view({ lease: lease() }), IDENTITY), {
    type: 'none',
    reason: 'already-suspended',
  });
});

test('只有 idle 会被暂停：reaction / auto / once 都不行', () => {
  assert.equal(reconcileIdleSuspension(view({ clip: 'reaction' }), IDENTITY).type, 'none');
  assert.equal(reconcileIdleSuspension(view({ clip: 'auto' }), IDENTITY).type, 'none');
  assert.equal(reconcileIdleSuspension(view({ clip: null }), IDENTITY).type, 'none');
  assert.deepEqual(reconcileIdleSuspension(view({ once: true }), IDENTITY), { type: 'none', reason: 'once-action' });
});

test('加载中/未兑现 play 不暂停', () => {
  for (const phase of ['loading', 'ready', 'ended', 'failed', 'cancelled']) {
    assert.deepEqual(reconcileIdleSuspension(view({ phase }), IDENTITY), { type: 'none', reason: `phase-${phase}` });
  }
});

test('可见且归属仍匹配 → 恢复一次', () => {
  const decision = reconcileIdleSuspension(view({ hidden: false, lease: lease() }), IDENTITY);
  assert.equal(decision.type, 'resume');
  assert.deepEqual(decision.type === 'resume' ? decision.lease : null, lease(3));
});

test('可见但无归属 → 不恢复（别动别的暂停）', () => {
  assert.deepEqual(reconcileIdleSuspension(view({ hidden: false }), IDENTITY), { type: 'none', reason: 'no-lease' });
});

test('同 requestId 换代后旧归属失效', () => {
  assert.deepEqual(reconcileIdleSuspension(view({ hidden: false, generation: 4, lease: lease(3) }), IDENTITY), {
    type: 'none',
    reason: 'stale-lease',
  });
});

test('元素身份不同的归属不认', () => {
  const foreign: IdlePauseLease = { generation: 3, slot: SINGLE_SLOT, elementIdentity: 'other' };
  assert.equal(reconcileIdleSuspension(view({ hidden: false, lease: foreign }), IDENTITY).type, 'none');
});

test('恢复在途不重复 play', () => {
  assert.deepEqual(reconcileIdleSuspension(view({ hidden: false, lease: lease(), resuming: true }), IDENTITY), {
    type: 'none',
    reason: 'resuming',
  });
});

test('leaseStillCurrent 只认当前代次与元素', () => {
  assert.equal(leaseStillCurrent(lease(3), 3, IDENTITY), true);
  assert.equal(leaseStillCurrent(lease(3), 4, IDENTITY), false);
  assert.equal(leaseStillCurrent(lease(3), 3, 'other'), false);
  assert.equal(leaseStillCurrent(null, 3, IDENTITY), false);
});
