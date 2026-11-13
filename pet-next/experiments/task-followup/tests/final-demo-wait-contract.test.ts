/** 共享等待契约（宿主侧）：引用的 ETA 原样采用；未知/未引用 ETA → 宿主有界复查；不伪造时间，不转成提问。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyWaitContract } from '../service/capability-assessor.ts'

const now = '2026-11-13T10:00:00.000Z'
const proposal = (wakeAt: string | null, deadlineAt: string | null = null, ev: string[] = ['mem-1']) => ({ kind: 'wait', reasonCode: 'waiting_for_evidence', question: null, optionIds: [], wakeAt, waitFor: 'r2', deadlineAt, deliverAt: null, batchable: true, evidenceTurnIds: [], evidenceItemIds: ev, answerFacts: [] })
const packet = (items: any[] = []) => ({ currentFacts: items, preferences: [], commitments: [], outcomes: [], context: { nonActionable: [] } }) as any
const rec = (p: any) => ({ proposal: p }) as any

test('unknown ETA (guard wait_without_recheck) becomes host bounded recheck, not ask', () => {
  const p = proposal(null)
  const out = applyWaitContract(rec(p), { accepted: false, code: 'wait_without_recheck', detail: 'wakeAt=null', proposal: p, fallback: { kind: 'ask', reasonCode: 'insufficient_evidence' }, checks: [] } as any, packet(), now, 90_000)
  assert.equal(out.submit.accepted, true)
  assert.equal(out.submit.fallback, null)
  assert.equal(out.submit.proposal!.wakeAt, '2026-11-13T10:01:30.000Z')
  assert.equal(out.contract!.source, 'host_bounded_recheck')
})

test('uncited far wakeAt (model guessed 24h) is replaced by host bounded recheck', () => {
  const p = proposal('2026-11-14T10:00:00.000Z')
  const out = applyWaitContract(rec(p), { accepted: true, code: 'accepted', detail: 'ok', proposal: p, fallback: null, checks: [] } as any, packet([{ itemId: 'mem-1', key: 'waitPolicy', value: '第二版出来再问', validUntil: null }]), now, 90_000)
  assert.equal(out.submit.proposal!.wakeAt, '2026-11-13T10:01:30.000Z')
  assert.equal(out.contract!.modelWakeAt, '2026-11-14T10:00:00.000Z')
})

test('cited ETA item is kept as-is', () => {
  const p = proposal('2026-11-13T12:00:00.000Z', null, ['mem-eta'])
  const out = applyWaitContract(rec(p), { accepted: true, code: 'accepted', detail: 'ok', proposal: p, fallback: null, checks: [] } as any, packet([{ itemId: 'mem-eta', key: 'expectedUpdateAt', value: '2026-11-13T12:00:00.000Z', validUntil: null }]), now, 90_000)
  assert.equal(out.submit.proposal!.wakeAt, '2026-11-13T12:00:00.000Z')
  assert.equal(out.contract!.source, 'cited_item')
})

test('host recheck never passes the deadline', () => {
  const p = proposal(null, '2026-11-13T10:00:40.000Z')
  const out = applyWaitContract(rec(p), { accepted: false, code: 'wait_without_recheck', detail: '', proposal: p, fallback: null, checks: [] } as any, packet(), now, 90_000)
  assert.equal(out.submit.proposal!.wakeAt, '2026-11-13T10:00:39.000Z')
})
