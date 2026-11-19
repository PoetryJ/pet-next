/**
 * R7：静默归档的宿主守卫。
 *
 * assessor 是脚本替身：它只验证“草案 → 归档”的接线与 fail-closed 条件，
 * 不代表任何模型能力结论。
 *
 * @module pet-next/experiments/task-followup/tests/r7-archive
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
}

function scriptedAssessor(): AsyncAssessor & { calls: Call[] } {
  const calls: Call[] = []
  return {
    id: 'r7-test-double',
    capability: false,
    calls,
    assess(snapshot, packet, signal) {
      return new Promise((resolve, reject) => {
        calls.push({ snapshot, packet, signal, resolve })
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')))
      })
    },
  }
}

const draft = (): AssessmentDraft => ({
  intent: 'archive',
  reasonCode: 'commitment_no_ask',
  reasonText: '两份报告都成功，按约定静默归档',
  archive: {
    compilationKey: 'test-compilation',
    condition: '{"op":"cmp"}',
    quotes: [{ turnId: 'say-1', text: '都成功就归档' }],
    taskIds: [],
  },
})

const reply = (drafts: readonly AssessmentDraft[]): AssessmentResponse => ({
  drafts,
  raw: { provider: 'test', model: 'r7-double (not a model)', rawOutput: JSON.stringify(drafts) },
})

const tick = () => new Promise((done) => setTimeout(done, 20))
async function until<T>(label: string, read: () => T | null | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = read()
    if (value) return value
    await tick()
  }
  throw new Error(`timed out: ${label}`)
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pet-r7-archive-'))
  const dbPath = join(root, 'state', 'db.sqlite')
  const clock = new FakeClock('2026-11-19T08:00:00.000Z')
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
    get built() {
      return built
    },
    reopen() {
      built.runtime.abortAllAssessments('process gone')
      built.db.close()
      built = make()
      built.runtime.recover()
      return built
    },
    delegate(title: string, bindings: { alias: string; taskId: string }[] = []) {
      return built.runtime.delegate({
        title,
        goal: '跟进报告；按承诺决定何时需要确认',
        goalCondition: { ...ANALYSIS_GOAL, analysisWhen: bindings.length ? 'always' : 'insufficient' },
        ...(bindings.length ? { reportBindings: bindings } : {}),
        at: clock.now(),
      })
    },
    result(ticketId: string, experimentId: string) {
      const seed = seedResult({
        workspace: root,
        experimentId,
        runId: `${experimentId}-run`,
        revision: 1,
        status: 'succeeded',
        total: 4,
        passed: 4,
        failed: 0,
      })
      const finding = readResultFile({ root, path: seed.resultPath, observedAt: clock.now() })
      if (!finding.observed) throw new Error(finding.detail)
      built.runtime.observe({ ticketId, observed: finding.observed })
    },
    /** 等待一个仍有效、且已看到输入集合的评估请求（ok=false 也返回：用于缺来源负控）。 */
    async callFor(ticketId: string) {
      return until('assessment request', () => [...assessor.calls].reverse().find((call) =>
        !call.signal.aborted
        && call.snapshot.identity.ticketId === ticketId
        && call.snapshot.task.inputSet !== undefined))
    },
    async readyCall(ticketId: string) {
      return until('assessment with full inputs', () => [...assessor.calls].reverse().find((call) =>
        !call.signal.aborted
        && call.snapshot.identity.ticketId === ticketId
        && call.snapshot.task.inputSet?.ok === true))
    },
    dispose() {
      try {
        built.runtime.abortAllAssessments('test end')
        built.db.close()
      } catch {
        // closed
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
  return h
}

async function archiveBoth(h: ReturnType<typeof setup>, primary: string, dep: string) {
  const call = await h.readyCall(primary)
  call.resolve(reply([{ ...draft(), archive: { ...draft().archive!, taskIds: [primary, dep] } }]))
  await until('archived', () => h.built.runtime.getTask(primary).status === 'archived')
}

test('两份报告都成功：无问题、无通知，任务静默归档并留下计划原话', async () => {
  const h = setup()
  try {
    const dep = h.delegate('依赖检查').ticketId
    const primary = h.delegate('主测试', [{ alias: 'B 报告', taskId: dep }]).ticketId
    await tick()
    h.result(dep, 'B')
    h.result(primary, 'A')
    h.built.runtime.requestReassessment(primary)
    await archiveBoth(h, primary, dep)
    const task = h.built.runtime.getTask(primary)
    assert.equal(task.stage, 'archived')
    assert.equal(task.completion?.mode, 'quiet_archive')
    assert.equal(task.completion?.planCompilationKey, 'test-compilation')
    assert.deepEqual(task.completion?.sourceQuotes, [{ turnId: 'say-1', text: '都成功就归档' }])
    assert.equal(h.built.attention.listOpen(primary).length, 0)
    assert.equal(h.built.runtime.notifications(primary).length, 0)
    assert.equal(h.built.runtime.exportTask(primary).decisions.filter((p) => p.kind === 'ask_user').length, 0)
  } finally {
    h.dispose()
  }
})

test('归档不因重启复活，也不会再评估', async () => {
  const h = setup()
  try {
    const dep = h.delegate('依赖检查').ticketId
    const primary = h.delegate('主测试', [{ alias: 'B 报告', taskId: dep }]).ticketId
    await tick()
    h.result(dep, 'B')
    h.result(primary, 'A')
    h.built.runtime.requestReassessment(primary)
    await archiveBoth(h, primary, dep)
    const before = h.built.runtime.listAssessments(primary).length
    h.reopen()
    await tick()
    assert.equal(h.built.runtime.getTask(primary).status, 'archived')
    assert.equal(h.built.runtime.listAssessments(primary).length, before)
    assert.equal(h.built.attention.listOpen(primary).length, 0)
  } finally {
    h.dispose()
  }
})

test('缺少计划身份 / 没有任何已核验来源：拒绝归档，任务保持 active', async () => {
  const h = setup()
  try {
    const dep = h.delegate('依赖检查').ticketId
    const primary = h.delegate('主测试', [{ alias: 'B 报告', taskId: dep }]).ticketId
    await tick()
    h.built.runtime.requestReassessment(primary)
    const first = await h.callFor(primary)
    first.resolve(reply([draft()]))
    await until('first archive rejected', () => h.built.runtime.exportTask(primary).decisions.some((p) => p.reasonCode === 'commitment_no_ask'))
    assert.equal(h.built.runtime.getTask(primary).status, 'active')

    // 来源 B 没有核验结果：即使带全计划身份也必须拒绝。
    h.built.runtime.requestReassessment(primary)
    const second = await h.callFor(primary)
    second.resolve(reply([{ ...draft(), archive: { ...draft().archive!, taskIds: [primary, dep] } }]))
    await until('second archive rejected', () => h.built.runtime.exportTask(primary).decisions.filter((p) => p.reasonCode === 'commitment_no_ask').length >= 2)
    assert.equal(h.built.runtime.getTask(primary).status, 'active')
    assert.equal(h.built.attention.listOpen(primary).length, 0)
  } finally {
    h.dispose()
  }
})

test('另一份来源未到不阻止归档：三值 false 已由主来源的核验结果锚定', async () => {
  const h = setup()
  try {
    const dep = h.delegate('依赖检查').ticketId
    const primary = h.delegate('主测试', [{ alias: 'B 报告', taskId: dep }]).ticketId
    await tick()
    h.result(primary, 'A')
    h.built.runtime.requestReassessment(primary)
    const call = await h.callFor(primary)
    call.resolve(reply([{ ...draft(), archive: { ...draft().archive!, taskIds: [primary, dep] } }]))
    await until('archived with missing dependency', () => h.built.runtime.getTask(primary).status === 'archived')
    assert.equal(h.built.runtime.getTask(primary).completion?.mode, 'quiet_archive')
    assert.deepEqual(h.built.runtime.getTask(primary).completion?.checkedPaths, [join(h.root, 'inbox', 'A', 'result.json')])
  } finally {
    h.dispose()
  }
})
