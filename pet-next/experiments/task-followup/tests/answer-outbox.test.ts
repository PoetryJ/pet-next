// Transport/persistence mechanism tests, not model or real-user capability tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnswerOutbox } from '../service/answer-outbox.ts'
import type { AnswerPayload, AnswerResponse } from '../service/answer-outbox.ts'

const payload = (): AnswerPayload => ({ ticketId: 'task-current', attentionId: 'attention-old', decisionId: 'decision-old', taskRevision: 2, optionId: 'analyze_failing' })
const at = '2026-11-13T11:17:19.925Z'
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pet-answer-outbox-'))
  return { root, path: join(root, '中文 空格', 'answers.json') }
}

test('离线选择落盘，重开原样重送，409明确终结而不改绑新问题或延长授权', async () => {
  const f = fixture()
  try {
    const original = payload(), first = new AnswerOutbox(f.path)
    const saved = first.enqueue(original, at)
    assert.equal((await first.flush(async sent => { assert.deepEqual(sent, original); throw new Error('ECONNREFUSED') }))[0]!.state, 'pending')
    const reopened = new AnswerOutbox(f.path)
    assert.deepEqual(reopened.list(), [saved])
    const response = { status: 409, json: { ok: false, code: 'stale_attention', error: '问题已失效' } }
    const result = await reopened.flush(async sent => { assert.deepEqual(sent, original); return response })
    assert.deepEqual(result[0], { ...saved, state: 'resolved', response })
    assert.deepEqual(new AnswerOutbox(f.path).list(), result)
    let resend = 0
    await new AnswerOutbox(f.path).flush(async () => { resend++; return response })
    assert.equal(resend, 0)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('并发flush每项只发一次，真实200持久化后重开不重发', async () => {
  const f = fixture()
  try {
    const outbox = new AnswerOutbox(f.path)
    outbox.enqueue(payload(), at)
    let finish!: (r: AnswerResponse) => void, calls = 0
    const response = new Promise<AnswerResponse>(resolve => { finish = resolve })
    const first = outbox.flush(async () => { calls++; return response })
    const second = outbox.flush(async () => { throw new Error('must not run a second sender') })
    assert.equal(first, second)
    await Promise.resolve()
    assert.equal(calls, 1)
    const actual = { status: 200, json: { ok: true, result: { receiptId: 'real-host-receipt' } } }
    finish(actual)
    const records = await first
    assert.deepEqual(records[0]!.response, actual)
    actual.json.result.receiptId = 'caller-mutation'
    records[0]!.payload.optionId = 'wait_more'
    const reopened = new AnswerOutbox(f.path)
    await reopened.flush(async () => { calls++; return actual })
    assert.equal(calls, 1)
    assert.equal(reopened.list()[0]!.payload.optionId, 'analyze_failing')
    assert.deepEqual(reopened.list()[0]!.response, { status: 200, json: { ok: true, result: { receiptId: 'real-host-receipt' } } })
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('调用方不能改已保存授权，同payload幂等，同attention冲突选项明确拒绝', async () => {
  const f = fixture()
  try {
    const outbox = new AnswerOutbox(f.path), input = payload()
    const saved = outbox.enqueue(input, at)
    input.optionId = 'wait_more'
    saved.payload.decisionId = 'new-decision'
    outbox.list()[0]!.payload.ticketId = 'another-task'
    assert.equal(outbox.enqueue(payload(), '2026-11-14T00:00:00Z').createdAt, at)
    assert.throws(() => outbox.enqueue(input, at), /answer_authorization_conflict/)
    assert.throws(() => outbox.enqueue({ ...payload(), decisionId: 'different-decision' }, at), /answer_authorization_conflict/)
    assert.equal(outbox.list().length, 1)
    let observed: AnswerPayload | null = null
    await outbox.flush(async sent => { observed = { ...sent }; sent.optionId = 'accept_current'; return { status: 409, json: { ok: false } } })
    assert.deepEqual(observed, payload())
    assert.deepEqual(new AnswerOutbox(f.path).list()[0]!.payload, payload())
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
