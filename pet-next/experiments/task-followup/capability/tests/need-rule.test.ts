import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_GOAL, DEFAULT_QUIET } from '../../contracts.ts'
import { ASSESSMENT_PROTOCOL, type AssessmentSnapshot } from '../../runtime/assessment.ts'
import type { MemoryPacket, PacketItem } from '../memory/types.ts'
import { CapabilityMemoryStore } from '../memory/store.ts'
import { FixtureClient } from './fixture-model.ts'
import { decideNeedRule, createNeedRuleAssessor } from '../baselines/need-rule.ts'

const at = (minutes: number) => new Date(Date.parse('2026-11-13T09:00:00Z') + minutes * 60_000).toISOString()
function snapshot(): AssessmentSnapshot {
  return { protocol: ASSESSMENT_PROTOCOL, identity: { requestId: 'fixture-request', ticketId: 'task:X', taskRevision: 2, assignmentId: 'asg', memoryCursor: 5, eventCursor: 8, round: 0, sourceRefs: [] }, now: at(10),
    task: { ticketId: 'task:X', title: '待跟进事项', goal: '结果需要决定时问我', goalCondition: DEFAULT_GOAL, taskRevision: 2, assignmentId: 'asg', stage: 'result_received', status: 'active', createdAt: at(0), updatedAt: at(9), eventCursor: 8, memoryCursor: 5, evidence: [], attempt: 0, diagnostics: [], result: { runId: 'run-any', revision: 2, status: 'partial', metrics: { total: 40, passed: 35, failed: 5, score: null }, artifactPath: 'input.json', artifactSha: 'abc', resultPath: 'result.json', resultFileSha: 'def', note: 'Current evidence has remaining failures.' } },
    evidence: [], history: [], openAttention: null, lastAnswer: null, attempt: 0, inputReady: true, goalSatisfied: false, quiet: DEFAULT_QUIET,
    actionMenu: [{ actionId: 'question-current', source: 'baseline-rule-menu', kind: 'ask_user', reasonCode: 'insufficient', reasonText: 'Choose a local next step', question: '需要生成本地分析吗？', options: [{ id: 'analyze_failing', label: '生成分析' }, { id: 'keep_waiting', label: '继续等' }], evidenceRefs: [] }],
  }
}
function item(key: string, value: string, extra: Partial<PacketItem> = {}): PacketItem {
  return { itemId: `mem-${key}`, kind: 'commitment', key, value, statement: `${key}=${value}`, scope: { level: 'task', id: 'task:X' }, validFrom: at(1), validUntil: null, status: 'active', authority: 'user', confidence: 1, evidenceTurnIds: [`turn-${key}`], supersedes: [], supersededBy: [], ...extra }
}
function packet(...items: PacketItem[]): MemoryPacket {
  return { schema: 'pet-capability-memory-packet/v1', taskId: 'task:X', asOf: at(10), evaluatedAt: at(10), intent: 'current', memoryCursor: 5, currentFacts: [], preferences: [], commitments: items, outcomes: [], evidenceRefs: [], missing: [], conflicts: [], context: { nonActionable: [], recentTurns: [], slotResolution: [], budgetUsed: { items: items.length, chars: 1000 }, truncated: false, diagnostics: [] } }
}
const intent = (p: MemoryPacket, s = snapshot()) => decideNeedRule(s, p, { recheckMs: 60_000, answerLeadMs: 10_000 }).drafts[0]?.intent

test('基线看到与候选相同的未来ETA/截止：等待；ETA已过且当前结果仍需选择：提问', () => {
  const waiting = packet(item('waitPolicy', 'wait_if_eta_before_decision_deadline'), item('expectedUpdateAt', at(11)), item('decisionDeadline', at(15)))
  const first = decideNeedRule(snapshot(), waiting, { recheckMs: 60_000, answerLeadMs: 10_000 })
  assert.equal(first.drafts[0]!.intent, 'wait')
  assert.equal(first.drafts[0]!.notBefore, at(11))
  assert.ok(first.trace.some((t) => t.itemIds.includes('mem-expectedUpdateAt')))
  const updated = { ...snapshot(), now: at(12) }
  const after = decideNeedRule(updated, waiting)
  assert.equal(after.drafts[0]!.intent, 'ask_now')
  assert.ok(after.trace.some((t) => t.rule === 'eta_elapsed'))
})

test('当前已验证结果里的显式ETA对基线开放，后来结果不再含ETA时不凭旧等待续期', () => {
  const s = snapshot()
  const r1 = { ...s, task: { ...s.task, result: { ...s.task.result!, revision: 1, note: `补录预计${at(11)}。` } } }
  assert.equal(intent(packet(), r1), 'wait')
  assert.equal(intent(packet(), s), 'ask_now')
})

test('明确等待某修订时，该修订提前到达也解除等待，不必拖到旧ETA', () => {
  const p = packet(item('waitPolicy', 'wait_for_r2'), item('expectedUpdateAt', at(15)), item('decisionDeadline', at(20)))
  const s = snapshot()
  assert.equal(intent(p, { ...s, task: { ...s.task, result: { ...s.task.result!, revision: 1 } } }), 'wait')
  assert.equal(intent(p, s), 'ask_now')
  assert.ok(decideNeedRule(s, p).trace.some((t) => t.rule === 'wait_target_arrived'))
})

