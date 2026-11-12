/**
 * R5 评分窗口与身份测试：visible/overdue/pending/missed 必须互斥且可解释。
 *
 * @module pet-next/experiments/task-followup/tests/r5-score
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { scoreR5Run } from '../eval/r5/score.ts'

function raw(patch: Record<string, unknown> = {}) {
  return {
    schema: 'pet-followup-r5-raw/v1',
    policy: 'N1',
    trajectoryId: 'R5-X',
    family: 'unit',
    split: 'dev',
    clockStart: '2026-11-12T08:00:00.000Z',
    finalClock: '2026-11-12T09:00:00.000Z',
    timezone: 'UTC',
    configSha: 'cfg',
    steps: [],
    asks: [
      {
        decisionId: 'd1',
        decisionKey: 'insufficient:run-01:r1',
        reasonCode: 'insufficient_result',
        ticketId: 't1',
        taskRevision: 1,
        assignmentId: 'as-1',
        at: '2026-11-12T08:05:00.000Z',
        outcome: 'open',
      },
    ],
    attentions: [
      {
        attentionId: 'a1',
        decisionId: 'd1',
        decisionKey: 'insufficient:run-01:r1',
        ticketId: 't1',
        taskRevision: 1,
        assignmentId: 'as-1',
        state: 'answered',
        createdAt: '2026-11-12T08:05:00.000Z',
        deadline: '2026-11-12T10:00:00.000Z',
        deliveredAt: '2026-11-12T08:06:00.000Z',
        presentedAt: null,
        answeredAt: '2026-11-12T08:07:00.000Z',
        answerOption: 'analyze_failing',
      },
    ],
    notifications: [
      {
        notificationId: 'n1',
        attentionId: 'a1',
        createdAt: '2026-11-12T08:05:00.000Z',
        deliveredAt: '2026-11-12T08:06:00.000Z',
        presentedAt: null,
      },
    ],
    wakes: [],
    receipts: [],
    final: { status: 'active', stage: 'awaiting_decision', completed: false, validCompletion: false, completionCheck: null },
    ...patch,
  }
}

const gold = {
  trajectoryId: 'R5-X',
  family: 'unit',
  split: 'dev',
  mustComplete: false,
  expectedStatus: 'active',
  maxNotifications: 1,
  required: [
    {
      kind: 'insufficient_result',
      earliest: '2026-11-12T08:05:00.000Z',
      latest: '2026-11-12T08:30:00.000Z',
      action: 'analyze_failing',
    },
  ],
}

type Raw = Parameters<typeof scoreR5Run>[0]

test('窗口内送达并回答：visible/answered/action 同时成立', () => {
  const score = scoreR5Run(raw() as unknown as Raw, gold)
  assert.equal(score.visible, 1)
  assert.equal(score.answered, 1)
  assert.equal(score.actionOk, 1)
  assert.equal(score.missed, 0)
  assert.equal(score.pending, 0)
  assert.equal(score.overdue, 0)
})

test('晚于最迟窗口：只记 overdue，不算 visible', () => {
  const r = raw()
  ;(r.attentions[0] as unknown as Record<string, unknown>).deliveredAt = '2026-11-12T08:40:00.000Z'
  const score = scoreR5Run(r as unknown as Raw, gold)
  assert.equal(score.visible, 0)
  assert.equal(score.overdue, 1)
  assert.equal(score.missed, 0)
})

test('未送达且未到最迟时刻：记 pending（censored）', () => {
  const r = raw({ finalClock: '2026-11-12T08:20:00.000Z' })
  ;(r.attentions[0] as unknown as Record<string, unknown>).deliveredAt = null
  ;(r.attentions[0] as unknown as Record<string, unknown>).presentedAt = null
  const score = scoreR5Run(r as unknown as Raw, gold)
  assert.equal(score.pending, 1)
  assert.equal(score.missed, 0)
  assert.equal(score.visible, 0)
})

test('未送达且已过最迟时刻：记 missed', () => {
  const r = raw({ finalClock: '2026-11-12T09:00:00.000Z' })
  ;(r.attentions[0] as unknown as Record<string, unknown>).deliveredAt = null
  ;(r.attentions[0] as unknown as Record<string, unknown>).presentedAt = null
  const score = scoreR5Run(r as unknown as Raw, gold)
  assert.equal(score.missed, 1)
  assert.equal(score.pending, 0)
})

test('身份字段缺失：fail closed，不算已见', () => {
  const r = raw()
  delete (r.asks[0] as unknown as Record<string, unknown>).ticketId
  const score = scoreR5Run(r as unknown as Raw, gold)
  assert.equal(score.visible, 0)
  assert.equal(score.missed, 1)
})

test('重复通知与过期通知分开计数', () => {
  const r = raw()
  r.notifications.push({ ...r.notifications[0], notificationId: 'n2' })
  const score = scoreR5Run(r as unknown as Raw, gold)
  assert.equal(score.duplicateNotifications, 1)
  assert.equal(score.staleNotifications, 0)
})
