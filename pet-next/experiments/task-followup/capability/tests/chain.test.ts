import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityMemoryStore } from '../memory/store.ts'
import { extractPending } from '../memory/extract.ts'
import { readForDecision } from '../memory/read.ts'
import { assess, submitAssessment } from '../intervention/assess.ts'
import type { AssessSnapshot } from '../intervention/assess.ts'
import { InterventionStore } from '../intervention/planner.ts'
import { FixtureClient } from './fixture-model.ts'
import type { Turn } from '../memory/types.ts'

const story = JSON.parse(readFileSync(new URL('../intervention/dev-story/story.json', import.meta.url), 'utf8'))
const turns: Turn[] = story.turns.map((t: any) => ({ turnId: t.id, sessionId: t.sessionId, seq: t.seq, at: t.at, role: t.role, text: t.text, taskIds: t.taskIds }))
const q = (turnId: string, text: string) => {
  const turn = turns.find((t) => t.turnId === turnId)!
  const start = turn.text.indexOf(text)
  assert.ok(start >= 0, `fixture quote must exist: ${text}`)
  return { turnId, start, end: start + text.length, text }
}

/** 夹具：手写的抽取输出（测试数据，不是模型输出）。第二轮根据请求里的 existingItems 填 supersedes。 */
function extractionFixture(req: any): string {
  const user = JSON.parse(req.messages[1].content)
  const ids = new Set(user.turnsToExtract.map((t: any) => t.id))
  const items: any[] = []
  if (ids.has('turn-001')) items.push({ kind: 'preference', key: 'notificationPolicy', value: 'only_when_decision_needed', statement: '只在需要用户决定时提醒', scope: { level: 'global', id: null }, validFrom: '2026-11-13T09:00:00+08:00', validUntil: null, supersedes: [], confidence: 0.9, status: 'active', quotes: [q('turn-001', '只在需要我决定的时候提醒我')] })
  if (ids.has('turn-002')) items.push({ kind: 'commitment', key: 'baselineVersion', value: 'v1', statement: 'A 用基线 v1', scope: { level: 'task', id: 'task:A' }, validFrom: '2026-11-13T09:01:00+08:00', validUntil: null, supersedes: [], confidence: 0.9, status: 'active', quotes: [q('turn-002', '先用基线v1')] })
  if (ids.has('turn-003')) items.push({ kind: 'commitment', key: 'baselineVersion', value: 'v1', statement: 'B 用基线 v1', scope: { level: 'task', id: 'task:B' }, validFrom: '2026-11-13T09:02:00+08:00', validUntil: null, supersedes: [], confidence: 0.9, status: 'active', quotes: [q('turn-003', '任务B用基线v1')] })
  if (ids.has('turn-004')) {
    const oldA = user.existingItems.find((i: any) => i.key === 'baselineVersion' && i.scope.id === 'task:A')
    items.push({ kind: 'commitment', key: 'baselineVersion', value: 'v2', statement: 'A 改用 v2', scope: { level: 'task', id: 'task:A' }, validFrom: '2026-11-13T10:30:00+08:00', validUntil: null, supersedes: oldA ? [oldA.itemId] : [], confidence: 0.9, status: 'active', quotes: [q('turn-004', 'A改用v2，旧v1别再用了')] })
    items.push({ kind: 'preference', key: 'nonUrgentDelivery', value: 'batch', statement: '今天下午开会，非紧急合并告知', scope: { level: 'global', id: null }, validFrom: '2026-11-13T10:30:00+08:00', validUntil: '2026-11-13T18:00:00+08:00', supersedes: [], confidence: 0.8, status: 'active', quotes: [q('turn-004', '今天下午我开会，非紧急的事一起告诉我')] })
  }
  if (ids.has('turn-005')) items.push({ kind: 'outcome', key: 'resultV1', value: 0.71, statement: 'A v1 结果 0.71', scope: { level: 'task', id: 'task:A' }, validFrom: '2026-11-13T11:00:00+08:00', validUntil: null, supersedes: [], confidence: 1, status: 'active', quotes: [q('turn-005', '准确率0.71')] })
  if (ids.has('turn-006')) items.push({ kind: 'outcome', key: 'progress', value: 0.6, statement: 'B 进度 60%', scope: { level: 'task', id: 'task:B' }, validFrom: '2026-11-13T11:05:00+08:00', validUntil: null, supersedes: [], confidence: 1, status: 'active', quotes: [q('turn-006', '已完成60%，无错误')] })
  if (ids.has('turn-007')) items.push({ kind: 'outcome', key: 'resultV2', value: 0.64, statement: 'A v2 结果 0.64 有失败', scope: { level: 'task', id: 'task:A' }, validFrom: '2026-11-13T13:20:00+08:00', validUntil: null, supersedes: [], confidence: 1, status: 'active', quotes: [q('turn-007', '准确率0.64，低于v1，有3个样本失败')] })
  return JSON.stringify({ items })
}

