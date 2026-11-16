/**
 * C 臂自测：JUnit 报告导入的计数、失败可见性、修订号与来源隔离。
 * 用固定 XML 夹具，不跑模型；真实两来源演示见 producer/test-report/two-source-demo.mjs。
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importTestReport, collectCases } from '../producer/import-test-report.mjs'
import { XMLParser } from '../producer/test-report/tooling/node_modules/fast-xml-parser/src/fxp.js'

const dir = () => mkdtempSync(join(tmpdir(), 'r6-junit-'))

const xml = (body: string) => `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>${body}</testsuites>\n`
const suite = (cases: string, attrs = '') => `<testsuite name="s" tests="3" failures="1" errors="0" skipped="1" time="0.3"${attrs}>${cases}</testsuite>`

const MIXED = xml(suite(`
  <testcase name="通过项" classname="tests/a" time="0.01"/>
  <testcase name="失败项" classname="tests/b" time="0.02"><failure message="expected 1 got 2">stack</failure></testcase>
  <testcase name="跳过项" classname="tests/c" time="0"><skipped message="not on this OS"/></testcase>
`))
const ALL_PASS = xml(`<testsuite name="s" tests="2" failures="0" errors="0" skipped="0" time="0.1">
  <testcase name="a" classname="x" time="0.01"/><testcase name="b" classname="x" time="0.01"/>
</testsuite>`)

test('混合报告：失败可见、skipped 单列、不当成全通过', () => {
  const root = dir()
  const report = join(root, 'junit.xml')
  writeFileSync(report, MIXED)
  const out = importTestReport({ report, out: join(root, 'out'), source: 'main-tests', command: 'node --test', exitCode: 1, startedAt: 'A', finishedAt: 'B' })
  assert.equal(out.counts.total, 3)
  assert.equal(out.counts.passed, 1)
  assert.equal(out.counts.failed, 1)
  assert.equal(out.counts.skipped, 1)
  assert.equal(out.status, 'failed')
  const result = JSON.parse(readFileSync(out.resultPath, 'utf8'))
  assert.equal(result.schema, 'pet-followup-result/v1')
  assert.equal(result.skipped, 1)
  assert.equal(result.metrics.passed, 1)
  assert.equal(result.metrics.failed, 1)
  assert.equal(result.input.sha256.length, 64)
  assert.equal(result.evidence.command, 'node --test')
  assert.equal(result.evidence.exitCode, 1)
  assert.ok(result.artifactSha.length === 64)
})

test('全通过 + 退出码 0 → succeeded；退出码与报告不一致 → 按失败处理', () => {
  const root = dir()
  const report = join(root, 'junit.xml')
  writeFileSync(report, ALL_PASS)
  const ok = importTestReport({ report, out: join(root, 'ok'), exitCode: 0 })
  assert.equal(ok.status, 'succeeded')
  assert.equal(ok.counts.failed, 0)
  const mismatch = importTestReport({ report, out: join(root, 'mismatch'), exitCode: 1 })
  assert.equal(mismatch.status, 'failed')
  const result = JSON.parse(readFileSync(mismatch.resultPath, 'utf8'))
  assert.match(result.note, /退出码/)
})

test('解析失败/报告不完整/文件缺失都不能当全通过', () => {
  const root = dir()
  const empty = join(root, 'empty.xml')
  writeFileSync(empty, '')
  const emptyOut = importTestReport({ report: empty, out: join(root, 'e'), exitCode: 0 })
  assert.equal(emptyOut.status, 'failed')
  assert.equal(emptyOut.counts.passed, 0)

  const junk = join(root, 'junk.xml')
  writeFileSync(junk, 'not xml at all <<<')
  const junkOut = importTestReport({ report: junk, out: join(root, 'j'), exitCode: 0 })
  assert.equal(junkOut.status, 'failed')
  assert.equal(junkOut.counts.total, 0)

  const missing = importTestReport({ report: join(root, 'nope.xml'), out: join(root, 'm'), exitCode: 0 })
  assert.equal(missing.status, 'failed')
  const missingResult = JSON.parse(readFileSync(missing.resultPath, 'utf8'))
  assert.equal(missingResult.evidence.parseError, 'report_missing')
})

test('同一字节重复导入不造新修订；字节变化才 +1', () => {
  const root = dir()
  const report = join(root, 'junit.xml')
  const outDir = join(root, 'out')
  writeFileSync(report, ALL_PASS)
  const first = importTestReport({ report, out: outDir, exitCode: 0 })
  const firstBytes = readFileSync(first.resultPath, 'utf8')
  const second = importTestReport({ report, out: outDir, exitCode: 0 })
  assert.equal(second.revision, first.revision)
  assert.equal(second.resultSha, first.resultSha)
  assert.equal(readFileSync(second.resultPath, 'utf8'), firstBytes)

  writeFileSync(report, MIXED)
  const third = importTestReport({ report, out: outDir, exitCode: 1 })
  assert.equal(third.revision, first.revision + 1)
  assert.notEqual(third.resultSha, first.resultSha)
})

test('两个来源各自独立 SHA/revision，不合并计数', () => {
  const root = dir()
  const a = join(root, 'a.xml')
  const b = join(root, 'b.xml')
  writeFileSync(a, ALL_PASS)
  writeFileSync(b, MIXED)
  const ra = importTestReport({ report: a, out: join(root, 'a'), source: 'main-tests', exitCode: 0 })
  const rb = importTestReport({ report: b, out: join(root, 'b'), source: 'cn-path-check', exitCode: 1 })
  const ja = JSON.parse(readFileSync(ra.resultPath, 'utf8'))
  const jb = JSON.parse(readFileSync(rb.resultPath, 'utf8'))
  assert.equal(ja.runId, 'main-tests')
  assert.equal(jb.runId, 'cn-path-check')
  assert.notEqual(ja.input.sha256, jb.input.sha256)
  assert.equal(ja.metrics.total, 2)
  assert.equal(jb.metrics.total, 3)
  assert.equal(ra.revision, 1)
  assert.equal(rb.revision, 1)
})

test('解析器本体：嵌套 suite 与 errors 也计入失败', () => {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true })
  const parsed = parser.parse(xml(`<testsuite name="outer"><testsuite name="inner"><testcase name="x"><error message="boom"/></testcase></testsuite></testsuite>`))
  const cases = collectCases(parsed)
  assert.equal(cases.length, 1)
  assert.equal(cases[0]!.state, 'failed')
  assert.match(cases[0]!.message ?? '', /boom/)
})
