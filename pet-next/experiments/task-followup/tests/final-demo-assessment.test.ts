/**
 * final-demo：事务外异步 assessment 接口。
 * 这里的 assessor 是测试替身（按测试脚本回交草案），只验证接线、身份校验与 guard 记录，不代表任何能力结论。
 *
 * @module pet-next/experiments/task-followup/tests/final-demo-assessment
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_QUIET } from '../contracts.ts'
import { buildRuntime } from '../runtime/build.ts'
import type { BuiltRuntime } from '../runtime/build.ts'
import { FakeClock } from '../runtime/clock.ts'
import type { AssessmentDraft, AssessmentResponse, AssessmentSnapshot, AsyncAssessor, MemoryPacket } from '../runtime/assessment.ts'
import { seedResult } from '../tools/seed.ts'
import { readResultFile } from '../tools/watch.ts'
import { ANALYSIS_GOAL } from './helpers.ts'

interface Call {
  readonly snapshot: AssessmentSnapshot
  readonly packet: MemoryPacket
  readonly signal: AbortSignal
  resolve(response: AssessmentResponse): void
  reject(error: Error): void
}

function scriptedAssessor(): AsyncAssessor & { calls: Call[] } {
  const calls: Call[] = []
  return {
    id: 'test-double',
    capability: false,
    calls,
    assess(snapshot, packet, signal) {
      return new Promise((resolve, reject) => {
        calls.push({ snapshot, packet, signal, resolve, reject })
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')))
      })
    },
  }
}

const raw = (drafts: readonly AssessmentDraft[]) => ({ provider: 'test', model: 'test-double (not a model)', rawOutput: JSON.stringify(drafts) })

function setup(start = '2026-11-11T08:00:00.000Z') {
  const root = mkdtempSync(join(tmpdir(), 'pet-assess-test-'))
  const dbPath = join(root, 'state', 'db.sqlite')
  const clock = new FakeClock(start)
  const assessor = scriptedAssessor()
  const make = () => buildRuntime({ workspaceRoot: root, policy: 'P3', dbPath, clock, quiet: DEFAULT_QUIET, assessment: { assessor, timeoutMs: 5000 } })
  let built: BuiltRuntime = make()
  const h = {
    root,
    clock,
    assessor,
    get built() {
      return built
    },
    reopen() {
      // 模拟进程消失：旧 runtime 的在途请求不再回写（abort 后其失败回写因行已被新进程处理而无效）。
      built.runtime.abortAllAssessments('process gone')
      built.db.close()
      built = make()
      built.runtime.recover()
      return built
    },
    delegate() {
      return built.runtime.delegate({ title: '异步判断', goal: '结果不足时分析失败样本', goalCondition: ANALYSIS_GOAL, at: clock.now() })
    },
    result(ticketId: string, revision = 1, failed = 11) {
      const seed = seedResult({ workspace: root, experimentId: 'E17', runId: 'run-01', revision, status: 'partial', total: 40, passed: 40 - failed, failed })
      const finding = readResultFile({ root, path: seed.resultPath, observedAt: clock.now() })
      if (!finding.observed) throw new Error(finding.detail)
      return built.runtime.observe({ ticketId, observed: finding.observed })
    },
    async close() {
      built.runtime.abortAllAssessments('test end')
      await built.runtime.settleAssessments()
    },
    dispose() {
      try {
        built.db.close()
      } catch {
        // closed
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
  return h
}

const rowFor = (h: ReturnType<typeof setup>, call: Call) => h.built.runtime.listAssessments().find((row) => row.request_id === call.snapshot.identity.requestId)!
const tick = () => new Promise((done) => setTimeout(done, 10))

test('需要判断时只登记请求、事务外调用 assessor；回交前不出现问题', async () => {
  const h = setup()
  try {
    const d = h.delegate()
    h.result(d.ticketId)
    await tick()
    const pending = h.built.runtime.listAssessments(d.ticketId).filter((row) => row.status === 'pending')
    assert.equal(pending.length, 1)
    assert.equal(h.built.attention.listOpen(d.ticketId).length, 0)
    const call = h.assessor.calls.at(-1)!
    const task = h.built.runtime.getTask(d.ticketId)
    assert.equal(call.snapshot.identity.taskRevision, task.taskRevision)
    assert.equal(call.snapshot.identity.memoryCursor, task.memoryCursor)
    assert.ok(call.snapshot.actionMenu.some((item) => item.kind === 'ask_user'), '规则提案作为合法动作菜单')
    assert.equal(call.packet.provider, 'legacy-readRelevant')
  } finally {
    await h.close()
    h.dispose()
  }
})

test('回交 ask_now：经既有校验打开问题；guard 前草案与 guard 后结果都记录', async () => {
  const h = setup()
  try {
    const d = h.delegate()
    h.result(d.ticketId)
    await tick()
    const call = h.assessor.calls.at(-1)!
    const ask = call.snapshot.actionMenu.find((item) => item.kind === 'ask_user')!
    const drafts: AssessmentDraft[] = [{ intent: 'ask_now', actionId: ask.actionId, reasonText: '需要用户选择', question: '换个问法：要分析失败样本吗？' }]
    call.resolve({ drafts, raw: raw(drafts) })
    await tick()
    const open = h.built.attention.listOpen(d.ticketId)
    assert.equal(open.length, 1)
    assert.equal(open[0]!.question, '换个问法：要分析失败样本吗？')
    const row = rowFor(h, call)
    assert.equal(row.status, 'submitted')
    assert.deepEqual(JSON.parse(row.pre_guard_json!), drafts)
    const post = JSON.parse(row.post_guard_json!) as { outcome: string; code: string; guard: string }[]
    assert.equal(post[0]!.guard, 'runtime')
    assert.equal(post[0]!.code, 'ok')
    assert.equal(JSON.parse(row.raw_json!).model, 'test-double (not a model)')
    const proposal = h.built.db.listProposals(d.ticketId).find((item) => item.implementation === 'async-assessment')
    assert.ok(proposal)
  } finally {
    await h.close()
    h.dispose()
  }
})

test('新版本到来：旧身份请求被中止，迟到的旧回交被拒绝，不执行旧判断；直接回交也按身份校验', async () => {
  const h = setup()
  try {
    const d = h.delegate()
    h.result(d.ticketId, 1, 11)
    await tick()
    const old = h.assessor.calls.at(-1)!
    h.clock.advance(60_000)
    h.result(d.ticketId, 2, 3)
    await tick()
    assert.equal(old.signal.aborted, true)
    const oldRow = rowFor(h, old)
    assert.equal(oldRow.status, 'aborted')
    const ask = old.snapshot.actionMenu.find((item) => item.kind === 'ask_user')!
    const late = h.built.runtime.submitAssessment(old.snapshot.identity.requestId, { drafts: [{ intent: 'ask_now', actionId: ask.actionId, reasonText: 'old' }], raw: raw([]) })
    assert.equal(late.ok, false)
    assert.equal(late.code, 'not_pending')
    assert.equal(h.built.attention.listOpen(d.ticketId).length, 0)
    const current = h.assessor.calls.at(-1)!
    assert.notEqual(current.snapshot.identity.requestId, old.snapshot.identity.requestId)
    assert.equal(rowFor(h, current).status, 'pending')
    // 身份校验本身：把当前请求的身份字段与任务状态错开后直接回交 → stale，不执行。
    h.built.db.handle.prepare('UPDATE assessments SET memory_cursor = memory_cursor - 1 WHERE request_id = ?').run(current.snapshot.identity.requestId)
    const stale = h.built.runtime.submitAssessment(current.snapshot.identity.requestId, { drafts: [{ intent: 'ask_now', actionId: current.snapshot.actionMenu.find((item) => item.kind === 'ask_user')!.actionId, reasonText: 'x' }], raw: raw([]) })
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'stale_memory_cursor')
    assert.equal(rowFor(h, current).status, 'stale')
    assert.equal(h.built.attention.listOpen(d.ticketId).length, 0)
  } finally {
    await h.close()
    h.dispose()
  }
})

test('guard：引用不在记忆包、菜单外动作、等待缺 ETA 均由宿主拒绝并记录', async () => {
  const h = setup()
  try {
    const d = h.delegate()
    h.result(d.ticketId)
    await tick()
    const call = h.assessor.calls.at(-1)!
    const drafts: AssessmentDraft[] = [
      { intent: 'ask_now', reasonText: 'bad ref', question: 'q', options: [{ id: 'analyze_failing', label: 'x' }], evidenceRefs: [{ kind: 'event', id: 'ev-forged' } as never] },
      { intent: 'act', actionId: 'a99-continue_local', reasonText: 'invented tool' },
      { intent: 'wait', reasonText: 'no eta' },
      { intent: 'none', reasonText: 'nothing useful now' },
    ]
    call.resolve({ drafts, raw: raw(drafts) })
    await tick()
    const row = rowFor(h, call)
    const post = JSON.parse(row.post_guard_json!) as { code: string; guard: string; outcome: string }[]
    assert.deepEqual(post.slice(0, 3).map((item) => item.code), ['evidence_not_in_packet', 'unknown_action', 'wait_without_eta'])
    assert.equal(post[3]!.outcome, 'recorded')
    assert.equal(h.built.attention.listOpen(d.ticketId).length, 0)
    assert.equal(h.built.db.listEffects().filter((effect) => effect.kind === 'tool').length, 0)
  } finally {
    await h.close()
    h.dispose()
  }
})

test('provider 错误与解析错误为真实失败，不生成占位动作', async () => {
  const h = setup()
  try {
    const d = h.delegate()
    h.result(d.ticketId)
    await tick()
    const call = h.assessor.calls.at(-1)!
    call.reject(new Error('HTTP 503 from provider'))
    await tick()
    const row = rowFor(h, call)
    assert.equal(row.status, 'failed')
    assert.equal(row.error_code, 'provider_error')
    assert.equal(h.built.attention.listOpen(d.ticketId).length, 0)
    assert.equal(h.built.db.listProposals(d.ticketId).filter((item) => item.implementation === 'async-assessment').length, 0)
  } finally {
    await h.close()
    h.dispose()
  }
})

test('wait：持久化最晚重新判断时间，到期唤醒后按下一轮重新请求', async () => {
  const h = setup()
  try {
    const d = h.delegate()
    h.result(d.ticketId)
    await tick()
    const call = h.assessor.calls.at(-1)!
    const due = '2026-11-11T08:30:00.000Z'
    call.resolve({ drafts: [{ intent: 'wait', reasonText: '预计 30 分钟内有新结果', notBefore: due }], raw: raw([]) })
    await tick()
    const job = h.built.runtime.listWakeJobs().find((item) => item.detail === 'assessment_wait')
    assert.ok(job)
    assert.equal(job!.dueAt, due)
    const before = h.assessor.calls.length
    h.clock.set(due)
    h.built.runtime.wakeDue()
    await tick()
    assert.equal(h.assessor.calls.length, before + 1)
    assert.equal(h.assessor.calls.at(-1)!.snapshot.identity.round, 1)
  } finally {
    h.built.runtime.abortAllAssessments('test end')
    await h.built.runtime.settleAssessments()
    await h.close()
    h.dispose()
  }
})

test('取消：在途请求中止，之后的回交与结果都不产生提醒或执行', async () => {
  const h = setup()
  try {
    const d = h.delegate()
    h.result(d.ticketId)
    await tick()
    const call = h.assessor.calls.at(-1)!
    h.built.runtime.cancel({ ticketId: d.ticketId, at: h.clock.now() })
    await h.built.runtime.settleAssessments()
    assert.equal(call.signal.aborted, true)
    const row = rowFor(h, call)
    assert.equal(row.status, 'aborted')
    assert.equal(h.built.attention.listOpen(d.ticketId).length, 0)
    assert.equal(h.built.runtime.notifications(d.ticketId).length, 0)
  } finally {
    await h.close()
    h.dispose()
  }
})

test('重启：上一进程的 pending 记为 abandoned，新进程按同身份下一轮重新请求', async () => {
  const h = setup()
  try {
    const d = h.delegate()
    h.result(d.ticketId)
    await tick()
    const call = h.assessor.calls.at(-1)!
    // 模拟进程消失：不让本进程回写结果，直接关库重开；上一进程留下的 pending 行应被标 abandoned。
    assert.equal(rowFor(h, call).status, 'pending')
    h.reopen()
    assert.equal(rowFor(h, call).status, 'abandoned')
    assert.equal(rowFor(h, call).error_code, 'process_restart')
    h.built.runtime.reevaluate()
    await tick()
    const next = h.assessor.calls.at(-1)!
    assert.notEqual(next.snapshot.identity.requestId, call.snapshot.identity.requestId)
    assert.equal(rowFor(h, next).status, 'pending')
  } finally {
    h.built.runtime.abortAllAssessments('test end')
    await h.built.runtime.settleAssessments()
    await h.close()
    h.dispose()
  }
})

test('用户已明确选择的继续动作不再交给 assessor：分析照常执行并完成', async () => {
  const h = setup()
  try {
    const d = h.delegate()
    h.result(d.ticketId)
    await tick()
    const call = h.assessor.calls.at(-1)!
    const ask = call.snapshot.actionMenu.find((item) => item.kind === 'ask_user')!
    call.resolve({ drafts: [{ intent: 'act', actionId: ask.actionId, reasonText: 'ask' }], raw: raw([]) })
    await tick()
    const open = h.built.attention.listOpen(d.ticketId)[0]!
    h.built.runtime.present(d.ticketId)
    const answer = h.built.runtime.answer({ attentionId: open.attentionId, taskRevision: open.taskRevision, optionId: 'analyze_failing' })
    assert.equal(answer.ok, true)
    await tick()
    const task = h.built.runtime.getTask(d.ticketId)
    assert.equal(task.status, 'completed')
    assert.equal(h.built.db.listReceipts(d.ticketId).length, 1)
  } finally {
    await h.close()
    h.dispose()
  }
})
