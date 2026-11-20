/**
 * R8：首败局部授权。assessor 是脚本替身，只验证“首败菜单 → 局部授权 → 只读失败来源”的接线，
 * 不代表模型能力结论。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  resolve: (response: AssessmentResponse) => void
  aborted: boolean
}

function scriptedAssessor(): AsyncAssessor & { calls: Call[] } {
  const calls: Call[] = []
  return {
    id: 'r8-first-failure-double',
    capability: false,
    calls,
    assess(snapshot, _packet, signal) {
      return new Promise((resolve, reject) => {
        const call: Call = { snapshot, resolve, aborted: false }
        calls.push(call)
        signal.addEventListener('abort', () => { call.aborted = true; reject(signal.reason ?? new Error('aborted')) })
      })
    },
  }
}

const reply = (drafts: readonly AssessmentDraft[]): AssessmentResponse => ({
  drafts,
  raw: { provider: 'test', model: 'r8-double (not a model)', rawOutput: JSON.stringify(drafts) },
})

const tick = () => new Promise((done) => setTimeout(done, 25))
async function until<T>(label: string, read: () => T | null | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = read()
    if (value) return value
    await tick()
  }
  throw new Error(`timed out: ${label}`)
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pet-r8-first-'))
  const dbPath = join(root, 'state', 'db.sqlite')
  const clock = new FakeClock('2026-11-20T08:00:00.000Z')
  const assessor = scriptedAssessor()
  const make = () => buildRuntime({
    workspaceRoot: root,
    policy: 'P3',
    dbPath,
    clock,
    quiet: DEFAULT_QUIET,
    assessment: { assessor, timeoutMs: 5000 },
  })
  let built: BuiltRuntime = make()
  const h = {
    root,
    clock,
    assessor,
    get built() { return built },
    reopen() {
      built.runtime.abortAllAssessments('process gone')
      built.db.close()
      built = make()
      built.runtime.recover()
    },
    delegate(title: string, bindings: { alias: string; taskId: string }[] = []) {
      return built.runtime.delegate({
        title, goal: '跟进报告；按承诺决定何时需要确认',
        goalCondition: { ...ANALYSIS_GOAL, analysisWhen: bindings.length ? 'always' : 'insufficient' },
        ...(bindings.length ? { reportBindings: bindings } : {}),
        at: clock.now(),
      })
    },
    seed(ticketId: string, experimentId: string, status: 'succeeded' | 'failed', runId = `${experimentId}-run`) {
      const seed = seedResult({
        workspace: root, experimentId, runId, revision: 1, status,
        total: 2, passed: status === 'failed' ? 0 : 2, failed: status === 'failed' ? 2 : 0,
      })
      const finding = readResultFile({ root, path: seed.resultPath, observedAt: clock.now() })
      if (!finding.observed) throw new Error(finding.detail)
      built.runtime.observe({ ticketId, observed: finding.observed })
    },
    async callWith(ticketId: string, predicate: (snapshot: AssessmentSnapshot) => boolean = () => true) {
      return until('assessment request', () => [...assessor.calls].reverse().find((call) =>
        !call.aborted && call.snapshot.identity.ticketId === ticketId && predicate(call.snapshot)))
    },
    dispose() {
      try { built.runtime.abortAllAssessments('test end'); built.db.close() } catch { /* closed */ }
      rmSync(root, { recursive: true, force: true })
    },
  }
  return h
}

const partialTemplate = (snap: AssessmentSnapshot) => snap.actionMenu.find((item) => item.kind === 'ask_user' && item.options?.some((option) => option.id === 'analyze_this'))

