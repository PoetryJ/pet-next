import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FOLLOWUP_ATTRIBUTES, resolveKey, timeLike } from '../memory/attributes.ts'
import { extractPending } from '../memory/extract.ts'
import { readForDecision } from '../memory/read.ts'
import { CapabilityMemoryStore } from '../memory/store.ts'
import type { Turn } from '../memory/types.ts'
import { FixtureClient } from './fixture-model.ts'

const asOf = '2026-11-13T12:00:00+08:00'
const scope = { level: 'task', id: 'task:A' }
const slots = ['runTarget', 'sampleCount', 'baselineVersion', 'experimentId']
const turn = (id: string, seq: number, text: string, taskId = 'task:A'): Turn => ({
  turnId: id, sessionId: `session-${seq}`, seq, at: `2026-11-13T09:${String(seq).padStart(2, '0')}:00+08:00`,
  role: 'user', text, taskIds: [taskId],
})
const item = (source: Turn, key: string, value: string | number, quote: string, extra: Record<string, unknown> = {}) => {
  const start = source.text.indexOf(quote)
  assert.ok(start >= 0, 'fixture evidence must be verbatim')
  return {
    kind: FOLLOWUP_ATTRIBUTES.find((x) => x.id === resolveKey(key).attribute)?.kind ?? 'commitment',
    key, value, statement: `${key}: ${value}`, scope: { ...scope, id: source.taskIds[0] },
    validFrom: source.at, validUntil: null, supersedes: [], confidence: 1, status: 'active',
    quotes: [{ turnId: source.turnId, start, end: start + quote.length, text: quote }], ...extra,
  }
}
async function extract(store: CapabilityMemoryStore, source: Turn, items: Record<string, unknown>[]) {
  store.appendTurn(source)
  const result = await extractPending(store, new FixtureClient(() => JSON.stringify({ items })), { entities: [], now: source.at })
  assert.equal(result.status, 'applied')
  assert.deepEqual(result.report!.rejected, [])
  return result.report!
}
const read = (store: CapabilityMemoryStore, requiredSlots = slots, taskId = 'task:A') => readForDecision(store, {
  taskId, asOf, intent: 'current', question: '本任务当前范围、样本数、基线版本和实验编号是什么？', requiredSlots,
  budget: { maxItems: 30, maxChars: 20000 },
})
const values = (store: CapabilityMemoryStore, taskId = 'task:A') => Object.fromEntries(read(store, slots, taskId).commitments.map((x) => [x.key, x.value]))

test('属性和历史别名分别指向数量、版本、实验标识；显式 other 保持未映射', () => {
  const groups: Record<string, string[]> = {
    runTarget: ['runTarget', 'targetSpec', 'targetDescription'],
    sampleCount: ['sampleCount', 'sample_count', 'sampleSize', 'numSamples'],
    baselineVersion: ['baselineVersion', 'baseline', 'config', 'configVersion', 'version'],
    experimentId: ['experimentId', 'experiment', 'experimentCode'],
  }
  for (const [attribute, names] of Object.entries(groups)) for (const name of names) assert.equal(resolveKey(name).attribute, attribute, name)
  for (const name of ['other.deadline', 'other.decisionDeadline', 'other.eta', 'other.sampleCount']) {
    assert.equal(resolveKey(name).attribute, null, name)
    assert.equal(resolveKey(name).via, 'unmapped', name)
  }
})

