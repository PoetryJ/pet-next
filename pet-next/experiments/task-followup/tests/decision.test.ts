import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_GOAL, DEFAULT_QUIET } from '../contracts.ts'
import type { DecisionContext, TaskSnapshot } from '../contracts.ts'
import { createPolicy } from '../decision/rules.ts'

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    ticketId: 'ticket-1',
    title: '跟进 E17',
    goal: '分析失败样本',
    goalCondition: { ...DEFAULT_GOAL, requireAnalysisArtifact: true, insufficientStatuses: ['failed', 'partial'] },
    taskRevision: 1,
    assignmentId: 'assignment-1',
    stage: 'result_received',
    status: 'active',
    createdAt: '2026-11-11T08:00:00.000Z',
    updatedAt: '2026-11-11T08:10:00.000Z',
    eventCursor: 2,
    memoryCursor: 2,
    evidence: [],
    attempt: 1,
    diagnostics: [],
    result: {
      runId: 'run-1',
      revision: 1,
      status: 'partial',
      metrics: { total: 40, passed: 29, failed: 11, score: 0.725 },
      artifactPath: 'inbox/E17/artifact.txt',
      artifactSha: 'a'.repeat(64),
      resultPath: 'inbox/E17/result.json',
      resultFileSha: 'b'.repeat(64),
    },
    ...overrides,
  }
}

function context(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    task: task(),
    trigger: null,
    evidence: [],
    memory: { cursor: 2, facts: [], notes: [], diagnostics: [] },
    now: '2026-11-11T08:10:00.000Z',
    quiet: DEFAULT_QUIET,
    history: [],
    goalSatisfied: false,
    inputReady: true,
    attempt: 1,
    ...overrides,
  }
}

test('P0 只记录，不提问', () => {
  const proposals = createPolicy('P0').propose(context())
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0]!.kind, 'record_only')
})

test('P3 在结果不足时提一个带选项的问题', () => {
  const proposals = createPolicy('P3').propose(context())
  const ask = proposals.find((proposal) => proposal.kind === 'ask_user')!
  assert.ok(ask)
  assert.equal(ask.reasonCode, 'insufficient_result')
  assert.ok(ask.options?.some((option) => option.id === 'analyze_failing'))
  assert.equal(ask.decisionKey, 'insufficient:run-1:r1')
})

test('P2 低于冻结阈值时只记录（可解释的漏报）', () => {
  const low = task({
    result: {
      runId: 'run-1',
      revision: 1,
      status: 'failed',
      metrics: { total: 100, passed: 98, failed: 2, score: 0.98 },
      artifactPath: 'inbox/E17/artifact.txt',
      artifactSha: 'a'.repeat(64),
      resultPath: 'inbox/E17/result.json',
      resultFileSha: 'b'.repeat(64),
    },
  })
  const proposals = createPolicy('P2').propose(context({ task: low }))
  assert.equal(proposals[0]!.kind, 'record_only')
  assert.equal(proposals[0]!.reasonCode, 'below_threshold')
})

test('P2 达到阈值时提问，且 decisionKey 不含 revision', () => {
  const proposals = createPolicy('P2').propose(context())
  const ask = proposals.find((proposal) => proposal.kind === 'ask_user')!
  assert.equal(ask.kind, 'ask_user')
  assert.equal(ask.decisionKey, 'P2:threshold:run-1')
})

test('用户选择分析后，策略产生本地分析请求而不是再次提问', () => {
  const proposals = createPolicy('P3').propose(
    context({ task: task({ lastAnswer: { optionId: 'analyze_failing', at: '2026-11-11T08:12:00.000Z' } }) }),
  )
  assert.equal(proposals[0]!.kind, 'continue_local')
  assert.equal(proposals[0]!.toolRequest?.tool, 'write_analysis')
})