const budget = { maxItems: 20, maxChars: 6000 }
const read = (store: CapabilityMemoryStore, taskId: string, asOf: string, extra: Partial<Parameters<typeof readForDecision>[1]> = {}) =>
  readForDecision(store, { taskId, asOf, intent: 'current', question: '现在用哪个基线？要不要找我？', requiredSlots: ['baselineVersion'], budget, ...extra })

async function seed(dir: string, upTo: number) {
  const store = new CapabilityMemoryStore(join(dir, 'cap.sqlite'))
  const client = new FixtureClient(extractionFixture)
  for (const t of turns.filter((x) => x.seq <= upTo)) {
    store.appendTurn(t)
    // 每个会话边界后抽取一次（模拟逐步到来的对话）
    if ([3, 4, 5, 6, 7].includes(t.seq)) await extractPending(store, client, { entities: story.entities, now: t.at })
  }
  return { store, client }
}

test('原话持久化 → 抽取 → 读取：A 改口只影响 A，B 仍为 v1，全局偏好两边都在；重启后仍成立', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-chain-'))
  try {
    const { store, client } = await seed(dir, 7)
    assert.ok(client.seen.every((r) => r.purpose === 'memory-extract'))
    const a = read(store, 'task:A', '2026-11-13T13:25:00+08:00')
    const b = read(store, 'task:B', '2026-11-13T13:25:00+08:00')
    assert.deepEqual(a.commitments.map((i) => i.value), ['v2'])
    assert.ok(a.context.nonActionable.some((i) => i.value === 'v1' && i.status === 'superseded'))
    assert.deepEqual(b.commitments.map((i) => i.value), ['v1'])
    assert.equal(b.context.nonActionable.length, 0)
    assert.ok(a.preferences.some((p) => p.key === 'notificationPolicy') && b.preferences.some((p) => p.key === 'notificationPolicy'))
    assert.deepEqual(a.missing, [])
    assert.ok(a.evidenceRefs.some((r) => r.turnId === 'turn-004' && r.quote.includes('v2')))
    assert.ok(!a.outcomes.some((o) => o.evidenceTurnIds.includes('turn-006')), 'B 的进度不进入 A 的包')
    store.close()
    // 重启：重新打开同一文件
    const again = new CapabilityMemoryStore(join(dir, 'cap.sqlite'))
    const a2 = read(again, 'task:A', '2026-11-13T13:25:00+08:00')
    assert.deepEqual(a2.commitments.map((i) => i.value), ['v2'])
    // 历史查询：更正前时刻看到 v1；未来信息不可见
    const hist = read(again, 'task:A', '2026-11-13T13:25:00+08:00', { intent: 'historical', historicalAt: '2026-11-13T10:00:00+08:00' })
    assert.deepEqual(hist.commitments.map((i) => i.value), ['v1'])
    assert.ok(!hist.evidenceRefs.some((r) => r.seq >= 4))
    // 临时偏好过期
    const evening = read(again, 'task:A', '2026-11-13T19:00:00+08:00')
    assert.ok(!evening.preferences.some((p) => p.key === 'nonUrgentDelivery'))
    again.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('抽取 guard：非逐字引用拒绝；助手复述不能成为用户偏好；跨任务更正转冲突；假设不可行动', async () => {
  const store = new CapabilityMemoryStore(':memory:')
  store.appendTurn({ turnId: 'u1', sessionId: 's', seq: 1, at: '2026-11-13T09:00:00+08:00', role: 'user', text: 'X任务交给甲。', taskIds: ['task:X'] })
  store.appendTurn({ turnId: 'a1', sessionId: 's', seq: 2, at: '2026-11-13T09:01:00+08:00', role: 'assistant', text: '你喜欢每小时汇报。', taskIds: ['task:X'] })
  store.appendTurn({ turnId: 'u2', sessionId: 's', seq: 3, at: '2026-11-13T09:02:00+08:00', role: 'user', text: '假如Y任务交给乙会怎样？', taskIds: ['task:Y'] })
  let round = 0
  const client = new FixtureClient((req) => {
    const user = JSON.parse(req.messages[1].content)
    round++
    if (round === 1) return JSON.stringify({ items: [
      { kind: 'fact', key: 'ownerId', value: '甲', statement: '', scope: { level: 'task', id: 'task:X' }, validFrom: null, validUntil: null, supersedes: [], confidence: 1, status: 'active', quotes: [{ turnId: 'u1', start: 0, end: 3, text: '交给甲' }] },
      { kind: 'fact', key: 'ownerId', value: '丙', statement: '', scope: { level: 'task', id: 'task:X' }, validFrom: null, validUntil: null, supersedes: [], confidence: 1, status: 'active', quotes: [{ turnId: 'u1', start: 0, end: 3, text: '交给丙' }] },
      { kind: 'preference', key: 'reportFrequency', value: 'hourly', statement: '', scope: { level: 'task', id: 'task:X' }, validFrom: null, validUntil: null, supersedes: [], confidence: 1, status: 'active', quotes: [{ turnId: 'a1', start: 1, end: 9, text: '喜欢每小时汇报' }] },
    ] })
    const old = user.existingItems.find((i: any) => i.key === 'ownerId')
    return JSON.stringify({ items: [
      { kind: 'fact', key: 'ownerId', value: '乙', statement: '', scope: { level: 'task', id: 'task:Y' }, validFrom: null, validUntil: null, supersedes: [old.itemId], confidence: 0.5, status: 'active', quotes: [{ turnId: 'u2', start: 0, end: 7, text: 'Y任务交给乙' }] },
      { kind: 'fact', key: 'ownerId', value: '乙', statement: '', scope: { level: 'task', id: 'task:Y' }, validFrom: null, validUntil: null, supersedes: [], confidence: 0.5, status: 'hypothetical', quotes: [{ turnId: 'u2', start: 2, end: 9, text: 'Y任务交给乙' }] },
    ] })
  })
  const r1 = await extractPending(store, client, { entities: [], now: '2026-11-13T09:01:30+08:00' })
  // u1/a1 第一轮，u2 也在第一轮里（未抽取的原话都会发送）；为制造两轮，先撤回再测：这里直接检查第一轮
  assert.equal(r1.status, 'applied')
  assert.deepEqual(r1.report!.rejected.map((x) => x.reason), ['quote_not_verbatim:u1'])
  const pref = r1.report!.accepted.find((i) => i.key === 'reportFrequency')!
  assert.equal(pref.authority, 'assistant')
  assert.equal(pref.status, 'inferred')
  const owner = r1.report!.accepted.find((i) => i.key === 'ownerId')!
  assert.ok(owner.checks.some((c) => c.startsWith('quote_relocated')), 'start/end 错但文本唯一时重定位并记录')
  // 第二轮：新增原话
  store.appendTurn({ turnId: 'u3', sessionId: 's', seq: 4, at: '2026-11-13T09:03:00+08:00', role: 'user', text: '假如Y任务交给乙会怎样？再问一次。', taskIds: ['task:Y'] })
  const r2 = await extractPending(store, client, { entities: [], now: '2026-11-13T09:03:30+08:00' })
  assert.equal(r2.status, 'applied')
  // r2 引用 u2（已在上一批）→ 记录 quote_outside_batch；跨任务 supersede → conflict
  const cross = r2.report!.accepted[0]!
  assert.equal(cross.status, 'conflict')
  assert.ok(cross.checks.some((c) => c.startsWith('supersede_cross_scope')))
  const packetX = readForDecision(store, { taskId: 'task:X', asOf: '2026-11-13T10:00:00+08:00', intent: 'current', question: '负责人', requiredSlots: ['ownerId'], budget })
  assert.deepEqual(packetX.currentFacts.map((f) => f.value), ['甲'], 'X 不被 Y 的假设/冲突改写')
  const packetY = readForDecision(store, { taskId: 'task:Y', asOf: '2026-11-13T10:00:00+08:00', intent: 'current', question: '负责人', requiredSlots: ['ownerId'], budget })
  assert.deepEqual(packetY.missing, ['ownerId'])
  assert.ok(packetY.conflicts.length >= 1)
  assert.ok(packetY.context.diagnostics.some((d) => d.startsWith('hypothetical_not_actionable')))
  // 撤回原话：依赖它的条目不再出现
  store.retractTurn('u1', '2026-11-13T09:30:00+08:00', 'user_deleted')
  const afterRetract = readForDecision(store, { taskId: 'task:X', asOf: '2026-11-13T10:00:00+08:00', intent: 'current', question: '负责人', requiredSlots: ['ownerId'], budget })
  assert.deepEqual(afterRetract.currentFacts, [])
  assert.deepEqual(afterRetract.missing, ['ownerId'])
  store.close()
})

function assessFixture(kind: string, extra: Record<string, unknown> = {}) {
  return (req: any) => {
    const user = JSON.parse(req.messages[1].content)
    const current = user.memory.commitments.map((i: any) => i.itemId)
    return JSON.stringify({ kind, reasonCode: kind === 'wait' ? 'waiting_external_info' : kind === 'digest' ? 'scheduled_digest' : 'needs_user_choice', question: kind === 'ask' || kind === 'digest' ? '是否分析失败样本？' : null, optionIds: [], wakeAt: null, waitFor: null, deadlineAt: null, deliverAt: null, batchable: false, evidenceTurnIds: user.memory.evidenceRefs.map((r: any) => r.turnId), evidenceItemIds: current, answerFacts: [], ...extra })
  }
}

const snap = (taskId: string, now: string, rev = 1, assignment: string | null = 'asg-1'): AssessSnapshot => ({ taskId, title: taskId, goal: '跟进实验', taskRevision: rev, assignmentId: assignment, status: 'running', stage: 'observing', now, latestResult: null, options: [] })

test('异步 assessment 回交：版本/assignment/相关记忆游标过期被拒；无关任务记忆变化不拒；引用旧版本被拒；无重判时间的 wait 被拒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-assess-'))
  try {
    const { store } = await seed(dir, 7)
    const now = '2026-11-13T13:25:00+08:00'
    const packet = read(store, 'task:A', now)
    const rec = await assess(snap('task:A', now), packet, undefined, new FixtureClient(assessFixture('ask')))
    assert.equal(rec.request.purpose, 'assess')
    assert.ok(!rec.request.messages[1]!.content.includes('turn-006'), 'B 的原话不进 A 的请求')
    assert.equal(submitAssessment(rec, packet, { taskRevision: 1, assignmentId: 'asg-1', now }, store).code, 'accepted')
    assert.equal(submitAssessment(rec, packet, { taskRevision: 2, assignmentId: 'asg-1', now }, store).code, 'stale_revision')
    assert.equal(submitAssessment(rec, packet, { taskRevision: 1, assignmentId: 'asg-2', now }, store).code, 'stale_assignment')
    store.appendTurn({ turnId: 'turn-b-late', sessionId: 'session-3', seq: 8, at: '2026-11-13T13:26:00+08:00', role: 'tool', text: 'B进度70%', taskIds: ['task:B'] })
    assert.equal(submitAssessment(rec, packet, { taskRevision: 1, assignmentId: 'asg-1', now }, store).code, 'accepted', 'B 的新原话不使 A 过期')
    store.appendTurn({ turnId: 'turn-a-late', sessionId: 'session-3', seq: 9, at: '2026-11-13T13:27:00+08:00', role: 'user', text: 'A的阈值先别动', taskIds: ['task:A'] })
    assert.equal(submitAssessment(rec, packet, { taskRevision: 1, assignmentId: 'asg-1', now }, store).code, 'stale_memory')

    const packet2 = read(store, 'task:A', now)
    const oldId = packet2.context.nonActionable.find((i) => i.value === 'v1')!.itemId
    const recStale = await assess(snap('task:A', now), packet2, undefined, new FixtureClient(assessFixture('ask', { evidenceItemIds: [oldId] })))
    assert.equal(submitAssessment(recStale, packet2, { taskRevision: 1, assignmentId: 'asg-1', now }, store).code, 'evidence_not_actionable')
    const recWait = await assess(snap('task:A', now), packet2, undefined, new FixtureClient(assessFixture('wait')))
    const w = submitAssessment(recWait, packet2, { taskRevision: 1, assignmentId: 'asg-1', now }, store)
    assert.equal(w.code, 'wait_without_recheck')
    assert.equal(w.proposal!.kind, 'wait', 'guard 前提案原样保留')
    const recBad = await assess(snap('task:A', now), packet2, undefined, new FixtureClient(() => 'not json'))
    assert.equal(recBad.failure!.code, 'parse_error')
    assert.equal(submitAssessment(recBad, packet2, { taskRevision: 1, assignmentId: 'asg-1', now }, store).code, 'model_failed')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('介入：wait 持久化且重判不能后推；A/B 合并通知各自保留 decision/version；答一个不答全部；新证据只撤回本任务；重复不再通知；取消后无效；重启保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-plan-'))
  try {
    const { store } = await seed(dir, 7)
    const plan = new InterventionStore(store.db)
    const now = '2026-11-13T13:25:00+08:00'
    const pA = read(store, 'task:A', now)
    const pB = read(store, 'task:B', now)
    // A：先等待（等第二批结果），带最晚重判
    const w1 = await assess(snap('task:A', now), pA, undefined, new FixtureClient(assessFixture('wait', { wakeAt: '2026-11-13T15:00:00+08:00', waitFor: '剩余样本结果', deadlineAt: '2026-11-13T17:00:00+08:00' })))
    const o1 = plan.apply(w1, submitAssessment(w1, pA, { taskRevision: 1, assignmentId: 'asg-1', now }, store), now)
    assert.equal(o1.type, 'waiting')
    const w2 = await assess(snap('task:A', now), pA, undefined, new FixtureClient(assessFixture('wait', { wakeAt: '2026-11-13T16:30:00+08:00', waitFor: '剩余样本结果' })))
    const o2 = plan.apply(w2, submitAssessment(w2, pA, { taskRevision: 1, assignmentId: 'asg-1', now }, store), now)
    assert.equal(o2.type === 'waiting' && o2.wait.recheckAt, '2026-11-13T15:00:00+08:00', '重判不能把最晚时间往后推')
    assert.equal(plan.waits().length, 1)
    assert.equal(plan.nextWakeAt(), '2026-11-13T15:00:00+08:00')
    assert.deepEqual(plan.dueWaits('2026-11-13T14:59:00+08:00'), [])
    assert.equal(plan.dueWaits('2026-11-13T15:00:00+08:00').length, 1)

    // 到期重判：A 需要选择但可合并；B 正常进度进入摘要
    const t2 = '2026-11-13T15:00:00+08:00'
    const aAsk = await assess(snap('task:A', t2), pA, undefined, new FixtureClient(assessFixture('ask', { batchable: true, deliverAt: '2026-11-13T17:30:00+08:00' })))
    const oa = plan.apply(aAsk, submitAssessment(aAsk, pA, { taskRevision: 1, assignmentId: 'asg-1', now: t2 }, store), t2)
    const bDig = await assess(snap('task:B', t2, 3, 'asg-b'), pB, undefined, new FixtureClient(assessFixture('digest', { deliverAt: '2026-11-13T18:00:00+08:00' })))
    const ob = plan.apply(bDig, submitAssessment(bDig, pB, { taskRevision: 3, assignmentId: 'asg-b', now: t2 }, store), t2)
    assert.equal(oa.type, 'notified')
    assert.equal(ob.type, 'notified')
    assert.equal(plan.waits()[0]!.status, 'resolved')
    const bundle = plan.notices().find((n) => n.mode === 'bundle')!
    assert.equal(bundle.members.length, 2)
    assert.equal(bundle.deliverAt, '2026-11-13T17:30:00+08:00', '合并通知按成员最早的最晚送达时间')
    assert.deepEqual(bundle.members.map((m) => [m.taskId, m.taskRevision, m.assignmentId]), [['task:A', 1, 'asg-1'], ['task:B', 3, 'asg-b']])
    assert.deepEqual(plan.dueNotices('2026-11-13T17:00:00+08:00'), [])
    assert.equal(plan.dueNotices('2026-11-13T17:30:00+08:00').length, 1)
    // 同状态重复判断 → 不重复通知
    const dup = plan.apply(bDig, submitAssessment(bDig, pB, { taskRevision: 3, assignmentId: 'asg-b', now: t2 }, store), t2)
    assert.equal(dup.type, 'suppressed_duplicate')
    // 打开 ≠ 回答；回答 A 不影响 B
    plan.markSeen(bundle.noticeId, '2026-11-13T17:31:00+08:00')
    const aDecision = bundle.members[0]!.decisionId
    assert.equal(plan.answer(bundle.noticeId, aDecision, 'analyze'), true)
    let now2 = plan.notices().find((n) => n.noticeId === bundle.noticeId)!
    assert.deepEqual(now2.members.map((m) => m.status), ['answered', 'pending'])
    // 新证据只撤回 B 自己的成员
    plan.evidenceArrived('task:B', '2026-11-13T17:40:00+08:00', 'progress-80')
    now2 = plan.notices().find((n) => n.noticeId === bundle.noticeId)!
    assert.deepEqual(now2.members.map((m) => m.status), ['answered', 'withdrawn'])
    // 取消 A：之后的提案不产生提醒
    plan.cancelTask('task:A', '2026-11-13T17:45:00+08:00')
    const after = await assess(snap('task:A', '2026-11-13T17:50:00+08:00'), pA, undefined, new FixtureClient(assessFixture('ask', { reasonCode: 'deadline_risk' })))
    const oc = plan.apply(after, submitAssessment(after, pA, { taskRevision: 1, assignmentId: 'asg-1', now: '2026-11-13T17:50:00+08:00' }, store), '2026-11-13T17:50:00+08:00')
    assert.deepEqual(oc, { type: 'rejected', code: 'task_cancelled' })
    // guard 前/后两层都有记录
    assert.ok(plan.assessments().length >= 6)
    store.close()
    // 重启后状态还在
    const reopened = new CapabilityMemoryStore(join(dir, 'cap.sqlite'))
    const plan2 = new InterventionStore(reopened.db)
    assert.equal(plan2.isCancelled('task:A'), true)
    assert.equal(plan2.notices().find((n) => n.noticeId === bundle.noticeId)!.members[0]!.status, 'answered')
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
