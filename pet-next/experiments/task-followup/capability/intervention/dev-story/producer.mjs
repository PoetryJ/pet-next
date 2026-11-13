#!/usr/bin/env node
/**
 * 独立本地工作生产者（与宿主/模型无关的独立进程）：
 *   run     --samples F --config v1|v2 --assignment ID --out DIR [--delay-ms N] [--progress-at K]
 *           读取样本，按配置实际比对 expected/prediction，先写进度文件（可选），再写 result-<ID>.json 和 report-<ID>.md
 *   analyze --result R --samples F --out DIR
 *           读取实际结果与样本，生成 analysis-<ID>.md（失败样本明细与混淆统计）
 * --delay-ms 是标注过的短演示等待（真实 sleep），不是假时钟。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const atomicWrite = (path, text) => { writeFileSync(path + '.tmp', text, 'utf8'); renameSync(path + '.tmp', path) }
const sha = (text) => createHash('sha256').update(text).digest('hex')

if (cmd === 'run') {
  const samplesPath = opt('--samples'), config = opt('--config'), id = opt('--assignment'), out = opt('--out')
  const delay = Number(opt('--delay-ms', '0')), progressAt = Number(opt('--progress-at', '0'))
  mkdirSync(out, { recursive: true })
  const data = JSON.parse(readFileSync(samplesPath, 'utf8'))
  const rows = []
  for (const [n, s] of data.samples.entries()) {
    const predicted = s.predictions?.[config]
    if (predicted === undefined) throw new Error(`sample ${s.id} has no prediction for config ${config}`)
    rows.push({ id: s.id, expected: s.expected, predicted, ok: predicted === s.expected })
    if (progressAt > 0 && n + 1 === progressAt) {
      await sleep(delay / 2)
      const done = rows.length, errors = rows.filter((r) => !r.ok).length
      atomicWrite(join(out, `progress-${id}.json`), JSON.stringify({ kind: 'progress', task: data.task, config, assignment: id, processed: done, total: data.samples.length, errorsSoFar: errors, at: new Date().toISOString() }, null, 2))
    }
  }
  await sleep(progressAt > 0 ? delay / 2 : delay)
  const correct = rows.filter((r) => r.ok).length
  const result = { kind: 'result', task: data.task, config, assignment: id, total: rows.length, correct, accuracy: Math.round((correct / rows.length) * 1000) / 1000, failures: rows.filter((r) => !r.ok).map((r) => r.id), status: correct === rows.length ? 'passed' : 'failed', samplesSha256: sha(readFileSync(samplesPath, 'utf8')), at: new Date().toISOString() }
  const report = [`# ${data.task} 评测结果（配置 ${config}，运行 ${id}）`, '', `正确 ${correct}/${rows.length}，准确率 ${result.accuracy}`, '', '| 样本 | 期望 | 预测 | 结果 |', '|---|---|---|---|', ...rows.map((r) => `| ${r.id} | ${r.expected} | ${r.predicted} | ${r.ok ? '✓' : '✗'} |`), ''].join('\n')
  atomicWrite(join(out, `report-${id}.md`), report)
  atomicWrite(join(out, `result-${id}.json`), JSON.stringify({ ...result, reportFile: `report-${id}.md`, reportSha256: sha(report) }, null, 2))
} else if (cmd === 'analyze') {
  const resultPath = opt('--result'), samplesPath = opt('--samples'), out = opt('--out')
  const result = JSON.parse(readFileSync(resultPath, 'utf8'))
  const data = JSON.parse(readFileSync(samplesPath, 'utf8'))
  const failed = data.samples.filter((s) => result.failures.includes(s.id))
  const confusion = {}
  for (const s of failed) { const k = `${s.expected}→${s.predictions[result.config]}`; confusion[k] = (confusion[k] ?? 0) + 1 }
  const md = [`# ${result.task} 失败样本分析（运行 ${result.assignment}，配置 ${result.config}）`, '', `来源结果文件 sha256=${sha(readFileSync(resultPath, 'utf8'))}`, `失败 ${failed.length}/${result.total}`, '', '## 混淆', ...Object.entries(confusion).map(([k, v]) => `- ${k}: ${v}`), '', '## 明细', ...failed.map((s) => `- ${s.id}（${s.text}）：期望 ${s.expected}，预测 ${s.predictions[result.config]}；另一配置预测 ${Object.entries(s.predictions).filter(([c]) => c !== result.config).map(([c, p]) => `${c}=${p}`).join(',')}`), ''].join('\n')
  mkdirSync(out, { recursive: true })
  atomicWrite(join(out, `analysis-${result.assignment}.md`), md)
} else {
  console.error('usage: producer.mjs run|analyze ...')
  process.exit(2)
}
