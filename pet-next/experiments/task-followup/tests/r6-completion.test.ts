import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ANALYSIS_GOAL, harness, answerOpen, fileSha } from './helpers.ts'
import type { GoalCondition } from '../contracts.ts'

// These are mechanism tests; real model comparisons run only after this gate.
const goal = { ...ANALYSIS_GOAL, analysisWhen: 'always' } as GoalCondition
test('R6: successful single source cannot bypass an explicit analysis goal', () => {
  const h = harness()
  try {
    const id = h.built.runtime.delegate({ title: '分析成功报告', goal: '授权后交付分析', goalCondition: goal }).ticketId
    h.observe(id, h.seed({ status: 'succeeded', failed: 0, passed: 40 }).resultPath)
    assert.equal(h.built.runtime.getTask(id).status, 'active')
    assert.equal(h.built.runtime.completionCheck(h.built.runtime.getTask(id)).ok, false)
    assert.equal(answerOpen(h, id, 'continue_now'), true)
    assert.equal(h.built.runtime.getTask(id).status, 'completed')
  } finally { h.dispose() }
})
function setup() {
  const h = harness({ fileDb: true })
  const b = h.built.runtime.delegate({ title: 'B', goal: '收集报告' }).ticketId
  const a = h.built.runtime.delegate({ title: 'A', goal: '两份报告到齐，授权后生成分析', goalCondition: goal, reportBindings: [{ alias: 'B', taskId: b }] }).ticketId
  const sb = h.seed({ experimentId: 'B', runId: 'B', status: 'succeeded', failed: 0, passed: 40 })
  h.observe(b, sb.resultPath)
  const sa = h.seed({ experimentId: 'A', runId: 'A', status: 'succeeded', failed: 0, passed: 40 })
  h.observe(a, sa.resultPath)
  return { h, a, b, sa, sb }
}

test('R6: succeeded report is not an analysis; explicit authorization creates both-source artifact', () => {
  const { h, a, sb } = setup()
  try {
    assert.equal(h.built.runtime.completionCheck(h.built.runtime.getTask(a)).ok, false, 'no artifact cannot satisfy analysis goal')
    assert.equal(h.built.db.listReceipts(a).length, 0, 'no tool before authorization')
    assert.equal(answerOpen(h, a, 'continue_now'), true, 'offered action must execute analysis')
    const task = h.built.runtime.getTask(a)
    assert.equal(task.status, 'completed')
    assert.ok(task.analysis)
    const receipt = h.built.db.getReceipt(task.analysis.receiptId)!
    assert.equal(receipt.outputSha256, fileSha(join(h.root, task.analysis.artifactPath)))
    assert.match(readFileSync(join(h.root, task.analysis.artifactPath), 'utf8'), new RegExp(fileSha(sb.resultPath)))
    h.reopen()
    assert.equal(h.built.db.listReceipts(a).length, 1, 'restart never repeats authorized work')
    assert.equal(h.built.runtime.completionCheck(h.built.runtime.getTask(a)).ok, true)
  } finally { h.dispose() }
})

test('R6: removal or tampering of real analysis revokes completion evidence', () => {
  const { h, a } = setup()
  try {
    assert.equal(answerOpen(h, a, 'continue_now'), true)
    const task = h.built.runtime.getTask(a)
    assert.ok(task.analysis)
    const path = join(h.root, task.analysis.artifactPath)
    writeFileSync(path, 'fake completion')
    assert.equal(h.built.runtime.completionCheck(task).ok, false)
    unlinkSync(path)
    assert.equal(h.built.runtime.completionCheck(task).ok, false)
  } finally { h.dispose() }
})

test('R6: changed dependency bytes cannot be authorized as the old report', () => {
  const { h, a, sb } = setup()
  try {
    writeFileSync(sb.resultPath, readFileSync(sb.resultPath, 'utf8') + ' ')
    assert.equal(answerOpen(h, a, 'continue_now'), false)
    assert.equal(h.built.db.listReceipts(a).length, 0)
    assert.equal(h.built.runtime.completionCheck(h.built.runtime.getTask(a)).ok, false)
  } finally { h.dispose() }
})

test('R6: waiting is not authorization and cannot complete an analysis goal', () => {
  const { h, a } = setup()
  try {
    assert.equal(answerOpen(h, a, 'wait_more'), true)
    h.reopen()
    assert.equal(h.built.db.listReceipts(a).length, 0)
    assert.equal(h.built.runtime.getTask(a).status, 'active')
  } finally { h.dispose() }
})

test('R6: receipt without the full authorization proof cannot establish completion', () => {
  const { h, a } = setup()
  try {
    assert.equal(answerOpen(h, a, 'continue_now'), true)
    h.built.db.handle.prepare('UPDATE receipts SET analysis_evidence_json=NULL WHERE ticket_id=?').run(a)
    assert.equal(h.built.runtime.completionCheck(h.built.runtime.getTask(a)).ok, false)
  } finally { h.dispose() }
})

test('R6: current dependency changes invalidate a previously generated analysis', () => {
  const { h, a, sb } = setup()
  try {
    assert.equal(answerOpen(h, a, 'continue_now'), true)
    writeFileSync(sb.resultPath, readFileSync(sb.resultPath, 'utf8') + ' ')
    assert.equal(h.built.runtime.completionCheck(h.built.runtime.getTask(a)).ok, false)
  } finally { h.dispose() }
})
