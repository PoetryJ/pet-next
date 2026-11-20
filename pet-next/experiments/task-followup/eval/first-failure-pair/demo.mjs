#!/usr/bin/env node
/** R8 演示：首败局部授权 / 等待 / 继续下一轮。回放只读 SQLite；live 调用同一 runner。 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1] }
const readJson = (p, fallback = null) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback } }

function summarize(dir) {
  const dbPath = join(dir, 'ws/state/followup.sqlite')
  if (!existsSync(dbPath)) return { dir, error: 'db_missing' }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const task = db.prepare("SELECT * FROM tasks WHERE title='主流程'").get() ?? db.prepare('SELECT * FROM tasks').get()
  const attentions = db.prepare('SELECT * FROM attentions WHERE ticket_id = ? ORDER BY created_at').all(task.ticket_id)
  const visible = attentions.filter((a) => a.delivered_at || a.presented_at)
  const analysis = task.analysis_json ? JSON.parse(task.analysis_json) : null
  const completion = task.completion_json ? JSON.parse(task.completion_json) : null
  const receipt = db.prepare("SELECT * FROM receipts WHERE ticket_id = ? AND tool='write_analysis' ORDER BY finished_at DESC LIMIT 1").get(task.ticket_id)
  const evidence = receipt?.analysis_evidence_json ? JSON.parse(receipt.analysis_evidence_json) : null
  const timeline = readJson(join(dir, 'timeline.json'), [])
  const produces = timeline.filter((t) => t.kind === 'produce')
  db.close()
  return {
    dir,
    status: task.status,
    stage: task.stage,
    action: completion?.mode === 'quiet_archive' ? 'archive' : visible.length ? 'ask' : task.status,
    question: visible[0]?.question ?? null,
    options: visible[0] ? JSON.parse(visible[0].options_json) : [],
    answered: visible.find((a) => a.state === 'answered')?.answer_option_id ?? null,
    partial: analysis?.scope === 'partial',
    analysisScope: analysis?.scope ?? null,
    analysisSha: analysis?.artifactSha ?? null,
    sourceTaskId: analysis?.sourceTaskId ?? null,
    authorizedTaskIds: evidence?.inputSet?.authorizedTaskIds ?? null,
    inputSetSha: evidence?.inputSet?.sha ?? null,
    lateAsksAfterLastProduce: produces.length
      ? attentions.filter((a) => String(a.created_at) >= produces.at(-1).at).length
      : attentions.length,
    archiveQuotes: completion?.sourceQuotes?.map((q) => q.text) ?? [],
  }
}

const live = process.argv.includes('--live')
const outArg = arg('out')
if (live) {
  const out = resolve(outArg ?? `eval/first-failure-pair/demo-${Date.now()}`)
  mkdirSync(out, { recursive: true })
  const r = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', 'eval/first-failure-pair/run.mjs', '--group', 'G1', '--promise', 'F', '--arm', 'V-C', '--out', out, '--base-port', '19600'], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
  console.log(JSON.stringify(summarize(join(out, 'G1-F-V-C')), null, 2))
  process.exit(0)
}

const dirs = (arg('replay', '') ?? '').split(',').map((s) => resolve(s.trim())).filter(Boolean)
if (!dirs.length) { console.error('usage: demo.mjs --replay <run>,<run> | --live --out <new>'); process.exit(2) }
const rows = dirs.map(summarize)
console.log(JSON.stringify(rows, null, 2))
for (const row of rows) {
  if (row.error) continue
  console.log(`\n${row.dir}`)
  console.log(`  动作=${row.action} 状态=${row.status} 问题=${row.question ?? '-'}`)
  console.log(`  选项=${row.options.map((o) => `${o.id}:${o.label}`).join(' / ') || '-'} 已回答=${row.answered ?? '-'}`)
  console.log(`  分析=${row.analysisScope ?? 'none'} 局部来源=${row.sourceTaskId ?? '-'} 授权=${JSON.stringify(row.authorizedTaskIds)}`)
  console.log(`  最后一份报告后新提醒=${row.lateAsksAfterLastProduce}`)
}
