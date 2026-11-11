import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES_DIR, GOLD_DIR, EXPERIMENT_ROOT } from '../paths.ts'

test('冻结 16 条轨迹，dev/heldout 各 8 条', () => {
  const files = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith('.json'))
  assert.equal(files.length, 16)
  const trajectories = files.map((name) => JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8')))
  assert.equal(trajectories.filter((item) => item.group === 'dev').length, 8)
  assert.equal(trajectories.filter((item) => item.group === 'heldout').length, 8)
  for (const item of trajectories) {
    const variants = item.variants ?? [{ id: 'a', steps: item.steps }]
    assert.ok(variants.length >= 1)
    for (const variant of variants) {
      assert.ok(variant.steps.length >= 1)
      assert.ok(!JSON.stringify(variant.steps).includes('expected'))
      assert.ok(!JSON.stringify(variant.steps).includes('gold'))
    }
  }
})

test('gold 覆盖所有轨迹与变体', () => {
  const files = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith('.json'))
  for (const name of files) {
    const trajectory = JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'))
    const gold = JSON.parse(readFileSync(join(GOLD_DIR, name), 'utf8'))
    assert.equal(gold.trajectoryId, trajectory.id)
    const variants = trajectory.variants ?? [{ id: 'a' }]
    for (const variant of variants) {
      const expected = gold.variants[variant.id]
      assert.ok(expected, `${trajectory.id}/${variant.id} missing gold`)
      assert.equal(typeof expected.mustComplete, 'boolean')
      assert.ok(Array.isArray(expected.requiredDecisions))
      assert.ok(expected.maxNotifications >= expected.requiredDecisions.length || expected.requiredDecisions.length === 0)
    }
  }
})

test('决策规则不读取 scenarioId / gold / 预期分数', () => {
  const source = readFileSync(join(EXPERIMENT_ROOT, 'decision', 'rules.ts'), 'utf8')
  for (const forbidden of ['scenarioId', 'trajectoryId', 'gold', 'expected', 'fixture']) {
    assert.equal(source.includes(forbidden), false, `decision/rules.ts must not reference ${forbidden}`)
  }
})
