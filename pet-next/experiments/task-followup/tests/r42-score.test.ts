/**
 * R4.2 评分身份测试：ask→attention 必须按 decisionId + 版本 + 派工精确连接。
 *
 * 用临时 raw/gold 目录直接调用 scoreAll（黑盒），不复制 score 内部逻辑；
 * 反例取自 policy-independent/evidence/T09-identity-counterexample.json 的结构。
 *
 * @module pet-next/experiments/task-followup/tests/r42-score
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { POLICY_IDS } from '../contracts.ts'
import { scoreAll } from '../eval/score.ts'

interface Ask {
  decisionId: string
  decisionKey: string
  reasonCode: string
  ticketId: string
  taskRevision: number
  assignmentId: string
  at: string
  outcome: string
}

interface Attention {
  attentionId: string
  ticketId: string
  decisionId: string
  decisionKey: string
  reasonCode: string
  question: string
  taskRevision: number
  assignmentId: string
  createdAt: string
  deadline: string | null
  state: string
  answeredAt: string | null
  answerOption: string | null
  notifiedAt: string | null
  deliveredAt: string | null
  presentedAt: string | null
}

function attention(patch: Partial<Attention> & Pick<Attention, 'attentionId' | 'decisionId' | 'taskRevision'>): Attention {
  return {
    ticketId: 't1',
    decisionKey: 'insufficient:run-01:r1',
    reasonCode: 'insufficient_result',
    question: 'q',
    assignmentId: 'as-1',
    createdAt: '2026-11-11T08:15:00.000Z',
    deadline: '2026-11-11T09:00:00.000Z',
    state: 'open',
    answeredAt: null,
    answerOption: null,
    notifiedAt: null,
    deliveredAt: null,
    presentedAt: null,
    ...patch,
  }
}

function ask(patch: Partial<Ask> & Pick<Ask, 'decisionId' | 'taskRevision'>): Ask {
  return {
    decisionKey: 'insufficient:run-01:r1',
    reasonCode: 'insufficient_result',
    ticketId: 't1',
    assignmentId: 'as-1',
    at: '2026-11-11T08:10:00.000Z',
    outcome: 'open',
    ...patch,
  }
}

function buildRaw(policy: string, asks: Ask[], attentions: Attention[]) {
  return {
    schema: 'pet-followup-raw/v2',
    policy,
    policyConfigSha: 'cfg',
    configSha: 'cfg',
    quiet: { timezone: 'UTC' },
    timezone: 'UTC',
    trajectoryId: 'T09',
    variantId: 'a',
    group: 'dev',
    name: 'identity',
    workspace: '/tmp',
    clockStart: '2026-11-11T08:00:00.000Z',
    finalClock: '2026-11-11T09:00:00.000Z',
    timeTrace: [],
    steps: [],
    observations: [],
    proposals: asks.map((item) => ({
      decisionId: item.decisionId,
      at: item.at,
      step: 0,
      kind: 'ask_user',
      decisionKey: item.decisionKey,
      reasonCode: item.reasonCode,
      ticketId: item.ticketId,
      taskRevision: item.taskRevision,
      assignmentId: item.assignmentId,
      outcome: item.outcome,
    })),
    attentions,
    notifications: [],
    receipts: [],
    effects: [],
    driverLog: [],
    asks,
    final: { status: 'active', stage: 'awaiting_decision', taskRevision: 2, completed: false, validCompletion: false },
    metrics: {
      completed: false,
      validCompletion: false,
      notifications: 0,
      notificationsDelivered: 0,
      notificationsPresented: 0,
      asks: asks.length,
      askedKinds: [...new Set(asks.filter((item) => item.outcome !== 'invalidated').map((item) => item.reasonCode))],
      answeredAttentions: attentions.filter((item) => item.state === 'answered').length,
      answeredWithoutVisibility: 0,
      hiddenAnswersBlocked: 0,
      unansweredNotifications: 0,
      supersededNotifications: 0,
      uselessNotifications: 0,
      quotaBlocks: 0,
      hardQuotaViolations: 0,
      deadlineMissed: false,
      staleAnswers: 0,
      staleBlocks: 0,
      staleProposals: 0,
      corrections: 0,
      proposeCalls: 0,
      receipts: 0,
      ioBytesRead: 0,
      ioBytesWritten: 0,
      duplicateEffects: 0,
      firstAskLatencyMs: null,
    },
  }
}

/** 四策略各一份相同 raw，避免 scoreAll 因缺目录跳过。 */
function score(raw: ReturnType<typeof buildRaw>) {
  const root = mkdtempSync(join(tmpdir(), 'r42-score-'))
  try {
    for (const policy of POLICY_IDS) {
      mkdirSync(join(root, 'raw', policy), { recursive: true })
      writeFileSync(join(root, 'raw', policy, 'T09-a.json'), JSON.stringify({ ...raw, policy }))
    }
    mkdirSync(join(root, 'gold'), { recursive: true })
    writeFileSync(
      join(root, 'gold', 'T09.json'),
      JSON.stringify({
        trajectoryId: 'T09',
        variants: { a: { mustComplete: true, requiredDecisions: ['insufficient_result'], maxNotifications: 3, expectedStatus: 'completed' } },
      }),
    )
    return scoreAll(join(root, 'raw'), join(root, 'gold')).policies.P3!
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('同键不同版本：旧版本送达不能算新问题已触达', () => {
  const result = score(
    buildRaw(
      'P3',
      [ask({ decisionId: 'd1', taskRevision: 1, at: '2026-11-11T08:10:00.000Z' }), ask({ decisionId: 'd2', taskRevision: 2, at: '2026-11-11T08:15:00.000Z' })],
      [
        attention({ attentionId: 'a1', decisionId: 'd1', taskRevision: 1, state: 'superseded', notifiedAt: '2026-11-11T08:10:00.000Z', deliveredAt: '2026-11-11T08:10:00.000Z' }),
        attention({ attentionId: 'a2', decisionId: 'd2', taskRevision: 2 }),
      ],
    ),
  )
  assert.equal(result.requiredProduced, 1)
  assert.equal(result.requiredVisible, 0)
  assert.equal(result.requiredAnswered, 0)
  assert.equal(result.notVisible, 1)
  assert.equal(result.notVisibleDetail[0]!.reason, 'not_visible:open')
})

test('反向：旧版本未送达、新版本送达并回答则计入', () => {
  const result = score(
    buildRaw(
      'P3',
      [ask({ decisionId: 'd1', taskRevision: 1 }), ask({ decisionId: 'd2', taskRevision: 2, at: '2026-11-11T08:15:00.000Z' })],
      [
        attention({ attentionId: 'a1', decisionId: 'd1', taskRevision: 1, state: 'superseded' }),
        attention({
          attentionId: 'a2',
          decisionId: 'd2',
          taskRevision: 2,
          state: 'answered',
          answeredAt: '2026-11-11T08:22:00.000Z',
          answerOption: 'analyze_failing',
          deliveredAt: '2026-11-11T08:15:00.000Z',
        }),
      ],
    ),
  )
  assert.equal(result.requiredVisible, 1)
  assert.equal(result.requiredAnswered, 1)
  assert.equal(result.notVisible, 0)
  assert.equal(result.notAnswered, 0)
})

test('旧版本的回答不能给新问题贡献已回答', () => {
  const result = score(
    buildRaw(
      'P3',
      [ask({ decisionId: 'd1', taskRevision: 1 }), ask({ decisionId: 'd2', taskRevision: 2, at: '2026-11-11T08:15:00.000Z' })],
      [
        attention({
          attentionId: 'a1',
          decisionId: 'd1',
          taskRevision: 1,
          state: 'answered',
          answeredAt: '2026-11-11T08:11:00.000Z',
          deliveredAt: '2026-11-11T08:10:00.000Z',
        }),
        attention({ attentionId: 'a2', decisionId: 'd2', taskRevision: 2 }),
      ],
    ),
  )
  assert.equal(result.requiredProduced, 1)
  assert.equal(result.requiredVisible, 0)
  assert.equal(result.requiredAnswered, 0)
  assert.equal(result.notAnswered, 1)
})

test('decisionId 相同但版本不一致时 fail closed', () => {
  const result = score(
    buildRaw(
      'P3',
      [ask({ decisionId: 'd1', taskRevision: 2 })],
      [attention({ attentionId: 'a1', decisionId: 'd1', taskRevision: 1, deliveredAt: '2026-11-11T08:10:00.000Z' })],
    ),
  )
  assert.equal(result.requiredVisible, 0)
  assert.equal(result.notVisibleDetail[0]!.reason, 'revision_mismatch')
})

test('同一 decisionId 多条 attention 属于歧义，不算已见', () => {
  const result = score(
    buildRaw(
      'P3',
      [ask({ decisionId: 'd1', taskRevision: 2 })],
      [
        attention({ attentionId: 'a1', decisionId: 'd1', taskRevision: 2, deliveredAt: '2026-11-11T08:10:00.000Z' }),
        attention({ attentionId: 'a2', decisionId: 'd1', taskRevision: 2, deliveredAt: '2026-11-11T08:11:00.000Z' }),
      ],
    ),
  )
  assert.equal(result.requiredVisible, 0)
  assert.equal(result.notVisibleDetail[0]!.reason, 'attention_ambiguous')
})

test('没有提案时只记漏提案，不混入未触达', () => {
  const result = score(buildRaw('P3', [], []))
  assert.equal(result.notProposed, 1)
  assert.equal(result.notVisible, 1)
  assert.equal(result.notAnswered, 1)
  assert.equal(result.requiredProduced, 0)
  assert.deepEqual(result.notProposedDetail, [{ run: 'T09-a', kind: 'insufficient_result' }])
  assert.equal(result.notVisibleDetail.length, 0)
})

test('已撤销的最新提案不算有效实例，回退到仍有效的上一版', () => {
  const result = score(
    buildRaw(
      'P3',
      [
        ask({ decisionId: 'd1', taskRevision: 1 }),
        ask({ decisionId: 'd2', taskRevision: 2, at: '2026-11-11T08:15:00.000Z', outcome: 'invalidated' }),
      ],
      [
        attention({
          attentionId: 'a1',
          decisionId: 'd1',
          taskRevision: 1,
          state: 'answered',
          answeredAt: '2026-11-11T08:11:00.000Z',
          deliveredAt: '2026-11-11T08:10:00.000Z',
        }),
      ],
    ),
  )
  assert.equal(result.requiredProduced, 1)
  assert.equal(result.requiredVisible, 1)
  assert.equal(result.requiredAnswered, 1)
})

test('三个缺失量共用 requiredTotal 分母', () => {
  const result = score(
    buildRaw(
      'P3',
      [ask({ decisionId: 'd1', taskRevision: 2 })],
      [attention({ attentionId: 'a1', decisionId: 'd1', taskRevision: 2 })],
    ),
  )
  assert.equal(result.requiredDecisions, 1)
  assert.equal(result.notProposed + result.requiredProduced, result.requiredDecisions)
  assert.equal(result.notVisible + result.requiredVisible, result.requiredDecisions)
  assert.equal(result.notAnswered + result.requiredAnswered, result.requiredDecisions)
})
