#!/usr/bin/env node
/**
 * R6-C 真实测试报告接入：把 Node 内建 JUnit reporter 的产物导入为既有
 * `pet-followup-result/v1`，并保留原始报告、命令、退出码与时间。
 *
 * 规则（见 CONTRACT/C.txt）：
 * - XML 解析用成熟库 fast-xml-parser（独立 tooling，记录版本/许可证），不手写 regex 解析器。
 * - 解析失败、报告不完整（无 testcase）、进程退出码非 0 且报告声称全通过，都不算“全通过”。
 * - skipped 单列，不凑进 passed；失败/错误分别计数后合并为 failed。
 * - 同一来源、同一输入字节重复导入：沿用 revision 并重写完全相同字节，不制造新修订。
 * - 每个来源独立 SHA 与 revision；两个来源的条件由 two-source-demo.mjs 组合，不混合计数。
 *
 * 用法：
 *   node import-test-report.mjs --report <junit.xml> --out <结果目录> [--source <来源ID>]
 *        [--experiment <名称>] [--command <实际命令>] [--exit-code <N>]
 *        [--started-at <iso>] [--finished-at <iso>] [--workspace <宿主工作区>]
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RESULT_SCHEMA = 'pet-followup-result/v1'
export const REPORT_SCHEMA = 'pet-followup-junit-report/v1'
const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLING = join(HERE, 'test-report', 'tooling')

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function loadParser() {
  const req = createRequire(join(TOOLING, 'package.json'))
  try {
    const { XMLParser } = req('fast-xml-parser')
    return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseAttributeValue: false, parseTagValue: false, trimValues: true })
  } catch (error) {
    throw new Error(`xml_parser_unavailable: 在 ${TOOLING} 运行 npm install（${error.message}）`)
  }
}

const asArray = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value])

/** 从 JUnit DOM 里收集 testcase（兼容 testsuites/testsuite 两种根，以及嵌套 suite）。 */
export function collectCases(parsed) {
  const cases = []
  const visitSuite = (suite) => {
    if (!suite || typeof suite !== 'object') return
    for (const test of asArray(suite.testcase)) {
      const failures = asArray(test.failure)
      const errors = asArray(test.error)
      const skipped = asArray(test.skipped)
      const state = failures.length > 0 || errors.length > 0 ? 'failed' : skipped.length > 0 ? 'skipped' : 'passed'
      const message = [...failures, ...errors, ...skipped]
        .map((n) => (typeof n === 'object' && n !== null ? String(n['@_message'] ?? n['#text'] ?? '') : String(n ?? '')))
        .filter(Boolean)
        .join(' | ')
      cases.push({
        name: String(test['@_name'] ?? '(unnamed)'),
        classname: String(test['@_classname'] ?? ''),
        time: Number(test['@_time'] ?? 0),
        state,
        ...(message ? { message: message.slice(0, 500) } : {}),
      })
    }
    for (const child of asArray(suite.testsuite)) visitSuite(child)
  }
  const root = parsed?.testsuites ?? parsed?.testsuite ? parsed : null
  if (!root) return cases
  if (parsed.testsuites) {
    for (const suite of asArray(parsed.testsuites.testsuite)) visitSuite(suite)
    // 只有根 testsuites 没有子 suite 时，testcase 可能直接挂在根上
    for (const test of asArray(parsed.testsuites.testcase)) visitSuite({ testcase: test })
  } else {
    visitSuite(parsed.testsuite)
  }
  return cases
}

/**
 * 导入一份 JUnit 报告。纯函数化（除落盘），测试直接调用。
 * @returns {{ resultPath: string, resultSha: string, artifactPath: string, revision: number, status: string, counts: object }}
 */
