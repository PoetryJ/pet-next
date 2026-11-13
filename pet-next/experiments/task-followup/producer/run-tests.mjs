#!/usr/bin/env node
/**
 * final-demo 真实本地工作生产者：读取用户可修改的测试样本（CSV 或 JSON），逐条实际计算并校验，
 * 输出跟进宿主已支持的 pet-followup-result/v1 result.json 与一份逐条明细产物。
 *
 * - 结果完全由输入计算：每条样本是一个算术表达式与期望值，生产者用受限解析器（只支持数字、
 *   + - * / 与括号，不用 eval）求值并比较；无法解析/期望值不是数字/不相等都会记为失败并标注原因。
 * - 同一输出目录是同一个来源（runId 固定）：输入内容变化时 revision+1；输入不变时重写完全相同的字节
 *   （宿主按 SHA 去重，用来演示“重复保存”）。
 * - 只写输出目录；result.json 用临时文件 + rename 原子落盘。不联网、不调模型、不执行任意命令。
 *
 * 用法：
 *   node run-tests.mjs --input <samples.csv|samples.json> --out <结果目录> [--workspace <宿主工作区>]
 *                      [--experiment <名称>] [--delay-ms <模拟运行时长>]
 * CSV 列：id,expression,expected（首行表头；# 开头为注释）。
 * JSON：[{ "id": "...", "expression": "...", "expected": 4 }, ...]
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'

export const RESULT_SCHEMA = 'pet-followup-result/v1'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseArgs(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args.set(token.slice(2), next)
      i += 1
    } else args.set(token.slice(2), 'true')
  }
  return args
}

/** 受限算术求值：数字、+ - * /、一元负号、括号。返回 { ok, value } 或 { ok:false, error }。 */
export function evaluate(expression) {
  const text = String(expression ?? '')
  let pos = 0
  const peek = () => {
    while (pos < text.length && /\s/.test(text[pos])) pos += 1
    return text[pos]
  }
  const fail = (message) => {
    throw new Error(`${message} at ${pos}`)
  }
  const number = () => {
    peek()
    const match = /^\d+(\.\d+)?/.exec(text.slice(pos))
    if (!match) fail(`unexpected ${text[pos] === undefined ? 'end' : `'${text[pos]}'`}`)
    pos += match[0].length
    return Number(match[0])
  }
  const factor = () => {
    const ch = peek()
    if (ch === '-') {
      pos += 1
      return -factor()
    }
    if (ch === '(') {
      pos += 1
      const value = expr()
      if (peek() !== ')') fail("missing ')'")
      pos += 1
      return value
    }
    return number()
  }
  const term = () => {
    let value = factor()
    for (;;) {
      const ch = peek()
      if (ch === '*') {
        pos += 1
        value *= factor()
      } else if (ch === '/') {
        pos += 1
        const divisor = factor()
        if (divisor === 0) fail('division by zero')
        value /= divisor
      } else return value
    }
  }
  const expr = () => {
    let value = term()
    for (;;) {
      const ch = peek()
      if (ch === '+') {
        pos += 1
        value += term()
      } else if (ch === '-') {
        pos += 1
        value -= term()
      } else return value
    }
  }
  try {
    if (text.trim() === '') throw new Error('empty expression')
    const value = expr()
    if (peek() !== undefined) fail(`unexpected '${text[pos]}'`)
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

export function loadSamples(path) {
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  if (extname(path).toLowerCase() === '.json') {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('JSON 样本必须是数组')
    return parsed.map((row, index) => ({ id: String(row.id ?? `row${index + 1}`), expression: String(row.expression ?? ''), expected: row.expected }))
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  const header = (lines.shift() ?? '').split(',').map((cell) => cell.trim().toLowerCase())
  const col = (name) => header.indexOf(name)
  if (col('id') < 0 || col('expression') < 0 || col('expected') < 0) throw new Error('CSV 表头必须包含 id,expression,expected')
  return lines.map((line) => {
    const cells = line.split(',')
    return { id: (cells[col('id')] ?? '').trim(), expression: (cells[col('expression')] ?? '').trim(), expected: (cells[col('expected')] ?? '').trim() }
  })
}

/** 逐条计算；note 前缀（assert/parse/data）用于宿主分析报告的失败聚类。 */
export function runSamples(samples) {
  return samples.map((sample) => {
    const expected = Number(sample.expected)
    if (sample.expected === '' || sample.expected === null || sample.expected === undefined || !Number.isFinite(expected)) {
      return { id: sample.id, expression: sample.expression, expected: sample.expected ?? null, actual: null, pass: false, note: `data: expected 不是数字（${String(sample.expected)}）` }
    }
    const result = evaluate(sample.expression)
    if (!result.ok) {
      return { id: sample.id, expression: sample.expression, expected, actual: null, pass: false, note: `parse: ${sample.expression} → ${result.error}` }
    }
    const pass = Math.abs(result.value - expected) < 1e-9
    return pass
      ? { id: sample.id, expression: sample.expression, expected, actual: result.value, pass: true }
      : { id: sample.id, expression: sample.expression, expected, actual: result.value, pass: false, note: `assert: ${sample.expression} 期望 ${expected} 实际 ${result.value}` }
  })
}

function atomicWrite(path, bytes) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, bytes)
  renameSync(tmp, path)
}

export function produce({ input, out, workspace, experiment, runId = 'local-tests' }) {
  const inputAbs = resolve(input)
  const outAbs = resolve(out)
  mkdirSync(outAbs, { recursive: true })
  const inputBytes = readFileSync(inputAbs)
  const inputSha = sha256(inputBytes)
  const samples = loadSamples(inputAbs)
  const rows = runSamples(samples)
  const passed = rows.filter((row) => row.pass).length
  const failed = rows.length - passed
  const status = rows.length === 0 ? 'failed' : failed === 0 ? 'succeeded' : 'failed'

  // 同一来源的 revision：输入 SHA 不变则沿用当前 revision（重写相同字节），变了则 +1。
  const resultPath = join(outAbs, 'result.json')
  const statePath = join(outAbs, 'producer-state.txt')
  let revision = 1
  let previous = null
  if (existsSync(statePath)) {
    const [rev, sha] = readFileSync(statePath, 'utf8').trim().split(/\s+/)
    previous = { revision: Number(rev), inputSha: sha }
    revision = previous.inputSha === inputSha ? previous.revision : previous.revision + 1
  }
  const experimentId = experiment ?? basename(outAbs)
  const artifactName = `details-r${revision}.txt`
  const artifactAbs = join(outAbs, artifactName)
  const lines = [
    `producer=pet-followup local test runner`,
    `input=${basename(inputAbs)}`,
    `input_sha256=${inputSha}`,
    `revision=${revision}`,
    `total=${rows.length} passed=${passed} failed=${failed} status=${status}`,
    '',
    'id\tpass\texpression\texpected\tactual\tnote',
    ...rows.map((row) => [row.id, row.pass ? 'PASS' : 'FAIL', row.expression, row.expected, row.actual ?? '', row.note ?? ''].join('\t')),
    '',
  ]
  const artifactBytes = Buffer.from(lines.join('\n'), 'utf8')
  atomicWrite(artifactAbs, artifactBytes)
  const root = workspace ? resolve(workspace) : null
  const artifactRel = root ? relative(root, artifactAbs).split('\\').join('/') : artifactAbs
  if (root && (artifactRel.startsWith('..') || isAbsolute(artifactRel))) throw new Error(`输出目录不在宿主工作区内：${outAbs}`)
  const result = {
    schema: RESULT_SCHEMA,
    experimentId,
    runId,
    revision,
    status,
    metrics: { total: rows.length, passed, failed, score: rows.length ? passed / rows.length : null },
    artifactPath: artifactRel,
    artifactSha: sha256(artifactBytes),
    note: `local tests ${basename(inputAbs)} r${revision}: ${failed}/${rows.length} failed`,
    input: { file: basename(inputAbs), sha256: inputSha },
    samples: rows.map((row) => ({ id: row.id, pass: row.pass, ...(row.note ? { note: row.note } : {}) })),
  }
  const body = Buffer.from(JSON.stringify(result, null, 2), 'utf8')
  atomicWrite(resultPath, body)
  writeFileSync(statePath, `${revision} ${inputSha}\n`)
  return { resultPath, resultSha: sha256(body), artifactPath: artifactAbs, revision, status, total: rows.length, passed, failed, sameAsPrevious: previous?.inputSha === inputSha }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
if (invoked || (process.argv[1] && process.argv[1].endsWith('run-tests.mjs'))) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.get('input') || !args.get('out')) {
    console.error('用法: node run-tests.mjs --input <samples.csv|json> --out <结果目录> [--workspace <宿主工作区>] [--delay-ms N]')
    process.exit(2)
  }
  const delay = Number(args.get('delay-ms') ?? 0)
  console.log(`[producer] ${new Date().toISOString()} 读取 ${args.get('input')}，开始逐条计算${delay ? `（模拟运行 ${delay}ms）` : ''}`)
  if (delay > 0) await new Promise((r) => setTimeout(r, delay))
  try {
    const report = produce({ input: args.get('input'), out: args.get('out'), workspace: args.get('workspace'), experiment: args.get('experiment') })
    console.log(`[producer] ${new Date().toISOString()} 写出 ${report.resultPath}`)
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    console.error(`[producer] 失败：${error.message}`)
    process.exit(1)
  }
}
