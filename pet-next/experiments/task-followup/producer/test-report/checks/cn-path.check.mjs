/**
 * 独立来源 #2：中文 + 空格路径下的生产者往返检查（真实文件系统，不 mock）。
 * 只用既有 producer/run-tests.mjs，不新增运行时路径逻辑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { produce } from '../../run-tests.mjs'

const root = () => mkdtempSync(join(tmpdir(), '宠物 结果 R6-'))

test('中文/空格路径：生产者写入、修订号与 SHA 往返一致', () => {
  const base = root()
  try {
    const input = join(base, '输入 样本.csv')
    writeFileSync(input, 'id,expression,expected\nc1,1+1,2\nc2,2*3,6\n', 'utf8')
    const out = join(base, '结果 目录')
    mkdirSync(out, { recursive: true })
    const first = produce({ input, out, experiment: '中文路径检查' })
    assert.equal(first.status, 'succeeded')
    assert.equal(first.total, 2)
    const body = JSON.parse(readFileSync(first.resultPath, 'utf8'))
    assert.equal(body.metrics.passed, 2)
    assert.equal(body.runId, 'local-tests')
    // 同一输入重复生产 → 不制造新修订、重写相同字节
    const again = produce({ input, out, experiment: '中文路径检查' })
    assert.equal(again.revision, first.revision)
    assert.equal(again.resultSha, first.resultSha)
    assert.equal(readFileSync(again.resultPath, 'utf8'), readFileSync(first.resultPath, 'utf8'))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