test('首败：A 失败、B 未到，先问；局部授权只写 A 的分析，不读后来到达的 B', async () => {
  const h = setup()
  try {
    const dep = h.delegate('依赖检查').ticketId
    const primary = h.delegate('主测试', [{ alias: 'B 报告', taskId: dep }]).ticketId
    await tick()
    h.seed(primary, 'A', 'failed')
    h.built.runtime.requestReassessment(primary)
    const call = await h.callWith(primary, (snap) => Boolean(partialTemplate(snap)))
    const snap = call.snapshot
    assert.equal(snap.task.inputSet?.ok, false)
    const template = partialTemplate(snap)!
    assert.deepEqual(template.options?.map((option) => option.id), ['analyze_this', 'wait_other', 'skip_once'])
    assert.match(template.question ?? '', /主测试 失败了/)
    assert.match(template.question ?? '', /B 报告 还没到/)
    call.resolve(reply([{
      intent: 'ask_now', actionId: template.actionId, reasonCode: 'first_failure_partial',
      reasonText: template.reasonText, question: template.question, options: template.options,
    }]))
    const attention = await until('partial attention', () => h.built.attention.listOpen(primary)[0])
    assert.deepEqual(attention.options.map((option) => option.id), ['analyze_this', 'wait_other', 'skip_once'])

    h.built.runtime.present(primary)
    const answered = h.built.runtime.answer({
      attentionId: attention.attentionId, taskRevision: attention.taskRevision,
      optionId: 'analyze_this', at: h.clock.now(),
    })
    assert.equal(answered.ok, true, JSON.stringify(answered))
    const task = await until('partial analysis', () => {
      const current = h.built.runtime.getTask(primary)
      return current.analysis?.scope === 'partial' ? current : null
    }, 10000)
    assert.equal(task.analysis?.sourceTaskId, primary)
    assert.equal(task.lastAnswer?.analysisEvidence?.scope, 'partial')
    assert.deepEqual(task.lastAnswer?.analysisEvidence?.inputSet.authorizedTaskIds, [primary])
    const receipt = h.built.runtime.exportTask(primary).receipts.at(-1)!
    assert.equal(receipt.tool, 'write_analysis')
    assert.equal(receipt.inputRef?.taskId, primary)
    assert.equal(receipt.analysisEvidence?.scope, 'partial')
    const artifact = readFileSync(join(h.root, task.analysis!.artifactPath), 'utf8')
    assert.match(artifact, new RegExp(primary))
    assert.doesNotMatch(artifact, /dependency/i)

    const partialCheck = h.built.runtime.completionCheck(task).partialAnalysis
    assert.equal(partialCheck?.ok, true)
    assert.equal(partialCheck?.sourceTaskId, primary)

    // 后来到达的 B 不得进入这份产物；产物仍是同一 SHA。
    const before = task.analysis!.artifactSha
    h.built.runtime.requestReassessment(primary)
    h.seed(dep, 'B', 'succeeded')
    h.built.runtime.requestReassessment(primary)
    await tick()
    const after = h.built.runtime.getTask(primary)
    assert.equal(after.analysis?.artifactSha, before)
  } finally {
    h.dispose()
  }
})

test('首败选择“等另一份”跨重启保留；B 到达后才再问', async () => {
  const h = setup()
  try {
    const dep = h.delegate('依赖检查').ticketId
    const primary = h.delegate('主测试', [{ alias: 'B 报告', taskId: dep }]).ticketId
    await tick()
    h.seed(primary, 'A', 'failed')
    h.built.runtime.requestReassessment(primary)
    const call = await h.callWith(primary, (snap) => Boolean(partialTemplate(snap)))
    const template = partialTemplate(call.snapshot)!
    call.resolve(reply([{ intent: 'ask_now', actionId: template.actionId, reasonText: template.reasonText, question: template.question, options: template.options }]))
    const attention = await until('first partial attention', () => h.built.attention.listOpen(primary)[0])
    h.built.runtime.present(primary)
    assert.equal(h.built.runtime.answer({ attentionId: attention.attentionId, taskRevision: attention.taskRevision, optionId: 'wait_other', at: h.clock.now() }).ok, true)
    assert.equal(h.built.runtime.getTask(primary).partial?.optionId, 'wait_other')

    h.reopen()
    await tick()
    assert.equal(h.built.runtime.getTask(primary).partial?.optionId, 'wait_other')
    assert.equal(h.built.attention.listOpen(primary).length, 0)

    h.seed(dep, 'B', 'succeeded')
    h.built.runtime.requestReassessment(primary)
    const next = await h.callWith(primary, (snap) => snap.task.inputSet?.ok === true)
    assert.equal(next.snapshot.actionMenu.some((item) => item.options?.some((option) => option.id === 'analyze_this')), false)
  } finally {
    h.dispose()
  }
})
