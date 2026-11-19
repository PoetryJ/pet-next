import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDependencyEdit } from '../service/dependency-correction.ts'
const primary = { taskId: 'primary', names: ['主测试', 'A'] }
const deps = [{ alias: 'B 报告', taskId: 'build' }, { alias: '性能报告', taskId: 'perf' }]
const resolve = (s: string) => resolveDependencyEdit(s, primary, deps)
test('explicit edits resolve registered sources; retain unmentioned bindings on removal', () => {
  assert.deepEqual(resolve('更正：B 那份不用等了，只等 A 的报告就问我。')?.bindings, [])
  assert.deepEqual(resolve('别等 B 报告了。')?.bindings, [deps[1]])
  assert.deepEqual(resolve('只等性能报告。')?.bindings, [deps[1]])
  // “B 失败也不用问我”与“不用等 B”同义：B 不再影响是否打扰。
  assert.deepEqual(resolve('更正：B 那份报告失败也不用问我，只有 A 失败才需要来问我。')?.bindings, [deps[1]])
  assert.deepEqual(resolve('B 报告失败也不用管。')?.bindings, [deps[1]])
})
test('unknown, conflicting, ambiguous, quoted and hypothetical edits preserve all inputs', () => {
  for (const text of ['只等 Z 的报告就问我。', '如果只等 A 会怎样？', '他说“只等 A”。', '只等 A 吗？', '只等 B，但性能报告仍然需要。', '只等 B，别等 B。', '不用等 A。', '只等性。']) {
    assert.equal(resolve(text), null, text)
  }
  assert.equal(resolveDependencyEdit('只等 A。', primary, [{ alias: 'A 报告', taskId: 'another' }]), null)
})