export function importTestReport(options) {
  const reportAbs = resolve(options.report)
  const outAbs = resolve(options.out)
  const source = options.source ?? basename(outAbs)
  const experimentId = options.experiment ?? source
  const command = options.command ?? null
  const exitCode = options.exitCode ?? null
  const startedAt = options.startedAt ?? null
  const finishedAt = options.finishedAt ?? null

  const raw = existsSync(reportAbs) ? readFileSync(reportAbs) : null
  const reportSha = raw ? sha256(raw) : null
  let cases = []
  let parseError = null
  if (!raw) parseError = 'report_missing'
  else if (raw.length === 0) parseError = 'report_empty'
  else {
    try {
      cases = collectCases(loadParser().parse(raw.toString('utf8')))
      if (cases.length === 0) parseError = 'report_incomplete:no_testcase'
    } catch (error) {
      parseError = `parse_error:${error.message}`
    }
  }

  const failed = cases.filter((c) => c.state === 'failed').length
  const skipped = cases.filter((c) => c.state === 'skipped').length
  const passed = cases.filter((c) => c.state === 'passed').length
  const total = cases.length
  const exitMismatch = !parseError && exitCode !== null && exitCode !== 0 && failed === 0
  const status = parseError || exitMismatch || failed > 0 ? 'failed' : skipped > 0 ? 'partial' : 'succeeded'

  // 同一来源的 revision：输入 SHA 不变则沿用（重写相同字节），变了才 +1。
  mkdirSync(outAbs, { recursive: true })
  const statePath = join(outAbs, 'import-state.json')
  let revision = 1
  let previous = null
  if (existsSync(statePath)) {
    previous = JSON.parse(readFileSync(statePath, 'utf8'))
    revision = previous.inputSha === reportSha ? Number(previous.revision) : Number(previous.revision) + 1
  }

  const artifactName = `junit-r${revision}.json`
  const artifactAbs = join(outAbs, artifactName)
  const artifact = {
    schema: REPORT_SCHEMA,
    source,
    command,
    exitCode,
    startedAt,
    finishedAt,
    reportFile: basename(reportAbs),
    reportSha256: reportSha,
    parseError,
    counts: { total, passed, failed, skipped },
    tests: cases,
  }
  const artifactBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  const writeAtomic = (path, bytes) => {
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, bytes)
    renameSync(tmp, path)
  }
  writeAtomic(artifactAbs, artifactBytes)

  const workspace = options.workspace ? resolve(options.workspace) : null
  const artifactRel = workspace ? relative(workspace, artifactAbs).split('\\').join('/') : artifactAbs
  if (workspace && (artifactRel.startsWith('..') || isAbsolute(artifactRel))) throw new Error(`输出目录不在宿主工作区内：${outAbs}`)
  const result = {
    schema: RESULT_SCHEMA,
    experimentId,
    runId: source,
    revision,
    status,
    metrics: { total, passed, failed, score: total - skipped > 0 ? passed / (total - skipped) : null },
    artifactPath: artifactRel,
    artifactSha: sha256(artifactBytes),
    note: parseError
      ? `import-test-report: ${parseError}，不能当作全通过`
      : exitMismatch
        ? `import-test-report: 进程退出码 ${exitCode} 与报告全通过不一致，按失败处理`
        : `import-test-report ${basename(reportAbs)} r${revision}: ${failed}/${total} failed, ${skipped} skipped`,
    input: { file: basename(reportAbs), sha256: reportSha },
    skipped,
    evidence: { command, exitCode, startedAt, finishedAt, reportSha256: reportSha, parseError },
    tests: cases.map((c) => ({ name: c.name, classname: c.classname, state: c.state, time: c.time })),
  }
  const body = Buffer.from(`${JSON.stringify(result, null, 2)}\n`, 'utf8')
  const resultPath = join(outAbs, 'result.json')
  writeAtomic(resultPath, body)
  writeFileSync(statePath, JSON.stringify({ revision, inputSha: reportSha, source, updatedAt: new Date().toISOString() }, null, 2))
  return {
    resultPath, resultSha: sha256(body), artifactPath: artifactAbs, revision, status,
    counts: { total, passed, failed, skipped },
    sameAsPrevious: previous?.inputSha === reportSha,
  }
}

function parseArgs(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key?.startsWith('--')) continue
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) args.set(key.slice(2), 'true')
    else { args.set(key.slice(2), next); i += 1 }
  }
  return args
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.get('report') || !args.get('out')) {
    console.error('usage: node import-test-report.mjs --report <junit.xml> --out <dir> [--source <id>] [--experiment <name>] [--command <cmd>] [--exit-code <n>] [--started-at <iso>] [--finished-at <iso>] [--workspace <dir>]')
    process.exit(2)
  }
  const exitCodeRaw = args.get('exit-code')
  const out = importTestReport({
    report: args.get('report'),
    out: args.get('out'),
    source: args.get('source') ?? undefined,
    experiment: args.get('experiment') ?? undefined,
    command: args.get('command') ?? undefined,
    exitCode: exitCodeRaw === undefined ? undefined : Number(exitCodeRaw),
    startedAt: args.get('started-at') ?? undefined,
    finishedAt: args.get('finished-at') ?? undefined,
    workspace: args.get('workspace') ?? undefined,
  })
  console.log(JSON.stringify(out, null, 2))
  process.exit(out.status === 'succeeded' || out.status === 'partial' ? 0 : 1)
}
