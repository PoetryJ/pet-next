/**
 * 针对真实模型（Qwen3-1.7B）实跑暴露问题的回归：每条对应一个已观测到的 guard 前错误形态。
 * 夹具只模拟“模型输出的形状”，用于证明本地链路的处理，不代表模型能力。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CapabilityMemoryStore } from '../memory/store.ts'
import { applyExtraction, buildExtractionRequest, extractPending } from '../memory/extract.ts'
import { readForDecision } from '../memory/read.ts'
import { assess, submitAssessment } from '../intervention/assess.ts'
import type { AssessSnapshot } from '../intervention/assess.ts'
import { FixtureClient } from './fixture-model.ts'
import { ingestVerifiedOutcome } from '../memory/verified.ts'

const budget = { maxItems: 30, maxChars: 6000 }
const T = (m: number) => new Date(Date.parse('2026-11-13T10:00:00Z') + m * 60_000).toISOString()
const item = (o: Record<string, unknown>) => ({ kind: 'commitment', statement: '', scope: { level: 'task', id: 'task:R' }, validFrom: null, validUntil: null, supersedes: [], confidence: 0.9, status: 'active', ...o })
const quote = (turnId: string, text: string) => [{ turnId, start: 0, end: 0, text }]

function seed() {
  const store = new CapabilityMemoryStore(':memory:')
  store.appendTurn({ turnId: 'u1', sessionId: 's1', seq: 1, at: T(0), role: 'user', text: '回归最初跑48个样本，需要我选方向时再问。', taskIds: ['task:R'] })
  return store
}

test('同一句原话再次送抽（全历史重抽）不产生重复/被自己取代的条目', async () => {
  const store = seed()
  const out = JSON.stringify({ items: [item({ key: 'sampleCount', value: 48, quotes: quote('u1', '最初跑48个样本') })] })
  const r1 = await extractPending(store, new FixtureClient(() => out), { entities: [], now: T(1) })
  assert.equal(r1.report!.accepted.length, 1)
  const first = r1.report!.accepted[0]!
  // 宿主把全历史再送一次（同一 turn 再作为本批）：模型又抽出同片段并声称取代旧条目
  const req = buildExtractionRequest({ newTurns: store.turns(), priorTurns: [], existingItems: [], entities: [], createdAt: T(2) })
  const again = JSON.stringify({ items: [item({ key: 'runTarget', value: 48, supersedes: [first.itemId], quotes: quote('u1', '跑48个样本') })] })
  const r2 = applyExtraction(store, { ...req, requestId: 'req-again' }, { requestId: 'req-again', rawText: again }, ['u1'], T(2))
  assert.deepEqual(r2.rejected.map((x) => x.reason), [`duplicate_span:${first.itemId}`])
  const p = readForDecision(store, { taskId: 'task:R', asOf: T(3), intent: 'current', question: '样本数', requiredSlots: ['runTarget'], budget })
  assert.deepEqual(p.commitments.map((i) => i.value), [48])
  assert.equal(p.context.nonActionable.length, 0, '没有自我取代出来的 superseded 副本')
  store.close()
})

test('结构字段名当 key（taskIds）被拒；非时间值不归入截止属性；整句当值被拒', async () => {
  const store = seed()
  const out = JSON.stringify({ items: [
    item({ key: 'taskIds', value: 'task:R', quotes: quote('u1', '回归最初跑48个样本') }),
    item({ key: 'deadline', value: '48', quotes: quote('u1', '最初跑48个样本') }),
    item({ key: 'notificationPolicy', kind: 'preference', value: '回归最初跑48个样本，需要我选方向时再问。', quotes: quote('u1', '回归最初跑48个样本，需要我选方向时再问。') }),
    item({ key: 'notificationPolicy', kind: 'preference', value: 'only_when_user_choice_needed', quotes: quote('u1', '需要我选方向时再问') }),
  ] })
  const r = await extractPending(store, new FixtureClient(() => out), { entities: [], now: T(1) })
  assert.deepEqual(r.report!.rejected.map((x) => x.reason), ['key_is_metadata:taskIds', 'value_is_whole_utterance'])
  const keys = r.report!.accepted.map((i) => i.key)
  assert.deepEqual(keys, ['other.deadline', 'notificationPolicy'])
  assert.ok(r.report!.accepted[0]!.checks.some((c) => c.startsWith('attribute_type_mismatch:decisionDeadline')))
  store.close()
})

test('工具/助手来源的条目不能取代用户原话条目', async () => {
  const store = seed()
  const r1 = await extractPending(store, new FixtureClient(() => JSON.stringify({ items: [item({ key: 'runTarget', value: 48, quotes: quote('u1', '最初跑48个样本') })] })), { entities: [], now: T(1) })
  const userItem = r1.report!.accepted[0]!
  store.appendTurn({ turnId: 't1', sessionId: 'obs', seq: 2, at: T(2), role: 'tool', text: '运行 run-64 修订1：总数64，通过56。', taskIds: ['task:R'] })
  const r2 = await extractPending(store, new FixtureClient(() => JSON.stringify({ items: [item({ key: 'runTarget', value: 64, supersedes: [userItem.itemId], quotes: quote('t1', '总数64') })] })), { entities: [], now: T(3) })
  const it = r2.report!.accepted[0]!
  assert.deepEqual(it.supersedes, [])
  assert.ok(it.checks.includes(`supersede_authority_ignored:${userItem.itemId}`))
  assert.equal(it.status, 'inferred', '非用户来源的承诺降为 inferred')
  const p = readForDecision(store, { taskId: 'task:R', asOf: T(4), intent: 'current', question: '样本数', requiredSlots: ['runTarget'], budget })
  const u = p.commitments.find((i) => i.itemId === userItem.itemId)
  assert.ok(u && u.status === 'active' && u.supersededBy.length === 0, '用户原话条目仍是当前依据，未被取代')
  assert.ok(p.commitments.filter((i) => i.value === 64).every((i) => i.authority === 'tool' && i.status === 'inferred'))
  store.close()
})

const snap = (now: string, options: AssessSnapshot['options'] = []): AssessSnapshot => ({ taskId: 'task:R', title: 'R', goal: '跟进', taskRevision: 1, assignmentId: 'run-r1', status: 'result_observed', stage: 'result_observed', now, latestResult: null, options })
const proposal = (o: Record<string, unknown>) => JSON.stringify({ kind: 'wait', reasonCode: 'waiting_external_info', question: null, optionIds: [], wakeAt: null, waitFor: '更正', deadlineAt: null, deliverAt: null, batchable: false, evidenceTurnIds: [], evidenceItemIds: [], answerFacts: [], ...o })

test('wait 的 wakeAt/deadlineAt 填成当前时间：有记忆里的预计到达时间则按条目修复并记录，否则仍拒绝', async () => {
  const store = seed()
  store.appendTurn({ turnId: 'u2', sessionId: 's2', seq: 2, at: T(1), role: 'user', text: `更正预计在 ${T(10)} 到，我的选择截止 ${T(30)}，先等。`, taskIds: ['task:R'] })
  await extractPending(store, new FixtureClient(() => JSON.stringify({ items: [
    item({ kind: 'fact', key: 'expectedUpdateAt', value: T(10), quotes: quote('u2', `更正预计在 ${T(10)} 到`) }),
    item({ key: 'decisionDeadline', value: T(30), quotes: quote('u2', `我的选择截止 ${T(30)}`) }),
  ] })), { entities: [], now: T(1) })
  const now = T(2)
  const packet = readForDecision(store, { taskId: 'task:R', asOf: now, intent: 'current', question: '等待', requiredSlots: ['expectedUpdateAt'], budget })
  const rec = await assess(snap(now), packet, undefined, new FixtureClient(() => proposal({ wakeAt: now, deadlineAt: now, evidenceTurnIds: ['u2'] })))
  const s = submitAssessment(rec, packet, { taskRevision: 1, assignmentId: 'run-r1', now }, store, snap(now))
  assert.equal(s.code, 'accepted')
  assert.equal(s.proposal!.wakeAt, T(10))
  assert.equal(s.proposal!.deadlineAt, T(30))
  assert.ok(s.checks.some((c) => c.startsWith('wakeAt_repaired:')))
  // 记忆里没有时间锚点：仍然拒绝
  const bare = seed()
  const p2 = readForDecision(bare, { taskId: 'task:R', asOf: now, intent: 'current', question: '等待', requiredSlots: [], budget })
  const rec2 = await assess(snap(now), p2, undefined, new FixtureClient(() => proposal({ wakeAt: now, evidenceTurnIds: ['u1'] })))
  assert.equal(submitAssessment(rec2, p2, { taskRevision: 1, assignmentId: 'run-r1', now }, bare, snap(now)).code, 'wait_without_recheck')
  store.close(); bare.close()
})

test('引用里混入未知 id / 未提供选项：剔除并记录，仍有有效依据时不整单拒绝', async () => {
  const store = seed()
  await extractPending(store, new FixtureClient(() => JSON.stringify({ items: [item({ key: 'runTarget', value: 48, quotes: quote('u1', '最初跑48个样本') })] })), { entities: [], now: T(1) })
  const now = T(2)
  const opts = [{ optionId: 'analyze_failing', label: '分析' }, { optionId: 'keep_waiting', label: '等' }]
  const packet = readForDecision(store, { taskId: 'task:R', asOf: now, intent: 'current', question: '样本', requiredSlots: [], budget })
  const rec = await assess(snap(now, opts), packet, undefined, new FixtureClient(() => proposal({ kind: 'ask', reasonCode: 'needs_user_choice', question: '分析吗？', optionIds: ['analyze_failing', 'fix_code'], evidenceTurnIds: ['u1', 'turn-999'], wakeAt: null })))
  const s = submitAssessment(rec, packet, { taskRevision: 1, assignmentId: 'run-r1', now }, store, snap(now, opts))
  assert.equal(s.code, 'accepted')
  assert.deepEqual(s.proposal!.optionIds, ['analyze_failing'])
  assert.deepEqual(s.proposal!.evidenceTurnIds, ['u1'])
  assert.ok(s.checks.includes('dropped_unknown_refs:turn-999'))
  assert.ok(s.checks.includes('dropped_unoffered_options:fix_code'))
  // 只有未知引用 → 仍拒绝
  const rec2 = await assess(snap(now, opts), packet, undefined, new FixtureClient(() => proposal({ kind: 'ask', reasonCode: 'needs_user_choice', question: '?', optionIds: ['analyze_failing'], evidenceTurnIds: ['turn-999'] })))
  assert.equal(submitAssessment(rec2, packet, { taskRevision: 1, assignmentId: 'run-r1', now }, store, snap(now, opts)).code, 'evidence_unknown')
  store.close()
})

test('逐 turn 覆盖 + 同值断言只记支持 + 相对时长由系统换算', async () => {
  const store = seed()
  await extractPending(store, new FixtureClient(() => JSON.stringify({ items: [item({ key: 'runTarget', value: 48, quotes: quote('u1', '最初跑48个样本') })] })), { entities: [], now: T(1) })
  const u1Item = store.items()[0]!
  store.appendTurn({ turnId: 'u2', sessionId: 's2', seq: 2, at: T(5), role: 'user', text: '还是48个样本。接下来4分钟我在开会。', taskIds: ['task:R'] })
  store.appendTurn({ turnId: 'u3', sessionId: 's2', seq: 3, at: T(6), role: 'user', text: '嗯。', taskIds: ['task:R'] })
  store.appendTurn({ turnId: 'u4', sessionId: 's2', seq: 4, at: T(7), role: 'user', text: '顺便说下天气不错。', taskIds: ['task:R'] })
  const r = await extractPending(store, new FixtureClient(() => JSON.stringify({ coverage: [{ turnId: 'u2', status: 'extracted' }, { turnId: 'u3', status: 'no_relevant_fact' }], items: [
    item({ key: 'runTarget', value: '48', quotes: quote('u2', '还是48个样本') }),
    item({ kind: 'preference', key: 'availability', value: 'busy', scope: { level: 'global', id: null }, durationMinutes: 4, validUntil: new Date(Date.parse(T(5)) + 4000).toISOString(), quotes: quote('u2', '接下来4分钟我在开会') }),
  ] })), { entities: [], now: T(8) })
  assert.deepEqual(r.report!.supports.map((x) => x.itemId), [u1Item.itemId], '同值不新建条目')
  const busy = r.report!.accepted.find((i) => i.key === 'availability')!
  assert.equal(busy.validUntil, new Date(Date.parse(T(5)) + 4 * 60_000).toISOString(), '4 分钟按原话时间换算，不信模型自己算的 4 秒')
  assert.deepEqual(r.report!.coverage.map((c) => `${c.turnId}:${c.status}`), ['u2:extracted', 'u3:no_relevant_fact', 'u4:uncovered'])
  const p = readForDecision(store, { taskId: 'task:R', asOf: T(9), intent: 'current', question: '样本', requiredSlots: ['runTarget'], budget })
  assert.ok(p.context.recentTurns.some((x) => x.turnId === 'u4'), '未覆盖原话仍可读')
  assert.ok(!p.context.recentTurns.some((x) => x.turnId === 'u3'))
  const again = await extractPending(store, new FixtureClient(() => { throw new Error('不应再次送抽未覆盖原话') }), { entities: [], now: T(10) })
  assert.equal(again.status, 'nothing')
  store.close()
})

test('宿主验真的工具结果直接成为 outcome，新修订取代旧修订（系统构建取代边）', () => {
  const store = seed()
  store.appendTurn({ turnId: 'o1', sessionId: 'obs', seq: 2, at: T(1), role: 'tool', text: '[结果] run-64 修订1 partial', taskIds: ['task:R'] })
  const a = ingestVerifiedOutcome(store, store.turn('o1')!, 'task:R', { runId: 'run-64', revision: 1, status: 'partial', metrics: { total: 64, passed: 56 }, resultFileSha: 'a'.repeat(64) }, T(1))
  store.appendTurn({ turnId: 'o2', sessionId: 'obs', seq: 3, at: T(2), role: 'tool', text: '[结果] run-64 修订2 partial', taskIds: ['task:R'] })
  const b = ingestVerifiedOutcome(store, store.turn('o2')!, 'task:R', { runId: 'run-64', revision: 2, status: 'partial', metrics: { total: 64, passed: 61 }, resultFileSha: 'b'.repeat(64) }, T(2))
  assert.deepEqual(b.supersedes, [a.itemId])
  assert.equal(ingestVerifiedOutcome(store, store.turn('o2')!, 'task:R', { runId: 'run-64', revision: 2, status: 'partial', metrics: { total: 64, passed: 61 }, resultFileSha: 'b'.repeat(64) }, T(3)).itemId, b.itemId, '重复观察幂等')
  const p = readForDecision(store, { taskId: 'task:R', asOf: T(4), intent: 'current', question: '结果', requiredSlots: ['resultObserved'], budget })
  assert.deepEqual(p.outcomes.map((i) => i.value), ['run-64-r2:partial'])
  assert.ok(store.extractedTurnIds().has('o2'), '工具原话按验真入库后才算覆盖')
  store.close()
})
