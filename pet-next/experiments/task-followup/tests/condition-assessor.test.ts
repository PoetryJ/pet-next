/**
 * R6 集成接线测试：conditions 评估器在真实 store/scheduler 接口上跑通
 * “编译一次 → 结果变化只重算 → 同一证据不重复问 → 用户改口必须重编译”。
 *
 * 模型一律用按 purpose 分派的 fixture 客户端；这些数字是机制证据，不代表模型能力。
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createConditionsHandle } from '../service/capability-conditions.ts'
import { ASSESSMENT_PROTOCOL } from '../runtime/assessment.ts'
import type { ActionTemplate, AssessmentSnapshot } from '../runtime/assessment.ts'
import type { TaskSnapshot } from '../contracts.ts'
import type { ModelRequest } from '../capability/model/protocol.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const NOW = '2026-11-16T02:00:00.000Z'
const TASK = 'task:R6'

const model = () => {
  const purposes: string[] = []
  let compileCount = 0
  const client = {
    kind: 'fixture',
    purposes,
    get compileCount() { return compileCount },
    async complete(request: ModelRequest) {
      purposes.push(request.purpose)
      let rawText = ''
      if (request.purpose === 'memory-extract') {
        const input = JSON.parse(request.messages[1]!.content) as { turnsToExtract?: { id: string; text: string }[] }
        const turns = input.turnsToExtract ?? []
        rawText = JSON.stringify({
          coverage: turns.map((t) => ({ turnId: t.id, status: 'extracted' })),
          items: turns.map((t) => ({
            key: 'availability', value: 'available',
            scope: { level: 'global', id: null },
            quotes: [{ turnId: t.id, text: t.text }],
          })),
        })
      } else if (request.purpose === 'condition-compile') {
        compileCount += 1
        const input = JSON.parse(request.messages[1]!.content) as { taskId: string; turns: { turnId: string; text: string }[] }
        const last = input.turns.at(-1)!
        const needle = '再问'
        const start = Math.max(0, last.text.indexOf(needle))
        rawText = JSON.stringify({
          when: { op: 'all', args: [
            { op: 'cmp', fact: `task:${input.taskId}.result.present`, rel: 'eq', value: true },
            { op: 'not', arg: { op: 'cmp', fact: 'user.availability', rel: 'eq', value: 'busy' } },
          ] },
          quotes: [{ turnId: last.turnId, start, end: start + (start >= 0 ? needle.length : 2), text: last.text.slice(start, start + (start >= 0 ? needle.length : 2)) }],
          unsupported: [],
        })
      } else {
        rawText = JSON.stringify({ kind: 'none', reasonCode: 'no_current_action', question: null, optionIds: [] })
      }
      return {
        ok: true as const,
        response: {
          protocol: 'pet-capability-model/v1' as const, requestId: request.requestId, sessionId: `s-${purposes.length}`,
          model: { provider: 'fixture', name: 'fixture-conditions', version: '1' },
          rawText, startedAt: NOW, finishedAt: NOW, usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      }
    },
  }
  return client
}

const askTemplate: ActionTemplate = {
  actionId: 'act-ask', source: 'baseline-rule-menu', kind: 'ask_user', reasonCode: 'needs_user_choice',
  reasonText: '', question: '现在处理吗？',
  options: [{ id: 'go', label: '现在处理' }, { id: 'later', label: '稍后' }], evidenceRefs: [],
}

const snapshot = (revision: number, resultSha: string, present = true): AssessmentSnapshot => ({
  protocol: ASSESSMENT_PROTOCOL,
  identity: { requestId: 'r1', ticketId: TASK, taskRevision: 1, assignmentId: 'a1', memoryCursor: 0, eventCursor: 0, round: 1, sourceRefs: [] },
  now: NOW,
  task: {
    ticketId: TASK, title: 'R6 跟进', goal: '两份报告都回来后问我', goalCondition: { kind: 'analysis', minSamples: 1, requirePassed: true } as unknown as TaskSnapshot['goalCondition'],
    taskRevision: 1, assignmentId: 'a1', stage: 'result_received', status: 'active', createdAt: NOW, updatedAt: NOW,
    eventCursor: 0, memoryCursor: 0, evidence: [], attempt: 0, diagnostics: [],
    ...(present ? { result: { runId: 'run', revision, status: 'succeeded', metrics: { total: 64, passed: 61, failed: 3, score: null }, artifactPath: null, artifactSha: sha(`artifact-${revision}`), resultPath: null, resultFileSha: resultSha } } : {}),
  },
  evidence: [], history: [], openAttention: null, lastAnswer: null, attempt: 1, inputReady: true, goalSatisfied: false,
  quiet: { fromHour: 22, toHour: 8, minGapMs: 0 } as AssessmentSnapshot['quiet'],
  actionMenu: [askTemplate],
})

const signal = () => new AbortController().signal

test('conditions：编译一次 → 结果变化只重算 → 同一证据只问一次 → 改口重编译', async () => {
  const db = new DatabaseSync(':memory:')
  const client = model()
  const handle = createConditionsHandle({}, fetch, client as never, { hostRecheckMs: 90_000, fallbackToModel: false })
  handle.attach(db)
  handle.appendTurn({ turnId: 'u1', sessionId: 'panel', at: '2026-11-16T01:00:00.000Z', role: 'user', text: '两份报告都回来以后再问我', taskIds: [TASK] })

  const first = await handle.assessor.assess(snapshot(2, sha('result-2')), undefined as never, signal())
  assert.equal(first.drafts[0]!.intent, 'ask_now', JSON.stringify(first.drafts[0]))
  assert.equal(client.compileCount, 1)
  const summary = handle.conditionSummary(TASK)
  assert.equal(summary.state, 'true')
  assert.equal(summary.action, 'ask')
  assert.ok(summary.quotes.length >= 1)

  // 同一证据版本：不重复问、不重编译
  const again = await handle.assessor.assess(snapshot(2, sha('result-2')), undefined as never, signal())
  assert.equal(again.drafts[0]!.intent, 'none')
  assert.match(again.drafts[0]!.reasonCode ?? '', /asked_same_evidence|asked/)
  assert.equal(client.compileCount, 1, '结果未变不重编译')

  // 新结果版本：只重算，仍不重编译；新证据允许再次提问
  const third = await handle.assessor.assess(snapshot(3, sha('result-3')), undefined as never, signal())
  assert.equal(third.drafts[0]!.intent, 'ask_now')
  assert.equal(client.compileCount, 1, '结果内容变化只重算')

  // 用户改口：承诺版本前进 → 必须重编译
  handle.appendTurn({ turnId: 'u2', sessionId: 'panel', at: '2026-11-16T01:30:00.000Z', role: 'user', text: '改口：只要主测试回来再问我', taskIds: [TASK] })
  const fourth = await handle.assessor.assess(snapshot(3, sha('result-3')), undefined as never, signal())
  assert.equal(client.compileCount, 2, '用户改口必须重编译')
  assert.equal(handle.conditionSummary(TASK).dev.planRevision, 2)
  assert.equal(fourth.drafts[0]!.intent, 'ask_now')
  db.close()
})

test('conditions：缺证据不直接变提问，按有界等待兜底', async () => {
  const db = new DatabaseSync(':memory:')
  const client = model()
  const handle = createConditionsHandle({}, fetch, client as never, { hostRecheckMs: 90_000, fallbackToModel: false })
  handle.attach(db)
  handle.appendTurn({ turnId: 'u1', sessionId: 'panel', at: '2026-11-16T01:00:00.000Z', role: 'user', text: '两份报告都回来以后再问我', taskIds: [TASK] })
  const response = await handle.assessor.assess(snapshot(2, sha('result-2'), false), undefined as never, signal())
  assert.equal(response.drafts[0]!.intent, 'wait', JSON.stringify(response.drafts[0]))
  assert.ok(response.drafts[0]!.notBefore)
  db.close()
})