test('更新赶不上决定截止时提问，已近截止不会用忙碌状态推迟漏办', () => {
  assert.equal(intent(packet(item('expectedUpdateAt', at(15)), item('decisionDeadline', at(12)))), 'ask_now')
  const p = packet(item('availability', 'busy_progress_only', { kind: 'preference', validUntil: at(20) }), item('decisionDeadline', at(10.1)))
  assert.equal(intent(p), 'ask_now')
})

test('忙碌有界等待，新原话明确回来会解除旧忙碌；不会把未回来识别成可用', () => {
  const p = packet(item('availability', 'busy_progress_only', { kind: 'preference', validUntil: at(11) }))
  assert.equal(intent(p), 'wait')
  const user = { turnId: 'return', sessionId: 's', seq: 12, at: at(9), role: 'user' as const, taskIds: ['task:X'], quote: '我回来了，可以给我选择。', start: 0, end: 15 }
  assert.equal(intent({ ...p, context: { ...p.context, recentTurns: [user] } }), 'ask_now')
  assert.equal(intent({ ...p, context: { ...p.context, recentTurns: [{ ...user, quote: '我还没回来，先别问。' }] } }), 'wait')
})

test('取消只接受当前用户来源；旧/其他任务/assistant/假设不能取消；新未处理原话阻止旧取消', () => {
  const cancel = item('taskStatus', 'cancelled')
  assert.equal(decideNeedRule(snapshot(), packet(cancel)).taskControl?.kind, 'cancel')
  for (const modified of [{ status: 'superseded' }, { authority: 'assistant' }, { status: 'hypothetical' }, { scope: { level: 'task', id: 'task:OTHER' } }] as Partial<PacketItem>[]) {
    assert.equal(decideNeedRule(snapshot(), packet({ ...cancel, ...modified })).taskControl, undefined)
  }
  const p = packet(cancel)
  const newRaw = { turnId: 'reverse', sessionId: 's', seq: 2, at: at(9), role: 'user' as const, taskIds: ['task:X'], quote: '继续，不取消', start: 0, end: 6 }
  assert.equal(decideNeedRule(snapshot(), { ...p, context: { ...p.context, recentTurns: [newRaw] } }).taskControl, undefined)
})

test('暂停不被截止强行转换成新问题；当前问题已存在时去重由宿主处理', () => {
  assert.equal(intent(packet(item('taskStatus', 'paused'), item('decisionDeadline', at(9)))), 'none')
  const s = snapshot()
  const attention = { attentionId: 'attention', ticketId: 'task:X', taskRevision: 2, assignmentId: 'asg', decisionId: 'd', decisionKey: 'k', question: '问题', options: [], evidenceRefs: [], state: 'open' as const, createdAt: at(8) }
  assert.equal(intent(packet(), { ...s, openAttention: attention }), 'none')
  assert.equal(intent(packet(), { ...s, openAttention: { ...attention, taskRevision: 1 } }), 'ask_now', '旧版本问题不能压制当前必要问题')
  assert.equal(intent(packet(), { ...s, openAttention: { ...attention, assignmentId: 'old-assignment' } }), 'ask_now', '同版本旧派工问题也不能压制当前问题')
})

test('更换任务ID/题名不改变规则行为；不接收错误作用域或未来条目', () => {
  const s = snapshot(), p = packet(item('expectedUpdateAt', at(11)))
  const a = decideNeedRule(s, p).drafts
  const renamed = { ...s, task: { ...s.task, ticketId: 'arbitrary-task', title: '完全不同名称' } }
  const renamedPacket = { ...p, taskId: 'arbitrary-task', commitments: p.commitments.map((i) => ({ ...i, scope: { ...i.scope, id: 'arbitrary-task' } })) }
  assert.deepEqual(decideNeedRule(renamed, renamedPacket).drafts, a)
  assert.throws(() => decideNeedRule(renamed, p), /mismatch/)
  assert.equal(intent(packet(item('expectedUpdateAt', at(11), { validFrom: at(20) }))), 'ask_now')
})

test('真实适配器共享抽取/读取，只调用抽取模型，规则结果附完整输入和解释', async () => {
  const store = new CapabilityMemoryStore(':memory:')
  try {
    store.appendTurn({ turnId: 'u', sessionId: 's', seq: 1, at: at(0), role: 'user', taskIds: ['task:X'], text: `下一份结果预计${at(11)}，决定截止${at(15)}。` })
    const client = new FixtureClient((req) => {
      assert.equal(req.purpose, 'memory-extract')
      return JSON.stringify({ coverage: [{ turnId: 'u', status: 'extracted' }], items: [
        { key: 'expectedUpdateAt', value: at(11), scope: { level: 'task', id: 'task:X' }, quotes: [{ turnId: 'u', text: `预计${at(11)}` }] },
        { key: 'decisionDeadline', value: at(15), scope: { level: 'task', id: 'task:X' }, quotes: [{ turnId: 'u', text: `截止${at(15)}` }] },
      ] })
    })
    const assessor = createNeedRuleAssessor({ store, extractionClient: client, now: () => at(10) })
    const response = await assessor.assess(snapshot(), {} as any, new AbortController().signal)
    assert.equal(assessor.capability, false)
    assert.equal(client.seen.length, 1)
    assert.equal(response.drafts[0]!.intent, 'wait')
    assert.match(response.raw.model, /extraction may use model/)
    assert.equal((response.raw.meta as any).extraction.model.provider, 'test-fixture')
    assert.ok((response.raw.meta as any).trace.some((t: any) => t.rule === 'useful_update_before_decision'))
    assert.equal((response.raw.requestPayload as any).memory.taskId, 'task:X')
  } finally { store.close() }
})
