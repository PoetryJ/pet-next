#!/usr/bin/env node
/**
 * 两份独立报告构成一个条件：主测试与中文路径检查都回来（且都没有失败）才需要用户确认。
 *
 * - 每个来源独立导入、独立 SHA 与 revision；不把两个来源的计数合并成一份。
 * - 条件求值用 R6 冻结内核（capability/conditions/kernel.ts），这里只构造事实与绑定。
 *
 * 用法：node two-source-demo.mjs --out <演示目录>
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importTestReport } from '../import-test-report.mjs'
import { runJunit } from './run-junit.mjs'
import { evaluate } from '../../capability/conditions/kernel.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

const fact = (source, rev, sha, value) => ({
  value,
  binding: { sourceId: `result:${source}`, version: String(rev), sha256: sha },
  observedAt: new Date().toISOString(),
})

export function importSource(outDir, source, invocation, reportFile) {
  return importTestReport({
    report: join(reportFile),
    out: outDir,
    source,
    experiment: source,
    command: invocation.command,
    exitCode: invocation.exitCode,
    startedAt: invocation.startedAt,
    finishedAt: invocation.finishedAt,
  })
}

export function main(outRoot = join(HERE, 'out')) {
  const root = resolve(outRoot)
  mkdirSync(root, { recursive: true })
  const sources = [
    { id: 'main-tests', cases: undefined },
    { id: 'cn-path-check', cases: [join(HERE, 'checks', 'cn-path.check.mjs')] },
  ]
  const imported = sources.map((s) => {
    const dir = join(root, s.id)
    const invocation = runJunit({ out: dir, source: s.id, cases: s.cases })
    const result = importSource(dir, s.id, invocation, join(dir, 'junit.xml'))
    return { id: s.id, dir, invocation, result }
  })

  const facts = {}
  const bindings = {}
  for (const item of imported) {
    const sha = JSON.parse(readFileSync(item.result.resultPath, 'utf8')).input.sha256
    bindings[`result:${item.id}`] = { sourceId: `result:${item.id}`, version: String(item.result.revision), sha256: sha }
    facts[`source:${item.id}.present`] = fact(item.id, item.result.revision, sha, true)
    facts[`source:${item.id}.failed`] = fact(item.id, item.result.revision, sha, item.result.counts.failed)
    facts[`source:${item.id}.revision`] = fact(item.id, item.result.revision, sha, item.result.revision)
  }
  const condition = {
    op: 'all',
    args: [
      { op: 'cmp', fact: 'source:main-tests.present', rel: 'eq', value: true },
      { op: 'cmp', fact: 'source:cn-path-check.present', rel: 'eq', value: true },
      { op: 'cmp', fact: 'source:main-tests.failed', rel: 'eq', value: 0 },
      { op: 'cmp', fact: 'source:cn-path-check.failed', rel: 'eq', value: 0 },
    ],
  }
  const allowedFacts = Object.keys(facts)
  const evaluation = evaluate(condition, { now: new Date().toISOString(), allowedFacts, facts, currentBindings: bindings })
  const summary = {
    schema: 'pet-two-source-demo/v1',
    sources: imported.map((i) => ({
      source: i.id, status: i.result.status, revision: i.result.revision,
      counts: i.result.counts, resultSha: i.result.resultSha, reportSha256: JSON.parse(readFileSync(i.result.resultPath, 'utf8')).input.sha256,
    })),
    perSourceCountsAreSeparate: imported.length === 2 && imported[0].result.counts !== imported[1].result.counts,
    condition,
    evaluation: { state: evaluation.state, watch: evaluation.watch, reads: evaluation.reads },
    conclusion: evaluation.state === 'true'
      ? '两份独立报告都到齐且无失败：可以按条件询问用户是否继续'
      : evaluation.state === 'false'
        ? '条件未满足：继续有界等待，不打扰'
        : '缺证据：不转成提问',
  }
  console.log(JSON.stringify(summary, null, 2))
  return summary
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const outIdx = process.argv.indexOf('--out')
  const summary = main(outIdx >= 0 ? process.argv[outIdx + 1] : undefined)
  process.exit(summary.evaluation.state === 'true' ? 0 : 1)
}