test('真实抽取和读取同时保留四个独立属性，不产生虚假冲突', async () => {
  const store = new CapabilityMemoryStore(':memory:')
  try {
    const source = turn('initial', 1, '跟进本地回归测试，实验编号是 E-LANTERN，采用基线 v1，总共 48 个样本。')
    await extract(store, source, [
      item(source, 'targetSpec', 'local_regression_suite', '本地回归测试'),
      item(source, 'sampleCount', 48, '48 个样本'),
      item(source, 'baselineVersion', 'v1', '基线 v1'),
      item(source, 'experimentId', 'E-LANTERN', '实验编号是 E-LANTERN'),
    ])
    assert.deepEqual(values(store), { runTarget: 'local_regression_suite', sampleCount: 48, baselineVersion: 'v1', experimentId: 'E-LANTERN' })
    const packet = read(store)
    assert.deepEqual(packet.conflicts, [])
    assert.deepEqual(packet.missing, [])
    assert.ok(packet.context.slotResolution.every((s) => s.status === 'satisfied' && s.itemIds.length === 1))
  } finally { store.close() }
})

test('数量和基线分别改口，只替换自身旧值；范围、实验标识、其他任务保持有效', async () => {
  const store = new CapabilityMemoryStore(':memory:')
  try {
    const first = turn('initial', 1, '跟进本地回归测试，实验编号 E-LANTERN，基线 v1，48 个样本。')
    await extract(store, first, [
      item(first, 'runTarget', 'local_regression_suite', '本地回归测试'),
      item(first, 'sampleCount', 48, '48 个样本'),
      item(first, 'baselineVersion', 'v1', '基线 v1'),
      item(first, 'experimentId', 'E-LANTERN', '实验编号 E-LANTERN'),
    ])
    const other = turn('other', 2, '另一个海报任务仍然用基线 v1，做 8 个样本。', 'task:B')
    await extract(store, other, [item(other, 'sampleCount', 8, '8 个样本'), item(other, 'baselineVersion', 'v1', '基线 v1')])
    const old = Object.fromEntries(store.items().filter((x) => x.scope.id === 'task:A').map((x) => [x.key, x.itemId]))
    const update = turn('correction', 3, '回归测试样本改为 64 个，基线改用 v2；实验编号和跟进对象都不变。')
    await extract(store, update, [
      item(update, 'sampleCount', 64, '样本改为 64 个', { supersedes: [old.sampleCount] }),
      item(update, 'baselineVersion', 'v2', '基线改用 v2', { supersedes: [old.baselineVersion] }),
    ])
    assert.deepEqual(values(store), { runTarget: 'local_regression_suite', experimentId: 'E-LANTERN', sampleCount: 64, baselineVersion: 'v2' })
    assert.deepEqual(values(store, 'task:B'), { sampleCount: 8, baselineVersion: 'v1' })
    const packet = read(store)
    assert.deepEqual(packet.conflicts, [])
    assert.deepEqual(new Set(packet.context.nonActionable.map((x) => `${x.key}:${x.value}:${x.status}`)), new Set(['sampleCount:48:superseded', 'baselineVersion:v1:superseded']))
    assert.ok(packet.commitments.filter((x) => ['runTarget', 'experimentId'].includes(x.key)).every((x) => x.status === 'active' && x.supersededBy.length === 0))
  } finally { store.close() }
})

test('模型错误跨属性 supersedes 不会让样本数或实验标识失效', async () => {
  const store = new CapabilityMemoryStore(':memory:')
  try {
    const first = turn('initial', 1, '实验 E-LANTERN 使用基线 v1，固定 64 个样本。')
    await extract(store, first, [item(first, 'sampleCount', 64, '64 个样本'), item(first, 'baselineVersion', 'v1', '基线 v1'), item(first, 'experimentId', 'E-LANTERN', '实验 E-LANTERN')])
    const old = Object.fromEntries(store.items().map((x) => [x.key, x.itemId]))
    const update = turn('correction', 2, '只把基线改为 v2，样本数和实验编号都保持。')
    const report = await extract(store, update, [item(update, 'baselineVersion', 'v2', '基线改为 v2', { supersedes: [old.baselineVersion, old.sampleCount, old.experimentId] })])
    assert.deepEqual(report.accepted[0]!.supersedes, [old.baselineVersion])
    assert.equal(report.accepted[0]!.checks.filter((x) => x.startsWith('supersede_key_mismatch_ignored')).length, 2)
    assert.deepEqual(values(store), { sampleCount: 64, experimentId: 'E-LANTERN', baselineVersion: 'v2' })
    assert.deepEqual(read(store).conflicts, [])
  } finally { store.close() }
})

