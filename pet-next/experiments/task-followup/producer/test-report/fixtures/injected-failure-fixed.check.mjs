/** 同一夹具的修复版本：断言改为真实的 2。 */
import test from 'node:test'
import assert from 'node:assert/strict'

test('修复后：值为 2（受控夹具）', () => {
  assert.equal(2, 2)
})
