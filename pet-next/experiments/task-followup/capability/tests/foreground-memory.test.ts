import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CapabilityMemoryStore } from '../memory/store.ts'
import { extractPending } from '../memory/extract.ts'
import { readForDecision } from '../memory/read.ts'
import { FixtureClient } from './fixture-model.ts'

const time = (n: number) => new Date(Date.parse('2026-11-13T10:00:00Z') + n * 60_000).toISOString()
const read = (store: CapabilityMemoryStore, maxChars = 1600) => readForDecision(store, {
  taskId: 'task:A', asOf: time(99), intent: 'current', question: '当前承诺和取消',
  requiredSlots: ['sampleCount', 'taskStatus'], budget: { maxItems: 20, maxChars },
})

test('旧记忆占满预算时，新更正/取消仍保留逐字来源；未抽取不等于用户没说', async () => {
  const store = new CapabilityMemoryStore(':memory:')
  try {
    for (let i = 0; i < 10; i++) {
      const turnId = `old-${i}`, text = `任务A约定事项${i}，原始证据${'完整保留'.repeat(20)}`
      store.appendTurn({ turnId, sessionId: 'old', seq: i + 1, at: time(i), role: 'user', taskIds: ['task:A'], text })
      await extractPending(store, new FixtureClient(() => JSON.stringify({ items: [{ key: `other.note${i}`, kind: 'commitment', value: `事项${i}`, scope: { level: 'task', id: 'task:A' }, quotes: [{ turnId, text }] }] })), { entities: [], now: time(i) })
    }
    const text = 'A现在取消，尚未执行的分析都不要做；B仍继续。'
    store.appendTurn({ turnId: 'cancel-now', sessionId: 'new', seq: 11, at: time(11), role: 'user', taskIds: ['task:A'], text })
    store.appendTurn({ turnId: 'other-task', sessionId: 'new', seq: 12, at: time(12), role: 'user', taskIds: ['task:B'], text: 'B的私有材料不进入A。' })
    const p = read(store)
    assert.equal(p.context.recentTurns.find((t) => t.turnId === 'cancel-now')?.quote, text)
    assert.ok(!JSON.stringify(p).includes('other-task'))
    assert.ok(p.context.budgetUsed.chars <= 1600)
    assert.ok(p.context.truncated)
    assert.equal(p.context.slotResolution.find((s) => s.slot === 'taskStatus')?.status, 'unresolved')
  } finally { store.close() }
})

test('紧凑模型 delta 补齐来源/类型，前台按任务抽取不消耗其他任务待办原话', async () => {
  const store = new CapabilityMemoryStore(':memory:')
  try {
    store.appendTurn({ turnId: 'b', sessionId: 's', seq: 1, at: time(0), role: 'user', taskIds: ['task:B'], text: 'B用32份样本。' })
    store.appendTurn({ turnId: 'a', sessionId: 's', seq: 2, at: time(1), role: 'user', taskIds: ['task:A'], text: 'A改成64份样本。' })
    const client = new FixtureClient((req) => {
      assert.deepEqual(JSON.parse(req.messages[1]!.content).turnsToExtract.map((t: any) => t.id), ['a'])
      return JSON.stringify({ coverage: [{ turnId: 'a', status: 'extracted' }], items: [{ key: 'sampleCount', value: 64, scope: { level: 'task', id: 'task:A' }, quotes: [{ turnId: 'a', text: '改成64份样本' }] }] })
    })
    const r = await extractPending(store, client, { entities: [], now: time(2), taskId: 'task:A' })
    assert.equal(r.report!.accepted[0]!.kind, 'commitment')
    assert.equal(r.report!.accepted[0]!.statement, '改成64份样本')
    assert.equal(r.report!.accepted[0]!.quotes[0]!.start, 1)
    assert.equal(store.extractedTurnIds().has('b'), false)
    assert.equal(read(store).commitments[0]!.value, 64)
  } finally { store.close() }
})

test('取消/恢复可用是用户状态转移，即使模型漏写supersedes仍替换同作用域旧状态', async () => {
  const store = new CapabilityMemoryStore(':memory:')
  try {
    const compile = async (seq: number, task: string, key: string, value: string, role: 'user' | 'assistant' = 'user') => {
      const turnId = `state-${seq}`, text = `${task}当前状态为${value}。`
      store.appendTurn({ turnId, sessionId: 's', seq, at: time(seq), role, taskIds: [task], text })
      return extractPending(store, new FixtureClient(() => JSON.stringify({ items: [{ key, value, scope: { level: 'task', id: task }, quotes: [{ turnId, text }] }] })), { entities: [], now: time(seq) })
    }
    const old = await compile(1, 'task:A', 'taskStatus', 'active')
    await compile(2, 'task:B', 'taskStatus', 'active')
    const cancel = await compile(3, 'task:A', 'taskStatus', 'cancelled')
    assert.deepEqual(cancel.report!.accepted[0]!.supersedes, [old.report!.accepted[0]!.itemId])
    assert.ok(cancel.report!.accepted[0]!.checks.some((s) => s.startsWith('user_state_transition:')))
    assert.deepEqual(read(store, 6000).commitments.filter((i) => i.key === 'taskStatus').map((i) => i.value), ['cancelled'])
    assert.equal(read(store, 6000).conflicts.filter((c) => c.key === 'taskStatus').length, 0)
    const assistant = await compile(4, 'task:A', 'taskStatus', 'active', 'assistant')
    assert.deepEqual(assistant.report!.accepted[0]!.supersedes, [], '助手不能恢复用户已取消任务')
    const busy = await compile(5, 'task:A', 'availability', 'busy')
    const back = await compile(6, 'task:A', 'availability', 'available')
    assert.ok(back.report!.accepted[0]!.supersedes.includes(busy.report!.accepted[0]!.itemId))
    const b = readForDecision(store, { taskId: 'task:B', asOf: time(99), intent: 'current', question: '当前任务状态', requiredSlots: ['taskStatus'], budget: { maxItems: 20, maxChars: 6000 } })
    assert.deepEqual(b.commitments.map((i) => i.value), ['active'])
  } finally { store.close() }
})