test('已有样本数不能假装已经提供了基线版本或实验标识', async () => {
  const store = new CapabilityMemoryStore(':memory:')
  try {
    const source = turn('count-only', 1, '这个任务使用 64 个样本。')
    await extract(store, source, [item(source, 'sampleCount', 64, '64 个样本')])
    const packet = read(store, ['sampleCount', 'baselineVersion', 'experimentId'])
    assert.deepEqual(packet.context.slotResolution.map((x) => [x.slot, x.status]), [['sampleCount', 'satisfied'], ['baselineVersion', 'missing'], ['experimentId', 'missing']])
  } finally { store.close() }
})

test('时间槽只接受自身为带时区的有效 ISO 时间戳，validUntil 和原话不能兜底', () => {
  for (const value of ['2026-11-13T18:30:00+08:00', '2026-11-13T10:30Z', '2028-02-29T00:00:00.123Z', '2026-11-13T10:30:00-04:00']) {
    assert.equal(timeLike(value, null, []), true, value)
  }
  for (const value of ['soon', '18:30', '明天下班前', '2026-11-13', '2026-11-13T18:30:00', '2026-02-29T18:30:00Z', '2026-04-31T18:30:00Z', '2026-11-13T24:00:00Z', '2026-11-13T18:60:00Z', '2026-11-13T18:30:60Z', '2026-11-13T18:30:00+08:99', 'prefix2026-11-13T18:30:00Z', '2026-11-13T18:30:00Z suffix', 123, null]) {
    assert.equal(timeLike(value, '2026-11-13T19:00:00+08:00', ['今天 18:30 前给我结果，明天继续。']), false, String(value))
  }
})

test('无效时间经过抽取降级后仍不能重新满足 deadline/eta；有效时间可同时存在', async () => {
  const store = new CapabilityMemoryStore(':memory:')
  try {
    const source = turn('ambiguous-time', 1, '今天 18:30 之前给我结论，下一份结果大概等一小时。')
    const report = await extract(store, source, [
      item(source, 'deadline', 'soon', '今天 18:30 之前给我结论', { validUntil: '2026-11-13T19:00:00+08:00' }),
      item(source, 'eta', 'one_hour', '下一份结果大概等一小时'),
    ])
    assert.deepEqual(report.accepted.map((x) => x.key), ['other.deadline', 'other.eta'])
    assert.ok(read(store, ['decisionDeadline', 'expectedUpdateAt']).context.slotResolution.every((x) => x.status !== 'satisfied'))
    const explicit = turn('explicit-time', 2, '明确一下：结论截止 2026-11-13T18:30:00+08:00，更正结果预计 2026-11-13T17:00:00+08:00 到。')
    await extract(store, explicit, [
      item(explicit, 'deadline', '2026-11-13T18:30:00+08:00', '结论截止 2026-11-13T18:30:00+08:00'),
      item(explicit, 'eta', '2026-11-13T17:00:00+08:00', '更正结果预计 2026-11-13T17:00:00+08:00'),
    ])
    const packet = read(store, ['decisionDeadline', 'expectedUpdateAt'])
    assert.ok(packet.context.slotResolution.every((x) => x.status === 'satisfied' && x.itemIds.length === 1))
    assert.deepEqual(packet.conflicts, [])
    assert.equal(packet.commitments.find((x) => x.key === 'decisionDeadline')!.value, '2026-11-13T18:30:00+08:00')
    assert.equal(packet.currentFacts.find((x) => x.key === 'expectedUpdateAt')!.value, '2026-11-13T17:00:00+08:00')
  } finally { store.close() }
})
