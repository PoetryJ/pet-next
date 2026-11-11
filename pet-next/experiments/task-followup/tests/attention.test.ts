import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_QUIET, stableId } from '../contracts.ts'
import type { ProposedDecision } from '../contracts.ts'
import { AttentionQueue } from '../attention/port.ts'
import { FollowupDb } from '../runtime/db.ts'

function proposal(overrides: Partial<ProposedDecision> = {}): ProposedDecision {
  const ticketId = overrides.ticketId ?? 'ticket-1'
  const taskRevision = overrides.taskRevision ?? 1
  const decisionKey = overrides.decisionKey ?? 'insufficient:run-1:r1'
  return {
    decisionId: stableId('dec', ticketId, taskRevision, decisionKey, JSON.stringify(overrides.question ?? 'q1')),
    ticketId,
    taskRevision,
    assignmentId: overrides.assignmentId ?? 'assignment-1',
    evidenceRefs: [],
    kind: 'ask_user',
    reasonCode: 'insufficient_result',
    reasonText: '结果不足',
    decisionKey,
    question: overrides.question ?? '要分析失败样本吗？',
    options: overrides.options ?? [
      { id: 'analyze_failing', label: '分析失败样本' },
      { id: 'wait_more', label: '继续等待' },
    ],
    implementation: 'scripted-rule',
    ...overrides,
  }
}

function queue() {
  const db = new FollowupDb(':memory:')
  return { db, attention: new AttentionQueue(db) }
}

test('同 decisionKey 合并为一个问题', () => {
  const { db, attention } = queue()
  const first = attention.open(proposal(), '2026-11-11T08:00:00.000Z', DEFAULT_QUIET)
  const second = attention.open(proposal({ question: '同一个决定' }), '2026-11-11T08:01:00.000Z', DEFAULT_QUIET)
  assert.equal(first.merged, false)
  assert.equal(second.merged, true)
  assert.equal(second.attention.attentionId, first.attention.attentionId)
  assert.equal(attention.listOpen('ticket-1').length, 1)
  db.close()
})

test('新 revision 撤销旧问题，保留记录', () => {
  const { db, attention } = queue()
  const first = attention.open(proposal(), '2026-11-11T08:00:00.000Z', DEFAULT_QUIET)
  const second = attention.open(
    proposal({ taskRevision: 2, decisionKey: 'insufficient:run-1:r2', question: '新问题' }),
    '2026-11-11T08:10:00.000Z',
    DEFAULT_QUIET,
  )
  assert.notEqual(second.attention.attentionId, first.attention.attentionId)
  assert.equal(attention.get(first.attention.attentionId)!.state, 'superseded')
  assert.equal(attention.listOpen('ticket-1').length, 1)
  db.close()
})

test('静默内不通知，静默结束后补发一次', () => {
  const { db, attention } = queue()
  const opened = attention.open(proposal(), '2026-11-11T02:00:00.000Z', DEFAULT_QUIET)
  const quiet = attention.notify(opened.attention.attentionId, '2026-11-11T02:00:00.000Z', DEFAULT_QUIET, false)
  assert.equal(quiet.notified, false)
  assert.equal(quiet.reason, 'quiet_hours')
  const after = attention.notify(opened.attention.attentionId, '2026-11-11T07:05:00.000Z', DEFAULT_QUIET, false)
  assert.equal(after.notified, true)
  db.close()
})

test('allowUrgent=false 时紧急也不越过静默；true 时才越过', () => {
  const { db, attention } = queue()
  const opened = attention.open(proposal(), '2026-11-11T02:00:00.000Z', DEFAULT_QUIET)
  assert.equal(attention.notify(opened.attention.attentionId, '2026-11-11T02:00:00.000Z', DEFAULT_QUIET, true).notified, false)
  const allowed = { ...DEFAULT_QUIET, allowUrgent: true }
  assert.equal(attention.notify(opened.attention.attentionId, '2026-11-11T02:00:00.000Z', allowed, true).notified, true)
  db.close()
})

test('旧 revision 的回答记 stale_answer，不推进', () => {
  const { db, attention } = queue()
  const opened = attention.open(proposal({ taskRevision: 2 }), '2026-11-11T08:00:00.000Z', DEFAULT_QUIET)
  const result = attention.answer({
    attentionId: opened.attention.attentionId,
    taskRevision: 1,
    optionId: 'analyze_failing',
    now: '2026-11-11T08:01:00.000Z',
    sourceId: 's1',
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'stale_answer')
  assert.equal(attention.get(opened.attention.attentionId)!.state, 'stale_answer')
  db.close()
})

test('未提供的选项被拒绝', () => {
  const { db, attention } = queue()
  const opened = attention.open(proposal(), '2026-11-11T08:00:00.000Z', DEFAULT_QUIET)
  const result = attention.answer({
    attentionId: opened.attention.attentionId,
    taskRevision: 1,
    optionId: 'not-offered',
    now: '2026-11-11T08:01:00.000Z',
    sourceId: 's1',
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'invalid_option')
  db.close()
})
