/** 受控失败夹具（明确标注：不是产品缺陷，只用来演示“失败→修复→新修订”链路）。 */
import test from 'node:test'
import assert from 'node:assert/strict'

test('注入失败：期望 1 得到 2（受控夹具）', () => {
  assert.equal(2, 1)
})
