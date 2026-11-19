import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { CapabilityMemoryStore } from '../memory/store.ts'
import { refreshSummary } from '../memory/adapters.ts'
import type { ModelClient, ModelRequest } from '../model/protocol.ts'

const now = '2026-11-19T00:00:00.000Z'
const task = 'test-handover'
const turnId = (seq: number) => `user-original-turn-${seq}`
function history(count: number) {
  const store = new CapabilityMemoryStore(new DatabaseSync(':memory:'))
  for (let seq = 1; seq <= count; seq++) {
    store.appendTurn({ turnId: turnId(seq), sessionId: 'chat', seq, at: now, role: 'user',
      text: seq === 1 ? '等两份报告' : String(seq), taskIds: [task] })
  }
  return store
}
function model(reply: (request: ModelRequest) => {rawText: string; finishReason: string}): ModelClient {
  return { kind: 'fixture', async complete(request) {
    return { ok: true, response: { protocol: 'pet-capability-model/v1', requestId: request.requestId,
      sessionId: 'test', model: { provider: 'test', name: 'test', version: 'test' }, startedAt: now, finishedAt: now,
      ...reply(request) } }
  } }
}
const valid = () => ({ rawText: '{"summary":"等两份报告","keyTurns":[1]}', finishReason: 'stop' })
const batchOf = (request: ModelRequest): {n:number; text:string}[] => JSON.parse(request.messages[1]!.content).newTurns

test('short references map back to source IDs across legacy state and a truncated batch', async () => {
  const store = history(49)
  try {
    store.db.exec('CREATE TABLE cap_text_state (task_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, summary TEXT NOT NULL, key_turns TEXT, updated_at TEXT NOT NULL)')
    store.db.prepare('INSERT INTO cap_text_state VALUES (?,?,?,?,?)').run(task, 1, '等两份报告', JSON.stringify([turnId(1)]), now)
    const seen: number[][] = []
    const client = model(request => {
      const batch = batchOf(request)
      assert.equal(request.maxTokens, 384)
      assert.ok(!request.messages[1]!.content.includes('user-original-turn'))
      assert.deepEqual(batch.map(t => t.n), Array.from({length:batch.length}, (_,i)=>i+1))
      seen.push(batch.map(t=>Number(t.text)))
      return seen.length === 1 ? { ...valid(), finishReason: 'length' } : valid()
    })
    const result = await refreshSummary(store,client,task,now)
    assert.deepEqual(seen.map(x=>[x[0],x.at(-1)]), [[2,49],[2,25],[26,49]])
    assert.equal(result.calls,3)
    assert.equal(result.error,null)
    assert.equal(result.state.seq,49)
    assert.deepEqual(result.state.keyTurns, [turnId(1),turnId(2),turnId(26)])
  } finally { store.db.close() }
})

test('invalid references do not advance coverage and a new refresh resumes from the reduced batch', async () => {
  const store = history(48)
  try {
    const sizes: number[] = []
    const invalid = model(req => {
      sizes.push(batchOf(req).length)
      return { rawText: '{"summary":"坏引用","keyTurns":[999]}', finishReason: 'stop' }
    })
    const failed = await refreshSummary(store,invalid,task,now)
    assert.equal(failed.calls,3)
    assert.deepEqual(sizes,[48,24,12])
    assert.equal(failed.state.seq,0)
    assert.equal(failed.error,'summary_invalid')
    assert.equal(failed.state.batchLimit,6)
    let recoverySizes: number[] = []
    const result = await refreshSummary(new CapabilityMemoryStore(store.db),model(req=>{
      recoverySizes.push(batchOf(req).length)
      return valid()
    }),task,now)
    assert.deepEqual(recoverySizes,[6,6,6])
    assert.equal(result.state.seq,18)
    assert.deepEqual(result.state.keyTurns,[turnId(1),turnId(7),turnId(13)])
  } finally { store.db.close() }
})
