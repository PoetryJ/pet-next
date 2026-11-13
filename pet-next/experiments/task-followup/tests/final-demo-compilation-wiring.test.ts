/**
 * Mechanism tests: real createCapabilityHandle + FollowupRuntime + SQLite,
 * FakeClock and a deliberately deferred FixtureClient. No network/GPU/model
 * capability claim. The fixture only controls cancellation/interleaving.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_QUIET } from '../contracts.ts'
import { buildRuntime } from '../runtime/build.ts'
import { FakeClock } from '../runtime/clock.ts'
import { createCapabilityHandle } from '../service/capability-assessor.ts'
import { CapabilityMemoryStore } from '../capability/memory/store.ts'
import { FixtureClient } from '../capability/tests/fixture-model.ts'
import type { ModelCallResult, ModelRequest } from '../capability/model/protocol.ts'
import { seedResult } from '../tools/seed.ts'
import { readResultFile } from '../tools/watch.ts'
import { ANALYSIS_GOAL } from './helpers.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const nextTurn = () => new Promise<void>((done) => setImmediate(done))

class DeferredFixtureClient extends FixtureClient {
  readonly started = deferred<ModelRequest>()
  readonly release = deferred<void>()
  readonly compilationCalls: { request: ModelRequest; signal?: AbortSignal }[] = []
  readonly assessmentRequests: ModelRequest[] = []
  onCompile: ((request: ModelRequest, signal?: AbortSignal) => Promise<ModelCallResult | null>) | null = null

  constructor() {
    super((request) => {
      const input = JSON.parse(request.messages[1]!.content)
      if (request.purpose === 'memory-extract') {
        const first = input.turnsToExtract.find((t: { id: string }) => t.id === 'original')
        return JSON.stringify({ coverage: input.turnsToExtract.map((t: { id: string }) => ({ turnId: t.id, status: t.id === 'original' ? 'extracted' : 'no_relevant_fact' })), items: first ? [{ key: 'sampleCount', value: 48, scope: { level: 'task', id: first.taskIds[0] }, quotes: [{ turnId: 'original', text: '先按48份样本跟进' }] }] : [] })
      }
      return JSON.stringify({ kind: 'none', reasonCode: 'no_current_action', evidenceTurnIds: input.memory.context.recentTurns.map((t: { turnId: string }) => t.turnId), evidenceItemIds: [] })
    })
  }

  override async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelCallResult> {
    if (request.purpose === 'memory-extract') {
      this.compilationCalls.push({ request, signal })
      this.started.resolve(request)
      if (this.onCompile) {
        const result = await this.onCompile(request, signal)
        if (result) return result
      } else await this.release.promise
    } else this.assessmentRequests.push(request)
    return super.complete(request)
  }
}

function environment(client: DeferredFixtureClient) {
  const root = mkdtempSync(join(tmpdir(), 'pet-compilation-wiring-'))
  // Keep original/correction turns before the capability handle's real asOf.
  const clock = new FakeClock(new Date(Date.now() - 60_000).toISOString())
  const handle = createCapabilityHandle({}, fetch, client)
  const built = buildRuntime({ workspaceRoot: root, policy: 'P3', clock, quiet: DEFAULT_QUIET, assessment: { assessor: handle.assessor, validateTaskControl: handle.validateTaskControl, timeoutMs: 5000 } })
  handle.attach(built.db.handle)
  const memory = new CapabilityMemoryStore(built.db.handle)
  const delegated = built.runtime.delegate({ title: '持续跟进实验', goal: '当前结果需要选择时询问', goalCondition: ANALYSIS_GOAL })
  const ticketId = delegated.ticketId
  handle.appendTurn({ turnId: 'original', sessionId: 'old-session', at: clock.now(), role: 'user', text: '先按48份样本跟进。', taskIds: [ticketId] })
  const seed = seedResult({ workspace: root, experimentId: 'E-COMPILE', runId: 'run-current', revision: 1, status: 'partial', total: 48, passed: 45, failed: 3 })
  built.runtime.observe({ ticketId, observed: readResultFile({ root, path: seed.resultPath, observedAt: clock.now() }).observed! })
  return { root, clock, handle, built, memory, ticketId }
}

test('真实接线：新原话废弃旧assessment，却复用在途抽取；一次写入，后续判断仍看见最新更正原文', async () => {
  const client = new DeferredFixtureClient()
  const { root, clock, handle, built, memory, ticketId } = environment(client)
  try {
    const extraction = await client.started.promise
    const firstPending = built.runtime.listAssessments(ticketId).find((r) => r.status === 'pending')!
    assert.ok(firstPending)
    assert.equal(client.compilationCalls.length, 1)
    for (const [turnId, text] of [['correction', '改口：最终应按64份样本，不是48。'], ['availability', '我现在有空，使用新口径继续跟进。']] as const) {
      clock.advance(1000)
      handle.appendTurn({ turnId, sessionId: 'new-session', at: clock.now(), role: 'user', text, taskIds: [ticketId] })
      built.runtime.requestReassessment(ticketId)
      built.runtime.reevaluate()
      await nextTurn()
      assert.equal(client.compilationCalls.length, 1, '每次新消息不能重启同一抽取')
      assert.equal(client.compilationCalls[0]!.signal!.aborted, false, 'assessment abort不得传入编译signal')
    }
    const old = built.runtime.listAssessments(ticketId).find((r) => r.request_id === firstPending.request_id)!
    assert.equal(old.status, 'aborted')
    assert.match(old.error_detail ?? '', /new user turn/)
    const pending = built.runtime.listAssessments(ticketId).filter((r) => r.status === 'pending')
    assert.equal(pending.length, 1)
    assert.notEqual(pending[0]!.request_id, firstPending.request_id)
    client.release.resolve()
    await built.runtime.settleAssessments()
    assert.equal(client.compilationCalls.length, 1)
    assert.equal(memory.extractions().filter((e) => e.requestId === extraction.requestId && e.status === 'applied').length, 1)
    assert.equal(memory.items().filter((i) => i.origin === extraction.requestId).length, 1)
    assert.equal(memory.items()[0]!.value, 48, '这个在途批次只抽到了旧原话，不能伪称已编译更正')
    assert.equal(memory.extractedTurnIds().has('correction'), false)
    assert.equal(client.assessmentRequests.length, 1, '旧消费者退出，只有当前消费者继续介入判断')
    const actualInput = JSON.parse(client.assessmentRequests[0]!.messages[1]!.content)
    assert.equal(actualInput.memory.context.recentTurns.find((t: { turnId: string }) => t.turnId === 'correction')?.quote, '改口：最终应按64份样本，不是48。')
    assert.ok(actualInput.memory.context.recentTurns.some((t: { turnId: string }) => t.turnId === 'availability'))
    assert.ok(built.runtime.listAssessments(ticketId).some((r) => r.status === 'submitted'))
  } finally {
    client.release.resolve()
    built.runtime.abortAllAssessments('test cleanup')
    await handle.close()
    await built.runtime.settleAssessments()
    built.db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('真实接线：handle.close取消编译并等清理，DB保持可用到清理完；随后没有晚到写入', async () => {
  const client = new DeferredFixtureClient()
  const aborted = deferred<void>(), cleanup = deferred<void>()
  let cleanupSawOpenDatabase = false, dbRead: (() => void) | null = null
  client.onCompile = async (request, signal) => {
    assert.ok(signal)
    await new Promise<void>((done) => signal.addEventListener('abort', () => { aborted.resolve(); done() }, { once: true }))
    await cleanup.promise
    dbRead!()
    cleanupSawOpenDatabase = true
    return { ok: false, code: 'aborted', detail: 'fixture compilation cleanup finished', requestId: request.requestId }
  }
  const { root, handle, built, memory, ticketId } = environment(client)
  dbRead = () => { assert.equal(memory.turns()[0]!.turnId, 'original') }
  let dbClosed = false
  try {
    await client.started.promise
    built.runtime.abortAllAssessments('host stopping')
    let closeDone = false
    const closing = handle.close().then(() => { closeDone = true })
    await aborted.promise
    await nextTurn()
    assert.equal(client.compilationCalls[0]!.signal!.aborted, true)
    assert.equal(closeDone, false, '不能仅因assessment已abort就关闭共享DB')
    assert.equal(dbClosed, false)
    assert.equal(memory.items().length, 0)
    cleanup.resolve()
    await closing
    await built.runtime.settleAssessments()
    assert.equal(cleanupSawOpenDatabase, true)
    assert.equal(client.assessmentRequests.length, 0)
    assert.equal(memory.items().length, 0)
    assert.ok(built.runtime.listAssessments(ticketId).every((r) => r.status !== 'pending'))
    built.db.close(); dbClosed = true
    await nextTurn()
    assert.equal(client.compilationCalls.length, 1)
    assert.throws(() => memory.items(), /closed|not open/i)
  } finally {
    cleanup.resolve(); client.release.resolve()
    if (!dbClosed) {
      built.runtime.abortAllAssessments('test cleanup')
      await handle.close()
      await built.runtime.settleAssessments()
      built.db.close()
    }
    rmSync(root, { recursive: true, force: true })
  }
})
