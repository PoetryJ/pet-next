/**
 * 独立来源的“真实失败”JUnit 用例：R7 需要一份确定性失败的 CI 报告。
 * 不是 mock 报告：由 Node 自带 test runner 实际执行并生成 junit.xml（exit 1）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

test('CI 回归：失败样本必须被报告为 failed', () => {
  const observed = { total: 3, failed: 1 }
  assert.equal(observed.failed, 0, '故意失败：用于验证“失败时才询问是否分析”')
})
